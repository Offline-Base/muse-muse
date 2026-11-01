/**
 * A pretend GitHub on this machine, for tests and local runs of the export (docs/GITHUB_EXPORT.md). The REST and OAuth parts
 * are made up to GitHub's documented shape. The git part is real: each repo is a bare repo served by `git http-backend`,
 * with the strict object checks on. Nothing here talks to GitHub.
 *
 *   npx tsx scripts/github-mock.ts <folder> <port>   then POST /__mock/next-login {"login":"..."} to pick who approves next.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export const MOCK_CLIENT_ID = "mock-client-id";
export const MOCK_CLIENT_SECRET = "mock-client-secret";

export interface MockGitHub {
  url: string;
  folder: string;
  /** Whoever approves the next sign-in. */
  nextLogin: string;
  scope: string;
  tokens: Map<string, string>;
  ids: Map<string, number>;
  repoPath(fullName: string): string;
  /** Every git request's token, to check which one was used. */
  gitTokens: string[];
  deleteRepo(fullName: string): void;
  close(): Promise<void>;
}

const read = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export async function startMockGitHub(folder: string, port = 0): Promise<MockGitHub> {
  mkdirSync(folder, { recursive: true });
  const codes = new Map<string, { login: string; redirect: string }>();
  const repos = new Set<string>();
  const mock: MockGitHub = {
    url: "",
    folder,
    nextLogin: "made-up-user",
    scope: "repo",
    tokens: new Map(),
    ids: new Map(),
    repoPath: (fullName) => path.join(folder, `${fullName}.git`),
    gitTokens: [],
    deleteRepo: (fullName) => void repos.delete(fullName),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  const idOf = (login: string) => {
    if (!mock.ids.has(login)) mock.ids.set(login, 1000 + mock.ids.size);
    return mock.ids.get(login)!;
  };
  const json = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const bearer = (req: IncomingMessage) => mock.tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));

  async function git(req: IncomingMessage, res: ServerResponse, url: URL, fullName: string) {
    const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
    const token = scheme === "Basic" ? Buffer.from(encoded ?? "", "base64").toString("utf8").split(":")[1] : undefined;
    if (token) mock.gitTokens.push(token);
    const login = token ? mock.tokens.get(token) : undefined;
    if (!login) return json(res, 401, { message: "Bad credentials" });
    if (!repos.has(fullName)) return json(res, 404, { message: "Not Found" });
    if (fullName.split("/")[0] !== login) return json(res, 403, { message: "Write access to repository not granted" });
    const body = await read(req);
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: folder,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: login,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
      } as unknown as NodeJS.ProcessEnv,
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(body);
    child.on("close", () => {
      const all = Buffer.concat(out);
      const split = all.indexOf("\r\n\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of all.subarray(0, split).toString("latin1").split("\r\n")) {
        const at = line.indexOf(":");
        const name = line.slice(0, at).toLowerCase();
        const value = line.slice(at + 1).trim();
        if (name === "status") status = parseInt(value, 10);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.end(all.subarray(split + 4));
    });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const p = url.pathname;
    void (async () => {
      if (p === "/login/oauth/authorize") {
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        const back = new URL(redirect);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        const code = randomBytes(10).toString("hex");
        codes.set(code, { login: mock.nextLogin, redirect });
        back.searchParams.set("code", code);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (p === "/login/oauth/access_token" && req.method === "POST") {
        const body = JSON.parse((await read(req)).toString("utf8")) as Record<string, string>;
        const held = codes.get(body.code ?? "");
        codes.delete(body.code ?? "");
        if (!held || body.client_id !== MOCK_CLIENT_ID || body.client_secret !== MOCK_CLIENT_SECRET || body.redirect_uri !== held.redirect) return json(res, 200, { error: "bad_verification_code" });
        const token = `gho_mock${randomBytes(20).toString("hex")}`;
        mock.tokens.set(token, held.login);
        return json(res, 200, { access_token: token, scope: mock.scope, token_type: "bearer" });
      }
      if (p === "/user" && req.method === "GET") {
        const login = bearer(req);
        return login ? json(res, 200, { id: idOf(login), login }) : json(res, 401, { message: "Bad credentials" });
      }
      if (p === "/user/repos" && req.method === "POST") {
        const login = bearer(req);
        if (!login) return json(res, 401, { message: "Bad credentials" });
        const body = JSON.parse((await read(req)).toString("utf8")) as { name: string; private: boolean };
        const fullName = `${login}/${body.name}`;
        if (repos.has(fullName)) return json(res, 422, { message: "name already exists on this account" });
        const at = mock.repoPath(fullName);
        mkdirSync(at, { recursive: true });
        spawnSync("git", ["init", "--bare", "--initial-branch=main", at]);
        spawnSync("git", ["-C", at, "config", "receive.fsckObjects", "true"]);
        spawnSync("git", ["-C", at, "config", "receive.denyNonFastForwards", "true"]);
        spawnSync("git", ["-C", at, "config", "http.receivepack", "true"]);
        repos.add(fullName);
        return json(res, 201, { full_name: fullName, default_branch: "main", private: body.private });
      }
      const repo = p.match(/^\/repos\/([^/]+\/[^/]+)$/);
      if (repo && req.method === "GET") {
        if (!bearer(req)) return json(res, 401, { message: "Bad credentials" });
        return repos.has(repo[1]!) ? json(res, 200, { full_name: repo[1] }) : json(res, 404, { message: "Not Found" });
      }
      if (/^\/applications\/[^/]+\/grant$/.test(p) && req.method === "DELETE") {
        const expected = `Basic ${Buffer.from(`${MOCK_CLIENT_ID}:${MOCK_CLIENT_SECRET}`).toString("base64")}`;
        if (req.headers.authorization !== expected) return json(res, 401, { message: "Bad credentials" });
        const body = JSON.parse((await read(req)).toString("utf8")) as { access_token: string };
        mock.tokens.delete(body.access_token);
        return json(res, 204);
      }
      if (p === "/__mock/next-login" && req.method === "POST") {
        mock.nextLogin = (JSON.parse((await read(req)).toString("utf8")) as { login: string }).login;
        return json(res, 200, {});
      }
      const gitPath = p.match(/^\/([^/]+\/[^/]+)\.git\/(info\/refs|git-receive-pack)$/);
      if (gitPath) return git(req, res, url, gitPath[1]!);
      return json(res, 404, { message: "Not Found" });
    })().catch(() => json(res, 500, { message: "mock failed" }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}

if (process.argv[1]?.endsWith("github-mock.ts")) {
  const mock = await startMockGitHub(process.argv[2] ?? ".data/github-mock", Number(process.argv[3] ?? 0));
  console.log(`Pretend GitHub at ${mock.url}`);
}

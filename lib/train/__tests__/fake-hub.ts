/**
 * A fake Hugging Face Hub on localhost for the hub tests (not a test file itself): the API calls lib/train/hub.ts makes
 * (repos/create, a repo's info with its "private", preupload, the LFS batch with "basic" and "multipart" actions and
 * none for an object it stores, the presigned PUTs and the multipart completion, the NDJSON commit, settings, the tree,
 * whoami) and the base model's raw LICENSE, as docs/HF_EXPORT_RESEARCH.md describes them. Point HF_ENDPOINT at `url`.
 *
 * Every API call needs "Authorization: Bearer <token>" (401 otherwise, echoing what it got, so tests can check that
 * errors blank the token out); the presigned storage URLs take no credential, and any Authorization header sent to
 * them is recorded in `leaks`. Files are LFS when they are over 10 MB, a weights type (.safetensors, .bin, .model) or
 * binary (a NUL byte in their sample). An object over `multipartOver` bytes gets a multipart plan of `chunkSize` parts.
 * `fail` makes the next calls to a path answer a status, `hang` makes them wait, and `expire` makes an upload URL
 * answer 403.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_LICENSE =
  "\n                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n";

export interface FakeFile {
  content?: Buffer;
  lfs?: { oid: string; size: number };
}

export interface FakeRepo {
  type: "model" | "dataset";
  id: string;
  private: boolean;
  license: string | null;
  files: Map<string, FakeFile>;
  commits: Array<{ oid: string; summary: string; description: string; files: string[]; lfsFiles: string[] }>;
  /** Objects in the repo's LFS storage, by oid. */
  objects: Map<string, Buffer>;
}

export interface FakeRequest {
  method: string;
  path: string;
  query: string;
  /** The Authorization header as sent, or null. */
  authorization: string | null;
  contentType: string | null;
  body: Buffer;
}

interface Upload {
  repo: string;
  oid: string;
  size: number;
  parts: Map<number, { bytes: Buffer; etag: string }>;
  expired: boolean;
}

const LFS_TYPE = "application/vnd.git-lfs+json";
const MB = 1024 * 1024;

export function gitOidOf(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const pointer = (oid: string, size: number) => Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`);

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export interface FakeHub {
  url: string;
  token: string;
  repos: Map<string, FakeRepo>;
  requests: FakeRequest[];
  /** Authorization headers sent to presigned URLs, which must never get one. */
  leaks: string[];
  /** The transfers every LFS batch asked for. */
  transfers: string[][];
  /** The next `statuses.length` calls whose path matches answer these statuses, one each. */
  fail(match: RegExp, statuses: number[], body?: unknown): void;
  /** The next `times` calls whose path matches wait `ms` before they are handled. */
  hang(match: RegExp, ms: number, times?: number): void;
  /** The next repos/create calls answer 409 for a conflicting operation in progress. */
  conflicts: number;
  /** Uploads whose URLs answer 403, as expired ones do. */
  expire(match: (path: string) => boolean): void;
  /** Paths preupload says .gitignore ignores. */
  ignored: Set<string>;
  multipartOver: number;
  chunkSize: number;
  /** A repo by "<model|dataset>:<id>". */
  repo(type: "model" | "dataset", id: string): FakeRepo | undefined;
  close(): Promise<void>;
}

export async function startFakeHub(opts: { token: string; multipartOver?: number; chunkSize?: number }): Promise<FakeHub> {
  const repos = new Map<string, FakeRepo>();
  const uploads = new Map<string, Upload>();
  const failing: Array<{ match: RegExp; status: number; body?: unknown }> = [];
  const hanging: Array<{ match: RegExp; ms: number }> = [];
  const expiring: Array<(path: string) => boolean> = [];
  let server: Server;
  const hub: FakeHub = {
    url: "",
    token: opts.token,
    repos,
    requests: [],
    leaks: [],
    transfers: [],
    conflicts: 0,
    ignored: new Set(),
    multipartOver: opts.multipartOver ?? 8 * MB,
    chunkSize: opts.chunkSize ?? 5 * MB,
    fail(match, statuses, body) {
      for (const status of statuses) failing.push({ match, status, body });
    },
    hang(match, ms, times = 1) {
      for (let i = 0; i < times; i++) hanging.push({ match, ms });
    },
    expire(match) {
      expiring.push(match);
    },
    repo(type, id) {
      return repos.get(`${type}:${id}`);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  const authed = (req: IncomingMessage) => req.headers.authorization === `Bearer ${opts.token}`;
  const signed = (path: string) => `${hub.url}${path}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${randomBytes(16).toString("hex")}`;

  function repoFrom(kind: string | undefined, ns: string, name: string): FakeRepo | undefined {
    return repos.get(`${kind === "datasets" ? "dataset" : "model"}:${ns}/${name}`);
  }

  function fileEntry(path: string, f: FakeFile) {
    if (f.lfs) {
      const p = pointer(f.lfs.oid, f.lfs.size);
      return { type: "file", path, size: f.lfs.size, oid: gitOidOf(p), lfs: { oid: f.lfs.oid, size: f.lfs.size, pointerSize: p.length } };
    }
    return { type: "file", path, size: f.content!.length, oid: gitOidOf(f.content!) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const body = await read(req);
    hub.requests.push({
      method: req.method ?? "GET",
      path,
      query: url.search,
      authorization: req.headers.authorization ?? null,
      contentType: (req.headers["content-type"] as string | undefined) ?? null,
      body,
    });
    const hang = hanging.findIndex((h) => h.match.test(path));
    if (hang >= 0) {
      const [h] = hanging.splice(hang, 1);
      await new Promise((r) => setTimeout(r, h!.ms));
    }
    const fail = failing.findIndex((f) => f.match.test(path));
    if (fail >= 0) {
      const [f] = failing.splice(fail, 1);
      return json(res, f!.status, f!.body ?? { error: `Injected HTTP ${f!.status}` }, f!.status === 429 ? { "retry-after": "0" } : {});
    }

    // Presigned storage: no credential.
    const s3 = path.match(/^\/s3\/([0-9a-f]+)(?:\/(\d+))?$/);
    if (s3 && req.method === "PUT") {
      if (req.headers.authorization) hub.leaks.push(req.headers.authorization);
      const up = uploads.get(s3[1]!);
      if (!up) return json(res, 404, { error: "No such upload" });
      if (up.expired || expiring.some((m) => m(path)) || !url.searchParams.get("X-Amz-Signature")) {
        return json(res, 403, { error: "Request has expired" });
      }
      if (s3[2]) {
        const etag = `"${createHash("md5").update(body).digest("hex")}"`;
        up.parts.set(Number(s3[2]), { bytes: body, etag });
        res.writeHead(200, { etag });
        return void res.end();
      }
      if (body.length !== up.size || sha256(body) !== up.oid) return json(res, 400, { error: "The bytes don't match the object" });
      repos.get(up.repo)!.objects.set(up.oid, body);
      res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
      return void res.end();
    }
    const complete = path.match(/^\/lfs-complete\/([0-9a-f]+)$/);
    if (complete && req.method === "POST") {
      if (req.headers.authorization) hub.leaks.push(req.headers.authorization);
      const up = uploads.get(complete[1]!);
      if (!up) return json(res, 404, { error: "No such upload" });
      const asked = JSON.parse(body.toString("utf8")) as { oid: string; parts: Array<{ partNumber: number; etag: string }> };
      if (asked.oid !== up.oid) return json(res, 400, { error: "Wrong oid" });
      const bytes: Buffer[] = [];
      for (const p of asked.parts) {
        const part = up.parts.get(p.partNumber);
        if (!part || part.etag !== p.etag) return json(res, 400, { error: `Part ${p.partNumber} doesn't match` });
        bytes.push(part.bytes);
      }
      const all = Buffer.concat(bytes);
      if (all.length !== up.size || sha256(all) !== up.oid) return json(res, 400, { error: "The parts don't make the object" });
      repos.get(up.repo)!.objects.set(up.oid, all);
      return json(res, 200, {});
    }
    if (path === "/meta-models/Muse-Glimmer-30B/raw/main/LICENSE") {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(FAKE_LICENSE);
    }

    if (!authed(req)) return json(res, 401, { error: `Invalid credentials in Authorization header: ${req.headers.authorization ?? "none"}` });

    if (path === "/api/whoami-v2") return json(res, 200, { type: "user", name: "muse-bot", orgs: [{ name: "muse-org" }] });

    if (path === "/api/repos/create" && req.method === "POST") {
      const b = JSON.parse(body.toString("utf8")) as { type?: string; name: string; organization: string; visibility?: string; private?: boolean; license?: string };
      if (b.visibility !== undefined && b.private !== undefined) return json(res, 400, { error: "private and visibility can't both be set" });
      const type = b.type === "dataset" ? "dataset" : "model";
      const id = `${b.organization}/${b.name}`;
      const repoUrl = `${hub.url}${type === "dataset" ? "/datasets" : ""}/${id}`;
      if (hub.conflicts > 0) {
        hub.conflicts -= 1;
        return json(res, 409, { error: "There is a conflicting operation in progress, please retry", url: repoUrl });
      }
      if (repos.has(`${type}:${id}`)) return json(res, 409, { error: `You already created this ${type} repo`, url: repoUrl });
      repos.set(`${type}:${id}`, {
        type,
        id,
        private: b.visibility === "private" || b.private === true,
        license: b.license ?? null,
        files: new Map([[".gitattributes", { content: Buffer.from("*.safetensors filter=lfs diff=lfs merge=lfs -text\n") }]]),
        commits: [],
        objects: new Map(),
      });
      return json(res, 200, { url: repoUrl, name: id, id: randomBytes(12).toString("hex") });
    }

    const info = path.match(/^\/api\/(models|datasets)\/([^/]+)\/([^/]+)$/);
    if (info && req.method === "GET") {
      const repo = repoFrom(info[1], info[2]!, info[3]!);
      if (!repo) return json(res, 404, { error: "Repository not found" });
      return json(res, 200, { id: repo.id, private: repo.private, sha: "0".repeat(40) });
    }

    const api = path.match(/^\/api\/(models|datasets)\/([^/]+)\/([^/]+)\/(preupload\/main|commit\/main|settings|tree\/main)$/);
    if (api) {
      const repo = repoFrom(api[1], api[2]!, api[3]!);
      if (!repo) return json(res, 404, { error: "Repository not found" });
      const what = api[4]!;
      if (what === "preupload/main") {
        const b = JSON.parse(body.toString("utf8")) as { files: Array<{ path: string; size: number; sample: string }> };
        return json(res, 200, {
          commitOid: "0".repeat(40),
          files: b.files.map((f) => {
            const sample = Buffer.from(f.sample, "base64");
            const lfs = f.size > 10 * MB || /\.(safetensors|bin|model)$/.test(f.path) || sample.includes(0);
            const have = repo.files.get(f.path);
            const oid = have ? (have.lfs ? have.lfs.oid : gitOidOf(have.content!)) : undefined;
            return { path: f.path, uploadMode: lfs ? "lfs" : "regular", shouldIgnore: hub.ignored.has(f.path), ...(oid ? { oid } : {}) };
          }),
        });
      }
      if (what === "commit/main") {
        if (!String(req.headers["content-type"]).startsWith("application/x-ndjson")) return json(res, 415, { error: "Send NDJSON" });
        const lines = body.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { key: string; value: Record<string, unknown> });
        if (lines[0]?.key !== "header") return json(res, 400, { error: "The first line must be the header" });
        const next = new Map(repo.files);
        const files: string[] = [];
        const lfsFiles: string[] = [];
        for (const line of lines.slice(1)) {
          const v = line.value;
          if (line.key === "file") {
            if (v.encoding !== "base64") return json(res, 400, { error: "Only base64 here" });
            next.set(String(v.path), { content: Buffer.from(String(v.content), "base64") });
            files.push(String(v.path));
          } else if (line.key === "lfsFile") {
            const obj = repo.objects.get(String(v.oid));
            if (v.algo !== "sha256" || !obj) return json(res, 422, { error: `LFS object ${String(v.oid)} not found in the repo's storage` });
            if (v.size !== undefined && v.size !== obj.length) return json(res, 422, { error: "Wrong LFS size" });
            next.set(String(v.path), { lfs: { oid: String(v.oid), size: obj.length } });
            lfsFiles.push(String(v.path));
          } else return json(res, 400, { error: `Unknown key ${line.key}` });
        }
        repo.files = next;
        const oid = randomBytes(20).toString("hex");
        const header = lines[0]!.value as { summary?: string; description?: string };
        repo.commits.push({ oid, summary: String(header.summary ?? ""), description: String(header.description ?? ""), files, lfsFiles });
        return json(res, 200, { success: true, commitOid: oid, commitUrl: `${hub.url}/${repo.id}/commit/${oid}`, hookOutput: "" });
      }
      if (what === "settings" && req.method === "PUT") {
        const b = JSON.parse(body.toString("utf8")) as { visibility?: string };
        if (b.visibility !== "public" && b.visibility !== "private") return json(res, 400, { error: "Bad visibility" });
        repo.private = b.visibility === "private";
        return json(res, 200, { private: repo.private, visibility: b.visibility });
      }
      if (what === "tree/main") return json(res, 200, [...repo.files].map(([p, f]) => fileEntry(p, f)));
    }

    const git = path.match(/^\/(?:(datasets)\/)?([^/]+)\/([^/]+)\.git\/info\/lfs\/objects\/batch$/);
    if (git && req.method === "POST") {
      const repo = repoFrom(git[1], git[2]!, git[3]!);
      if (!repo) return json(res, 404, { error: "Repository not found" });
      if (req.headers.accept !== LFS_TYPE || req.headers["content-type"] !== LFS_TYPE) return json(res, 406, { error: "Send git-lfs JSON" });
      const b = JSON.parse(body.toString("utf8")) as { transfers?: string[]; objects?: Array<{ oid: string; size: number }> };
      hub.transfers.push(b.transfers ?? []);
      let multipart = false;
      const objects = (b.objects ?? []).map((o) => {
        // An object it stores gets no actions, as git-lfs servers answer.
        if (repo.objects.get(o.oid)?.length === o.size) return { oid: o.oid, size: o.size };
        const id = randomBytes(8).toString("hex");
        uploads.set(id, { repo: `${repo.type}:${repo.id}`, oid: o.oid, size: o.size, parts: new Map(), expired: false });
        const verify = { href: `${hub.url}/${repo.id}.git/info/lfs/objects/verify`, header: { Authorization: `Bearer ${opts.token}` } };
        if (o.size > hub.multipartOver && b.transfers?.includes("multipart")) {
          multipart = true;
          const n = Math.ceil(o.size / hub.chunkSize);
          const header: Record<string, string> = { chunk_size: String(hub.chunkSize) };
          for (let i = 1; i <= n; i++) header[String(i).padStart(5, "0")] = signed(`/s3/${id}/${i}`);
          return { oid: o.oid, size: o.size, authenticated: true, actions: { upload: { href: signed(`/lfs-complete/${id}`), header }, verify } };
        }
        return { oid: o.oid, size: o.size, authenticated: true, actions: { upload: { href: signed(`/s3/${id}`), header: { "x-amz-meta-test": "1" } }, verify } };
      });
      res.writeHead(200, { "content-type": LFS_TYPE });
      return void res.end(JSON.stringify({ transfer: multipart ? "multipart" : "basic", objects }));
    }
    return json(res, 404, { error: `Fake Hub has no ${req.method} ${path}` });
  }

  server = createServer((req, res) => {
    handle(req, res).catch((err) => json(res, 500, { error: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return hub;
}

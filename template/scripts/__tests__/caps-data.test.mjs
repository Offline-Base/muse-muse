// The data cap's overlay (docs/CAPABILITIES.md, section 9) and core's sign-in parts: lib/platform/data.ts against a fake
// gateway, lib/platform/user.ts, the user and owner routes, the SignIn component, the fixed checks
// (scripts/caps/data.mjs) and the overlay's paths. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-data.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = path.join(TEMPLATE, "caps/data/files");
const CORE = path.join(TEMPLATE, "caps/core/files");
const AGENT = path.join(TEMPLATE, "targets/agent/files");
const modules = path.join(TEMPLATE, "node_modules");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name), base)) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}

describe("the overlay's files", () => {
  test("write no path the template, a target overlay or another cap overlay writes", () => {
    const own = walk(DATA);
    const others = [
      ...walk(TEMPLATE).filter((f) => !f.startsWith("targets/") && !f.startsWith("caps/")),
      ...readdirSync(path.join(TEMPLATE, "targets")).flatMap((t) => walk(path.join(TEMPLATE, "targets", t, "files"))),
      ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "data").flatMap((c) => walk(path.join(TEMPLATE, "caps", c, "files"))),
    ];
    assert.deepEqual(own.filter((f) => others.includes(f)), []);
  });

  test("are all platform files, and so are core's sign-in parts", () => {
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/data/platform-files.json"), "utf8")).sort(), walk(DATA).sort());
    const core = JSON.parse(readFileSync(path.join(TEMPLATE, "caps/core/platform-files.json"), "utf8"));
    for (const f of ["lib/platform/user.ts", "app/api/musemuse/user/route.ts", "app/api/musemuse/user-sign-out/route.ts"]) assert.ok(core.includes(f), f);
  });

  test("the owner route is a static segment beside the agent kit's catch-all, which has no file of the same path", () => {
    assert.ok(existsSync(path.join(AGENT, "app/api/musemuse/[...path]/route.ts")));
    assert.ok(!walk(AGENT).includes("app/api/musemuse/owner/route.ts"));
  });

  test("the skill names every helper the build prompt names, and no em dash", () => {
    const skill = readFileSync(path.join(DATA, ".agents/skills/muse-data/SKILL.md"), "utf8");
    for (const name of ["checkSecondBrowser", "signInAs", "seed", "deleteMine", "currentUser", "SignIn", "ifVersion", "version_conflict", "quota_exceeded"]) assert.ok(skill.includes(name), name);
    for (const f of [...walk(DATA), ...["lib/platform/user.ts", "app/api/musemuse/user/route.ts", "app/api/musemuse/user-sign-out/route.ts"].map((f) => `core:${f}`)]) {
      const file = f.startsWith("core:") ? path.join(CORE, f.slice(5)) : path.join(DATA, f);
      assert.ok(!readFileSync(file, "utf8").includes("—"), f);
    }
  });
});

describe("the fixed checks (scripts/caps/data.mjs)", () => {
  let checker;
  before(async () => {
    checker = await import(pathToFileURL(path.join(DATA, "scripts/caps/data.mjs")).href);
  });

  function root(manifest) {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-data-check-"));
    dirs.push(dir);
    if (manifest) writeFileSync(path.join(dir, "musemuse.json"), JSON.stringify(manifest));
    return dir;
  }
  const proof = { writes: 3, rows: 3, users: 1, "brief:groceries:shared": 1, "brief:notes:visitor": 1 };
  const manifest = { data: { collections: [{ name: "notes", scope: "visitor" }, { name: "groceries", scope: "shared", writes: "anyone" }] } };
  const record = { cap: "data", checks: [{ id: "second-browser", ok: true, detail: "saw it" }, { id: "visitor-private", ok: true, detail: "didn't" }] };

  test("pass when the manifest is the brief's, the gateway saw saves and both browsers checked out", async () => {
    const out = await checker.check({ record, proof, root: root(manifest) });
    assert.deepEqual(out.map((c) => [c.id, c.ok]), [["manifest", true], ["writes", true], ["second-browser", true], ["visitor-private", true]]);
  });

  test("fail a manifest that renames or rescopes a collection, and say what each has", async () => {
    const out = await checker.check({ record, proof, root: root({ data: { collections: [{ name: "groceries", scope: "shared" }, { name: "notes", scope: "shared" }] } }) });
    const m = out.find((c) => c.id === "manifest");
    assert.equal(m.ok, false);
    assert.match(m.detail, /notes \(shared\)/);
    assert.match(m.detail, /notes \(visitor\)/);
  });

  test("fail with no gateway record, no saves, or a smoke test that skipped the second browser", async () => {
    const none = await checker.check({ record, proof: null, root: root(manifest) });
    assert.deepEqual(none.filter((c) => !c.ok).map((c) => c.id), ["manifest", "writes"]);
    const idle = await checker.check({ record: { checks: [] }, proof: { ...proof, writes: 0 }, root: root(manifest) });
    assert.deepEqual(idle.filter((c) => !c.ok).map((c) => c.id), ["writes", "second-browser", "visitor-private"]);
  });

  test("need the same person on a second browser, and a signed-in save, for a user collection", async () => {
    const userProof = { writes: 2, "brief:lists:user": 1, users: 0 };
    const m = { data: { collections: [{ name: "lists", scope: "user" }] } };
    const follows = { checks: [{ id: "visitor-private", ok: true }, { id: "user-follows", ok: true, detail: "saw it" }] };
    const out = await checker.check({ record: follows, proof: userProof, root: root(m) });
    assert.equal(out.find((c) => c.id === "user-follows").ok, false, "the gateway saw no signed-in person save");
    assert.ok(!out.some((c) => c.id === "second-browser"), "no shared collection, so no shared check");
    const ok = await checker.check({ record: follows, proof: { ...userProof, users: 1 }, root: root(m) });
    assert.ok(ok.every((c) => c.ok), JSON.stringify(ok));
  });
});

describe("in a product with core and data", { skip: existsSync(modules) ? false : "needs template/node_modules" }, () => {
  let dir;
  let server;
  let base;
  const seen = [];
  let answer = () => ({ status: 200, body: {} });

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-data-product-"));
    dirs.push(dir);
    for (const f of ["tsconfig.json", "package.json"]) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    cpSync(path.join(TEMPLATE, "lib"), path.join(dir, "lib"), { recursive: true });
    cpSync(path.join(TEMPLATE, "components"), path.join(dir, "components"), { recursive: true });
    cpSync(CORE, dir, { recursive: true });
    cpSync(DATA, dir, { recursive: true });
    symlinkSync(modules, path.join(dir, "node_modules"));
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
        const a = answer(req);
        res.writeHead(a.status, { "content-type": "application/json" });
        res.end(JSON.stringify(a.body));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/api/gateway`;
  });
  after(() => server?.close());

  /** Runs TypeScript in the product folder, so "@/..." is the product's own files, and gives its last line as JSON. */
  async function run(code) {
    const script = path.join(dir, `run-${seen.length}-${Math.random().toString(36).slice(2)}.mts`);
    writeFileSync(script, `${code}\n`);
    const tsx = fileURLToPath(import.meta.resolve("tsx/esm"));
    const { spawn } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsx, script], { cwd: dir, env: { ...process.env, GATEWAY_URL: base, PRODUCT_TOKEN: "mm_build_sample_token_value" } });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (status) => (status === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error(err || out))));
    });
  }

  const COOKIES = "mm_vid=visitor_abcdefghijklmnop; mm_owner=os1.p.s.9999999999999.sig_sig_sig_sig; mm_user=us1.p.subject123.9999999999999.signaturesignature; mm_user_name=Ana%20B";

  test("data() sends the token and who is asking, and each call goes to its path", async () => {
    seen.length = 0;
    answer = (req) => {
      if (req.method === "POST" && req.url.endsWith("/query")) return { status: 200, body: { items: [{ id: "a", data: { name: "Milk" }, version: 1 }], next: null } };
      if (req.method === "GET") return { status: 200, body: { id: "a", data: { name: "Milk" }, version: 1 } };
      if (req.method === "DELETE") return { status: 200, body: req.url.endsWith("_mine") ? { deleted: 2 } : { deleted: true } };
      return { status: req.method === "POST" ? 201 : 200, body: { id: "a", version: 1 } };
    };
    const out = await run(`
import { data, deleteMine } from "./lib/platform/data.ts";
const request = new Request("http://localhost/x", { headers: { cookie: ${JSON.stringify(COOKIES)}, "x-forwarded-for": "203.0.113.9" } });
const list = data(request).collection("groceries", { scope: "shared" });
const created = await list.create({ name: "Milk" });
const got = await list.get("a");
const put = await list.put("a", { name: "Oat milk" }, { ifVersion: 1 });
const page = await list.query({ where: { bought: false }, limit: 10 });
const gone = await list.delete("a");
const mine = await deleteMine(request);
console.log(JSON.stringify({ created, got, put, page, gone, mine }));
`);
    assert.deepEqual(out.created, { id: "a", version: 1 });
    assert.equal(out.got.data.name, "Milk");
    assert.equal(out.page.items.length, 1);
    assert.equal(out.gone, true);
    assert.equal(out.mine, 2);
    assert.deepEqual(
      seen.map((s) => `${s.method} ${s.url}`),
      [
        "POST /api/gateway/data/groceries?scope=shared",
        "GET /api/gateway/data/groceries/a?scope=shared",
        "PUT /api/gateway/data/groceries/a?scope=shared",
        "POST /api/gateway/data/groceries/query",
        "DELETE /api/gateway/data/groceries/a?scope=shared",
        "DELETE /api/gateway/data/_mine",
      ],
    );
    const h = seen[0].headers;
    assert.equal(h.authorization, "Bearer mm_build_sample_token_value");
    assert.equal(h["x-musemuse-visitor"], "visitor_abcdefghijklmnop");
    assert.equal(h["x-musemuse-owner"], "os1.p.s.9999999999999.sig_sig_sig_sig");
    assert.equal(h["x-musemuse-user"], "us1.p.subject123.9999999999999.signaturesignature");
    assert.equal(h["x-musemuse-client-ip"], "203.0.113.9");
    assert.deepEqual(seen[0].body, { data: { name: "Milk" } });
    assert.deepEqual(seen[2].body, { data: { name: "Oat milk" }, ifVersion: 1 });
    assert.deepEqual(seen[3].body, { scope: "shared", where: { bought: false }, limit: 10 });
  });

  test("a refusal is a CapError with the gateway's code and words; a missing item is null; a visitor read with no cookie asks nothing", async () => {
    seen.length = 0;
    answer = (req) =>
      req.method === "GET"
        ? { status: 404, body: { error: { code: "not_found", message: "There's no item with that id here." } } }
        : { status: 429, body: { error: { code: "quota_exceeded", message: "You've saved as many items here as one person can (200)." } } };
    const out = await run(`
import { CapError, data } from "./lib/platform/data.ts";
const signedOut = new Request("http://localhost/x");
const notes = data(signedOut).collection("notes", { scope: "visitor" });
const empty = await notes.query();
const none = await notes.get("a");
const shared = data(new Request("http://localhost/x", { headers: { cookie: "mm_vid=visitor_abcdefghijklmnop" } })).collection("groceries", { scope: "shared" });
const missing = await shared.get("zzz");
let refused = null;
try { await shared.create({ name: "x" }); } catch (err) { refused = err instanceof CapError ? { code: err.code, status: err.status, message: err.message } : String(err); }
let bad = null;
try { data(signedOut).collection("Bad Name"); } catch (err) { bad = err instanceof CapError ? err.code : String(err); }
console.log(JSON.stringify({ empty, none, missing, refused, bad }));
`);
    assert.deepEqual(out.empty, { items: [], next: null });
    assert.equal(out.none, null);
    assert.equal(out.missing, null);
    assert.deepEqual(out.refused, { code: "quota_exceeded", status: 429, message: "You've saved as many items here as one person can (200)." });
    assert.equal(out.bad, "invalid_arguments");
    assert.deepEqual(seen.map((s) => s.method), ["GET", "POST"], "the visitor calls with no cookie never reached the gateway");
  });

  test("currentUser reads the cookies for showing only, and signInHref stays on the site", async () => {
    const out = await run(`
import { currentUser, signInHref, userHeaders } from "./lib/platform/user.ts";
const h = (cookie: string) => new Request("http://localhost/", { headers: { cookie } });
console.log(JSON.stringify({
  ana: currentUser(h(${JSON.stringify(COOKIES)})),
  test: currentUser(h("mm_user=ut1.p.build1.testsubject.9999999999999.signaturesignature")),
  expired: currentUser(h("mm_user=us1.p.subject123.1000.signaturesignature")),
  junk: currentUser(h("mm_user=<script>")),
  none: currentUser(h("")),
  href: signInHref("/lists?x=1"),
  away: signInHref("//evil.example"),
  headers: userHeaders(h(${JSON.stringify(COOKIES)})),
}));
`);
    assert.deepEqual(out.ana, { id: "subject123", name: "Ana B" });
    assert.deepEqual(out.test, { id: "testsubject", name: "" });
    assert.equal(out.expired, null);
    assert.equal(out.junk, null);
    assert.equal(out.none, null);
    assert.equal(out.href, "/api/musemuse/user?returnTo=%2Flists%3Fx%3D1");
    assert.equal(out.away, "/api/musemuse/user?returnTo=%2F");
    assert.deepEqual(out.headers, { "x-musemuse-user": "us1.p.subject123.9999999999999.signaturesignature" });
  });

  test("the user route sends people to the platform's page, sets the session from a code, and signs in a build's made-up person", async () => {
    seen.length = 0;
    answer = (req) => {
      if (req.url.endsWith("/identity/user/link")) return { status: 200, body: { url: "https://platform.example/u/sign-in?product=lists&returnTo=%2Flists" } };
      if (req.url.endsWith("/identity/user")) return { status: 200, body: { session: "us1.p.subj_123.9999999999999.signaturesignature", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), user: { id: "subj_123", name: "Ana" } } };
      if (req.url.endsWith("/identity/user/test")) return { status: 200, body: { session: "ut1.p.b.subj_9.9999999999999.signaturesignature", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), user: { id: "subj_9", name: "Bo" }, simulated: true } };
      return { status: 404, body: {} };
    };
    const out = await run(`
const route = await import("./app/api/musemuse/user/route.ts");
const signOut = await import("./app/api/musemuse/user-sign-out/route.ts");
const go = await route.GET(new Request("http://localhost/api/musemuse/user?returnTo=/lists"));
const back = await route.GET(new Request("http://localhost/api/musemuse/user?code=uc1.x&returnTo=//evil.example"));
const test = await route.POST(new Request("http://localhost/api/musemuse/user", { method: "POST", body: JSON.stringify({ test: "Bo" }), headers: { "content-type": "application/json" } }));
const cross = await route.POST(new Request("http://localhost/api/musemuse/user", { method: "POST", body: JSON.stringify({ test: "Bo" }), headers: { "sec-fetch-site": "cross-site" } }));
const form = new FormData(); form.set("returnTo", "/lists");
const out = await signOut.POST(new Request("http://localhost/api/musemuse/user-sign-out", { method: "POST", body: form }));
const cookies = (r: Response) => r.headers.getSetCookie();
console.log(JSON.stringify({
  go: { status: go.status, location: go.headers.get("location") },
  back: { status: back.status, location: back.headers.get("location"), cookies: cookies(back) },
  test: { status: test.status, body: await test.json(), cookies: cookies(test) },
  cross: cross.status,
  out: { status: out.status, location: out.headers.get("location"), cookies: cookies(out) },
}));
`);
    assert.deepEqual(out.go, { status: 303, location: "https://platform.example/u/sign-in?product=lists&returnTo=%2Flists" });
    assert.equal(out.back.status, 303);
    assert.equal(out.back.location, "/", "a returnTo that leaves the site goes home");
    assert.match(out.back.cookies[0], /^mm_user=us1\.p\.subj_123\.9999999999999\.signaturesignature; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    assert.match(out.back.cookies[1], /^mm_user_name=Ana; /);
    assert.equal(out.test.status, 200);
    assert.deepEqual(out.test.body, { user: { id: "subj_9", name: "Bo" } });
    assert.match(out.test.cookies[0], /^mm_user=ut1\./);
    assert.equal(out.cross, 403);
    assert.equal(out.out.location, "/lists");
    assert.match(out.out.cookies[0], /^mm_user=; Path=\/; Max-Age=0/);
    assert.deepEqual(seen.map((s) => s.url), ["/api/gateway/identity/user/link", "/api/gateway/identity/user", "/api/gateway/identity/user/test"]);
    assert.deepEqual(seen[1].body, { code: "uc1.x" });
  });

  test("the owner route trades the code for the owner cookie", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { session: "os1.prod.subj.9999999999999.signaturesig", expiresAt: "x" } });
    const out = await run(`
const route = await import("./app/api/musemuse/owner/route.ts");
const res = await route.GET(new Request("http://localhost/api/musemuse/owner?code=oc1.abc"));
console.log(JSON.stringify({ status: res.status, location: res.headers.get("location"), cookie: res.headers.get("set-cookie") }));
`);
    assert.equal(out.status, 303);
    assert.equal(out.location, "/");
    assert.match(out.cookie, /^mm_owner=os1\.prod\.subj\.9999999999999\.signaturesig; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
    assert.equal(seen[0].url, "/api/gateway/identity/owner");
  });

  test("the product's tsc takes the overlay, SignIn and the test helpers", { timeout: 240_000 }, () => {
    cpSync(path.join(TEMPLATE, "app"), path.join(dir, "app"), { recursive: true, force: false, errorOnExist: false });
    cpSync(path.join(TEMPLATE, "tests"), path.join(dir, "tests"), { recursive: true, force: false, errorOnExist: false });
    cpSync(CORE, dir, { recursive: true });
    cpSync(DATA, dir, { recursive: true });
    for (const f of readdirSync(dir).filter((f) => f.startsWith("run-"))) rmSync(path.join(dir, f));
    for (const f of ["next-env.d.ts", "next.config.ts", "playwright.config.ts", "musemuse.json"]) if (existsSync(path.join(TEMPLATE, f))) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    writeFileSync(
      path.join(dir, "app/signin-sample.tsx"),
      `import { headers } from "next/headers";\nimport { SignIn } from "@/components/platform/SignIn";\nimport { currentUser } from "@/lib/platform/user";\nexport default async function Sample() {\n  return <SignIn user={currentUser(await headers())} returnTo="/" />;\n}\n`,
    );
    const tsc = path.join(modules, "typescript/bin/tsc");
    const res = spawnSync(process.execPath, [tsc, "--noEmit", "-p", "."], { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });
});

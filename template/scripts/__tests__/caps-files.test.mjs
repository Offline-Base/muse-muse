// The files cap's overlay (docs/CAPABILITIES.md, section 10): lib/platform/files.ts, search.ts and datasets.ts against a
// fake gateway, uploadFile's three steps, the product's files routes, Citation, the fixed checks
// (scripts/caps/files.mjs) and the overlay's paths. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-files.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = path.join(TEMPLATE, "caps/files/files");
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
  test("write no path another writes, but the owner route, which is data's, byte for byte", () => {
    const own = walk(FILES);
    const others = [
      ...walk(TEMPLATE).filter((f) => !f.startsWith("targets/") && !f.startsWith("caps/")),
      ...readdirSync(path.join(TEMPLATE, "targets")).flatMap((t) => walk(path.join(TEMPLATE, "targets", t, "files"))),
      ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "files").flatMap((c) => walk(path.join(TEMPLATE, "caps", c, "files"))),
    ];
    assert.deepEqual(own.filter((f) => others.includes(f)), ["app/api/musemuse/owner/route.ts"]);
    const route = "app/api/musemuse/owner/route.ts";
    assert.equal(readFileSync(path.join(FILES, route), "utf8"), readFileSync(path.join(DATA, route), "utf8"), "an exact copy, so either overlay writes the same bytes");
  });

  test("are all platform files", () => {
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/files/platform-files.json"), "utf8")).sort(), walk(FILES).sort());
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/files/deps.json"), "utf8")), { dependencies: {}, devDependencies: {} });
  });

  test("its routes are static segments beside the agent kit's catch-all, which has none of the same path", () => {
    assert.ok(existsSync(path.join(AGENT, "app/api/musemuse/[...path]/route.ts")));
    for (const f of walk(FILES).filter((f) => f.startsWith("app/api/"))) assert.ok(!walk(AGENT).includes(f), f);
  });

  test("the skill names every helper the build prompt names, the browser's types match the gateway's, and no em dash", () => {
    const skill = readFileSync(path.join(FILES, ".agents/skills/muse-files/SKILL.md"), "utf8");
    for (const name of ["uploadFile", "files(request)", "search(request)", "dataset(request", "Citation", "datasetCitation", "checkFiles", "openAsOwner", "file-upload", "file-search", "UploadError"]) assert.ok(skill.includes(name), name);
    for (const f of walk(FILES)) assert.ok(!readFileSync(path.join(FILES, f), "utf8").includes("—"), f);
    const browser = readFileSync(path.join(FILES, "lib/platform/files-browser.ts"), "utf8");
    const gateway = readFileSync(path.join(TEMPLATE, "../lib/caps/files/limits.ts"), "utf8");
    const listed = (text, start) => [...text.slice(text.indexOf(start)).split("]")[0].matchAll(/"([a-z]+\/[a-z0-9.+-]+)"/g)].map((m) => m[1]);
    assert.deepEqual(listed(browser, "KEEPABLE_TYPES"), listed(gateway, "FILE_CONTENT_TYPES"));
  });
});

describe("the fixed checks (scripts/caps/files.mjs)", () => {
  let checker;
  before(async () => {
    checker = await import(pathToFileURL(path.join(FILES, "scripts/caps/files.mjs")).href);
  });

  function root(manifest) {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-files-check-"));
    dirs.push(dir);
    if (manifest) writeFileSync(path.join(dir, "musemuse.json"), JSON.stringify(manifest));
    return dir;
  }
  const proof = { uploaded: 1, files: 1, indexed: 1, datasetReads: 1, "dataset:palmer-penguins": 1, "brief:scope:shared": 1, "brief:uploads:owner": 1, "brief:search": 1, "brief:dataset:palmer-penguins": 1 };
  const manifest = { caps: ["files"], files: { scope: "shared", uploads: "owner", search: true, datasets: ["palmer-penguins"] } };
  const record = {
    cap: "files",
    checks: [
      { id: "upload-listed", ok: true, detail: "listed" },
      { id: "search-cited", ok: true, detail: "found" },
      { id: "dataset-cited", ok: true, detail: "shown" },
    ],
  };

  test("pass when the manifest is the brief's and the gateway and the smoke test both saw each part", async () => {
    const out = await checker.check({ record, proof, root: root(manifest) });
    assert.deepEqual(out.map((c) => [c.id, c.ok]), [["manifest", true], ["uploaded", true], ["upload-listed", true], ["search-cited", true], ["dataset-cited", true]]);
  });

  test("fail a manifest that widens who uploads, drops search or adds a dataset, and say what each has", async () => {
    for (const files of [
      { ...manifest.files, uploads: "anyone" },
      { ...manifest.files, search: false },
      { ...manifest.files, datasets: ["palmer-penguins", "mnist"] },
      { ...manifest.files, scope: "visitor" },
    ]) {
      const out = await checker.check({ record, proof, root: root({ files }) });
      assert.equal(out[0].ok, false, JSON.stringify(files));
      assert.match(out[0].detail, /the brief has shared \(added by owner\), search on, datasets palmer-penguins/);
    }
    assert.equal((await checker.check({ record, proof, root: root({}) }))[0].detail, "musemuse.json has no files block");
  });

  test("fail with no gateway record, no upload this check, or a part the gateway didn't see", async () => {
    assert.equal((await checker.check({ record, proof: null, root: root(manifest) })).every((c) => c.id === "upload-listed" || !c.ok), true);
    const none = await checker.check({ record, proof: { ...proof, uploaded: 0, indexed: 0, "dataset:palmer-penguins": 0 }, root: root(manifest) });
    assert.deepEqual(none.filter((c) => !c.ok).map((c) => c.id), ["uploaded", "search-cited", "dataset-cited"]);
    const skipped = await checker.check({ record: { cap: "files", checks: [] }, proof, root: root(manifest) });
    assert.deepEqual(skipped.filter((c) => !c.ok).map((c) => c.id), ["upload-listed", "search-cited", "dataset-cited"]);
  });

  test("ask only for what the brief has: no search or dataset check without them", async () => {
    const plain = { uploaded: 1, "brief:scope:visitor": 1 };
    const out = await checker.check({ record: { cap: "files", checks: [record.checks[0]] }, proof: plain, root: root({ files: { scope: "visitor", search: false, datasets: [] } }) });
    assert.deepEqual(out.map((c) => [c.id, c.ok]), [["manifest", true], ["uploaded", true], ["upload-listed", true]]);
  });
});

describe("in a product with core and files", { skip: existsSync(modules) ? false : "needs template/node_modules" }, () => {
  let dir;
  let server;
  let base;
  const seen = [];
  let answer = () => ({ status: 200, body: {} });
  const csv = "species,island\nAdelie,Torgersen\n";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-files-product-"));
    dirs.push(dir);
    for (const f of ["tsconfig.json", "package.json"]) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    cpSync(path.join(TEMPLATE, "lib"), path.join(dir, "lib"), { recursive: true });
    cpSync(path.join(TEMPLATE, "components"), path.join(dir, "components"), { recursive: true });
    cpSync(CORE, dir, { recursive: true });
    cpSync(FILES, dir, { recursive: true });
    symlinkSync(modules, path.join(dir, "node_modules"));
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        let body = null;
        try {
          body = raw.length ? JSON.parse(raw.toString("utf8")) : null;
        } catch {
          body = raw.toString("utf8");
        }
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        const a = answer(req);
        if (a.raw !== undefined) {
          res.writeHead(a.status, { "content-type": a.type ?? "text/plain" });
          res.end(a.raw);
          return;
        }
        res.writeHead(a.status, { "content-type": "application/json" });
        res.end(JSON.stringify(a.body));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/api/gateway`;
  });
  after(() => server?.close());

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

  const COOKIES = "mm_vid=visitor_abcdefghijklmnop; mm_owner=os1.p.s.9999999999999.sig_sig_sig_sig";
  const ID = "0b9a3c2e-1d4f-4a6b-8c7d-9e0f1a2b3c4d";
  const stored = { id: ID, name: "notes.txt", contentType: "text/plain", bytes: 5, sha256: "x", scope: "shared", createdAt: "2026-11-01T00:00:00.000000Z", url: "https://g/files/x/content", expiresAt: "2026-11-01T01:00:00Z" };

  test("files(), search() and the routes send the token and who is asking, each to its path", async () => {
    seen.length = 0;
    answer = (req) => {
      if (req.url.startsWith("/api/gateway/files/ticket")) return { status: 201, body: { id: ID, upload: { url: "https://vercel.com/api/blob/?pathname=x", method: "PUT", headers: { "x-content-type": "text/plain" } }, expiresAt: "z" } };
      if (req.url.startsWith("/api/gateway/search/query")) return { status: 200, body: { hits: [{ source: { fileId: ID }, title: "notes.txt", snippet: "Herons nest", score: 0.1, citation: { source: { fileId: ID }, name: "notes.txt", offset: 4 } }] } };
      if (req.url.startsWith("/api/gateway/search/index")) return { status: 201, body: { indexed: true, chunks: 1 } };
      if (req.url.startsWith("/api/gateway/search/remove")) return { status: 200, body: { removed: true } };
      if (req.method === "DELETE") return { status: 200, body: { deleted: true } };
      if (req.url === "/api/gateway/files?scope=shared") return { status: 200, body: { items: [stored], next: null } };
      return { status: 200, body: stored };
    };
    const out = await run(`
import { files } from "./lib/platform/files.ts";
import { search } from "./lib/platform/search.ts";
const request = new Request("http://localhost/x", { headers: { cookie: ${JSON.stringify(COOKIES)}, "x-forwarded-for": "203.0.113.9" } });
const list = await files(request).list({ scope: "shared" });
const one = await files(request).get("${ID}");
const ticket = await files(request).ticket({ name: "notes.txt", contentType: "text/plain", bytes: 5, scope: "shared" });
const done = await files(request).done("${ID}");
const indexed = await search(request).index({ source: { fileId: "${ID}" }, text: "Herons nest" });
const hits = await search(request).query("heron");
const removed = await search(request).remove({ fileId: "${ID}" });
const gone = await files(request).delete("${ID}");
let bad = null;
try { await files(request).get("not-an-id"); } catch (e) { bad = e.code; }
console.log(JSON.stringify({ list, one, ticket, done, indexed, hits, removed, gone, bad }));
`);
    assert.equal(out.list.items.length, 1);
    assert.equal(out.one.id, ID);
    assert.equal(out.ticket.upload.method, "PUT");
    assert.equal(out.hits[0].citation.offset, 4);
    assert.equal(out.removed, true);
    assert.equal(out.gone, true);
    assert.equal(out.bad, "invalid_arguments");
    assert.deepEqual(
      seen.map((s) => `${s.method} ${s.url}`),
      [
        "GET /api/gateway/files?scope=shared",
        `GET /api/gateway/files/${ID}`,
        "POST /api/gateway/files/ticket",
        `POST /api/gateway/files/${ID}/done`,
        "POST /api/gateway/search/index",
        "POST /api/gateway/search/query",
        "POST /api/gateway/search/remove",
        `DELETE /api/gateway/files/${ID}`,
      ],
    );
    const h = seen[0].headers;
    assert.equal(h.authorization, "Bearer mm_build_sample_token_value");
    assert.equal(h["x-musemuse-visitor"], "visitor_abcdefghijklmnop");
    assert.equal(h["x-musemuse-owner"], "os1.p.s.9999999999999.sig_sig_sig_sig");
    assert.equal(h["x-musemuse-client-ip"], "203.0.113.9");
    assert.deepEqual(seen[2].body, { name: "notes.txt", contentType: "text/plain", bytes: 5, scope: "shared" });
    assert.deepEqual(seen[5].body, { q: "heron" });
  });

  test("a refusal is a FilesError with the gateway's code and words, and a missing file is null", async () => {
    answer = (req) => (req.url.includes("ticket") ? { status: 429, body: { error: { code: "quota_exceeded", message: "This product has stored as much as it can (500 MB)." } } } : { status: 404, body: { error: { code: "not_found", message: "none" } } });
    const out = await run(`
import { files, FilesError } from "./lib/platform/files.ts";
const missing = await files(null).get("${ID}");
let err = null;
try { await files(null).ticket({ name: "a.txt", contentType: "text/plain", bytes: 1 }); } catch (e) { err = { isFilesError: e instanceof FilesError, code: e.code, status: e.status, message: e.message }; }
console.log(JSON.stringify({ missing, err }));
`);
    assert.equal(out.missing, null);
    assert.deepEqual(out.err, { isFilesError: true, code: "quota_exceeded", status: 429, message: "This product has stored as much as it can (500 MB)." });
  });

  test("dataset() reads a vetted file through the gateway and refuses bytes that don't match their sha256", async () => {
    const sha = createHash("sha256").update(csv).digest("hex");
    const info = { id: "palmer-penguins", title: "Palmer penguins", why: "w", license: { spdx: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" }, source: { name: "s", url: "https://e" }, attribution: "a", files: [{ name: "penguins.csv", contentType: "text/csv", bytes: Buffer.byteLength(csv), sha256: sha, url: "x" }] };
    let body = csv;
    answer = (req) => (req.url === "/api/gateway/datasets" ? { status: 200, body: { datasets: [info] } } : { status: 200, raw: body, type: "text/csv" });
    const code = `
import { dataset } from "./lib/platform/datasets.ts";
import { datasetCitation } from "./components/platform/Citation.tsx";
const d = dataset(null, "palmer-penguins");
let text = null, err = null;
try { text = await d.text("penguins.csv"); } catch (e) { err = e.code; }
const cite = datasetCitation(await d.info());
console.log(JSON.stringify({ text, err, cite }));
`;
    const good = await run(code);
    assert.equal(good.text, csv);
    assert.deepEqual(good.cite, { source: { collection: "datasets", docId: "palmer-penguins" }, name: "Palmer penguins", offset: 0, license: "CC0-1.0", href: "https://creativecommons.org/publicdomain/zero/1.0/" });
    assert.ok(seen.some((s) => s.url === "/api/gateway/datasets/palmer-penguins/penguins.csv" && s.headers.authorization === "Bearer mm_build_sample_token_value"));
    body = csv.replace("Adelie", "Adelia");
    const bad = await run(code);
    assert.equal(bad.text, null);
    assert.equal(bad.err, "checksum");
  });

  test("every dataset() read reaches the gateway, so a later verify round's read is on its record", async () => {
    const sha = createHash("sha256").update(csv).digest("hex");
    const info = { id: "palmer-penguins", title: "Palmer penguins", why: "w", license: { spdx: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" }, source: { name: "s", url: "https://e" }, attribution: "a", files: [{ name: "penguins.csv", contentType: "text/csv", bytes: Buffer.byteLength(csv), sha256: sha, url: "x" }] };
    seen.length = 0;
    answer = (req) => (req.url === "/api/gateway/datasets" ? { status: 200, body: { datasets: [info] } } : { status: 200, raw: csv, type: "text/csv" });
    // Stands in for Next's patched fetch: a cache: "force-cache" request answers from its data cache once it has a copy.
    await run(`
const real = globalThis.fetch;
const cached = new Map();
globalThis.fetch = async (url, init = {}) => {
  if (init.cache === "force-cache" && cached.has(String(url))) return cached.get(String(url)).clone();
  const res = await real(url, init);
  if (init.cache === "force-cache") cached.set(String(url), res.clone());
  return res;
};
const { dataset } = await import("./lib/platform/datasets.ts");
const d = dataset(null, "palmer-penguins");
await d.text("penguins.csv");
await d.text("penguins.csv");
console.log(JSON.stringify({}));
`);
    assert.equal(seen.filter((s) => s.url === "/api/gateway/datasets/palmer-penguins/penguins.csv").length, 2);
  });

  test("uploadFile asks for a ticket, puts the bytes at its URL with its headers, then finishes, and refuses an unkept type", async () => {
    const out = await run(`
import { uploadFile, typeOf, UploadError } from "./lib/platform/files-browser.ts";
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method, headers: init.headers, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body instanceof Blob ? "blob:" + init.body.size : null });
  if (String(url) === "/api/musemuse/files") return Response.json({ id: "${ID}", upload: { url: "https://vercel.com/api/blob/?pathname=p", method: "PUT", headers: { "x-content-type": "text/plain", "x-vercel-blob-access": "public" } } }, { status: 201 });
  if (String(url).startsWith("https://vercel.com/")) return new Response("{}", { status: 200 });
  return Response.json(${JSON.stringify(stored)});
};
const file = new File(["hello"], "notes.md", { type: "" });
const kept = await uploadFile(file, { scope: "shared" });
let refused = null;
try { await uploadFile(new File(["<b>"], "page.html", { type: "text/html" })); } catch (e) { refused = e instanceof UploadError ? e.code : "other"; }
console.log(JSON.stringify({ kept, calls, refused, md: typeOf(file) }));
`);
    assert.equal(out.md, "text/markdown", "a blank type gets one from the name");
    assert.equal(out.refused, "invalid_arguments");
    assert.deepEqual(out.calls.map((c) => `${c.method} ${c.url}`), ["POST /api/musemuse/files", "PUT https://vercel.com/api/blob/?pathname=p", "POST /api/musemuse/files/done"]);
    assert.deepEqual(out.calls[0].body, { name: "notes.md", contentType: "text/markdown", bytes: 5, scope: "shared" });
    assert.deepEqual(out.calls[1].headers, { "x-content-type": "text/plain", "x-vercel-blob-access": "public" });
    assert.equal(out.calls[1].body, "blob:5");
    assert.deepEqual(out.calls[2].body, { id: ID, scope: "shared" });
    assert.equal(out.kept.id, ID);
  });

  test("the product's files routes pass a ticket, a page and a delete on, and answer a refusal in plain words", async () => {
    seen.length = 0;
    answer = (req) =>
      req.url.includes("ticket")
        ? { status: 201, body: { id: ID, upload: { url: "u", method: "PUT", headers: {} }, expiresAt: "z" } }
        : req.method === "DELETE"
          ? { status: 403, body: { error: { code: "sign_in_required", message: "Only the product's owner can delete shared files." } } }
          : { status: 200, body: { items: [], next: null } };
    const out = await run(`
import { GET, POST, DELETE } from "./app/api/musemuse/files/route.ts";
const req = (method, url, body) => new Request("http://localhost" + url, { method, headers: { "content-type": "application/json", cookie: ${JSON.stringify(COOKIES)} }, ...(body ? { body: JSON.stringify(body) } : {}) });
const t = await POST(req("POST", "/api/musemuse/files", { name: "a.txt", contentType: "text/plain", bytes: 3, scope: "shared" }));
const bad = await POST(req("POST", "/api/musemuse/files", { name: "a.txt" }));
const page = await GET(req("GET", "/api/musemuse/files?scope=shared"));
const del = await DELETE(req("DELETE", "/api/musemuse/files?id=${ID}&scope=shared"));
console.log(JSON.stringify({ t: [t.status, await t.json()], bad: [bad.status, await bad.json()], page: [page.status, await page.json()], del: [del.status, await del.json()] }));
`);
    assert.equal(out.t[0], 201);
    assert.equal(out.t[1].id, ID);
    assert.equal(out.bad[0], 400);
    assert.equal(out.page[0], 200);
    assert.deepEqual(out.del, [403, { error: "Only the product's owner can delete shared files.", code: "sign_in_required" }]);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ["POST /api/gateway/files/ticket", "GET /api/gateway/files?scope=shared", `DELETE /api/gateway/files/${ID}?scope=shared`]);
  });

  test("the product's tsc takes the overlay, Citation and the test helpers", { timeout: 240_000 }, () => {
    cpSync(path.join(TEMPLATE, "app"), path.join(dir, "app"), { recursive: true, force: false, errorOnExist: false });
    cpSync(path.join(TEMPLATE, "tests"), path.join(dir, "tests"), { recursive: true, force: false, errorOnExist: false });
    cpSync(CORE, dir, { recursive: true });
    cpSync(FILES, dir, { recursive: true });
    for (const f of readdirSync(dir).filter((f) => f.startsWith("run-"))) rmSync(path.join(dir, f));
    for (const f of ["next-env.d.ts", "next.config.ts", "playwright.config.ts", "musemuse.json"]) if (existsSync(path.join(TEMPLATE, f))) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    writeFileSync(
      path.join(dir, "app/citation-sample.tsx"),
      `import { Citation, datasetCitation } from "@/components/platform/Citation";\nexport default function Sample() {\n  return (<p><Citation citation={{ source: { fileId: "x" }, name: "notes.txt", offset: 12 }} /><Citation citation={datasetCitation({ id: "p", title: "P", license: { spdx: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" } })} /></p>);\n}\n`,
    );
    const tsc = path.join(modules, "typescript/bin/tsc");
    const res = spawnSync(process.execPath, [tsc, "--noEmit", "-p", "."], { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });
});

// verify's caps step (docs/CAPABILITIES.md, 2.8): scripts/caps-check.mjs from the core overlay, against a product's own
// record and the gateway's, with a pass, a failure, and no caps file. Also the overlay rules every cap overlay keeps.
// Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CAPS = path.join(TEMPLATE, "caps");
const CORE = path.join(CAPS, "core/files");
const { runCapsCheck } = await import(pathToFileURL(path.join(CORE, "scripts/caps-check.mjs")).href);

/** Runs a script without blocking this process, so a server in it can answer. */
function runNode(script, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A product folder with the core overlay's caps-check, a caps file, a checker and what its smoke test recorded. */
function product({ capsFile = { caps: ["data"], overlays: ["core", "data"] }, checker, record, env } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-caps-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "scripts/caps"), { recursive: true });
  copyFileSync(path.join(CORE, "scripts/caps-check.mjs"), path.join(dir, "scripts/caps-check.mjs"));
  if (capsFile) writeFileSync(path.join(dir, "musemuse.caps.json"), JSON.stringify(capsFile));
  if (checker) writeFileSync(path.join(dir, "scripts/caps/data.mjs"), checker);
  if (record) {
    mkdirSync(path.join(dir, "test-results/caps"), { recursive: true });
    writeFileSync(path.join(dir, "test-results/caps/data.json"), JSON.stringify(record));
  }
  if (env) writeFileSync(path.join(dir, ".env.local"), env);
  return dir;
}

/** A checker that passes only when the second browser saw the row and the gateway saw it written. */
const DATA_CHECKER = `export function check({ record, proof }) {
  const seen = record.checks.find((c) => c.id === "second-browser");
  return [
    { id: "second-browser", ok: seen?.ok === true, detail: seen?.detail ?? "not recorded" },
    { id: "gateway-rows", ok: (proof?.rows ?? 0) > 0, detail: proof ? proof.rows + " row(s) in the build namespace" : "the gateway's record couldn't be read" },
  ];
}
`;
const RECORD = { cap: "data", checks: [{ id: "second-browser", ok: true, detail: "Second browser, after a reload, saw the item" }] };

function proofFile(dir, caps) {
  const file = path.join(dir, "proof.json");
  writeFileSync(file, JSON.stringify({ buildId: "b1", namespace: "b:b1", caps }));
  return file;
}

describe("scripts/caps-check.mjs", () => {
  test("passes when the product's record and the gateway's agree", async () => {
    const dir = product({ checker: DATA_CHECKER, record: RECORD });
    const result = await runCapsCheck({ root: dir, proofFile: proofFile(dir, { data: { rows: 2 } }) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.caps.map((c) => c.checks.map((k) => [k.id, k.ok])), [[["second-browser", true], ["gateway-rows", true]]]);
  });

  test("fails when the gateway saw nothing, whatever the product's own record says", async () => {
    const dir = product({ checker: DATA_CHECKER, record: RECORD });
    const result = await runCapsCheck({ root: dir, proofFile: proofFile(dir, { data: { rows: 0 } }) });
    assert.equal(result.ok, false);
    assert.equal(result.caps[0].checks.find((k) => k.id === "gateway-rows").ok, false);
  });

  test("fails a cap with no checker, one whose smoke test recorded nothing, and a checker that throws", async () => {
    const none = product({ record: RECORD });
    assert.deepEqual((await runCapsCheck({ root: none })).caps[0].checks, [{ id: "checker", ok: false, detail: "scripts/caps/data.mjs is missing" }]);
    const quiet = product({ checker: DATA_CHECKER });
    assert.equal((await runCapsCheck({ root: quiet })).caps[0].checks[0].id, "recorded");
    const broken = product({ checker: "export function check() { throw new Error('boom'); }\n", record: RECORD });
    assert.match((await runCapsCheck({ root: broken })).caps[0].checks[0].detail, /failed: boom/);
  });

  test("fails without a caps file", async () => {
    const dir = product({ capsFile: null });
    const result = await runCapsCheck({ root: dir });
    assert.equal(result.ok, false);
    assert.equal(result.caps[0].checks[0].id, "caps-file");
  });

  test("never reads the gateway's address or token from the product's .env.local, which product code can edit", async () => {
    // The review's spoof: .env.local points GATEWAY_URL at a server that answers with made-up counts.
    let called = false;
    const server = http.createServer((_req, res) => {
      called = true;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ caps: { data: { rows: 42 } } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address();
      const dir = product({ checker: DATA_CHECKER, record: RECORD, env: `GATEWAY_URL=http://127.0.0.1:${port}\nPRODUCT_TOKEN=mm_build_sample\n` });
      const result = await runCapsCheck({ root: dir, capsDir: null });
      assert.equal(called, false, "the product's .env.local was used");
      assert.equal(result.ok, false);
      assert.equal(result.gateway.ok, false);
      assert.match(result.caps[0].checks.find((k) => k.id === "gateway-rows").detail, /The gateway's record couldn't be read/);
    } finally {
      server.close();
    }
  });
});

/**
 * A build sandbox's read-only overlays folder in a temp dir: active.json, the core copy of caps-check, the data
 * overlay's checker and the gateway record. The product folder next to it has its own, different copies.
 */
function platform({ gateway, checker = DATA_CHECKER }) {
  const caps = mkdtempSync(path.join(tmpdir(), "mm-capsdir-"));
  dirs.push(caps);
  mkdirSync(path.join(caps, "core/files/scripts"), { recursive: true });
  copyFileSync(path.join(CORE, "scripts/caps-check.mjs"), path.join(caps, "core/files/scripts/caps-check.mjs"));
  mkdirSync(path.join(caps, "data/files/scripts/caps"), { recursive: true });
  writeFileSync(path.join(caps, "data/files/scripts/caps/data.mjs"), checker);
  writeFileSync(path.join(caps, "active.json"), JSON.stringify({ caps: ["data"], overlays: ["core", "data"] }));
  writeFileSync(path.join(caps, "gateway.json"), JSON.stringify(gateway));
  return { caps, script: path.join(caps, "core/files/scripts/caps-check.mjs") };
}

/** Runs node on a script with arguments, without blocking this process. */
function runArgs(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stdout += d));
    child.on("close", (status) => resolve({ status, stdout }));
  });
}

describe("the caps check in a build sandbox (its read-only copy)", () => {
  test("asks the gateway in the platform's record for what it saw since verify started, with the platform's checker", async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ buildId: "b1", namespace: "b:b1", caps: { data: { rows: 4 } } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address();
      const { script } = platform({ gateway: { url: `http://127.0.0.1:${port}/api/gateway`, token: "mm_build_sample" } });
      // The product's own copies say something else: a checker that always passes and a caps file with no caps.
      const dir = product({ capsFile: { caps: [], overlays: [] }, checker: "export const check = () => [{ id: 'fake', ok: true }];\n", record: RECORD, env: "GATEWAY_URL=http://127.0.0.1:1\nPRODUCT_TOKEN=nope\n" });
      const since = "2026-10-31T17:50:00.000Z";
      const res = await runArgs([script, "--root", dir, "--since", since], dir);
      assert.equal(res.status, 0, res.stdout);
      assert.deepEqual(seen, [{ url: `/api/gateway/caps/proof?since=${encodeURIComponent(since)}`, auth: "Bearer mm_build_sample" }]);
      const last = JSON.parse(res.stdout.trim().split("\n").at(-1));
      assert.deepEqual(last.caps[0].checks.map((k) => k.id), ["second-browser", "gateway-rows"], "the platform's checker ran, not the product's");
      assert.ok(!res.stdout.includes("mm_build_sample"), "the token is never printed");
      assert.ok(existsSync(path.join(dir, "test-results/caps/summary.json")), "the summary goes in the product's folder");
      // A failing record fails the run.
      const failing = product({ record: { cap: "data", checks: [{ id: "second-browser", ok: false }] } });
      assert.equal((await runArgs([script, "--root", failing, "--since", since], failing)).status, 1);
    } finally {
      server.close();
    }
  });

  test("on a local run says why the gateway's record is missing instead of failing with no reason", async () => {
    const reason = "this is a local run, so the build machine can't reach the gateway. Test platform services with a public PLATFORM_URL";
    const { caps } = platform({ gateway: { url: null, token: null, reason } });
    const dir = product({ record: RECORD });
    const result = await runCapsCheck({ root: dir, capsDir: caps });
    assert.equal(result.ok, false);
    assert.deepEqual(result.gateway, { ok: false, problem: reason });
    const gateway = result.caps[0].checks.find((k) => k.id === "gateway-rows");
    assert.equal(gateway.ok, false);
    assert.ok(gateway.detail.endsWith(`The gateway's record couldn't be read: ${reason}`), gateway.detail);
    // A check that passed without the gateway's record stays passed.
    assert.equal(result.caps[0].checks.find((k) => k.id === "second-browser").ok, true);
  });

  test("verify runs the platform's copy by its CAPS_DIR path, with the product as --root and its own start as --since", () => {
    const verify = readFileSync(path.join(TEMPLATE, "scripts/verify.mjs"), "utf8");
    assert.match(verify, /const PLATFORM_CAPS_CHECK = "\/vercel\/musemuse\/caps\/core\/files\/scripts\/caps-check\.mjs";/);
    assert.match(verify, /existsSync\(PLATFORM_CAPS_CHECK\) \? PLATFORM_CAPS_CHECK :/);
    assert.match(verify, /\[script, "--root", ROOT, "--since", STARTED_AT\]/);
  });
});

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const filesOf = (root) => walk(root).map((f) => path.relative(root, f).split(path.sep).join("/"));
const SKIP = new Set(["node_modules", ".next", "test-results", "playwright-report", ".git", ".vercel", ".DS_Store", "__tests__"]);
const baseFiles = () =>
  filesOf(TEMPLATE).filter((f) => !f.startsWith("caps/") && !f.startsWith("targets/") && !f.split("/").some((p) => SKIP.has(p)) && !f.split("/").at(-1).startsWith(".env"));

describe("cap overlays (template/caps)", () => {
  const overlays = readdirSync(CAPS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

  test("each has deps.json with exact versions and platform-files.json naming files it ships", () => {
    assert.ok(overlays.includes("core"));
    for (const o of overlays) {
      const deps = JSON.parse(readFileSync(path.join(CAPS, o, "deps.json"), "utf8"));
      for (const field of ["dependencies", "devDependencies"]) {
        for (const [name, version] of Object.entries(deps[field] ?? {})) assert.match(version, /^\d+\.\d+\.\d+$/, `${o}: ${name}@${version} isn't exact`);
      }
      const shipped = filesOf(path.join(CAPS, o, "files"));
      for (const p of JSON.parse(readFileSync(path.join(CAPS, o, "platform-files.json"), "utf8"))) assert.ok(shipped.includes(p), `${o}: ${p} is listed but not shipped`);
    }
  });

  test("no overlay writes a path the base template, a target overlay or another cap overlay writes", () => {
    const base = new Set(baseFiles());
    const targets = new Set(walk(path.join(TEMPLATE, "targets")).flatMap((f) => {
      const rel = path.relative(path.join(TEMPLATE, "targets"), f).split(path.sep);
      return rel[1] === "files" ? [rel.slice(2).join("/")] : [];
    }));
    // The two allowed overlaps (docs/CAPABILITIES.md, 2.5), each checked byte for byte by its unit's test.
    const allowed = new Map([["core", new Set(["lib/platform/identity.ts"])], ["trust", new Set(["components/Footer.tsx"])]]);
    const seen = new Map();
    for (const o of overlays) {
      for (const f of filesOf(path.join(CAPS, o, "files"))) {
        if (allowed.get(o)?.has(f)) continue;
        assert.ok(!base.has(f), `${o} writes ${f}, which the base template has`);
        assert.ok(!targets.has(f), `${o} writes ${f}, which a target overlay writes`);
        assert.ok(!seen.has(f), `${o} and ${seen.get(f)} both write ${f}`);
        seen.set(f, o);
      }
    }
  });

  test("routes the platform owns are static segments under app/api/musemuse/, and helpers are platform files", () => {
    for (const o of overlays) {
      const platform = new Set(JSON.parse(readFileSync(path.join(CAPS, o, "platform-files.json"), "utf8")));
      for (const f of filesOf(path.join(CAPS, o, "files"))) {
        // Wave 3, unit 9: a dynamic segment may come last, under a static one (code's pyodide/[file], whose file names have
        // dots), since the static segment already keeps it apart from the agent kit's catch-all.
        if (f.startsWith("app/api/")) assert.match(f, /^app\/api\/musemuse\/[a-z0-9-]+(\/[a-z0-9-]+)*(\/\[[a-z]+\])?\/route\.ts$/, `${o}: ${f}`);
        if (/^(lib\/platform\/|tests\/caps\/|scripts\/caps)/.test(f)) assert.ok(platform.has(f), `${o}: ${f} must be in platform-files.json`);
      }
    }
  });
});

// The runtime cap's overlay (docs/CAPABILITIES.md, section 16): Python functions in api/py/, the local runner
// (scripts/py-local.mjs), the server helper (lib/platform/python.ts) and the fixed checks (scripts/caps/runtime.mjs).
// The Python parts need a Python 3 on this machine and are skipped without one. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-runtime.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OVERLAY = path.join(TEMPLATE, "caps/runtime");
const FILES = path.join(OVERLAY, "files");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name), base)) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}

const hasPythonBin = ["python3.14", "python3.13", "python3.12", "python3"].find((bin) => spawnSync(bin, ["-c", "import sys; assert sys.version_info >= (3, 9)"]).status === 0);
const hasPython = Boolean(hasPythonBin);
const needsPython = hasPython ? false : "needs a Python 3 on this machine";

/** A product folder: the overlay's files plus the given functions, with its own package cache. */
function product(functions = {}, requirements = null) {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-runtime-"));
  dirs.push(dir);
  cpSync(FILES, dir, { recursive: true });
  // The overlay pins the builder snapshot's Python for Vercel. Here, whatever Python this machine has runs it.
  rmSync(path.join(dir, ".python-version"));
  for (const [name, source] of Object.entries(functions)) writeFileSync(path.join(dir, "api/py", `${name}.py`), source);
  if (requirements !== null) writeFileSync(path.join(dir, "requirements.txt"), requirements);
  return dir;
}

const env = (dir) => ({ ...process.env, MUSEMUSE_PY_CACHE: path.join(dir, ".py-cache") });

const SUM = `import json
from http.server import BaseHTTPRequestHandler


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or b"null")
        print("a debug line, which must not reach the reply")
        if not isinstance(data, dict) or not isinstance(data.get("values"), list):
            body, status = json.dumps({"error": "Send a list of values."}).encode(), 400
        else:
            body, status = json.dumps({"total": sum(data["values"]), "items": [{"n": v} for v in data["values"]]}).encode(), 200
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
`;

function call(dir, name, input, extra = []) {
  return spawnSync(process.execPath, [path.join(dir, "scripts/py-local.mjs"), "call", name, ...extra], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: env(dir), cwd: dir });
}

describe("the overlay's files", () => {
  test("write no path the template, a target overlay or another cap overlay writes", () => {
    const own = walk(FILES);
    const others = [
      ...walk(TEMPLATE).filter((f) => !f.startsWith("targets/") && !f.startsWith("caps/")),
      ...readdirSync(path.join(TEMPLATE, "targets")).flatMap((t) => walk(path.join(TEMPLATE, "targets", t, "files"))),
      ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "runtime").flatMap((c) => walk(path.join(TEMPLATE, "caps", c, "files"))),
    ];
    const taken = new Set(others);
    assert.deepEqual(own.filter((f) => taken.has(f)), []);
  });

  test("list every helper, checker, runner and skill as a platform file, and nothing that isn't there", () => {
    const platform = JSON.parse(readFileSync(path.join(OVERLAY, "platform-files.json"), "utf8"));
    for (const f of platform) assert.ok(existsSync(path.join(FILES, f)), f);
    for (const f of ["lib/platform/python.ts", "scripts/py-local.mjs", "scripts/caps/runtime.mjs", "tests/caps/runtime.ts", "api/py/musemuse_health.py", "vercel.json", ".agents/skills/muse-python/SKILL.md"]) {
      assert.ok(platform.includes(f), f);
    }
    // requirements.txt is the product's to fill in, so it isn't put back before each verify.
    assert.ok(!platform.includes("requirements.txt"));
    assert.deepEqual(JSON.parse(readFileSync(path.join(OVERLAY, "deps.json"), "utf8")), { dependencies: {}, devDependencies: {} });
  });

  test("vercel.json configures only the Python functions, which always match because of the health function", () => {
    const config = JSON.parse(readFileSync(path.join(FILES, "vercel.json"), "utf8"));
    assert.deepEqual(Object.keys(config).sort(), ["$schema", "functions"]);
    assert.deepEqual(Object.keys(config.functions), ["api/py/*.py"]);
    assert.equal(config.functions["api/py/*.py"].maxDuration, 10);
    assert.match(config.functions["api/py/*.py"].excludeFiles, /node_modules\/\*\*/);
    assert.ok(existsSync(path.join(FILES, "api/py/musemuse_health.py")));
  });
});

describe("the local runner", { skip: needsPython }, () => {
  test("runs a function with JSON on stdin and prints only its reply", () => {
    const dir = product({ sum_values: SUM });
    const res = call(dir, "sum_values", { values: [1, 2, 3.5] });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), { total: 6.5, items: [{ n: 1 }, { n: 2 }, { n: 3.5 }] });
  });

  test("answers the health function on GET", () => {
    const dir = product();
    const res = call(dir, "musemuse_health", "", ["--method", "GET", "--json-result"]);
    const out = JSON.parse(res.stdout);
    assert.equal(out.status, 200);
    const body = JSON.parse(Buffer.from(out.body, "base64").toString("utf8"));
    assert.equal(body.ok, true);
    assert.match(body.python, /^3\.\d+\.\d+$/);
  });

  test("reports a function's own 400, a crash, a missing file and a file without a handler, as JSON", () => {
    const dir = product({ sum_values: SUM, crash: "raise RuntimeError('boom at import')\n", nohandler: "x = 1\n" });
    const bad = JSON.parse(call(dir, "sum_values", { nope: true }, ["--json-result"]).stdout);
    assert.equal(bad.status, 400);
    assert.deepEqual(JSON.parse(Buffer.from(bad.body, "base64").toString("utf8")), { error: "Send a list of values." });
    assert.match(JSON.parse(call(dir, "crash", {}, ["--json-result"]).stdout).error, /RuntimeError: boom at import/);
    assert.match(JSON.parse(call(dir, "nohandler", {}, ["--json-result"]).stdout).error, /class handler\(BaseHTTPRequestHandler\)/);
    const missing = JSON.parse(call(dir, "missing", {}, ["--json-result"]).stdout);
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(call(dir, "Bad-Name", {}, ["--json-result"]).stdout).status, 404);
  });

  test("gives a function none of the server's settings, so it can't read a token", () => {
    const dir = product({ envdump: SUM.replace('body, status = json.dumps({"total"', 'import os\n            body, status = json.dumps({"keys": sorted(k for k in os.environ if k in ("PRODUCT_TOKEN", "GATEWAY_URL", "MODEL_API_KEY")), "total"') });
    const res = spawnSync(process.execPath, [path.join(dir, "scripts/py-local.mjs"), "call", "envdump"], {
      input: JSON.stringify({ values: [1] }),
      encoding: "utf8",
      cwd: dir,
      env: { ...env(dir), PRODUCT_TOKEN: "mm_live_secret", GATEWAY_URL: "https://platform.example/api/gateway", MODEL_API_KEY: "secret" },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout).keys, []);
  });

  test("stops a function that runs too long", async () => {
    const dir = product({ slow: "import time\nfrom http.server import BaseHTTPRequestHandler\n\nclass handler(BaseHTTPRequestHandler):\n    def do_POST(self):\n        time.sleep(30)\n" });
    const py = await import(pathToFileURL(path.join(dir, "scripts/py-local.mjs")).href);
    await assert.rejects(py.runFunction({ root: dir, name: "slow", body: "{}", timeoutMs: 1500, env: env(dir) }), (err) => err.code === "timeout");
  });

  test("reads requirements.txt the way the checks need", async () => {
    const py = await import(pathToFileURL(path.join(FILES, "scripts/py-local.mjs")).href);
    const ok = product({}, "# a comment\nnumpy==2.3.4\npandas[performance]==2.3.3  # with extras\n\n");
    assert.deepEqual(py.readRequirements(ok).packages.map((p) => [p.name, p.version]), [["numpy", "2.3.4"], ["pandas", "2.3.3"]]);
    assert.equal(py.readRequirements(ok).ok, true);
    const bad = py.readRequirements(product({}, "numpy>=2\nFlask==3.1.0\n-r other.txt\ngit+https://example.com/x.git\n"));
    assert.equal(bad.ok, false);
    assert.equal(bad.problems.length, 4);
    assert.match(bad.problems.join("\n"), /Flask is a web framework/);
    assert.equal(py.readRequirements(product({}, "")).packages.length, 0);
  });
});

describe("the fixed checks", { skip: needsPython }, () => {
  async function checker(dir) {
    return import(pathToFileURL(path.join(dir, "scripts/caps/runtime.mjs")).href);
  }
  function logCall(dir, entry) {
    mkdirSync(path.join(dir, "test-results/caps"), { recursive: true });
    writeFileSync(path.join(dir, "test-results/caps/runtime-calls.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a" });
  }
  const record = { cap: "runtime", checks: [{ id: "python-action", ok: true, detail: "sum answered through the Python function sum_values" }] };
  const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

  test("pass when the smoke test ran an action through Python and the platform gets the same shape again", async () => {
    const dir = product({ sum_values: SUM });
    logCall(dir, { name: "sum_values", input: { values: [1, 2] }, output: { total: 3, items: [{ n: 1 }, { n: 2 }] } });
    const checks = await (await checker(dir)).check({ record, root: dir, env: env(dir) });
    assert.deepEqual(checks.map((c) => c.id), ["python", "requirements", "functions", "health", "python-action", "rerun"]);
    for (const c of checks) assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
  });

  test("fail without the smoke test's record, without a noted call, or with a reply of another shape", async () => {
    const dir = product({ sum_values: SUM });
    let checks = byId(await (await checker(dir)).check({ record: null, root: dir, env: env(dir) }));
    assert.equal(checks["python-action"].ok, false);
    assert.equal(checks.rerun.ok, false);
    assert.match(checks.rerun.detail, /no Python call was noted/);
    logCall(dir, { name: "sum_values", input: { values: [1] }, output: { total: 1, items: [], extra: "faked" } });
    checks = byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) }));
    assert.equal(checks.rerun.ok, false);
    assert.match(checks.rerun.detail, /another shape/);
  });

  test("fail a function that doesn't load, a product with only the health function, and an unpinned package", async () => {
    let dir = product({ sum_values: SUM, broken: "import nothing_called_this\n" });
    assert.equal(byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) })).functions.ok, false);
    dir = product();
    assert.match(byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) })).functions.detail, /no Python function/);
    dir = product({ sum_values: SUM }, "numpy\n");
    assert.equal(byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) })).requirements.ok, false);
  });

  test("fail when the build's Python isn't the one .python-version gives Vercel", async () => {
    const dir = product({ sum_values: SUM });
    writeFileSync(path.join(dir, ".python-version"), "3.9\n");
    const python = byId(await (await checker(dir)).check({ record, root: dir, env: { ...env(dir), MUSEMUSE_PYTHON_BIN: hasPythonBin } }));
    assert.equal(python.python.ok, python.python.detail.startsWith("Python 3.9"), python.python.detail);
    if (!python.python.ok) assert.match(python.python.detail, /but \.python-version gives Vercel 3\.9$/);
    assert.equal(readFileSync(path.join(FILES, ".python-version"), "utf8"), "3.14\n", "the builder snapshot's Python (probe, Oct 31)");
  });

  test("compare shapes, not values", async () => {
    const { shapeOf } = await import(pathToFileURL(path.join(FILES, "scripts/caps/runtime.mjs")).href);
    assert.deepEqual(shapeOf({ b: [1, 2], a: "x", c: null }), { a: "string", b: ["number"], c: "null" });
    assert.deepEqual(shapeOf([]), []);
  });
});

describe("callPython", { skip: needsPython }, () => {
  const tsx = fileURLToPath(import.meta.resolve("tsx/esm"));
  function run(dir, script, extraEnv) {
    const file = path.join(dir, "call.mts");
    writeFileSync(file, script);
    return spawnSync(process.execPath, ["--import", tsx, file], { cwd: dir, encoding: "utf8", env: { ...env(dir), ...extraEnv } });
  }
  const SCRIPT = `import { CapError, callPython } from "./lib/platform/python.ts";
const out: Record<string, unknown> = {};
out.sum = await callPython(new Request("http://localhost:3100/api/actions/sum"), "sum_values", { values: [2, 3] });
try { await callPython(new Request("http://localhost:3100/"), "sum_values", { nope: 1 }); } catch (e) { out.bad = e instanceof CapError ? [e.code, e.status, e.message] : String(e); }
try { await callPython(new Request("http://localhost:3100/"), "../x", {}); } catch (e) { out.name = e instanceof CapError ? e.code : String(e); }
console.log(JSON.stringify(out));
`;

  test("runs the function on this machine in a build, and notes each call for the checks", () => {
    const dir = product({ sum_values: SUM });
    const res = run(dir, SCRIPT, { MUSEMUSE_PYTHON: "local", VERCEL: "" });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.trim().split("\n").at(-1));
    assert.deepEqual(out.sum, { total: 5, items: [{ n: 2 }, { n: 3 }] });
    assert.deepEqual(out.bad, ["python_failed", 400, "Send a list of values."]);
    assert.equal(out.name, "unknown_function");
    const log = readFileSync(path.join(dir, "test-results/caps/runtime-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log.length, 1, "only calls that answered are noted");
    assert.deepEqual([log[0].name, log[0].input, log[0].output], ["sum_values", { values: [2, 3] }, { total: 5, items: [{ n: 2 }, { n: 3 }] }]);
  });

  test("calls an address over HTTP when MUSEMUSE_PYTHON_URL is set, and notes nothing outside a build", async () => {
    const dir = product({ sum_values: SUM });
    const py = await import(pathToFileURL(path.join(dir, "scripts/py-local.mjs")).href);
    const server = await py.serve(dir, { port: 0, env: env(dir) });
    try {
      const { port } = server.address();
      const file = path.join(dir, "call.mts");
      writeFileSync(file, SCRIPT);
      // Not spawnSync: this process's server has to answer while the script runs.
      const res = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["--import", tsx, file], { cwd: dir, env: { ...env(dir), MUSEMUSE_PYTHON: "", MUSEMUSE_PYTHON_URL: `http://127.0.0.1:${port}` } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c));
        child.stderr.on("data", (c) => (stderr += c));
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      });
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout.trim().split("\n").at(-1));
      assert.deepEqual(out.sum, { total: 5, items: [{ n: 2 }, { n: 3 }] });
      assert.deepEqual(out.bad, ["python_failed", 400, "Send a list of values."]);
      assert.ok(!existsSync(path.join(dir, "test-results/caps/runtime-calls.jsonl")));
    } finally {
      server.close();
    }
  });
});

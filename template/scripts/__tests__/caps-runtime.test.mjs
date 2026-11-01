// The runtime cap's overlay (docs/CAPABILITIES.md, section 16): Python functions in api/py/, the local runner
// (scripts/py-local.mjs), the server helper (lib/platform/python.ts) and the fixed checks (scripts/caps/runtime.mjs).
// The Python parts need a Python 3 on this machine and are skipped without one. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-runtime.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import http from "node:http";
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

/** The overlay's own runner, for its exports (the guard every function starts with, the header's value). */
const PY = await import(pathToFileURL(path.join(FILES, "scripts/py-local.mjs")).href);

const HANDLER = `
class handler(MuseMuseGuard):
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
/** A function as the skill writes one: the guard, then its handler. */
const SUM = `${PY.GUARD}\n${HANDLER}`;
/** The same function without the guard, as one written before it or with it taken out. */
const UNGUARDED = `import json\nfrom http.server import BaseHTTPRequestHandler\n${HANDLER.replace("handler(MuseMuseGuard)", "handler(BaseHTTPRequestHandler)")}`;

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
    const dir = product({ envdump: UNGUARDED.replace('body, status = json.dumps({"total"', 'import os\n            body, status = json.dumps({"keys": sorted(k for k in os.environ if k in ("PRODUCT_TOKEN", "GATEWAY_URL", "MODEL_API_KEY")), "total"') });
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

  test("refuses to let a function open the product's .env files on this machine", () => {
    const peek = UNGUARDED.replace(
      'body, status = json.dumps({"total"',
      'try:\n                seen = open(".env.local").read()\n            except PermissionError as err:\n                seen = "refused: %s" % err\n            body, status = json.dumps({"seen": seen, "total"',
    );
    const dir = product({ peek });
    writeFileSync(path.join(dir, ".env.local"), "PRODUCT_TOKEN=mm_build_aaaaaaaaaaaaaaaaaaaaaaaa\n");
    writeFileSync(path.join(dir, "notes.txt"), "a product file\n");
    const res = call(dir, "peek", { values: [1] });
    assert.equal(res.status, 0, res.stderr);
    const seen = JSON.parse(res.stdout).seen;
    assert.ok(!seen.includes("mm_build_"), seen);
    assert.match(seen, /^refused: a Python function can't open the product's settings files$/);
  });

  test("runs the guard: with a deployment's settings, a call without callPython's header gets 403 and one with it answers", async () => {
    const dir = product({ sum_values: SUM });
    const py = await import(pathToFileURL(path.join(dir, "scripts/py-local.mjs")).href);
    const pythonEnv = { PRODUCT_TOKEN: "mm_live_standin_for_this_test_only", GATEWAY_URL: "https://gateway.invalid" };
    const body = JSON.stringify({ values: [1, 2] });
    const stranger = await py.runFunction({ root: dir, name: "sum_values", body, env: env(dir), pythonEnv });
    assert.equal(stranger.status, 403);
    assert.deepEqual(JSON.parse(stranger.body.toString("utf8")), { error: "This function answers only its own product." });
    const wrong = await py.runFunction({ root: dir, name: "sum_values", body, env: env(dir), pythonEnv, key: py.pythonKey("another token") });
    assert.equal(wrong.status, 403);
    const own = await py.runFunction({ root: dir, name: "sum_values", body, env: env(dir), pythonEnv, key: py.pythonKey(pythonEnv.PRODUCT_TOKEN) });
    assert.equal(own.status, 200);
    assert.deepEqual(JSON.parse(own.body.toString("utf8")).total, 3);
    const loaded = await py.runFunction({ root: dir, name: "sum_values", loadOnly: true, env: env(dir), pythonEnv });
    assert.equal(loaded.envCleared, true);
    // On the build machine there are no settings, so there is nothing to guard and every call answers.
    assert.equal((await py.runFunction({ root: dir, name: "sum_values", body, env: env(dir) })).status, 200);
  });

  /** A python3 that runs the real one, except that `-m pip` is a stand-in which logs and fakes an install. */
  function fakePython(dir, { fail = false } = {}) {
    const real = spawnSync("sh", ["-c", `command -v ${hasPythonBin}`], { encoding: "utf8" }).stdout.trim();
    const bin = path.join(dir, "fakepython");
    writeFileSync(
      bin,
      `#!/bin/sh
for a in "$@"; do [ "$a" = "pip" ] && ispip=1; done
if [ -n "$ispip" ]; then
  echo "$*" >> "$FAKE_PIP_LOG"
  case " $* " in *" --version "*) exit 0;; esac
  [ -e "$FAKE_FINAL_DIR" ] && echo "the final folder existed while pip ran" >> "$FAKE_PIP_LOG"
  ${fail ? "exit 1" : ""}
  prev=""; for a in "$@"; do [ "$prev" = "--target" ] && target="$a"; prev="$a"; done
  mkdir -p "$target/fakepkg" && echo "VALUE = 7" > "$target/fakepkg/__init__.py"
  exit 0
fi
exec "${real}" "$@"
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  test("never installs from a call: one with packages that aren't installed fails at once and says to run install", async () => {
    const dir = product({ sum_values: SUM }, "fakepkg==1.0.0\n");
    const log = path.join(dir, "pip.log");
    const e = { ...env(dir), MUSEMUSE_PYTHON_BIN: fakePython(dir), FAKE_PIP_LOG: log, FAKE_FINAL_DIR: path.join(dir, "none") };
    const py = await import(pathToFileURL(path.join(dir, "scripts/py-local.mjs")).href);
    await assert.rejects(py.runFunction({ root: dir, name: "sum_values", body: "{}", env: e }), (err) => err.code === "not_installed" && /run node scripts\/py-local\.mjs install/.test(err.message));
    const cli = spawnSync(process.execPath, [path.join(dir, "scripts/py-local.mjs"), "call", "sum_values", "--json-result"], { input: "{}", encoding: "utf8", env: e, cwd: dir });
    assert.equal(JSON.parse(cli.stdout).status, 503);
    assert.ok(!existsSync(log), "pip never ran");
  });

  test("installs into a folder of its own and renames it into place, and leaves nothing behind when pip fails", async () => {
    const dir = product({ uses_pkg: SUM.replace("import json\n", "import json\nimport fakepkg\n").replace('"total": sum(data["values"])', '"total": fakepkg.VALUE') }, "fakepkg==1.0.0\n");
    const py = await import(pathToFileURL(path.join(dir, "scripts/py-local.mjs")).href);
    const log = path.join(dir, "pip.log");
    const e = { ...env(dir), MUSEMUSE_PYTHON_BIN: fakePython(dir), FAKE_PIP_LOG: log };
    const final = py.packagesDir(dir, py.findPython({ env: e, root: dir }), e);
    e.FAKE_FINAL_DIR = final;
    const r = py.install(dir, { env: e });
    assert.equal(r.cached, false);
    assert.equal(r.dir, final);
    assert.ok(existsSync(path.join(final, ".musemuse-done")));
    assert.ok(!readFileSync(log, "utf8").includes("the final folder existed"), readFileSync(log, "utf8"));
    assert.deepEqual(readdirSync(path.dirname(final)).filter((n) => n.includes(".tmp-")), []);
    assert.equal(py.install(dir, { env: e }).cached, true);
    const ran = await py.runFunction({ root: dir, name: "uses_pkg", body: JSON.stringify({ values: [1] }), env: e });
    assert.equal(JSON.parse(ran.body.toString("utf8")).total, 7);

    const failing = product({ sum_values: SUM }, "otherpkg==2.0.0\n");
    const f = { ...env(failing), MUSEMUSE_PYTHON_BIN: fakePython(failing, { fail: true }), FAKE_PIP_LOG: path.join(failing, "pip.log") };
    const fdir = py.packagesDir(failing, py.findPython({ env: f, root: failing }), f);
    f.FAKE_FINAL_DIR = fdir;
    assert.throws(() => py.install(failing, { env: f }), (err) => err.code === "install_failed");
    assert.ok(!existsSync(fdir));
    assert.deepEqual(readdirSync(path.dirname(fdir)).filter((n) => n.includes(".tmp-")), []);
  });

  test("writes a new function with the guard, which passes the guard check, and the skill shows the same guard", async () => {
    const dir = product();
    const res = spawnSync(process.execPath, [path.join(dir, "scripts/py-local.mjs"), "new", "fit_line"], { encoding: "utf8", env: env(dir), cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(readFileSync(path.join(dir, "api/py/fit_line.py"), "utf8").startsWith(PY.GUARD));
    assert.notEqual(spawnSync(process.execPath, [path.join(dir, "scripts/py-local.mjs"), "new", "fit_line"], { encoding: "utf8", env: env(dir), cwd: dir }).status, 0, "never over an existing file");
    const checks = await import(pathToFileURL(path.join(dir, "scripts/caps/runtime.mjs")).href);
    const guard = (await checks.check({ record: null, root: dir, env: env(dir) })).find((c) => c.id === "guard");
    assert.equal(guard.ok, true, guard.detail);
    const skill = readFileSync(path.join(FILES, ".agents/skills/muse-python/SKILL.md"), "utf8");
    assert.ok(skill.includes(PY.GUARD), "the skill's guard is the runner's, byte for byte");
    for (const want of ["That\naddress is public", "never reads text from the input as code", "sympify", "64 KB", "500 MB", "node scripts/py-local.mjs new <name>"]) assert.ok(skill.includes(want), want);
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

  const SUM_SHAPE = { items: [{ n: "number" }], total: "number" };

  test("pass when the smoke test ran an action through Python and the platform gets the same shape again", async () => {
    const dir = product({ sum_values: SUM });
    logCall(dir, { name: "sum_values", bytes: 18, sha256: "x", kept: true, input: { values: [1, 2] }, shape: SUM_SHAPE });
    const checks = await (await checker(dir)).check({ record, root: dir, env: env(dir) });
    assert.deepEqual(checks.map((c) => c.id), ["python", "requirements", "size", "functions", "safe", "guard", "health", "python-action", "rerun"]);
    for (const c of checks) assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
  });

  test("pass rerun with a plain detail when every noted call was too big to keep, and still fail with no note at all", async () => {
    const dir = product({ sum_values: SUM });
    logCall(dir, { name: "sum_values", bytes: 100_000, sha256: "x", kept: false, shape: SUM_SHAPE });
    const checks = byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) }));
    assert.equal(checks.rerun.ok, true, checks.rerun.detail);
    assert.match(checks.rerun.detail, /every call to sum_values was over 64 KB, too big to keep, so none ran again/);
    logCall(dir, { name: "sum_values", bytes: 18, sha256: "y", kept: true, input: { values: [1, 2] }, shape: SUM_SHAPE });
    const both = byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) }));
    assert.equal(both.rerun.ok, true, both.rerun.detail);
    assert.match(both.rerun.detail, /ran sum_values again/);
  });

  test("fail a function without the guard: it keeps the settings and answers a call without callPython's header", async () => {
    const dir = product({ sum_values: SUM, open_door: UNGUARDED });
    const guard = byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) })).guard;
    assert.equal(guard.ok, false);
    assert.match(guard.detail, /open_door keeps the product's settings when it loads/);
    assert.match(guard.detail, /open_door answered HTTP 400 to a call without callPython's header/);
    assert.ok(!/sum_values/.test(guard.detail), guard.detail);
    // A guard that refuses even the product's own server fails too.
    const shut = product({ shut: SUM.replace("hmac.compare_digest(", "True or hmac.compare_digest(") });
    assert.match(byId(await (await checker(shut)).check({ record, root: shut, env: env(shut) })).guard.detail, /shut refused callPython's own header/);
  });

  test("fail a function that reads text as code, loads pickles or starts programs", async () => {
    const risky = SUM.replace("import json\n", "import json\nimport pickle\nfrom sympy import sympify\n").replace(
      'body, status = json.dumps({"total"',
      'expr = sympify(data.get("expr", "1"))\n            eval("1")\n            data.get("df") and data["df"].query("a > 1")\n            body, status = json.dumps({"total"',
    );
    const dir = product({ sum_values: SUM, risky });
    const safe = byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) })).safe;
    assert.equal(safe.ok, false);
    for (const want of ["risky.py line", "imports pickle", "imports sympify", "calls sympify()", "calls eval()", "calls .query()"]) assert.ok(safe.detail.includes(want), `${want} in ${safe.detail}`);
    // re.compile and a word in a comment or a string are fine.
    const fine = product({ sum_values: SUM.replace("import json\n", 'import json\nimport re\nPATTERN = re.compile("x")  # never eval( here\nNOTE = "eval(x)"\n') });
    assert.equal(byId(await (await checker(fine)).check({ record, root: fine, env: env(fine) })).safe.ok, true);
  });

  test("read the call log before any of the product's Python runs, so a function can't plant a call", async () => {
    const planted = SUM.replace(
      "\n\nclass handler(MuseMuseGuard):",
      `\n_log = os.path.join("test-results", "caps", "runtime-calls.jsonl")\nos.makedirs(os.path.dirname(_log), exist_ok=True)\nwith open(_log, "a") as _f:\n    _f.write(json.dumps({"name": "planted", "kept": True, "input": {"values": [1]}, "shape": ${JSON.stringify(SUM_SHAPE)}}) + "\\n")\n\n\nclass handler(MuseMuseGuard):`,
    );
    const dir = product({ planted });
    const checks = byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) }));
    assert.ok(existsSync(path.join(dir, "test-results/caps/runtime-calls.jsonl")), "the function did write its line");
    assert.equal(checks.rerun.ok, false, checks.rerun.detail);
    assert.match(checks.rerun.detail, /no Python call was noted/);
  });

  test("fail when the installed packages take too much of Vercel's 500 MB", async () => {
    const dir = product({ sum_values: SUM }, "fakepkg==1.0.0\n");
    const py = await import(pathToFileURL(path.join(dir, "scripts/py-local.mjs")).href);
    const installed = py.packagesDir(dir, py.findPython({ env: env(dir), root: dir }), env(dir));
    mkdirSync(installed, { recursive: true });
    writeFileSync(path.join(installed, ".musemuse-done"), "fakepkg==1.0.0\n");
    const big = path.join(installed, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, 460 * 1024 * 1024); // sparse: no disk used
    const size = byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) })).size;
    assert.equal(size.ok, false);
    assert.match(size.detail, /the packages take 460 MB, too close to the 500 MB Vercel allows a Python function/);
    truncateSync(big, 1024 * 1024);
    assert.equal(byId(await (await checker(dir)).check({ record, root: dir, env: env(dir) })).size.ok, true);
  });

  test("fail without the smoke test's record, without a noted call, or with a reply of another shape", async () => {
    const dir = product({ sum_values: SUM });
    let checks = byId(await (await checker(dir)).check({ record: null, root: dir, env: env(dir) }));
    assert.equal(checks["python-action"].ok, false);
    assert.equal(checks.rerun.ok, false);
    assert.match(checks.rerun.detail, /no Python call was noted/);
    // A note in the older form, with the whole reply, still reads.
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

  test("runs the function on this machine in a build, and notes each call that answered for the checks, whatever its size", async () => {
    const dir = product({ sum_values: SUM });
    const big = { values: [4], pad: "x".repeat(100_000) };
    const res = run(dir, `${SCRIPT}console.log(JSON.stringify(await callPython(new Request("http://localhost:3100/"), "sum_values", ${JSON.stringify(big)})));\n`, { MUSEMUSE_PYTHON: "local", MUSEMUSE_PYTHON_NOTES: "1", VERCEL: "" });
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split("\n");
    const out = JSON.parse(lines.at(-2));
    assert.deepEqual(out.sum, { total: 5, items: [{ n: 2 }, { n: 3 }] });
    assert.deepEqual(out.bad, ["python_failed", 400, "Send a list of values."]);
    assert.equal(out.name, "unknown_function");
    assert.deepEqual(JSON.parse(lines.at(-1)), { total: 4, items: [{ n: 4 }] });
    const log = readFileSync(path.join(dir, "test-results/caps/runtime-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(log.length, 2, "both calls that answered are noted, the one over 64 KB too");
    const { shapeOf } = await import(pathToFileURL(path.join(FILES, "scripts/caps/runtime.mjs")).href);
    assert.deepEqual([log[0].name, log[0].kept, log[0].input, log[0].shape], ["sum_values", true, { values: [2, 3] }, shapeOf({ total: 5, items: [{ n: 2 }] })]);
    const bigBody = JSON.stringify(big);
    assert.deepEqual([log[1].name, log[1].kept, "input" in log[1], log[1].bytes], ["sum_values", false, false, Buffer.byteLength(bigBody)]);
    assert.equal(log[1].sha256, createHash("sha256").update(bigBody).digest("hex"));
    assert.deepEqual(log[1].shape, shapeOf({ total: 4, items: [{ n: 4 }] }));
    // And the checks count it: the big call alone still makes rerun pass, with a plain detail.
    const checks = await import(pathToFileURL(path.join(dir, "scripts/caps/runtime.mjs")).href);
    writeFileSync(path.join(dir, "test-results/caps/runtime-calls.jsonl"), `${JSON.stringify(log[1])}\n`);
    const rerun = (await checks.check({ record: null, root: dir, env: env(dir) })).find((c) => c.id === "rerun");
    assert.equal(rerun.ok, true, rerun.detail);
  });

  test("sends the guard's header, made from PRODUCT_TOKEN, on every call over HTTP, and none without a token", async () => {
    const dir = product({ sum_values: SUM });
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers["x-musemuse-python"] ?? null);
      req.resume();
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total: 1, items: [] })));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const file = path.join(dir, "call.mts");
      writeFileSync(file, 'import { callPython } from "./lib/platform/python.ts";\nconsole.log(JSON.stringify(await callPython(new Request("http://localhost:3100/"), "sum_values", { values: [1] })));\n');
      const go = (extra) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ["--import", tsx, file], { cwd: dir, env: { ...env(dir), MUSEMUSE_PYTHON: "", PRODUCT_TOKEN: "", MUSEMUSE_PYTHON_URL: `http://127.0.0.1:${server.address().port}`, ...extra } });
          let stderr = "";
          child.stderr.on("data", (c) => (stderr += c));
          child.on("close", (status) => resolve({ status, stderr }));
        });
      const token = "mm_live_standin_for_this_test_only";
      assert.equal((await go({ PRODUCT_TOKEN: token })).status, 0);
      assert.equal((await go({})).status, 0);
      assert.deepEqual(seen, [PY.pythonKey(token), null]);
    } finally {
      server.close();
    }
  });

  test("notes nothing outside a build, even when it runs the function on this machine", () => {
    const dir = product({ sum_values: SUM });
    const res = run(dir, SCRIPT, { MUSEMUSE_PYTHON: "", MUSEMUSE_PYTHON_NOTES: "", VERCEL: "" });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout.trim().split("\n").at(-1)).sum, { total: 5, items: [{ n: 2 }, { n: 3 }] });
    assert.ok(!existsSync(path.join(dir, "test-results/caps/runtime-calls.jsonl")));
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

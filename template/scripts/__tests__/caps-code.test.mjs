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

  test("the Pyodide route is a static segment beside the agent kit's catch-all, which has no file of the same path", () => {
    assert.ok(existsSync(path.join(AGENT, "app/api/musemuse/[...path]/route.ts")));
    assert.ok(!walk(AGENT).some((f) => f.startsWith("app/api/musemuse/pyodide/")));
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

  test("pass when the page showed each run and the gateway saw the server run and the page", async () => {
    const out = await checker.check({ record: passed, proof: all });
    assert.deepEqual(out.map((c) => [c.id, c.ok]), [["in-page", true], ["exec-output", true], ["browse-page", true]]);
    assert.match(out[1].detail, /1 finished run/);
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
    const out = await checker.check({ record: passed, proof: { ...all, execOk: 0, browse: 0 } });
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

describe("the Pyodide route", () => {
  test("serves only Pyodide's five files, from the product's own node_modules, with the right types", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-code-route-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "node_modules/pyodide"), { recursive: true });
    for (const f of ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json", "package.json"]) writeFileSync(path.join(dir, "node_modules/pyodide", f), `contents of ${f}`);
    writeFileSync(path.join(dir, "secret.txt"), "not served");
    cpSync(path.join(CODE, "app/api/musemuse/pyodide/[file]/route.ts"), path.join(dir, "route.ts"));
    const out = await runIn(
      dir,
      "run-route.mts",
      `
import { GET } from "./route.ts";
const ask = async (file) => { const r = await GET(new Request("http://localhost/api/musemuse/pyodide/" + file), { params: Promise.resolve({ file }) }); return [r.status, r.headers.get("content-type"), r.status === 200 ? await r.text() : null]; };
const out = [];
for (const f of ["pyodide.mjs", "pyodide.asm.wasm", "pyodide-lock.json", "package.json", "../../secret.txt", "..%2F..%2Fsecret.txt", "constructor", "__proto__"]) out.push([f, await ask(f)]);
console.log(JSON.stringify(out));
`,
    );
    const got = new Map(out);
    assert.deepEqual(got.get("pyodide.mjs"), [200, "text/javascript; charset=utf-8", "contents of pyodide.mjs"]);
    assert.deepEqual(got.get("pyodide.asm.wasm"), [200, "application/wasm", "contents of pyodide.asm.wasm"]);
    assert.equal(got.get("pyodide-lock.json")[0], 200);
    for (const f of ["package.json", "../../secret.txt", "..%2F..%2Fsecret.txt", "constructor", "__proto__"]) assert.equal(got.get(f)[0], 404, f);
  });
});

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

  test("the Pyodide worker hands stdin over once, keeps each run's names apart, and reports errors in stderr", async () => {
    // A stand-in pyodide.mjs beside the worker: it "prints" each line of code that starts with print: and reads stdin once.
    writeFileSync(
      path.join(dir, "pyodide.mjs"),
      `export async function loadPyodide() {
  let out = null, err = null, stdin = null, made = 0, destroyed = 0;
  return {
    setStdout: (o) => { out = o.batched; }, setStderr: (o) => { err = o.batched; }, setStdin: (o) => { stdin = o.stdin; },
    globals: { get: () => () => ({ n: ++made, destroy: () => { destroyed++; } }) },
    async runPythonAsync(code, { globals }) {
      if (code.includes("raise")) throw new Error("Traceback: ValueError: bad");
      for (const line of code.split("\\n")) if (line.startsWith("print:")) out(line.slice(6));
      if (code.includes("input")) { out("read " + JSON.stringify(stdin())); out("then " + JSON.stringify(stdin())); }
      out("globals " + globals.n + " destroyed " + destroyed);
    },
  };
}
`,
    );
    const out = await run(`
import { WORKER_SOURCE } from "./lib/platform/pyodide.ts";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const replies = [];
globalThis.self = { postMessage: (m) => replies.push(m) };
writeFileSync("worker.mjs", WORKER_SOURCE);
await import(pathToFileURL(process.cwd() + "/worker.mjs").href);
const base = pathToFileURL(process.cwd() + "/").href;
const send = (data) => self.onmessage({ data: { base, ...data } });
await send({ id: 1, kind: "load" });
await send({ id: 2, kind: "run", code: "print:hello\\nprint:world\\ninput", stdin: "3\\n4" });
await send({ id: 3, kind: "run", code: "print:again", stdin: "" });
await send({ id: 4, kind: "run", code: "raise", stdin: "" });
console.log(JSON.stringify(replies.map(({ ms, ...r }) => ({ ...r, timed: typeof ms === "number" || ms === undefined }))));
`);
    assert.deepEqual(out[0], { id: 1, ok: true, timed: true });
    assert.equal(out[1].ok, true);
    assert.equal(out[1].stdout, 'hello\nworld\nread "3\\n4"\nthen null\nglobals 1 destroyed 0\n');
    assert.equal(out[2].stdout, "again\nglobals 2 destroyed 1\n", "a fresh dict each run, the last one destroyed");
    assert.equal(out[3].ok, false);
    assert.match(out[3].stderr, /ValueError: bad/);
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

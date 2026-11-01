// The Muse Code kit (template/caps/musecode, docs/CAPABILITIES.md 15b): the overlay's paths, the fixed check, the client
// and the product's routes against a fake gateway, replay mode, and the run screen's first render. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-musecode.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OVERLAY = path.join(TEMPLATE, "caps/musecode");
const KIT = path.join(OVERLAY, "files");
const CODE = path.join(TEMPLATE, "caps/code/files");
const CORE = path.join(TEMPLATE, "caps/core/files");
const modules = path.join(TEMPLATE, "node_modules");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name), base)) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}

const DISCLOSURE = "Runs Muse Code in a private temporary workspace. It's deleted after 15 minutes, and your task is sent to Meta.";

describe("the overlay's files", () => {
  test("write no path the template, a target overlay or another cap overlay writes, and are all platform files", () => {
    const own = walk(KIT);
    const others = [
      ...walk(TEMPLATE).filter((f) => !f.startsWith("targets/") && !f.startsWith("caps/")),
      ...readdirSync(path.join(TEMPLATE, "targets")).flatMap((t) => walk(path.join(TEMPLATE, "targets", t, "files"))),
      ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "musecode").flatMap((c) => walk(path.join(TEMPLATE, "caps", c, "files"))),
    ];
    assert.deepEqual(own.filter((f) => others.includes(f)), []);
    assert.deepEqual(JSON.parse(readFileSync(path.join(OVERLAY, "platform-files.json"), "utf8")).sort(), own.sort());
    assert.deepEqual(JSON.parse(readFileSync(path.join(OVERLAY, "deps.json"), "utf8")), { dependencies: {}, devDependencies: {} });
  });

  test("say the disclosure word for word everywhere, as the platform's limits file does, with no em dash anywhere", () => {
    for (const f of ["lib/muse-code/client.ts", "components/platform/CodeRun.tsx", ".agents/skills/muse-code-in-product/SKILL.md"]) {
      assert.ok(readFileSync(path.join(KIT, f), "utf8").includes(DISCLOSURE), f);
    }
    assert.ok(readFileSync(path.resolve(TEMPLATE, "../lib/caps/code/musecode/limits.ts"), "utf8").includes(DISCLOSURE));
    for (const f of walk(KIT)) assert.ok(!readFileSync(path.join(KIT, f), "utf8").includes("—"), f);
  });

  test("the skill names everything the build prompt names", () => {
    const skill = readFileSync(path.join(KIT, ".agents/skills/muse-code-in-product/SKILL.md"), "utf8");
    for (const name of ["museCode.start", "museCode.events", "museCode.steer", "museCode.stop", "museCode.result", "museCode.link", "CodeRun", "MuseCodeDisclosure", "expectMuseCodeRun", "expectReplayRun", "sign_in_required", "replay: true", "worked", "120 seconds", "5 minutes and $0.50"]) {
      assert.ok(skill.includes(name), name);
    }
  });

  test("routes export only what Next takes from a route file, under static segments", () => {
    for (const f of walk(KIT).filter((x) => x.startsWith("app/api/"))) {
      assert.match(f, /^app\/api\/musemuse\/[a-z0-9-]+(\/[a-z0-9-]+)*\/route\.ts$/);
      const names = [...readFileSync(path.join(KIT, f), "utf8").matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
      for (const n of names) assert.ok(["GET", "POST", "runtime", "maxDuration"].includes(n), `${f} exports ${n}`);
    }
  });

  test("the sample run is made-up data that ends with files and an answer, and says it's a sample", () => {
    const run = JSON.parse(readFileSync(path.join(KIT, "lib/muse-code/sample-run.json"), "utf8"));
    assert.match(run.note, /made-up/);
    assert.equal(run.model, "muse-spark-1.3-contributor");
    assert.ok(run.result.worked && run.result.files.length && run.result.finalText);
    assert.deepEqual(run.steps.map((s) => s.at), [...run.steps.map((s) => s.at)].sort((a, b) => a - b));
    assert.ok(run.steps.at(-1).at < run.durationMs);
  });
});

describe("the helpers and the words", () => {
  const helper = () => readFileSync(path.join(KIT, "tests/caps/muse-code.ts"), "utf8");
  const skill = () => readFileSync(path.join(KIT, ".agents/skills/muse-code-in-product/SKILL.md"), "utf8");
  const client = () => readFileSync(path.join(KIT, "lib/muse-code/client.ts"), "utf8");

  test("expectMuseCodeRun gives the test the time it waits, and takes a replay only as the build's fallback", () => {
    const text = helper();
    assert.match(text, /test\.setTimeout\(/);
    assert.match(text, /import \{ expect, test, type Page \}/);
    assert.match(text, /data-musecode-replay/);
    assert.doesNotMatch(text, /toHaveAttribute\("data-musecode-replay", "false"\)/, "a fallback replay must not fail the check by itself");
  });

  test("says what really happens: when the workspace goes, how long the files and steps stay, and what the firewall allows", () => {
    for (const text of [skill(), client()]) assert.doesNotMatch(text, /deleted when the task ends|deletes it when the task ends/);
    const s = skill();
    assert.doesNotMatch(s, /no way out but/);
    assert.match(s, /24 hours/);
    assert.match(s, /about 18 minutes/);
    assert.match(s, /build_tasks_used|used, and one worked/);
    assert.ok(s.includes("Runs Muse Code in a private temporary workspace. It's deleted after 15 minutes, and your task is sent to Meta."), "the required line is word for word");
  });
});

describe("the fixed check", () => {
  const checker = () => import(pathToFileURL(path.join(CODE, "scripts/caps/code.mjs")).href);
  const record = { checks: [{ id: "muse-code-run", ok: true, detail: "A real Muse Code task ran and its files and final answer show" }] };

  test("passes only when the page showed a real run and the gateway saw one make files", async () => {
    const { check } = await checker();
    const one = async (rec, proof) => (await check({ record: rec, proof: { "brief:museCode": 1, ...proof } })).find((c) => c.id === "muse-code-run");
    assert.equal((await one(record, { museCode: 1, museCodeWorked: 1 })).ok, true);
    const noFiles = await one(record, { museCode: 1, museCodeWorked: 0 });
    assert.equal(noFiles.ok, false);
    assert.match(noFiles.detail, /without making files/);
    const noRun = await one(record, { museCode: 0, museCodeWorked: 0 });
    assert.match(noRun.detail, /no real Muse Code task/);
    assert.equal((await one({ checks: [] }, { museCode: 1, museCodeWorked: 1 })).ok, false, "a replay records nothing");
  });

  test("takes a run from earlier in the build, while the page replayed: the gateway's count decides", async () => {
    const { check } = await checker();
    const replayed = { checks: [{ id: "muse-code-run", ok: true, detail: "The build's real Muse Code tasks are used and one worked; this run replayed the recording" }] };
    const one = async (proof) => (await check({ record: replayed, proof: { "brief:museCode": 1, ...proof } })).find((c) => c.id === "muse-code-run");
    assert.equal((await one({ museCode: 2, museCodeWorked: 1 })).ok, true);
    assert.equal((await one({ museCode: 2, museCodeWorked: 0 })).ok, false, "a replay can't stand in for a real run that never worked");
    assert.match(readFileSync(path.join(CODE, "scripts/caps/code.mjs"), "utf8"), /in this build/);
  });

  test("asks for nothing when the brief has no Muse Code", async () => {
    const { check } = await checker();
    const out = await check({ record: { checks: [] }, proof: { "brief:quickjs": 1 } });
    assert.ok(!out.some((c) => c.id === "muse-code-run"));
  });
});

/** Runs TypeScript with tsx in `cwd`, and gives its last line as JSON. */
function runIn(cwd, code, env = {}) {
  const script = path.join(cwd, `run-${Math.random().toString(36).slice(2)}.mts`);
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

describe("in a product with core, code and the kit", { skip: existsSync(modules) ? false : "needs template/node_modules" }, () => {
  let dir;
  let server;
  let base;
  const seen = [];
  let answer = () => ({ status: 200, body: {} });
  const ID = "0190f0a0-0000-7000-8000-000000000001";
  const COOKIES = "mm_vid=visitor_abcdefghijklmnop; mm_owner=os1.p.s.9999999999999.sig_sig_sig_sig";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-musecode-product-"));
    dirs.push(dir);
    for (const f of ["tsconfig.json", "package.json"]) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    cpSync(path.join(TEMPLATE, "lib"), path.join(dir, "lib"), { recursive: true });
    cpSync(path.join(TEMPLATE, "tests"), path.join(dir, "tests"), { recursive: true });
    cpSync(CORE, dir, { recursive: true });
    cpSync(CODE, dir, { recursive: true });
    cpSync(KIT, dir, { recursive: true });
    mkdirSync(path.join(dir, "node_modules"));
    for (const name of readdirSync(modules)) symlinkSync(path.join(modules, name), path.join(dir, "node_modules", name));
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

  const run = (code, env = {}) => runIn(dir, code, { GATEWAY_URL: base, PRODUCT_TOKEN: "mm_build_sample_token_value", ...env });

  test("the client calls each route with the token and who is asking, never from a browser's own cookie alone", async () => {
    seen.length = 0;
    answer = (req) => ({ status: req.method === "POST" && req.url.endsWith("/sessions") ? 201 : 200, body: { id: ID, status: "running", events: [], next: -1, costUsd: 0.01, done: false, sent: true } });
    await run(`
import { museCode } from "./lib/muse-code/client.ts";
const request = new Request("http://localhost/x", { headers: { cookie: ${JSON.stringify(COOKIES)}, "x-forwarded-for": "203.0.113.9" } });
await museCode.start(request, { task: "Dedupe it.", files: [{ name: "a.csv", text: "1" }] });
await museCode.events(request, ${JSON.stringify(ID)}, 0);
await museCode.events(request, ${JSON.stringify(ID)});
await museCode.steer(request, ${JSON.stringify(ID)}, "Use semicolons.");
await museCode.stop(request, ${JSON.stringify(ID)});
await museCode.result(request, ${JSON.stringify(ID)});
console.log("{}");
`);
    assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [
      "POST /api/gateway/code/sessions",
      `GET /api/gateway/code/sessions/${ID}/events?after=0`,
      `GET /api/gateway/code/sessions/${ID}/events?after=-1`,
      `POST /api/gateway/code/sessions/${ID}/steer`,
      `POST /api/gateway/code/sessions/${ID}/stop`,
      `GET /api/gateway/code/sessions/${ID}/result`,
    ]);
    for (const s of seen) {
      assert.equal(s.headers.authorization, "Bearer mm_build_sample_token_value");
      assert.equal(s.headers["x-musemuse-owner"], "os1.p.s.9999999999999.sig_sig_sig_sig");
      assert.equal(s.headers["x-musemuse-client-ip"], "203.0.113.9");
    }
    assert.deepEqual(seen[0].body, { task: "Dedupe it.", files: [{ name: "a.csv", text: "1" }] });
    assert.deepEqual(seen[3].body, { text: "Use semicolons." });
  });

  test("a refusal is a CapError with the gateway's words; a bad id never reaches the gateway; link adds ?run=", async () => {
    seen.length = 0;
    answer = () => ({ status: 403, body: { error: { code: "sign_in_required", message: "Only the product's owner can run Muse Code tasks here." } } });
    const out = await run(`
import { CapError, museCode } from "./lib/muse-code/client.ts";
const caught = async (p) => { try { await p; return null; } catch (e) { return { isCapError: e instanceof CapError, code: e.code, status: e.status, message: e.message }; } };
console.log(JSON.stringify({
  refused: await caught(museCode.start(null, { task: "x" })),
  badId: await caught(museCode.events(null, "../../exec")),
  link: museCode.link("https://p.example/run?x=1", ${JSON.stringify(ID)}),
}));
`);
    assert.deepEqual(out.refused, { isCapError: true, code: "sign_in_required", status: 403, message: "Only the product's owner can run Muse Code tasks here." });
    assert.equal(out.badId.code, "invalid_arguments");
    assert.equal(seen.length, 1, "only the start reached the gateway");
    assert.equal(out.link, `https://p.example/run?x=1&run=${ID}`);
  });

  test("replay plays the recording without the gateway, only with MUSE_CODE_REPLAY_OK, and ends with files and an answer", async () => {
    seen.length = 0;
    const code = `
import { CapError, museCode } from "./lib/muse-code/client.ts";
import { replayEvents, replayResult, replayStart, SAMPLE_RUN } from "./lib/muse-code/replay.ts";
let refused = null;
try { await museCode.start(null, { task: "x", replay: true }); } catch (e) { refused = e instanceof CapError ? e.code : "other"; }
if (refused) { console.log(JSON.stringify({ refused })); process.exit(0); }
const started = await museCode.start(null, { task: "x", replay: true });
const t0 = Number(started.id.slice("replay_".length));
const early = replayEvents(started.id, -1, t0 + 1000);
const later = replayEvents(started.id, early.next, t0 + 5000);
const done = replayEvents(started.id, later.next, t0 + SAMPLE_RUN.durationMs);
console.log(JSON.stringify({ started, early, later, done, notYet: replayResult(started.id, t0 + 1000), result: replayResult(started.id, t0 + SAMPLE_RUN.durationMs), again: replayStart(5000000000000).id }));
`;
    assert.deepEqual(await run(code), { refused: "replay_off" });
    const out = await run(code, { MUSE_CODE_REPLAY_OK: "1" });
    assert.equal(seen.length, 0, "nothing reached the gateway");
    assert.equal(out.started.replay, true);
    assert.equal(out.early.status, "running");
    assert.deepEqual(out.early.events.map((e) => e.n), [0, 1]);
    assert.ok(out.later.events.length > 0 && out.later.events[0].n === out.early.next + 1, "picks up after the last step");
    assert.equal(out.done.status, "completed");
    assert.equal(out.done.worked, true);
    assert.ok(out.done.finalText);
    assert.equal(out.notYet.done, false);
    assert.equal(out.result.done, true);
    assert.ok(out.result.files.length > 0);
    assert.equal(out.result.zipUrl, null, "a replay has nothing to download");
    assert.equal(out.again, "replay_5000000000000");
  });

  test("the routes hold the token and pass on who is asking, and answer the gateway's refusals in plain words", async () => {
    seen.length = 0;
    answer = (req) => (req.url.includes("/events") ? { status: 200, body: { id: ID, status: "running", events: [{ n: 0, kind: "say", text: "hi" }], next: 0, costUsd: 0 } } : { status: 201, body: { id: ID, status: "running" } });
    const out = await run(`
import { GET, POST } from "./app/api/musemuse/muse-code/route.ts";
const headers = { cookie: ${JSON.stringify(COOKIES)}, "content-type": "application/json" };
const started = await POST(new Request("http://localhost/api/musemuse/muse-code", { method: "POST", headers, body: JSON.stringify({ task: "Dedupe it." }) }));
const empty = await POST(new Request("http://localhost/api/musemuse/muse-code", { method: "POST", headers, body: "{}" }));
const events = await GET(new Request("http://localhost/api/musemuse/muse-code?id=${ID}&after=-1", { headers }));
console.log(JSON.stringify({ started: [started.status, await started.json()], empty: [empty.status, (await empty.json()).error.code], events: [events.status, (await events.json()).events.length] }));
`);
    assert.equal(out.started[0], 201);
    assert.equal(out.started[1].id, ID);
    assert.ok(!JSON.stringify(out.started[1]).includes("mm_build_sample_token_value"), "the token stays on the server");
    assert.deepEqual(out.empty, [400, "invalid_arguments"]);
    assert.deepEqual(out.events, [200, 1]);
    assert.equal(seen[0].headers["x-musemuse-owner"], "os1.p.s.9999999999999.sig_sig_sig_sig");
  });

  test("steer, stop and result route through, and a replay's Stop needs no gateway", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { id: ID, status: "stopped", done: true, sent: true, files: [], costUsd: 0 } });
    const out = await run(`
import { POST as steer } from "./app/api/musemuse/muse-code/steer/route.ts";
import { POST as stop } from "./app/api/musemuse/muse-code/stop/route.ts";
import { GET as result } from "./app/api/musemuse/muse-code/result/route.ts";
const headers = { "content-type": "application/json" };
const post = (handler, body) => handler(new Request("http://localhost/x", { method: "POST", headers, body: JSON.stringify(body) }));
const a = await post(steer, { id: ${JSON.stringify(ID)}, text: "note" });
const b = await post(steer, { id: ${JSON.stringify(ID)} });
const c = await post(stop, { id: ${JSON.stringify(ID)} });
const d = await result(new Request("http://localhost/x?id=${ID}"));
const r = await post(stop, { id: "replay_1000000000000" });
console.log(JSON.stringify({ codes: [a.status, b.status, c.status, d.status], replay: await r.json() }));
`, { MUSE_CODE_REPLAY_OK: "1" });
    assert.deepEqual(out.codes, [200, 400, 200, 200]);
    assert.equal(out.replay.status, "stopped");
    assert.deepEqual(seen.map((s) => s.url.split("/").pop()), ["steer", "stop", "result"]);
  });

  test("the owner landing trades the code for the owner cookie, and a bad one lands on the page without it", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { session: "os1.p.s.9999999999999.sig_sig_sig_sig" } });
    const out = await run(`
import { GET } from "./app/api/musemuse/muse-code/owner/route.ts";
const ok = await GET(new Request("http://localhost/api/musemuse/muse-code/owner?code=abc"));
const none = await GET(new Request("http://localhost/api/musemuse/muse-code/owner"));
console.log(JSON.stringify({ ok: [ok.status, ok.headers.get("location"), ok.headers.get("set-cookie")], none: [none.status, none.headers.get("set-cookie")] }));
`);
    assert.equal(out.ok[0], 303);
    assert.equal(out.ok[1], "/");
    assert.match(out.ok[2], /^mm_owner=os1\./);
    assert.match(out.ok[2], /HttpOnly/);
    assert.deepEqual(out.none, [303, null]);
    assert.deepEqual(seen[0].body, { code: "abc" });
  });

  test("in a build whose real tasks are used and one worked, a start replays instead of failing the build; never on live", async () => {
    seen.length = 0;
    answer = () => ({ status: 429, body: { error: { code: "build_tasks_used", message: "This build's real Muse Code tasks are used, and one worked." } } });
    const code = `
import { CapError, museCode } from "./lib/muse-code/client.ts";
try { console.log(JSON.stringify(await museCode.start(null, { task: "x" }))); } catch (e) { console.log(JSON.stringify({ refused: e instanceof CapError ? e.code : "other" })); }
`;
    const out = await run(code, { MUSE_CODE_REPLAY_OK: "1" });
    assert.equal(out.replay, true);
    assert.match(out.id, /^replay_/);
    assert.equal(seen.length, 1, "it asked the gateway first");
    assert.deepEqual(await run(code), { refused: "build_tasks_used" }, "a live product never replays");
    answer = () => ({ status: 429, body: { error: { code: "rate_limited", message: "no" } } });
    assert.deepEqual(await run(code, { MUSE_CODE_REPLAY_OK: "1" }), { refused: "rate_limited" }, "with no real run that worked, it stays a refusal");
  });

  test("a first-time visitor gets a visitor id with a start the gateway took, sent on the same call", async () => {
    seen.length = 0;
    answer = () => ({ status: 201, body: { id: ID, status: "running" } });
    const code = (cookie) => `
import { POST } from "./app/api/musemuse/muse-code/route.ts";
const res = await POST(new Request("http://localhost/api/musemuse/muse-code", { method: "POST", headers: { "content-type": "application/json"${cookie ? `, cookie: ${JSON.stringify(cookie)}` : ""} }, body: JSON.stringify({ task: "x" }) }));
console.log(JSON.stringify({ status: res.status, cookie: res.headers.get("set-cookie") }));
`;
    const first = await run(code(""));
    assert.equal(first.status, 201);
    assert.match(first.cookie ?? "", /^mm_vid=[A-Za-z0-9_-]{16,64}; .*HttpOnly/);
    assert.equal(first.cookie.split(";")[0].split("=")[1], seen[0].headers["x-musemuse-visitor"], "the gateway heard the same id");
    assert.equal((await run(code(COOKIES))).cookie, null, "one who has an id keeps it");
    assert.equal((await run(code("mm_owner=os1.p.s.9999999999999.sig_sig_sig_sig"))).cookie, null, "the owner needs none");
    answer = () => ({ status: 403, body: { error: { code: "sign_in_required", message: "Only the owner." } } });
    assert.equal((await run(code(""))).cookie, null, "a refused start sets nothing");
  });

  test("the run screen renders its status, an empty step list and a Stop button, and the disclosure word for word", async () => {
    const out = await run(`
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeRun, MuseCodeDisclosure } from "./components/platform/CodeRun.tsx";
console.log(JSON.stringify({ run: renderToStaticMarkup(createElement(CodeRun, { runId: "x" })), line: renderToStaticMarkup(createElement(MuseCodeDisclosure)) }));
`);
    assert.match(out.run, /data-musecode="run"/);
    assert.match(out.run, /data-musecode-status="starting"/);
    assert.match(out.run, /data-musecode="stop"/);
    assert.match(out.run, /data-musecode="cost"/);
    assert.match(out.line, /deleted after 15 minutes, and your task is sent to Meta\./);
  });
});

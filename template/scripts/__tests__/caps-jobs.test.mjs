// The jobs cap's overlay (docs/CAPABILITIES.md, section 12): its paths, platform files and skill, the fixed checks
// (scripts/caps/jobs.mjs), jobHandler and the helpers against a fake gateway, and the product's tsc with core, data and
// jobs applied. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-jobs.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const JOBS = path.join(TEMPLATE, "caps/jobs/files");
const CORE = path.join(TEMPLATE, "caps/core/files");
const DATA = path.join(TEMPLATE, "caps/data/files");
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
    const own = walk(JOBS);
    const others = [
      ...walk(TEMPLATE).filter((f) => !f.startsWith("targets/") && !f.startsWith("caps/")),
      ...readdirSync(path.join(TEMPLATE, "targets")).flatMap((t) => walk(path.join(TEMPLATE, "targets", t, "files"))),
      ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "jobs").flatMap((c) => walk(path.join(TEMPLATE, "caps", c, "files"))),
    ];
    assert.deepEqual(own.filter((f) => others.includes(f)), []);
  });

  test("are all platform files, with no dependency of their own", () => {
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/jobs/platform-files.json"), "utf8")).sort(), walk(JOBS).sort());
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/jobs/deps.json"), "utf8")), { dependencies: {}, devDependencies: {} });
  });

  test("musemuse.schema.json takes a jobs block and a collection's jobWrites, and requires neither", () => {
    const schema = JSON.parse(readFileSync(path.join(TEMPLATE, "musemuse.schema.json"), "utf8"));
    assert.deepEqual(Object.keys(schema.properties.jobs.properties), ["schedules", "webhooks"]);
    assert.ok(!schema.required.includes("jobs"));
    const collection = schema.properties.data.properties.collections.items;
    assert.equal(collection.properties.jobWrites.type, "boolean");
    assert.ok(!collection.required.includes("jobWrites"));
  });

  test("the skill names every helper and every limit, and nothing has an em dash", () => {
    const skill = readFileSync(path.join(JOBS, ".agents/skills/muse-jobs/SKILL.md"), "utf8");
    for (const name of ["jobHandler", "checkpoint(", "notifyOwner", "enqueue(", "fireJob", "fireWebhook", "checkResultShown", "jobWrites", "run_limit", "sign_in_required", "switched_off", "64 KB", "10 ticks", "14 days", "15 minutes", "held"]) assert.ok(skill.includes(name), name);
    for (const f of walk(JOBS)) assert.ok(!readFileSync(path.join(JOBS, f), "utf8").includes("—"), f);
  });
});

describe("the fixed checks (scripts/caps/jobs.mjs)", () => {
  let checker;
  before(async () => {
    checker = await import(pathToFileURL(path.join(JOBS, "scripts/caps/jobs.mjs")).href);
  });
  const proof = { fired: 2, done: 1, resumed: 1, webhook_runs: 1, rows: 1, "brief:schedule:digest": 1, "brief:webhook:log": 1, "brief:result:digests": 1 };
  const manifest = { jobs: { schedules: [{ name: "digest", every: "1 day at 07:30" }], webhooks: [{ name: "log" }] }, data: { collections: [{ name: "digests", scope: "shared", jobWrites: true }, { name: "notes", scope: "shared" }] } };
  const record = { cap: "jobs", checks: [{ id: "job-fired", ok: true, detail: "ran" }, { id: "webhook-run", ok: true, detail: "hook" }, { id: "result-shown", ok: true, detail: "shown" }] };
  function root(m) {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-jobs-check-"));
    dirs.push(dir);
    if (m) writeFileSync(path.join(dir, "musemuse.json"), JSON.stringify(m));
    return dir;
  }
  const failed = async (over) => (await checker.check({ record, proof, root: root(manifest), ...over })).filter((c) => !c.ok).map((c) => c.id);

  test("pass when the gateway's record and the smoke test agree", async () => {
    assert.deepEqual(await failed({}), []);
    assert.deepEqual((await checker.check({ record, proof, root: root(manifest) })).map((c) => c.id), ["manifest", "job-ran", "job-wrote", "result-shown", "webhook-run"]);
  });

  test("the product's own record can't pass what the gateway didn't see", async () => {
    assert.deepEqual(await failed({ proof: { ...proof, done: 0 } }), ["job-ran"]);
    assert.deepEqual(await failed({ proof: { ...proof, rows: 0 } }), ["job-wrote"]);
    assert.deepEqual(await failed({ proof: { ...proof, webhook_runs: 0 } }), ["webhook-run"]);
    assert.deepEqual(await failed({ proof: null }), ["manifest", "job-ran", "job-wrote", "webhook-run"]);
  });

  test("the gateway's record can't pass what the smoke test didn't do", async () => {
    assert.deepEqual(await failed({ record: null }), ["job-ran", "result-shown", "webhook-run"]);
    assert.deepEqual(await failed({ record: { checks: [{ id: "job-fired", ok: false }, { id: "webhook-run", ok: true }, { id: "result-shown", ok: true }] } }), ["job-ran"]);
  });

  test("the manifest has to match the brief, jobWrites included", async () => {
    assert.deepEqual(await failed({ root: root(null) }), ["manifest"]);
    assert.deepEqual(await failed({ root: root({ ...manifest, jobs: { schedules: [{ name: "digest" }, { name: "extra" }], webhooks: [{ name: "log" }] } }) }), ["manifest"]);
    assert.deepEqual(await failed({ root: root({ ...manifest, data: { collections: [{ name: "digests", scope: "shared" }] } }) }), ["manifest"]);
  });

  test("a brief with no results or webhooks doesn't ask for them", async () => {
    const small = { done: 1, "brief:schedule:digest": 1 };
    const out = await checker.check({ record: { checks: [{ id: "job-fired", ok: true }] }, proof: small, root: root({ jobs: { schedules: [{ name: "digest", every: "1 hour" }], webhooks: [] } }) });
    assert.deepEqual(out.map((c) => [c.id, c.ok]), [["manifest", true], ["job-ran", true]]);
  });
});

describe("in a product with core, data and jobs", { skip: existsSync(modules) ? false : "needs template/node_modules" }, () => {
  let dir;
  let server;
  let base;
  const seen = [];
  let answer = () => ({ status: 200, body: {} });
  const TOKEN = "jr1.p.r.1.sig";

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-jobs-product-"));
    dirs.push(dir);
    for (const f of ["tsconfig.json", "package.json", "next-env.d.ts"]) if (existsSync(path.join(TEMPLATE, f))) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    for (const d of ["lib", "components", "app", "tests"]) cpSync(path.join(TEMPLATE, d), path.join(dir, d), { recursive: true });
    cpSync(CORE, dir, { recursive: true });
    cpSync(DATA, dir, { recursive: true });
    cpSync(JOBS, dir, { recursive: true });
    symlinkSync(modules, path.join(dir, "node_modules"));
    mkdirSync(path.join(dir, "app/api/jobs/digest"), { recursive: true });
    writeFileSync(
      path.join(dir, "app/api/jobs/digest/route.ts"),
      `import { checkpoint, jobHandler, notifyOwner } from "@/lib/platform/jobs";
import { metaClient } from "@/lib/meta/client";
import { data } from "@/lib/platform/data";

export const maxDuration = 60;

export const POST = jobHandler<unknown, { after: string | null }>("digest", async (job) => {
  const news = await data(job.request).collection("news").query({ after: job.checkpoint?.after ?? null, limit: 20 });
  const reply = await metaClient(job.request).responses.create({ model: "muse-wonder-1.0", max_output_tokens: 2000, input: "made up" });
  await data(job.request).collection("digests").create({ text: reply.output_text });
  if (news.next) return checkpoint(job, { after: news.next });
  await notifyOwner(job, { title: "Ready" });
});
`,
    );
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const entry = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
        seen.push(entry);
        const out = answer(entry);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/gw`;
  });

  after(() => server?.close());

  async function run(code) {
    const script = path.join(dir, `run-${Math.random().toString(36).slice(2)}.mts`);
    writeFileSync(script, `import * as jobs from "./lib/platform/jobs.ts";\nconst call = (headers = {}) => new Request("https://product.example/api/jobs/digest", { method: "POST", headers });\nconst TOKEN = ${JSON.stringify(TOKEN)};\nconst say = (o) => console.log(JSON.stringify(o));\n${code}\n`);
    const tsx = fileURLToPath(import.meta.resolve("tsx/esm"));
    const { spawn } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsx, script], { cwd: dir, env: { ...process.env, GATEWAY_URL: base, PRODUCT_TOKEN: "mm_live_test" } });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (status) => (status === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error(err || out))));
    });
  }

  const verified = (over = {}) => ({ status: 200, body: { runId: "r1", name: "digest", tick: 1, input: { a: 1 }, checkpoint: null, budgetUsd: 0.1, ...over } });
  const gateway = (extra = {}) => (e) => {
    if (e.url.endsWith("/jobs/verify")) return extra.verify ? extra.verify(e) : verified();
    if (e.url.endsWith("/jobs/checkpoint")) return { status: 200, body: { ok: true } };
    if (e.url.endsWith("/jobs/notify")) return { status: 200, body: { ok: true, id: "n1" } };
    if (e.url.endsWith("/jobs/enqueue")) return extra.enqueue ? extra.enqueue(e) : { status: 202, body: { runId: "r2" } };
    return extra.other ? extra.other(e) : { status: 200, body: {} };
  };
  const path_ = (e) => e.url.replace(/^\/gw/, "");

  test("jobHandler refuses a call without a token before anything runs", async () => {
    seen.length = 0;
    const out = await run(`
let ran = false;
const res = await jobs.jobHandler("digest", async () => { ran = true; })(call());
say({ status: res.status, ran });
`);
    assert.deepEqual(out, { status: 401, ran: false });
    assert.equal(seen.length, 0, "not even asking the gateway");
  });

  test("jobHandler refuses what the gateway refuses, before anything runs", async () => {
    const attempt = `
let ran = false;
const res = await jobs.jobHandler("digest", async () => { ran = true; })(call({ "x-musemuse-job": TOKEN }));
say({ status: res.status, ran });
`;
    answer = gateway({ verify: () => ({ status: 403, body: { error: { code: "sign_in_required", message: "No." } } }) });
    assert.deepEqual(await run(attempt), { status: 401, ran: false });
    answer = gateway({ verify: () => ({ status: 409, body: { error: { code: "job_not_running", message: "It's done." } } }) });
    assert.deepEqual(await run(attempt), { status: 409, ran: false });
    answer = gateway({ verify: () => verified({ name: "another" }) });
    assert.deepEqual(await run(attempt), { status: 400, ran: false }, "another job's token");
  });

  test("a finished job closes its run, and its input and checkpoint reach the handler", async () => {
    seen.length = 0;
    answer = gateway({ verify: () => verified({ checkpoint: { cursor: 2 }, tick: 2 }) });
    const out = await run(`
let got;
const res = await jobs.jobHandler("digest", async (job) => { got = job; })(call({ "x-musemuse-job": TOKEN }));
say({ status: res.status, body: await res.json(), got: [got.runId, got.tick, got.input, got.checkpoint, got.budgetUsd, got.simulated] });
`);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, status: "done", tick: 2 });
    assert.deepEqual(out.got, ["r1", 2, { a: 1 }, { cursor: 2 }, 0.1, false]);
    assert.deepEqual(seen.map(path_), ["/jobs/verify", "/jobs/checkpoint"]);
    assert.equal(seen[0].headers["x-musemuse-job"], TOKEN);
    assert.equal(seen[0].headers.authorization, "Bearer mm_live_test");
    assert.deepEqual(seen[1].body, { state: null, done: true });
  });

  test("checkpoint saves the state and leaves the run for the next tick, with no second close", async () => {
    seen.length = 0;
    answer = gateway();
    const out = await run(`
const res = await jobs.jobHandler("digest", async (job) => jobs.checkpoint(job, { cursor: 5 }))(call({ "x-musemuse-job": TOKEN }));
say(await res.json());
`);
    assert.deepEqual(out, { ok: true, status: "queued", tick: 1 });
    assert.deepEqual(seen.filter((e) => path_(e) === "/jobs/checkpoint").map((e) => e.body), [{ state: { cursor: 5 }, done: false }]);
  });

  test("a thrown error ends the run with its first line, and the route says 500", async () => {
    seen.length = 0;
    answer = gateway();
    const out = await run(`
const res = await jobs.jobHandler("digest", async () => { throw new Error("The feed was empty.\\nstack line"); })(call({ "x-musemuse-job": TOKEN }));
say({ status: res.status });
`);
    assert.equal(out.status, 500);
    assert.deepEqual(seen.find((e) => path_(e) === "/jobs/checkpoint").body, { state: null, done: true, error: "The feed was empty." });
  });

  test("inside a job, every gateway call carries its token, and calls elsewhere and after it don't", async () => {
    seen.length = 0;
    answer = gateway();
    const out = await run(`
const base = process.env.GATEWAY_URL;
await jobs.jobHandler("digest", async () => {
  await fetch(base + "/v1/responses", { method: "POST", headers: { "x-keep": "yes" }, body: "{}" });
  await fetch(base.replace("/gw", "") + "/elsewhere", { method: "POST", body: "{}" });
})(call({ "x-musemuse-job": TOKEN }));
await fetch(base + "/after", { method: "POST", body: "{}" });
say({ done: true });
`);
    assert.deepEqual(out, { done: true });
    const model = seen.find((e) => e.url === "/gw/v1/responses");
    assert.equal(model.headers["x-musemuse-job"], TOKEN);
    assert.equal(model.headers["x-keep"], "yes", "other headers stay");
    assert.equal(seen.find((e) => e.url === "/elsewhere").headers["x-musemuse-job"], undefined);
    assert.equal(seen.find((e) => e.url === "/gw/after").headers["x-musemuse-job"], undefined, "after the job, the token is gone");
  });

  test("the real metaClient and data helpers go through a job's token", async () => {
    seen.length = 0;
    answer = gateway({
      other: (e) => (path_(e).startsWith("/v1/") ? { status: 200, body: { id: "r", object: "response", output: [] } } : { status: 200, body: { items: [], next: null } }),
    });
    const out = await run(`
import { metaClient } from "./lib/meta/client.ts";
import { data } from "./lib/platform/data.ts";
const res = await jobs.jobHandler("digest", async (job) => {
  await metaClient(job.request).responses.create({ model: "muse-wonder-1.0", input: "made up" });
  await data(job.request).collection("news").query({});
})(call({ "x-musemuse-job": TOKEN }));
say({ status: res.status });
`);
    assert.equal(out.status, 200);
    for (const u of ["/gw/v1/responses", "/gw/data/news/query"]) assert.equal(seen.find((e) => e.url === u)?.headers["x-musemuse-job"], TOKEN, u);
  });

  test("notifyOwner and enqueue send what they say; a visitor's enqueue comes back as a plain refusal", async () => {
    seen.length = 0;
    answer = gateway();
    await run(`
await jobs.jobHandler("digest", async (job) => { await jobs.notifyOwner(job, { title: "Ready", body: "Three items." }); })(call({ "x-musemuse-job": TOKEN }));
say({ done: true });
`);
    assert.deepEqual(seen.find((e) => path_(e) === "/jobs/notify").body, { title: "Ready", body: "Three items." });
    const refused = `
try { await jobs.enqueue(new Headers(), { name: "digest" }); say({ refused: false }); } catch (e) { say({ code: e.code, status: e.status }); }
`;
    answer = gateway({ enqueue: () => ({ status: 403, body: { error: { code: "sign_in_required", message: "Only the product's owner can start a background job." } } }) });
    assert.deepEqual(await run(refused), { code: "sign_in_required", status: 403 });
    answer = () => ({ status: 404, body: { error: { code: "unknown_endpoint" } } });
    assert.deepEqual(await run(refused), { code: "switched_off", status: 404 });
  });

  test("fireJob and fireWebhook run under Playwright in smoke, and the demo replay fires nothing", async () => {
    answer = (e) => {
      if (e.url.endsWith("/jobs/test-fire")) return e.body.hook ? { status: 200, body: { hook: { url: `${base}/made-up-hook` } } } : { status: 200, body: { token: "jr1.made.up" } };
      if (e.url.endsWith("/made-up-hook")) return { status: 202, body: { ok: true, queued: true } };
      if (e.url.startsWith("/api/jobs/")) return { status: 200, body: { ok: true, status: "done", tick: 1 } };
      return { status: 404, body: {} };
    };
    writeFileSync(path.join(dir, "pw.jobs.config.mts"), `import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "tests/pw", outputDir: "test-results/pw", use: { baseURL: ${JSON.stringify(base.replace(/\/gw$/, ""))} }, projects: [{ name: "smoke" }, { name: "demo" }] });\n`);
    mkdirSync(path.join(dir, "tests/pw/caps"), { recursive: true });
    cpSync(path.join(dir, "tests/caps"), path.join(dir, "tests/pw/caps"), { recursive: true });
    cpSync(path.join(dir, "tests/judge-shot.ts"), path.join(dir, "tests/pw/judge-shot.ts"));
    writeFileSync(
      path.join(dir, "tests/pw/smoke.spec.ts"),
      `import { expect, test } from "@playwright/test";\nimport { fireJob, fireWebhook } from "./caps/jobs";\ntest("jobs", async ({ request }) => {\n  const first = await fireJob(request, "digest");\n  expect(first.status).toBe("done");\n  expect((await fireWebhook(request, "log", { event: "sample" })).status).toBe("done");\n});\n`,
    );
    // Async: the fake gateway answers from this process.
    const playwright = async (project) => {
      seen.length = 0;
      const { spawn } = await import("node:child_process");
      const child = spawn(path.join(modules, ".bin/playwright"), ["test", "-c", "pw.jobs.config.mts", "--project", project, "--reporter", "line"], { cwd: dir, env: { ...process.env, GATEWAY_URL: base, PRODUCT_TOKEN: "mm_build_test" } });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      const status = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(status, 0, out);
      return seen.map((e) => e.url.replace(/^\/gw/, "")).filter((u) => !u.startsWith("/favicon"));
    };
    assert.deepEqual(await playwright("smoke"), ["/jobs/test-fire", "/api/jobs/digest", "/jobs/test-fire", "/made-up-hook", "/jobs/test-fire", "/api/jobs/log"]);
    const recorded = JSON.parse(readFileSync(path.join(dir, "test-results/caps/jobs.json"), "utf8"));
    assert.deepEqual(recorded.checks.map((c) => [c.id, c.ok]), [["job-fired", true], ["webhook-run", true]]);
    assert.deepEqual(await playwright("demo"), [], "the demo shows what smoke already made");
    const after = JSON.parse(readFileSync(path.join(dir, "test-results/caps/jobs.json"), "utf8"));
    assert.deepEqual(after.checks, recorded.checks, "and leaves smoke's record alone");
    answer = () => ({ status: 200, body: {} });
  });

  test("the product's tsc passes with a job route written the skill's way", () => {
    const tsc = path.join(modules, "typescript/bin/tsc");
    const res = spawnSync(process.execPath, [tsc, "--noEmit", "-p", dir], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });
});

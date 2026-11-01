/**
 * The whole path with nothing of ours faked: the template's real jobHandler, metaClient and data helpers in a product's
 * process, calling the platform's real gateway handlers on a real Postgres (in-memory PGlite) over HTTP. Only Meta's
 * answer is a stand-in, so nothing is spent. It plays section 22's build: a daily digest test-fired twice, the second
 * resuming a checkpoint, a webhook into a log, the fixed checks on the gateway's own record, and then the same product
 * run by the real cron as a live product.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/jobs/__tests__/e2e.scenario.test.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import type { CapId } from "@/lib/caps/ids";
import type { CapProduct, CapToken } from "@/lib/caps/gate";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-jobs";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const TEMPLATE = path.join(REPO, "template");
const modules = path.join(TEMPLATE, "node_modules");
const canMock = typeof (mock as { module?: unknown }).module === "function";
const skip = !canMock ? "needs --experimental-test-module-mocks" : existsSync(modules) ? false : "needs template/node_modules";

const BRIEF = {
  data: { collections: [{ name: "digests", scope: "shared", writes: "owner", holds: "One digest.", personal: false }, { name: "log", scope: "shared", writes: "owner", holds: "A logged event.", personal: false }], signIn: "none" },
  jobs: { schedules: [{ name: "digest", every: "1 day at 07:30", does: "Makes a digest in two steps." }], webhooks: [{ name: "hook", from: "A form", does: "Logs what came." }], results: ["digests", "log"] },
};
const MANIFEST = {
  caps: ["data", "jobs"],
  jobs: { schedules: [{ name: "digest", every: "1 day at 07:30" }], webhooks: [{ name: "hook" }] },
  data: { collections: [{ name: "digests", scope: "shared", writes: "owner", jobWrites: true }, { name: "log", scope: "shared", writes: "owner", jobWrites: true }] },
};

const DIGEST_ROUTE = `import { checkpoint, jobHandler, notifyOwner } from "@/lib/platform/jobs";
import { metaClient } from "@/lib/meta/client";
import { data } from "@/lib/platform/data";

export const POST = jobHandler<unknown, { step: number }>("digest", async (job) => {
  const reply = await metaClient(job.request).responses.create({ model: "muse-wonder-1.0", max_output_tokens: 200, input: "made up" });
  if (!job.checkpoint) return checkpoint(job, { step: 1 });
  await data(job.request).collection("digests").create({ text: reply.output_text ?? "digest", step: job.checkpoint.step + 1 });
  await notifyOwner(job, { title: "Digest ready" });
});
`;
const HOOK_ROUTE = `import { jobHandler } from "@/lib/platform/jobs";
import { data } from "@/lib/platform/data";

export const POST = jobHandler<{ payload: { event: string } }>("hook", async (job) => {
  await data(job.request).collection("log").create({ event: job.input.payload.event });
});
`;
const SPY_ROUTE = `import { jobHandler } from "@/lib/platform/jobs";
import { data } from "@/lib/platform/data";

export const POST = jobHandler("spy", async (job) => {
  await data(job.request).collection("secrets").create({ nope: true });
});
`;
const SERVER = `import http from "node:http";
import { POST as digest } from "./app/api/jobs/digest/route.ts";
import { POST as hook } from "./app/api/jobs/hook/route.ts";
import { POST as spy } from "./app/api/jobs/spy/route.ts";
const routes = { "/api/jobs/digest": digest, "/api/jobs/hook": hook, "/api/jobs/spy": spy };
const server = http.createServer(async (req, res) => {
  const route = routes[req.url];
  if (!route) { res.writeHead(404); res.end(); return; }
  const answer = await route(new Request("http://product" + req.url, { method: req.method, headers: req.headers }));
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(await answer.text());
});
server.listen(0, "127.0.0.1", () => console.log("port " + server.address().port));
`;

describe("a background job, end to end", { skip }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
  let gatewayServer: http.Server;
  let product: ChildProcess;
  let productUrl = "";
  let gatewayUrl = "";
  let dir = "";
  let productId = "";
  let ownerId = "";
  let buildId = "";
  const metaCalls: Array<Record<string, unknown>> = [];
  let scope: "build" | "live" = "build";

  const tokenFor = (): CapToken => ({ id: "33333333-3333-4333-8333-333333333333", productId, scope, allowedModels: ["muse-wonder-1.0", "cap:data", "cap:jobs"], dailyBudgetUsd: 2, buildId: scope === "build" ? buildId : null });

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: path.join(REPO, "drizzle") });
    (testDb as unknown as { batch: (q: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch = async (queries) => {
      const out: unknown[] = [];
      for (const q of queries) out.push(await q);
      return out;
    };
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    process.env.JOBS_WEBHOOKS = "1";

    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    ownerId = user!.id;
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: ownerId }).returning();
    const [p] = await testDb.insert(realSchema.products).values({ slug: "digest", name: "Digest", ownerId, status: "live", manifest: MANIFEST as never, ownerSeenAt: new Date() }).returning();
    productId = p!.id;
    const [b] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: ownerId, productId, brief: BRIEF as never }).returning();
    buildId = b!.id;
    await testDb.update(realSchema.products).set({ latestBuildId: buildId }).where(eq(realSchema.products.id, productId));

    const jobs = await import("../handler");
    const store = await import("../store");
    const budget = await import("../budget");
    const data = await import("@/lib/caps/data/handler");
    const dataStore = await import("@/lib/caps/data/store");
    const { collectionRules, narrowCollectionRules } = await import("@/lib/caps/data/types");
    const { withJobWrites } = await import("../rules");
    const { handleGateway } = await import("@/lib/gateway/handler");
    const { fakeGateway } = await import("@/lib/gateway/__tests__/helpers");
    const { handleCapsProof } = await import("@/lib/caps/proof");

    const rates = new Map<string, number>();
    const hitRateLimits = async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, rates.set(k, (rates.get(k) ?? 0) + 1).get(k)!]));
    const capProduct = async (): Promise<CapProduct> => ({ status: "live", manifest: scope === "build" ? null : MANIFEST, liveUrl: productUrl, takenDownAt: null, ownerId, ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null });
    const gate = { servedCaps: (): CapId[] => ["data", "jobs"], findToken: async () => tokenFor(), product: capProduct, adminEmails: [] as string[], hitRateLimits };
    const jobsDeps = { ...gate, store: store.jobsStore, webhooksOn: () => true, runUsd: () => 0.1, gatewayUrl: "" };
    const dataDeps: import("@/lib/caps/data/handler").DataDeps = {
      ...gate,
      store: dataStore.dataStore,
      quotas: () => ({ productRows: 100, productBytes: 1_000_000, dailyWrites: 100 }),
      signInOn: () => false,
      rules: async (token) => {
        const rules = withJobWrites(collectionRules(BRIEF.data), BRIEF);
        return token.scope === "build" ? rules : narrowCollectionRules(rules, collectionRules(MANIFEST.data));
      },
      reserveCounter: async () => 1,
      platformUrl: "http://platform",
      productSlug: async () => "digest",
      jobWrote: store.noteRunWrote,
      jobRun: store.jobsStore.getRun,
    };
    const counters = new Map<string, number>();
    const fake = fakeGateway({
      token: { productId, allowedModels: ["muse-wonder-1.0"], scope: "build" },
      fetch: (async (_url: string, init: RequestInit) => {
        metaCalls.push(Object.fromEntries(new Headers(init.headers)));
        return new Response(JSON.stringify({ id: "r", object: "response", model: "muse-wonder-1.0", output_text: "A made-up digest", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "A made-up digest" }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    const jobCallDeps = {
      getRun: store.jobsStore.getRun,
      addRunCost: store.addRunCost,
      stopRun: store.stopRunForBudget,
      addNotice: store.jobsStore.addNotice,
      dailyUsd: () => 5,
      productDailyUsd: () => 1,
      counterValue: async (k: string) => counters.get(k) ?? 0,
      adjustCounter: async (k: string, _w: Date, d: number) => void counters.set(k, (counters.get(k) ?? 0) + d),
    };

    gatewayServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, gatewayUrl);
      const parts = url.pathname.replace(/^\/gw\//, "").split("/");
      const request = new Request(url, { method: req.method, headers: req.headers as HeadersInit, ...(body.length && req.method !== "GET" ? { body } : {}) });
      const answer = await (async () => {
        if (parts[0] === "jobs") return jobs.handleJobs(request, parts.slice(1), { ...jobsDeps, pauseDays: () => 14, gatewayUrl });
        if (parts[0] === "hooks") return jobs.handleHook(request, parts.slice(1), { servedCaps: gate.servedCaps, product: capProduct, adminEmails: [], hitRateLimits, store: store.jobsStore, webhooksOn: () => true, runUsd: () => 0.1, pauseDays: () => 14, liveToken: async () => tokenFor() });
        if (parts[0] === "data") return data.handleData(request, parts.slice(1), dataDeps);
        if (parts[0] === "v1") {
          const token = { ...fake.deps, findToken: async () => ({ ...tokenFor() }) as never, jobCall: (r: Request, t: { productId: string; scope: string; buildId?: string | null }, now: Date) => budget.jobCallOf(r, { productId: t.productId, scope: t.scope, buildId: (t as { buildId?: string | null }).buildId ?? null }, jobCallDeps, now) };
          return handleGateway(request, parts.slice(1), token as never);
        }
        if (parts[0] === "caps") return handleCapsProof(request, { enabledCaps: () => ["jobs"], findToken: async () => tokenFor(), productStatus: async () => "live", hitRateLimits, counters: { jobs: store.jobsProof } });
        return new Response("not found", { status: 404 });
      })();
      res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await answer.arrayBuffer()));
    });
    await new Promise<void>((r) => gatewayServer.listen(0, "127.0.0.1", r));
    gatewayUrl = `http://127.0.0.1:${(gatewayServer.address() as { port: number }).port}/gw`;

    dir = mkdtempSync(path.join(tmpdir(), "mm-jobs-e2e-"));
    for (const f of ["tsconfig.json", "package.json"]) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    for (const d of ["lib", "components", "app"]) cpSync(path.join(TEMPLATE, d), path.join(dir, d), { recursive: true });
    for (const o of ["core", "data", "jobs"]) cpSync(path.join(TEMPLATE, "caps", o, "files"), dir, { recursive: true });
    symlinkSync(modules, path.join(dir, "node_modules"));
    for (const [name, code] of Object.entries({ digest: DIGEST_ROUTE, hook: HOOK_ROUTE, spy: SPY_ROUTE })) {
      mkdirSync(path.join(dir, "app/api/jobs", name), { recursive: true });
      writeFileSync(path.join(dir, "app/api/jobs", name, "route.ts"), code);
    }
    writeFileSync(path.join(dir, "server.mts"), SERVER);
    const tsx = fileURLToPath(import.meta.resolve("tsx/esm"));
    product = spawn(process.execPath, ["--import", tsx, "server.mts"], { cwd: dir, env: { ...process.env, GATEWAY_URL: gatewayUrl, PRODUCT_TOKEN: "mm_made_up_token" } });
    productUrl = await new Promise<string>((resolve, reject) => {
      let err = "";
      product.stderr!.on("data", (c) => (err += c));
      product.stdout!.on("data", (c) => {
        const m = /port (\d+)/.exec(String(c));
        if (m) resolve(`http://127.0.0.1:${m[1]}`);
      });
      product.on("exit", () => reject(new Error(err)));
    });
    await testDb.update(realSchema.products).set({ liveUrl: productUrl }).where(eq(realSchema.products.id, productId));
  });

  after(async () => {
    delete process.env.JOBS_WEBHOOKS;
    product?.kill();
    await new Promise((r) => gatewayServer?.close(r));
    await client?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const gw = (p: string, init?: RequestInit) => fetch(`${gatewayUrl}/${p}`, { ...init, headers: { authorization: "Bearer made-up", "content-type": "application/json", ...init?.headers } });
  const fire = async (body: unknown) => (await (await gw("jobs/test-fire", { method: "POST", body: JSON.stringify(body) })).json()) as { token: string; runId: string; tick: number; hook: { url: string } };
  const route = async (name: string, token?: string) => {
    const res = await fetch(`${productUrl}/api/jobs/${name}`, { method: "POST", headers: token ? { "x-musemuse-job": token } : {} });
    return { status: res.status, body: (await res.json()) as { status?: string; tick?: number; error?: string } };
  };
  const records: Array<{ id: string; ok: boolean; detail: string }> = [];

  it("the route refuses a call with no token, and one with a made-up token", async () => {
    assert.equal((await route("digest")).status, 401);
    assert.equal((await route("digest", "jr1.not.a.real.token")).status, 401);
    assert.equal(metaCalls.length, 0);
  });

  it("a digest fired twice: the first saves a checkpoint, and the second resumes it and saves its result", async () => {
    const first = await fire({ name: "digest" });
    const one = await route("digest", first.token);
    assert.deepEqual([one.status, one.body.status, one.body.tick], [200, "queued", 1]);
    const second = await fire({ name: "digest" });
    assert.deepEqual([second.runId, second.tick], [first.runId, 2], "the same run");
    const two = await route("digest", second.token);
    assert.deepEqual([two.status, two.body.status, two.body.tick], [200, "done", 2]);
    records.push({ id: "job-fired", ok: true, detail: "fired" });
    const [row] = await testDb.select().from(realSchema.productRows).where(eq(realSchema.productRows.collection, "digests"));
    assert.equal(row!.namespace, `b:${buildId}`, "in the build's own space");
    assert.deepEqual(row!.data, { text: "A made-up digest", step: 2 }, "it read its checkpoint");
    const [run] = await testDb.select().from(realSchema.jobRuns).where(eq(realSchema.jobRuns.id, first.runId));
    assert.deepEqual([run!.status, run!.tick, run!.rowsWritten], ["done", 2, 1]);
    const notice = await testDb.select().from(realSchema.ownerNotices);
    assert.deepEqual(notice.map((n) => [n.title, n.namespace]), [["Digest ready", `b:${buildId}`]], "and tells no one");
  });

  it("every model call carried the job, its cost went on the run, and the token never reached Meta", async () => {
    assert.equal(metaCalls.length, 2);
    for (const headers of metaCalls) assert.equal(headers["x-musemuse-job"], undefined);
    const [run] = await testDb.select().from(realSchema.jobRuns);
    assert.ok(run!.costUsd > 0, "the run's dollars moved");
  });

  it("a webhook's sample payload leads to a run, and its row", async () => {
    const { hook } = await fire({ name: "hook", hook: true });
    const posted = await fetch(hook.url, { method: "POST", body: JSON.stringify({ event: "a-made-up-event" }) });
    assert.equal(posted.status, 202);
    const wrong = await fetch(hook.url.replace(/k=[^&]+/, "k=wrong"), { method: "POST", body: "{}" });
    assert.equal(wrong.status, 401);
    const fired = await fire({ name: "hook" });
    const res = await route("hook", fired.token);
    assert.deepEqual([res.status, res.body.status], [200, "done"]);
    records.push({ id: "webhook-run", ok: true, detail: "hook" });
    const rows = await testDb.select().from(realSchema.productRows).where(eq(realSchema.productRows.collection, "log"));
    assert.deepEqual(rows.map((r) => r.data), [{ event: "a-made-up-event" }]);
  });

  it("a job that saves somewhere else fails, ends its run and writes nothing", async () => {
    const fired = await fire({ name: "spy" });
    const res = await route("spy", fired.token);
    assert.equal(res.status, 500);
    const [run] = await testDb.select().from(realSchema.jobRuns).where(eq(realSchema.jobRuns.id, fired.runId));
    assert.equal(run!.status, "failed");
    assert.equal(run!.rowsWritten, 0);
    assert.equal((await testDb.select().from(realSchema.productRows).where(eq(realSchema.productRows.collection, "secrets"))).length, 0);
  });

  it("the fixed checks pass on the gateway's own record", async () => {
    records.push({ id: "result-shown", ok: true, detail: "shown on the screen" });
    const proofRes = await gw("caps/proof");
    assert.equal(proofRes.status, 200);
    const proof = ((await proofRes.json()) as { caps: { jobs: Record<string, number> } }).caps.jobs;
    assert.deepEqual([proof.done, proof.resumed, proof.webhook_runs, proof.rows, proof.notices], [2, 1, 1, 2, 1]);
    const root = mkdtempSync(path.join(tmpdir(), "mm-jobs-e2e-check-"));
    writeFileSync(path.join(root, "musemuse.json"), JSON.stringify(MANIFEST));
    const checker = (await import(pathToFileURL(path.join(TEMPLATE, "caps/jobs/files/scripts/caps/jobs.mjs")).href)) as { check(i: unknown): Promise<Array<{ id: string; ok: boolean; detail: string }>> };
    const out = await checker.check({ record: { checks: records }, proof, root });
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(out.map((c) => [c.id, c.ok]), [["manifest", true], ["job-ran", true], ["job-wrote", true], ["result-shown", true], ["webhook-run", true]]);
  });

  it("the build's rows go when it ends", async () => {
    const { clearJobsBuild } = await import("../cleanup");
    await clearJobsBuild(buildId);
    assert.equal((await testDb.select().from(realSchema.jobRuns)).length, 0);
    assert.equal((await testDb.select().from(realSchema.ownerNotices)).length, 0);
  });

  it("live: the deploy sets the schedule, and the real cron runs both ticks, a pass apart, with a real job token", async () => {
    scope = "live";
    const { shipJobs } = await import("../ship");
    const store = await import("../store");
    const { runJobsCron } = await import("../cron");
    const made = await shipJobs({ buildId, productId, sandboxName: "sb", liveUrl: productUrl, brief: BRIEF as never }, { readManifest: async () => MANIFEST, syncSchedules: store.syncSchedules, now: () => new Date() });
    assert.match(made ?? "", /Schedules on: digest/);
    const [s] = await testDb.select().from(realSchema.productSchedules);
    assert.equal(s!.everyMinutes, 1440);
    await testDb.update(realSchema.productSchedules).set({ nextRunAt: new Date(Date.now() - 1000) });
    const counters = new Map<string, number>();
    const pass = (now: Date) =>
      runJobsCron({
        dailyRuns: () => 2000,
        runUsd: () => 0.1,
        pauseDays: () => 14,
        pauseAbsent: store.pauseAbsent,
        queueDueSchedules: store.queueDueSchedules,
        expireStale: store.expireStale,
        claimQueued: store.claimQueued,
        unclaimRun: store.unclaimRun,
        productDailyRuns: () => 400,
        retryOrFail: store.retryOrFail,
        addNoticeOnce: store.addNoticeOnce,
        reserveCounter: async (k, _w, a, l) => {
          const n = (counters.get(k) ?? 0) + a;
          if (n > l) return null;
          counters.set(k, n);
          return n;
        },
        adjustCounter: async (k, _w, d) => void counters.set(k, (counters.get(k) ?? 0) + d),
        fetch: (input, init) => fetch(input, init),
        now: () => now,
      });
    const now = new Date();
    const one = await pass(now);
    assert.deepEqual([one.queued, one.fired, one.failed], [1, 1, 0]);
    const [waiting] = await testDb.select().from(realSchema.jobRuns);
    assert.deepEqual([waiting!.status, waiting!.tick, waiting!.namespace, waiting!.trigger], ["queued", 1, "live", "schedule"]);
    assert.deepEqual(waiting!.checkpoint, { step: 1 });
    const two = await pass(new Date(now.getTime() + 300_000));
    assert.deepEqual([two.queued, two.fired, two.failed], [0, 1, 0]);
    const [finished] = await testDb.select().from(realSchema.jobRuns);
    assert.deepEqual([finished!.status, finished!.tick, finished!.rowsWritten], ["done", 2, 1]);
    const rows = await testDb.select().from(realSchema.productRows).where(eq(realSchema.productRows.namespace, "live"));
    assert.deepEqual(rows.map((r) => r.collection), ["digests"]);
    assert.deepEqual((await store.listNotices(ownerId)).map((n) => n.title), ["Digest ready"], "the owner sees it");
  });
});

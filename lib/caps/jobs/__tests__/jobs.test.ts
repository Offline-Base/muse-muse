/**
 * Background jobs on a real Postgres (in-memory PGlite, nothing on disk), with the real store, handlers, cron, data route
 * and connect's send route. Only the product's job route is faked. All made-up data, and no model call.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/jobs/__tests__/jobs.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import type { CapId } from "@/lib/caps/ids";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import { JOBS_LIMITS } from "@/lib/caps/jobs/limits";
import { mintJobToken, readJobToken } from "@/lib/caps/jobs/token";
import { mintOwnerSession } from "@/lib/tools/principal";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-jobs";

const canMock = typeof (mock as { module?: unknown }).module === "function";
type TestDb = import("drizzle-orm/pglite").PgliteDatabase<typeof realSchema>;
const NOW = new Date("2026-11-02T12:00:00Z");

describe("jobs on a database", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let testDb: TestDb;
  let store: typeof import("../store");
  let cleanup: typeof import("../cleanup");
  let handler: typeof import("../handler");
  let cron: typeof import("../cron");
  let ship: typeof import("../ship");
  let data: typeof import("@/lib/caps/data/handler");
  let dataStore: typeof import("@/lib/caps/data/store");
  let connect: typeof import("@/lib/caps/connect/handler");
  let held: typeof import("../held");
  let productId = "";
  let ownerId = "";
  let buildId = "";
  const BRIEF = {
    data: { collections: [{ name: "digests", scope: "shared", writes: "owner", holds: "One digest.", personal: false }, { name: "notes", scope: "shared", writes: "owner", holds: "A note.", personal: false }, { name: "mine", scope: "visitor", writes: "owner", holds: "Mine.", personal: true }], signIn: "none" },
    jobs: { schedules: [{ name: "digest", every: "1 day at 07:30", does: "Makes a digest." }], webhooks: [{ name: "log", from: "A form", does: "Logs it." }], results: ["digests"] },
  };

  before(async () => {
    process.env.JOBS_WEBHOOKS = "1";
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    client = new PGlite();
    testDb = drizzle({ client, schema: realSchema });
    await migrate(testDb, { migrationsFolder: new URL("../../../../drizzle", import.meta.url).pathname });
    (testDb as unknown as { batch: (q: PromiseLike<unknown>[]) => Promise<unknown[]> }).batch = async (queries) => {
      const out: unknown[] = [];
      for (const q of queries) out.push(await q);
      return out;
    };
    mock.module(new URL("../../../db/client.ts", import.meta.url).href, { namedExports: { db: () => testDb, schema: realSchema } });
    store = await import("../store");
    cleanup = await import("../cleanup");
    handler = await import("../handler");
    cron = await import("../cron");
    ship = await import("../ship");
    held = await import("../held");
    data = await import("@/lib/caps/data/handler");
    dataStore = await import("@/lib/caps/data/store");
    connect = await import("@/lib/caps/connect/handler");
  });

  after(async () => {
    delete process.env.JOBS_WEBHOOKS;
    await client.close();
  });

  beforeEach(async () => {
    await client.exec(`delete from job_runs; delete from owner_notices; delete from product_webhooks; delete from product_schedules; delete from product_rows; delete from product_data_counts; delete from builds; delete from products; delete from inspirations; delete from users;`);
    const [user] = await testDb.insert(realSchema.users).values({ email: "maker@example.com" }).returning();
    ownerId = user!.id;
    const [muse] = await testDb.insert(realSchema.inspirations).values({ userId: user!.id }).returning();
    const [product] = await testDb.insert(realSchema.products).values({ slug: "digest", name: "Digest", ownerId, status: "live", liveUrl: "https://digest.example.app", ownerSeenAt: NOW, createdAt: NOW }).returning();
    const [build] = await testDb.insert(realSchema.builds).values({ inspirationId: muse!.id, userId: ownerId, productId: product!.id, brief: BRIEF as never }).returning();
    productId = product!.id;
    buildId = build!.id;
    await testDb.update(realSchema.products).set({ latestBuildId: buildId }).where(eq(realSchema.products.id, productId));
    counters.clear();
    rates.clear();
  });

  const counters = new Map<string, number>();
  const rates = new Map<string, number>();
  const hitRateLimits = async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, rates.set(k, (rates.get(k) ?? 0) + 1).get(k)!]));
  const reserveCounter = async (key: string, _w: Date, amount: number, limit: number) => {
    const next = (counters.get(key) ?? 0) + amount;
    if (next > limit) return null;
    counters.set(key, next);
    return next;
  };
  const adjustCounter = async (key: string, _w: Date, delta: number) => void counters.set(key, (counters.get(key) ?? 0) + delta);
  const live = (): CapToken => ({ id: "33333333-3333-4333-8333-333333333333", productId, scope: "live", allowedModels: ["cap:jobs", "cap:data", "cap:connect"], dailyBudgetUsd: 1, buildId: null });
  const buildToken = (): CapToken => ({ ...live(), scope: "build", buildId });
  const product = (over: Partial<CapProduct> = {}): CapProduct => ({ status: "live", manifest: null, liveUrl: "https://digest.example.app", takenDownAt: null, ownerId, ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null, ...over });
  const gate = (tok: CapToken, caps: CapId[] = ["jobs", "data", "connect"]) => ({
    servedCaps: () => caps,
    findToken: async () => tok,
    product: async () => product(),
    adminEmails: [] as string[],
    hitRateLimits,
    now: () => NOW,
  });
  const jobsDeps = (tok: CapToken): import("../handler").JobsDeps => ({ ...gate(tok), store: store.jobsStore, webhooksOn: () => true, runUsd: () => 0.1, pauseDays: () => 14, gatewayUrl: "https://platform.example/api/gateway" });
  const hookDeps = (over: Partial<import("../handler").HookDeps> = {}): import("../handler").HookDeps => ({
    servedCaps: () => ["jobs"],
    product: async () => product(),
    adminEmails: [],
    hitRateLimits,
    store: store.jobsStore,
    webhooksOn: () => true,
    runUsd: () => 0.1,
    pauseDays: () => 14,
    liveToken: async () => live(),
    now: () => NOW,
    ...over,
  });
  const dataDeps = (tok: CapToken, manifest: unknown = { data: { collections: [{ name: "digests", scope: "shared", jobWrites: true }, { name: "notes", scope: "shared" }, { name: "mine", scope: "visitor" }] } }): import("@/lib/caps/data/handler").DataDeps => ({
    ...gate(tok),
    store: dataStore.dataStore,
    quotas: () => ({ productRows: 100, productBytes: 1_000_000, dailyWrites: 100 }),
    signInOn: () => false,
    rules: async (token) => {
      const { collectionRules, narrowCollectionRules } = await import("@/lib/caps/data/types");
      const { withJobWrites } = await import("../rules");
      const brief = withJobWrites(collectionRules(BRIEF.data), BRIEF);
      return token.scope === "build" ? brief : narrowCollectionRules(brief, collectionRules((manifest as { data?: unknown }).data));
    },
    reserveCounter,
    platformUrl: "https://platform.example",
    productSlug: async () => "digest",
    jobWrote: store.noteRunWrote,
    jobRun: store.jobsStore.getRun,
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`https://platform.example/api/gateway/${path}`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const liveJob = (runId: string, tick = 1, attempt = 1) => ({ "x-musemuse-job": mintJobToken({ productId, runId, tick, attempt, expiresAt: new Date(NOW.getTime() + 600_000) }) });
  const owner = () => ({ "x-musemuse-owner": mintOwnerSession({ productId, subject: "owner-sub" }, NOW).session });
  const runRow = async (id: string) => (await testDb.select().from(realSchema.jobRuns).where(eq(realSchema.jobRuns.id, id)))[0]!;
  const allRuns = () => testDb.select().from(realSchema.jobRuns);
  const notices = () => testDb.select().from(realSchema.ownerNotices);
  async function runningRun(over: Partial<typeof realSchema.jobRuns.$inferInsert> = {}) {
    const [row] = await testDb.insert(realSchema.jobRuns).values({ productId, name: "digest", trigger: "schedule", budgetUsd: 0.1, status: "running", tick: 1, attempt: 1, startedAt: NOW, ...over }).returning();
    return row!;
  }

  // A product's job route, faked: what it answers and what the cron called.
  function cronDeps(route: (url: string, init: RequestInit, job: { runId: string }) => Promise<Response>, over: Partial<import("../cron").JobsCronDeps> = {}): import("../cron").JobsCronDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      dailyRuns: () => 2000,
      productDailyRuns: () => 400,
      runUsd: () => 0.1,
      pauseDays: () => 14,
      pauseAbsent: store.pauseAbsent,
      queueDueSchedules: store.queueDueSchedules,
      expireStale: store.expireStale,
      claimQueued: store.claimQueued,
      unclaimRun: store.unclaimRun,
      retryOrFail: store.retryOrFail,
      addNoticeOnce: store.addNoticeOnce,
      reserveCounter,
      adjustCounter,
      fetch: (async (input: string, init: RequestInit) => {
        calls.push(input);
        const token = new Headers(init.headers).get("x-musemuse-job");
        const read = readJobToken(token, { productId }, new Date());
        assert.ok(read, "the cron's call carries a good job token");
        return route(input, init, { runId: read.runId });
      }) as unknown as typeof fetch,
      now: () => NOW,
      ...over,
    };
  }
  const closes = (done: boolean, state: unknown = null) => async (_u: string, init: RequestInit) => {
    const res = await handler.handleJobs(post("jobs/checkpoint", { state, done }, { "x-musemuse-job": new Headers(init.headers).get("x-musemuse-job")! }), ["checkpoint"], jobsDeps(live()));
    assert.equal(res.status, 200);
    return Response.json({ ok: true });
  };

  describe("the gateway's routes", () => {
    it("verify gives a running run's work to a call with its token, and nothing to any other", async () => {
      const run = await runningRun({ input: { from: "x" }, checkpoint: { cursor: 3 }, tick: 2 });
      const ok = await handler.handleJobs(post("jobs/verify", {}, liveJob(run.id)), ["verify"], jobsDeps(live()));
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { runId: run.id, name: "digest", tick: 2, input: { from: "x" }, checkpoint: { cursor: 3 }, budgetUsd: 0.1 });
      assert.equal((await handler.handleJobs(post("jobs/verify", {}), ["verify"], jobsDeps(live()))).status, 403, "no token");
      assert.equal((await handler.handleJobs(post("jobs/verify", {}, { "x-musemuse-job": "jr1.a.b.c.d" }), ["verify"], jobsDeps(live()))).status, 403, "forged");
      assert.equal((await handler.handleJobs(post("jobs/verify", {}, owner()), ["verify"], jobsDeps(live()))).status, 403, "the owner isn't a job");
      await testDb.update(realSchema.jobRuns).set({ status: "done" }).where(eq(realSchema.jobRuns.id, run.id));
      const over = await handler.handleJobs(post("jobs/verify", {}, liveJob(run.id)), ["verify"], jobsDeps(live()));
      assert.equal(over.status, 409);
    });

    it("a live token can't use a build's job token, and a build's can't reach a live run", async () => {
      const run = await runningRun();
      const buildJob = { "x-musemuse-job": mintJobToken({ productId, runId: run.id, tick: 1, attempt: 1, buildId, expiresAt: new Date(NOW.getTime() + 600_000) }) };
      assert.equal((await handler.handleJobs(post("jobs/verify", {}, buildJob), ["verify"], jobsDeps(live()))).status, 403, "signed for the build");
      assert.equal((await handler.handleJobs(post("jobs/verify", {}, buildJob), ["verify"], jobsDeps(buildToken()))).status, 403, "the run is in live, the token in b:");
    });

    it("needs the cap's marker and a signed-in builder", async () => {
      const run = await runningRun();
      const noMarker = { ...live(), allowedModels: ["cap:data"] };
      assert.equal((await handler.handleJobs(post("jobs/verify", {}, liveJob(run.id)), ["verify"], jobsDeps(noMarker))).status, 403);
      const guest = { ...jobsDeps(live()), product: async () => product({ ownerEmail: "guest@musemuse.invalid" }) };
      const res = await handler.handleJobs(post("jobs/verify", {}, liveJob(run.id)), ["verify"], guest);
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "sign_in_required");
    });

    it("a checkpoint resumes on the next tick, and the 10th tick ends the run", async () => {
      const run = await runningRun();
      const saved = await handler.handleJobs(post("jobs/checkpoint", { state: { cursor: 5 }, done: false }, liveJob(run.id)), ["checkpoint"], jobsDeps(live()));
      assert.equal(((await saved.json()) as { status: string }).status, "queued");
      const row = await runRow(run.id);
      assert.deepEqual([row.status, row.attempt], ["queued", 0]);
      assert.deepEqual(row.checkpoint, { cursor: 5 });
      const again = await handler.handleJobs(post("jobs/checkpoint", { state: {}, done: true }, liveJob(run.id)), ["checkpoint"], jobsDeps(live()));
      assert.equal(again.status, 409, "the tick was already closed");

      const last = await runningRun({ tick: JOBS_LIMITS.ticksPerRun, name: "long" });
      const res = await handler.handleJobs(post("jobs/checkpoint", { state: { cursor: 9 }, done: false }, liveJob(last.id, JOBS_LIMITS.ticksPerRun)), ["checkpoint"], jobsDeps(live()));
      assert.equal(((await res.json()) as { status: string }).status, "failed");
      assert.match((await runRow(last.id)).error ?? "", /10 ticks/);
      assert.equal((await notices()).filter((n) => n.kind === "job_failed").length, 1);
    });

    it("a late answer from an earlier tick or try can't close the tick that's going now", async () => {
      const run = await runningRun({ tick: 2, attempt: 1, checkpoint: { cursor: 5 } });
      const late = await handler.handleJobs(post("jobs/checkpoint", { done: true }, liveJob(run.id, 1, 1)), ["checkpoint"], jobsDeps(live()));
      assert.equal(late.status, 409);
      const row = await runRow(run.id);
      assert.deepEqual([row.status, row.checkpoint], ["running", { cursor: 5 }], "nothing changed");
      await testDb.update(realSchema.jobRuns).set({ attempt: 2 }).where(eq(realSchema.jobRuns.id, run.id));
      assert.equal((await handler.handleJobs(post("jobs/checkpoint", { done: true }, liveJob(run.id, 2, 1)), ["checkpoint"], jobsDeps(live()))).status, 409, "an earlier try of this tick");
      assert.equal((await handler.handleJobs(post("jobs/checkpoint", { done: true }, liveJob(run.id, 2, 2)), ["checkpoint"], jobsDeps(live()))).status, 200, "this try");
      assert.equal((await runRow(run.id)).status, "done");
    });

    it("a checkpoint over 64 KB is refused and changes nothing; an error fails the run and tells the owner", async () => {
      const run = await runningRun();
      const big = await handler.handleJobs(post("jobs/checkpoint", { state: "x".repeat(70_000), done: false }, liveJob(run.id)), ["checkpoint"], jobsDeps(live()));
      assert.equal(big.status, 400);
      assert.equal((await runRow(run.id)).status, "running");
      await handler.handleJobs(post("jobs/checkpoint", { done: true, error: "The feed was empty." }, liveJob(run.id)), ["checkpoint"], jobsDeps(live()));
      assert.deepEqual([(await runRow(run.id)).status, (await runRow(run.id)).error], ["failed", "The feed was empty."]);
      assert.equal((await notices())[0]!.body, "The feed was empty.");
    });

    it("enqueue takes the owner or a job, never a visitor or a product's bare call, and stops at 50 a day", async () => {
      assert.equal((await handler.handleJobs(post("jobs/enqueue", { name: "digest" }), ["enqueue"], jobsDeps(live()))).status, 403, "a bare call");
      assert.equal((await handler.handleJobs(post("jobs/enqueue", { name: "digest" }, { "x-musemuse-visitor": "visitor-aaaaaaaaaaaaaaaa" }), ["enqueue"], jobsDeps(live()))).status, 403, "a visitor");
      assert.equal((await handler.handleJobs(post("jobs/enqueue", { name: "../etc" }, owner()), ["enqueue"], jobsDeps(live()))).status, 400);
      const ok = await handler.handleJobs(post("jobs/enqueue", { name: "digest", input: { a: 1 } }, owner()), ["enqueue"], jobsDeps(live()));
      assert.equal(ok.status, 202);
      const [row] = await allRuns();
      assert.deepEqual([row!.trigger, row!.status, row!.namespace, row!.budgetUsd], ["enqueue", "queued", "live", 0.1]);
      assert.deepEqual(row!.input, { a: 1 });
      rates.set(`jobs-enqueue:${productId}`, JOBS_LIMITS.enqueuePerProductPerDay);
      assert.equal((await handler.handleJobs(post("jobs/enqueue", { name: "digest" }, owner()), ["enqueue"], jobsDeps(live()))).status, 429);
    });

    it("notify takes a job only, cleans its text, and stops at 10 a day", async () => {
      const run = await runningRun();
      assert.equal((await handler.handleJobs(post("jobs/notify", { title: "Hi" }, owner()), ["notify"], jobsDeps(live()))).status, 403);
      const ok = await handler.handleJobs(post("jobs/notify", { title: "  Digest\n ready ", body: "Three items." }, liveJob(run.id)), ["notify"], jobsDeps(live()));
      assert.equal(ok.status, 200);
      const [n] = await notices();
      assert.deepEqual([n!.title, n!.body, n!.kind, n!.namespace], ["Digest ready", "Three items.", "job", "live"]);
      rates.set(`jobs-notify:${productId}`, JOBS_LIMITS.notifyPerProductPerDay);
      assert.equal((await handler.handleJobs(post("jobs/notify", { title: "Again" }, liveJob(run.id)), ["notify"], jobsDeps(live()))).status, 429);
    });

    it("test-fire is a build's only, goes on from a checkpoint, and stops at its limit", async () => {
      assert.equal((await handler.handleJobs(post("jobs/test-fire", { name: "digest" }), ["test-fire"], jobsDeps(live()))).status, 403);
      const first = (await (await handler.handleJobs(post("jobs/test-fire", { name: "digest", input: { n: 1 } }), ["test-fire"], jobsDeps(buildToken()))).json()) as { token: string; runId: string; tick: number; simulated: boolean };
      assert.deepEqual([first.tick, first.simulated], [1, true]);
      const job = { "x-musemuse-job": first.token };
      const verify = (await (await handler.handleJobs(post("jobs/verify", {}, job), ["verify"], jobsDeps(buildToken()))).json()) as { input: unknown; simulated: boolean };
      assert.deepEqual(verify.input, { n: 1 });
      assert.equal(verify.simulated, true);
      await handler.handleJobs(post("jobs/checkpoint", { state: { cursor: 7 }, done: false }, job), ["checkpoint"], jobsDeps(buildToken()));
      const second = (await (await handler.handleJobs(post("jobs/test-fire", { name: "digest" }), ["test-fire"], jobsDeps(buildToken()))).json()) as { token: string; runId: string; tick: number };
      assert.deepEqual([second.runId, second.tick], [first.runId, 2], "the same run, its next tick");
      const resumed = (await (await handler.handleJobs(post("jobs/verify", {}, { "x-musemuse-job": second.token }), ["verify"], jobsDeps(buildToken()))).json()) as { checkpoint: unknown };
      assert.deepEqual(resumed.checkpoint, { cursor: 7 });
      await handler.handleJobs(post("jobs/checkpoint", { done: true }, { "x-musemuse-job": second.token }), ["checkpoint"], jobsDeps(buildToken()));
      const proof = await store.jobsProof(buildId, { since: null });
      assert.deepEqual([proof.fired, proof.done, proof.resumed, proof["brief:schedule:digest"], proof["brief:webhook:log"], proof["brief:result:digests"]], [1, 1, 1, 1, 1, 1]);
      rates.set(`jobs-test-fire:${buildId}`, JOBS_LIMITS.testFiresPerBuild);
      assert.equal((await handler.handleJobs(post("jobs/test-fire", { name: "digest" }), ["test-fire"], jobsDeps(buildToken()))).status, 429);
    });
  });

  describe("a whole build's test fires", () => {
    const fire = (body: unknown) => handler.handleJobs(post("jobs/test-fire", body), ["test-fire"], jobsDeps(buildToken()));
    // The biggest brief: 3 schedules, each fired twice, and 2 webhooks, each once with its hook address and then its fire.
    const smokeRun = async () => {
      const statuses: number[] = [];
      for (const name of ["one", "two", "three"]) for (let i = 0; i < 2; i++) statuses.push((await fire({ name })).status);
      for (const name of ["log", "form"]) {
        statuses.push((await fire({ name, hook: true })).status);
        statuses.push((await fire({ name })).status);
      }
      rates.delete(`jobs-test-fire-minute:${buildId}`);
      return statuses;
    };

    it("last through session verifies, platform verifies and all 3 fix rounds, on the biggest brief", async () => {
      // A first round and 3 fix rounds. Muse Code runs verify itself, say twice a round, and the platform once. The demo fires nothing.
      for (const round of [0, 1, 2, 3]) {
        for (const verify of ["session", "session", "platform"]) assert.deepEqual([...new Set(await smokeRun())], [200], `round ${round}, ${verify}`);
      }
    });

    it("a hook's address doesn't count as a fire, and has its own limit", async () => {
      rates.set(`jobs-test-fire:${buildId}`, JOBS_LIMITS.testFiresPerBuild);
      assert.equal((await fire({ name: "log", hook: true })).status, 200);
      assert.equal((await fire({ name: "log" })).status, 429);
      rates.delete(`jobs-test-fire:${buildId}`);
      rates.set(`jobs-test-hook:${buildId}`, JOBS_LIMITS.testFiresPerBuild);
      assert.equal((await fire({ name: "log", hook: true })).status, 429);
      assert.equal((await fire({ name: "log" })).status, 200);
    });

    it("stop at their per-minute limit", async () => {
      rates.set(`jobs-test-fire-minute:${buildId}`, JOBS_LIMITS.testFiresPerMinute);
      assert.equal((await fire({ name: "log" })).status, 429);
    });
  });

  describe("a flood of failures", () => {
    it("leaves one unread notice per job, from a failing tick or a stopped run", async () => {
      for (let i = 0; i < 5; i++) {
        const run = await runningRun({ name: "flaky" });
        assert.equal((await handler.handleJobs(post("jobs/checkpoint", { done: true, error: "It broke." }, liveJob(run.id)), ["checkpoint"], jobsDeps(live()))).status, 200);
      }
      assert.equal((await notices()).filter((n) => n.kind === "job_failed").length, 1);
    });
  });

  describe("text Postgres can't keep", () => {
    const sha = async (s: string) => (await import("node:crypto")).createHash("sha256").update(s).digest("hex");
    const hook = (body: string) => new Request(`https://platform.example/api/gateway/hooks/${productId}/log?k=s`, { method: "POST", body });
    it("a hook payload with a NUL, or broken text, is a plain 400", async () => {
      await store.saveWebhook(productId, "log", await sha("s"), NOW);
      for (const body of ['{"a":"x\\u0000y"}', '{"a\\u0000":1}', "plain\u0000words", '{"a":"\\ud800"}']) {
        assert.equal((await handler.handleHook(hook(body), [productId, "log"], hookDeps())).status, 400, body);
      }
      assert.equal((await allRuns()).length, 0);
      assert.equal((await handler.handleHook(hook('{"a":"a backslash \\\\u0000 is only text"}'), [productId, "log"], hookDeps())).status, 202);
    });
    it("a checkpoint, an enqueue and a notice with a NUL are refused, and the run goes on", async () => {
      const run = await runningRun();
      const body = (o: string) => new Request("https://platform.example/api/gateway/jobs/x", { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json", ...liveJob(run.id) }, body: o });
      assert.equal((await handler.handleJobs(body('{"state":{"a":"\\u0000"},"done":false}'), ["checkpoint"], jobsDeps(live()))).status, 400);
      assert.equal((await runRow(run.id)).status, "running");
      assert.equal((await handler.handleJobs(body('{"done":true,"error":"x\\u0000"}'), ["checkpoint"], jobsDeps(live()))).status, 400);
      assert.equal((await handler.handleJobs(body('{"name":"digest","input":{"a":"\\u0000"}}'), ["enqueue"], jobsDeps(live()))).status, 400);
      assert.equal((await handler.handleJobs(body('{"title":"x\\u0000"}'), ["notify"], jobsDeps(live()))).status, 400);
    });
  });

  describe("what's kept", () => {
    it("a run's input goes when it finishes, however it finishes", async () => {
      const closed = await runningRun({ input: { payload: "made up" } });
      await handler.handleJobs(post("jobs/checkpoint", { done: true }, liveJob(closed.id)), ["checkpoint"], jobsDeps(live()));
      assert.equal((await runRow(closed.id)).input, null);
      const next = await runningRun({ input: { payload: "made up" }, name: "second" });
      await handler.handleJobs(post("jobs/checkpoint", { state: { a: 1 }, done: false }, liveJob(next.id)), ["checkpoint"], jobsDeps(live()));
      assert.deepEqual((await runRow(next.id)).input, { payload: "made up" }, "a run still going keeps it");
      const stopped = await runningRun({ input: { payload: "made up" }, name: "third" });
      await store.stopRunForBudget(stopped.id, NOW);
      assert.equal((await runRow(stopped.id)).input, null);
      const tried = await runningRun({ input: { payload: "made up" }, name: "fourth", attempt: JOBS_LIMITS.maxAttempts });
      await store.retryOrFail({ id: tried.id, productId, name: "fourth", tick: 1, attempt: JOBS_LIMITS.maxAttempts, liveUrl: "x" }, "no", NOW);
      assert.equal((await runRow(tried.id)).input, null);
    });

    it("a run cancelled for waiting too long tells the owner once", async () => {
      await testDb.insert(realSchema.jobRuns).values([1, 2].map((i) => ({ productId, name: "old", trigger: "enqueue" as const, budgetUsd: 0.1, input: { i }, createdAt: new Date(NOW.getTime() - JOBS_LIMITS.runMaxAgeMs - 1000) })));
      await store.claimQueued(10, NOW);
      assert.deepEqual((await notices()).map((n) => n.title), ["A queued job waited too long"]);
      assert.equal((await allRuns())[0]!.input, null);
    });

    it("an unanswered held send expires: its address and words go, and the owner is told", async () => {
      const id = await held.holdJobSend({ productId, namespace: "live", send: { channel: "email", to: ["friend@example.com"], subject: "Plan", body: "Made-up words.", from: null }, lines: ["To: friend@example.com"], title: "Send this email?" });
      const fresh = new Date(Date.now() + JOBS_LIMITS.heldKeepMs - 60_000);
      await cleanup.sweepJobs(fresh);
      assert.equal((await notices())[0]!.kind, "send_held", "not yet");
      await cleanup.sweepJobs(new Date(Date.now() + JOBS_LIMITS.heldKeepMs + 60_000));
      const [n] = await notices();
      assert.deepEqual([n!.id, n!.kind, n!.payload], [id, "job", null]);
      assert.doesNotMatch(`${n!.title} ${n!.body}`, /friend@example|Made-up/);
      assert.ok(n!.resolvedAt, "it can't be answered");
      assert.equal(await store.claimNotice(id, NOW), false);
    });
  });

  describe("a job token after its run ended", () => {
    const write = (hdr: Record<string, string>) => data.handleData(post("data/digests?scope=shared", { data: { text: "made up" } }, hdr), ["digests"], dataDeps(live()));
    const read = (hdr: Record<string, string>) => data.handleData(post("data/digests/query?scope=shared", {}, hdr), ["digests", "query"], dataDeps(live()));

    for (const status of ["budget", "cancelled", "done", "failed"] as const) {
      it(`a ${status} run can't save, read, queue or draft a send`, async () => {
        const run = await runningRun({ status });
        const hdr = liveJob(run.id);
        assert.equal((await write(hdr)).status, 409);
        assert.equal((await read(hdr)).status, 409);
        assert.equal((await runRow(run.id)).rowsWritten, 0);
        assert.equal((await handler.handleJobs(post("jobs/enqueue", { name: "digest" }, hdr), ["enqueue"], jobsDeps(live()))).status, 409);
        assert.equal((await allRuns()).length, 1, "nothing queued");
        const connectDeps = { ...gate(live()), store: {} as never, vaultOn: () => true, sendsOn: () => true, keyring: () => null, rules: async () => ({ publicApis: [], keys: [{ service: "weather", why: "x" }], sends: [{ channel: "email", why: "x" }] }) as never, reserveCounter, recordUsage: async () => undefined, fetch: (async () => assert.fail("nothing goes out")) as typeof fetch, userAgent: "test", holdSend: held.holdJobSend, jobRun: store.jobsStore.getRun };
        assert.equal((await connect.handleSend(post("send", { channel: "email", to: ["friend@example.com"], subject: "Plan", body: "Made up." }, hdr), connectDeps)).status, 409);
        assert.equal((await notices()).length, 0, "no draft");
        const call = await connect.handleVault(post("vault/call", { name: "openweathermap", method: "GET", path: "/data/2.5/weather" }, hdr), ["call"], { ...connectDeps, rules: async () => ({ publicApis: [], keys: [{ service: "openweathermap", why: "x" }], sends: [] }) as never, store: { sealedKey: async () => null } as never });
        assert.equal(call.status, 409);
      });
    }

    it("a queued run between ticks can't either, and a running one still can", async () => {
      const run = await runningRun({ status: "queued" });
      assert.equal((await write(liveJob(run.id))).status, 409);
      await testDb.update(realSchema.jobRuns).set({ status: "running" }).where(eq(realSchema.jobRuns.id, run.id));
      assert.equal((await write(liveJob(run.id))).status, 201);
      assert.equal((await read(liveJob(run.id))).status, 200);
    });

    it("a token for a run that isn't in this product or space is refused", async () => {
      const elsewhere = await runningRun({ namespace: `b:${buildId}` });
      assert.equal((await write(liveJob(elsewhere.id))).status, 403);
    });

    it("with no way to read the run, a job is refused rather than trusted", async () => {
      const run = await runningRun();
      const { jobRun: _gone, ...noRead } = dataDeps(live());
      const res = await data.handleData(post("data/digests?scope=shared", { data: { text: "made up" } }, liveJob(run.id)), ["digests"], noRead);
      assert.equal(res.status, 403);
    });
  });

  describe("a job's writes", () => {
    const writeAs = (hdr: Record<string, string>, collection = "digests", tok = live()) => data.handleData(post(`data/${collection}?scope=shared`, { data: { text: "made up" } }, hdr), [collection], dataDeps(tok));

    it("go only to a collection the brief and the manifest both mark, and count on the run", async () => {
      const run = await runningRun();
      const ok = await writeAs(liveJob(run.id));
      assert.equal(ok.status, 201);
      assert.equal((await runRow(run.id)).rowsWritten, 1);
      const notes = await writeAs(liveJob(run.id), "notes");
      assert.equal(notes.status, 403);
      assert.equal(((await notes.json()) as { error: { code: string } }).error.code, "cap_not_allowed");
      assert.equal((await runRow(run.id)).rowsWritten, 1);
    });

    it("a manifest that drops the mark takes it away, and one can't add a mark the brief doesn't have", async () => {
      const run = await runningRun();
      const unmarked = { data: { collections: [{ name: "digests", scope: "shared" }, { name: "notes", scope: "shared", jobWrites: true }] } };
      assert.equal((await data.handleData(post("data/digests?scope=shared", { data: {} }, liveJob(run.id)), ["digests"], dataDeps(live(), unmarked))).status, 403, "the manifest dropped it");
      assert.equal((await data.handleData(post("data/notes?scope=shared", { data: {} }, liveJob(run.id)), ["notes"], dataDeps(live(), unmarked))).status, 403, "the manifest can't add one");
    });

    it("a job can update and read what it may, can't delete elsewhere, and can never read a visitor's items", async () => {
      const run = await runningRun();
      const put = await data.handleData(new Request("https://platform.example/api/gateway/data/digests/a1?scope=shared", { method: "PUT", headers: { authorization: "Bearer x", "content-type": "application/json", ...liveJob(run.id) }, body: JSON.stringify({ data: { n: 1 } }) }), ["digests", "a1"], dataDeps(live()));
      assert.ok(put.status < 300);
      assert.equal((await runRow(run.id)).rowsWritten, 1);
      const del = await data.handleData(new Request("https://platform.example/api/gateway/data/notes/a1?scope=shared", { method: "DELETE", headers: { authorization: "Bearer x", ...liveJob(run.id) } }), ["notes", "a1"], dataDeps(live()));
      assert.equal(del.status, 403);
      const read = await data.handleData(post("data/notes/query", { scope: "shared" }, liveJob(run.id)), ["notes", "query"], dataDeps(live()));
      assert.equal(read.status, 200, "a job reads shared items");
      const visitorRead = await data.handleData(post("data/mine/query", { scope: "visitor" }, { ...liveJob(run.id), "x-musemuse-visitor": "visitor-aaaaaaaaaaaaaaaa" }), ["mine", "query"], dataDeps(live()));
      assert.equal(visitorRead.status, 403, "not even carrying a visitor's id");
    });

    it("in a build too: the same rules hold, in the build's own space", async () => {
      const fire = (await (await handler.handleJobs(post("jobs/test-fire", { name: "digest" }), ["test-fire"], jobsDeps(buildToken()))).json()) as { token: string; runId: string };
      const hdr = { "x-musemuse-job": fire.token };
      assert.equal((await writeAs(hdr, "digests", buildToken())).status, 201);
      assert.equal((await writeAs(hdr, "notes", buildToken())).status, 403);
      const rows = await testDb.select().from(realSchema.productRows);
      assert.deepEqual(rows.map((r) => r.namespace), [`b:${buildId}`]);
      await handler.handleJobs(post("jobs/checkpoint", { done: true }, hdr), ["checkpoint"], jobsDeps(buildToken()));
      assert.equal((await store.jobsProof(buildId, { since: null })).rows, 1);
    });
  });

  describe("a job's sends", () => {
    const sendBody = { channel: "email", to: ["friend@example.com"], subject: "Plan", body: "Made-up words." };
    const connectDeps = (tok: CapToken, holdSend: boolean): import("@/lib/caps/connect/handler").ConnectDeps => ({
      ...gate(tok),
      store: {} as never,
      vaultOn: () => true,
      sendsOn: () => true,
      keyring: () => null,
      rules: async () => ({ publicApis: [], keys: [], sends: [{ channel: "email", why: "Plans." }] }) as never,
      reserveCounter,
      recordUsage: async () => undefined,
      fetch: (async () => assert.fail("nothing goes out")) as typeof fetch,
      userAgent: "test",
      ...(holdSend ? { holdSend: held.holdJobSend, jobRun: store.jobsStore.getRun } : {}),
    });

    it("become a notice with the whole message, whatever approval it claims, and nothing goes", async () => {
      const run = await runningRun();
      const res = await connect.handleSend(post("send", { ...sendBody, approval: "ap1.forged.1.x" }, liveJob(run.id)), connectDeps(live(), true));
      assert.equal(res.status, 200);
      const reply = (await res.json()) as { ok: boolean; code: string; id: string };
      assert.deepEqual([reply.ok, reply.code], [false, "held_for_owner"]);
      const [n] = await notices();
      assert.equal(n!.kind, "send_held");
      assert.match(n!.body, /To: friend@example\.com/);
      assert.match(n!.body, /Message: Made-up words\./);
      assert.equal((n!.payload as { send: { body: string } }).send.body, "Made-up words.");
    });

    it("stop at a day's limit per product", async () => {
      const run = await runningRun();
      rates.set(`jobs-held:${productId}`, JOBS_LIMITS.heldPerProductPerDay);
      assert.equal((await connect.handleSend(post("send", sendBody, liveJob(run.id)), connectDeps(live(), true))).status, 429);
      assert.equal((await notices()).length, 0);
    });

    it("stay at the top of the owner's list however many failures come after, and the rest is counted", async () => {
      const run = await runningRun();
      await connect.handleSend(post("send", sendBody, liveJob(run.id)), connectDeps(live(), true));
      for (let i = 0; i < 25; i++) await store.jobsStore.addNotice({ productId, namespace: "live", kind: "job", title: `Made up ${i}`, body: "" });
      const list = await store.listNotices(ownerId);
      assert.equal(list.length, 20);
      assert.equal(list[0]!.kind, "send_held");
      assert.equal(await store.countNotices(ownerId), 26);
    });

    it("are refused like anyone but the owner while the jobs cap is off", async () => {
      const run = await runningRun();
      const res = await connect.handleSend(post("send", sendBody, liveJob(run.id)), connectDeps(live(), false));
      assert.equal(res.status, 403);
      assert.equal((await notices()).length, 0);
    });

    it("are confirmed once by the owner: the sends switch, a key and the day's count still apply", async () => {
      const send = { channel: "email" as const, to: ["friend@example.com"], subject: "Plan", body: "Made-up words.", from: null };
      const base = { store: { sealedKey: async () => null, recordSend: async () => undefined }, sendsOn: () => true, keyring: () => null, reserveCounter, recordUsage: async () => undefined, fetch: (async () => assert.fail("nothing goes out")) as typeof fetch, userAgent: "test" } as never;
      const off = await connect.deliverHeldSend({ productId, send, nonce: "n1", now: NOW }, { ...(base as object), sendsOn: () => false } as never);
      assert.deepEqual([off.ok, !off.ok && off.code], [false, "sends_off"]);
      const noRing = await connect.deliverHeldSend({ productId, send, nonce: "n1", now: NOW }, base);
      assert.deepEqual([noRing.ok, !noRing.ok && noRing.code], [false, "sends_off"]);
      const id = await held.holdJobSend({ productId, namespace: "live", send, lines: ["x"], title: "Send this email?" });
      assert.equal(await store.claimNotice(id, NOW), true);
      assert.equal(await store.claimNotice(id, NOW), false, "one answer");
      await store.releaseNotice(id);
      assert.equal(await store.claimNotice(id, NOW), true, "given back when nothing went");
    });
  });

  describe("webhooks", () => {
    const hook = (k: string, body: BodyInit = '{"event":"made-up"}', name = "log") => new Request(`https://platform.example/api/gateway/hooks/${productId}/${name}?k=${k}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const sha = async (s: string) => (await import("node:crypto")).createHash("sha256").update(s).digest("hex");

    it("store the payload and queue the job for the right secret, and refuse a wrong one", async () => {
      await store.saveWebhook(productId, "log", await sha("good-secret"), NOW);
      assert.equal((await handler.handleHook(hook("wrong"), [productId, "log"], hookDeps())).status, 401);
      assert.equal((await handler.handleHook(hook(""), [productId, "log"], hookDeps())).status, 401);
      assert.equal((await allRuns()).length, 0);
      assert.equal((await handler.handleHook(hook("good-secret", undefined, "other"), [productId, "other"], hookDeps())).status, 401, "no hook by that name");
      const ok = await handler.handleHook(hook("good-secret"), [productId, "log"], hookDeps());
      assert.equal(ok.status, 202);
      const [run] = await allRuns();
      assert.deepEqual([run!.trigger, run!.name, run!.status, run!.namespace], ["webhook", "log", "queued", "live"]);
      assert.deepEqual((run!.input as { payload: unknown }).payload, { event: "made-up" });
    });

    it("keep text that isn't JSON, and refuse over 64 KB", async () => {
      await store.saveWebhook(productId, "log", await sha("s"), NOW);
      await handler.handleHook(hook("s", "plain words"), [productId, "log"], hookDeps());
      assert.equal(((await allRuns())[0]!.input as { payload: unknown }).payload, "plain words");
      assert.equal((await handler.handleHook(hook("s", "x".repeat(70_000)), [productId, "log"], hookDeps())).status, 400);
    });

    it("a replaced or removed hook's secret stops working, and a product has at most 2", async () => {
      await store.saveWebhook(productId, "log", await sha("old"), NOW);
      await store.saveWebhook(productId, "log", await sha("new"), NOW);
      assert.equal((await handler.handleHook(hook("old"), [productId, "log"], hookDeps())).status, 401);
      assert.equal((await handler.handleHook(hook("new"), [productId, "log"], hookDeps())).status, 202);
      assert.equal(await store.saveWebhook(productId, "second", await sha("a"), NOW), "ok");
      assert.equal(await store.saveWebhook(productId, "third", await sha("a"), NOW), "full");
      assert.equal(await store.revokeWebhook(productId, "log", NOW), true);
      assert.equal((await handler.handleHook(hook("new"), [productId, "log"], hookDeps())).status, 401);
    });

    it("are off with their flag, and closed while the product is off or its owner isn't a builder", async () => {
      await store.saveWebhook(productId, "log", await sha("s"), NOW);
      assert.equal((await handler.handleHook(hook("s"), [productId, "log"], hookDeps({ webhooksOn: () => false }))).status, 404);
      assert.equal((await handler.handleHook(hook("s"), [productId, "log"], hookDeps({ servedCaps: () => [] }))).status, 404);
      assert.equal((await handler.handleHook(hook("s"), [productId, "log"], hookDeps({ product: async () => product({ status: "disabled" }) }))).status, 403);
      assert.equal((await handler.handleHook(hook("s"), [productId, "log"], hookDeps({ product: async () => product({ ownerEmail: "guest@musemuse.invalid" }) }))).status, 403);
      assert.equal((await handler.handleHook(hook("s"), [productId, "log"], hookDeps({ liveToken: async () => ({ scope: "live", allowedModels: [] }) }))).status, 403);
      assert.equal((await allRuns()).length, 0);
    });

    it("stop at 60 a minute", async () => {
      await store.saveWebhook(productId, "log", await sha("s"), NOW);
      const [row] = await testDb.select().from(realSchema.productWebhooks);
      rates.set(`hook:${row!.id}`, JOBS_LIMITS.hookPerMinute);
      assert.equal((await handler.handleHook(hook("s"), [productId, "log"], hookDeps())).status, 429);
    });

    it("a build's test hook queues a run in the build's space, which the cron never touches, and its next fire runs it", async () => {
      const made = (await (await handler.handleJobs(post("jobs/test-fire", { name: "log", hook: true }), ["test-fire"], jobsDeps(buildToken()))).json()) as { hook: { url: string } };
      const res = await handler.handleHook(new Request(made.hook.url, { method: "POST", body: '{"event":"sample"}' }), [productId, "log"], hookDeps());
      assert.equal(res.status, 202);
      const deps = cronDeps(async () => assert.fail("the cron never calls a build's run"));
      await cron.runJobsCron(deps);
      const fired = (await (await handler.handleJobs(post("jobs/test-fire", { name: "log" }), ["test-fire"], jobsDeps(buildToken()))).json()) as { token: string; runId: string };
      const v = (await (await handler.handleJobs(post("jobs/verify", {}, { "x-musemuse-job": fired.token }), ["verify"], jobsDeps(buildToken()))).json()) as { input: { payload: unknown } };
      assert.deepEqual(v.input.payload, { event: "sample" });
      await handler.handleJobs(post("jobs/checkpoint", { done: true }, { "x-musemuse-job": fired.token }), ["checkpoint"], jobsDeps(buildToken()));
      assert.equal((await store.jobsProof(buildId, { since: null })).webhook_runs, 1);
    });
  });

  describe("the cron", () => {
    const schedule = async (over: Partial<typeof realSchema.productSchedules.$inferInsert> = {}) => {
      const [s] = await testDb.insert(realSchema.productSchedules).values({ productId, name: "digest", everyMinutes: 60, nextRunAt: new Date(NOW.getTime() - 1000), ...over }).returning();
      return s!;
    };

    it("fires a due schedule once, with a token, and moves it to its next slot", async () => {
      const s = await schedule();
      const deps = cronDeps(closes(true));
      const out = await cron.runJobsCron(deps);
      assert.deepEqual([out.queued, out.fired, out.failed], [1, 1, 0]);
      assert.deepEqual(deps.calls, ["https://digest.example.app/api/jobs/digest"]);
      const [run] = await allRuns();
      assert.deepEqual([run!.status, run!.trigger, run!.tick, run!.scheduleId], ["done", "schedule", 1, s.id]);
      const [after] = await testDb.select().from(realSchema.productSchedules);
      assert.equal(after!.nextRunAt.toISOString(), "2026-11-02T13:00:00.000Z");
      const again = await cron.runJobsCron(deps);
      assert.deepEqual([again.queued, again.fired], [0, 0], "not due again");
    });

    it("leaves a schedule that isn't due, a paused one, and a run already going", async () => {
      await schedule({ nextRunAt: new Date(NOW.getTime() + 60_000) });
      assert.equal((await cron.runJobsCron(cronDeps(closes(true)))).queued, 0);
      await testDb.delete(realSchema.productSchedules);
      await schedule({ pausedAt: NOW, pauseReason: "owner_away" });
      assert.equal((await cron.runJobsCron(cronDeps(closes(true)))).queued, 0);
      await testDb.delete(realSchema.productSchedules);
      const s = await schedule();
      await testDb.insert(realSchema.jobRuns).values({ productId, scheduleId: s.id, name: "digest", trigger: "schedule", budgetUsd: 0.1, status: "running", tick: 1, attempt: 1, startedAt: NOW });
      assert.equal((await cron.runJobsCron(cronDeps(closes(true)))).queued, 0, "the slot is skipped while its last run is going");
    });

    it("runs only for a live product of a signed-in builder", async () => {
      await schedule();
      const off = async (set: Partial<typeof realSchema.products.$inferInsert>) => {
        await testDb.update(realSchema.products).set(set).where(eq(realSchema.products.id, productId));
        const out = await cron.runJobsCron(cronDeps(async () => assert.fail("never called")));
        assert.equal(out.fired, 0, JSON.stringify(set));
      };
      await off({ status: "disabled" });
      await off({ status: "building" });
      await off({ status: "live", liveUrl: null });
      await off({ liveUrl: "https://digest.example.app", takenDownAt: NOW });
      await testDb.update(realSchema.products).set({ takenDownAt: null }).where(eq(realSchema.products.id, productId));
      await testDb.update(realSchema.users).set({ bannedAt: NOW }).where(eq(realSchema.users.id, ownerId));
      assert.equal((await cron.runJobsCron(cronDeps(async () => assert.fail("banned")))).fired, 0);
      await testDb.update(realSchema.users).set({ bannedAt: null, email: "guest@musemuse.invalid" }).where(eq(realSchema.users.id, ownerId));
      assert.equal((await cron.runJobsCron(cronDeps(async () => assert.fail("guest")))).fired, 0);
    });

    it("a checkpoint goes on at the next pass with the same run, one more tick", async () => {
      await schedule();
      await cron.runJobsCron(cronDeps(closes(false, { cursor: 1 })));
      const [first] = await allRuns();
      assert.deepEqual([first!.status, first!.tick, first!.attempt], ["queued", 1, 0], "the next tick waits for the next pass");
      const later = new Date(NOW.getTime() + 300_000);
      await cron.runJobsCron(cronDeps(closes(true, null), { now: () => later }));
      const all = await allRuns();
      assert.equal(all.length, 1);
      assert.deepEqual([all[0]!.status, all[0]!.tick], ["done", 2]);
    });

    it("tries a failed tick once more on the same tick, then fails it and tells the owner once", async () => {
      await schedule();
      const fail = async () => new Response("no", { status: 500 });
      const once = await cron.runJobsCron(cronDeps(fail));
      assert.equal(once.fired, 1, "a retry waits for the next pass");
      assert.deepEqual([(await allRuns())[0]!.status, (await notices()).length], ["queued", 0]);
      const later = new Date(NOW.getTime() + 300_000);
      await testDb.update(realSchema.productSchedules).set({ nextRunAt: new Date(NOW.getTime() + 3_600_000) });
      await cron.runJobsCron(cronDeps(fail, { now: () => later }));
      const [run] = await allRuns();
      assert.deepEqual([run!.status, run!.tick, run!.attempt], ["failed", 1, 2]);
      assert.match(run!.error ?? "", /500/);
      const list = await notices();
      assert.deepEqual(list.map((n) => [n.kind, n.title]), [["job_failed", "Job digest failed"]]);
      // Another failure of the same job adds no second unread notice.
      await testDb.update(realSchema.productSchedules).set({ nextRunAt: new Date(later.getTime() - 1000) });
      const later2 = new Date(later.getTime() + 300_000);
      await cron.runJobsCron(cronDeps(fail, { now: () => later }));
      await cron.runJobsCron(cronDeps(fail, { now: () => later2 }));
      assert.equal((await allRuns()).filter((r) => r.status === "failed").length, 2);
      assert.equal((await notices()).length, 1);
    });

    it("a route that doesn't finish its run fails it; a missing route says so", async () => {
      await schedule();
      await cron.runJobsCron(cronDeps(async () => Response.json({ ok: true })));
      assert.match((await allRuns())[0]!.error ?? "", /without finishing/);
      await client.exec("delete from job_runs; delete from owner_notices");
      await testDb.update(realSchema.productSchedules).set({ nextRunAt: new Date(NOW.getTime() - 1000) });
      await cron.runJobsCron(cronDeps(async () => new Response("", { status: 404 })));
      assert.match((await allRuns())[0]!.error ?? "", /no route/);
    });

    it("a timeout leaves the tick alone until its time runs out, then retries it, then fails it", async () => {
      await schedule();
      const timeout = async () => {
        throw Object.assign(new Error("slow"), { name: "TimeoutError" });
      };
      await cron.runJobsCron(cronDeps(timeout));
      assert.equal((await allRuns())[0]!.status, "running", "it may still be working");
      const later = new Date(NOW.getTime() + JOBS_LIMITS.staleMs + 1000);
      await testDb.update(realSchema.productSchedules).set({ nextRunAt: new Date(later.getTime() + 3_600_000) });
      await cron.runJobsCron(cronDeps(timeout, { now: () => later }));
      const [second] = await allRuns();
      assert.deepEqual([second!.status, second!.attempt, second!.tick], ["running", 2, 1], "retried on the same tick");
      const latest = new Date(later.getTime() + JOBS_LIMITS.staleMs + 1000);
      await cron.runJobsCron(cronDeps(async () => assert.fail("no third try"), { now: () => latest }));
      assert.equal((await allRuns())[0]!.status, "failed");
      assert.match((await notices())[0]!.body, /in time/);
    });

    it("stops at the day's runs, gives back what it didn't use, and 0 pauses everything", async () => {
      for (let i = 0; i < 12; i++) await store.jobsStore.queueRun({ productId, namespace: "live", name: `job-${i}`, trigger: "enqueue", budgetUsd: 0.1 });
      const seen: string[] = [];
      const out = await cron.runJobsCron(cronDeps(async (u, i, j) => (seen.push(u), closes(true)(u, i)), { dailyRuns: () => 5 }));
      assert.deepEqual([out.fired, out.capped], [5, true]);
      assert.equal(counters.get("jobs-runs"), 5);
      counters.clear();
      const rest = await cron.runJobsCron(cronDeps(closes(true)));
      assert.equal(rest.fired, 7);
      assert.equal(counters.get("jobs-runs"), 7, "what it reserved and didn't use came back");
      const paused = await cron.runJobsCron(cronDeps(async () => assert.fail("paused"), { dailyRuns: () => 0 }));
      assert.equal(paused.capped, true);
      await schedule();
      const free = await cron.runJobsCron(cronDeps(async () => assert.fail("paused"), { runUsd: () => 0 }));
      assert.deepEqual([free.queued, free.capped], [0, true]);
    });

    it("cancels a queued run older than two days, without calling it", async () => {
      await testDb.insert(realSchema.jobRuns).values({ productId, name: "old", trigger: "enqueue", budgetUsd: 0.1, createdAt: new Date(NOW.getTime() - JOBS_LIMITS.runMaxAgeMs - 1000) });
      await cron.runJobsCron(cronDeps(async () => assert.fail("too old")));
      assert.equal((await allRuns())[0]!.status, "cancelled");
    });
  });

  describe("one product can't take everyone's runs", () => {
    const otherProduct = async () => {
      const [other] = await testDb.insert(realSchema.products).values({ slug: "other", name: "Other", ownerId, status: "live", liveUrl: "https://other.example.app", ownerSeenAt: NOW, createdAt: NOW }).returning();
      return other!.id;
    };
    const queue = (id: string, n: number, at: Date) => testDb.insert(realSchema.jobRuns).values(Array.from({ length: n }, (_, i) => ({ productId: id, name: `job-${i}`, trigger: "webhook" as const, budgetUsd: 0.1, createdAt: new Date(at.getTime() + i) })));
    const closesAny = (seen: string[]) => async (u: string, init: RequestInit) => {
      seen.push(new URL(u).host);
      const token = new Headers(init.headers).get("x-musemuse-job")!;
      await testDb.update(realSchema.jobRuns).set({ status: "done" }).where(eq(realSchema.jobRuns.id, token.split(".")[2]!));
      return Response.json({ ok: true });
    };
    const anyProductDeps = (seen: string[], over: Partial<import("../cron").JobsCronDeps>) => ({ ...cronDeps(async () => assert.fail("unused")), fetch: (async (input: string, init: RequestInit) => closesAny(seen)(input, init)) as unknown as typeof fetch, ...over });

    it("a backlog on one product doesn't starve another's newer run", async () => {
      const other = await otherProduct();
      await queue(productId, 50, new Date(NOW.getTime() - 60_000));
      await queue(other, 1, NOW);
      const seen: string[] = [];
      const out = await cron.runJobsCron(anyProductDeps(seen, { dailyRuns: () => 2 }));
      assert.deepEqual([out.fired, out.capped], [2, true]);
      assert.deepEqual(seen.sort(), ["digest.example.app", "other.example.app"]);
    });

    it("takes turns across products in one batch, and uses spare room", async () => {
      const other = await otherProduct();
      await queue(productId, 30, new Date(NOW.getTime() - 60_000));
      await queue(other, 2, NOW);
      const batch = await store.claimQueued(10, NOW, NOW);
      assert.equal(batch.length, 10);
      assert.equal(batch.filter((r) => r.productId === other).length, 2, "the other product's two go in the first batch");
      assert.equal(new Set(batch.map((r) => r.id)).size, 10);
    });

    it("a product stops at its own ticks for the day: the rest wait unspent, the owner hears once, and others go on", async () => {
      const other = await otherProduct();
      await queue(productId, 6, new Date(NOW.getTime() - 60_000));
      await queue(other, 2, NOW);
      const seen: string[] = [];
      const out = await cron.runJobsCron(anyProductDeps(seen, { productDailyRuns: () => 3 }));
      assert.equal(seen.filter((h) => h === "digest.example.app").length, 3);
      assert.equal(seen.filter((h) => h === "other.example.app").length, 2);
      assert.equal(out.fired, 5);
      assert.equal(counters.get("jobs-runs"), 5, "the platform's count holds only what fired");
      const waiting = (await allRuns()).filter((r) => r.status === "queued");
      assert.equal(waiting.length, 3);
      assert.ok(waiting.every((r) => r.tick === 0 && r.attempt === 0), "a run given back has used no tick");
      assert.equal((await notices()).filter((n) => n.title === "Background jobs reached today's limit").length, 1);
      const later = new Date(NOW.getTime() + 300_000);
      const next = await cron.runJobsCron(anyProductDeps(seen, { productDailyRuns: () => 3, now: () => later }));
      assert.equal(next.fired, 0, "still over, next pass too");
      assert.equal((await notices()).filter((n) => n.title === "Background jobs reached today's limit").length, 1);
    });

    it("a hook is refused once the product has its queue full, and enqueue too", async () => {
      const sha = (await import("node:crypto")).createHash("sha256").update("s").digest("hex");
      await store.saveWebhook(productId, "log", sha, NOW);
      await queue(productId, JOBS_LIMITS.queuedPerProduct, NOW);
      const res = await handler.handleHook(new Request(`https://platform.example/api/gateway/hooks/${productId}/log?k=s`, { method: "POST", body: "{}" }), [productId, "log"], hookDeps());
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("retry-after"), "300");
      assert.equal((await handler.handleJobs(post("jobs/enqueue", { name: "digest" }, owner()), ["enqueue"], jobsDeps(live()))).status, 429);
      assert.equal((await allRuns()).length, JOBS_LIMITS.queuedPerProduct);
    });
  });

  describe("the owner away", () => {
    const AWAY = new Date(NOW.getTime() + 15 * 86_400_000);
    const awayJob = (runId: string) => ({ "x-musemuse-job": mintJobToken({ productId, runId, tick: 1, attempt: 1, expiresAt: new Date(AWAY.getTime() + 600_000) }) });
    const awayDeps = () => ({ ...jobsDeps(live()), now: () => AWAY });
    const hookAway = (k: string) => new Request(`https://platform.example/api/gateway/hooks/${productId}/log?k=${k}`, { method: "POST", body: "{}" });

    it("the cron runs no queued work for a product whose owner stayed away, and empties its queue", async () => {
      await testDb.insert(realSchema.jobRuns).values({ productId, name: "looper", trigger: "enqueue", budgetUsd: 0.1, createdAt: AWAY });
      assert.deepEqual(await store.claimQueued(10, AWAY, AWAY), [], "the claim itself refuses");
      const out = await cron.runJobsCron(cronDeps(async () => assert.fail("nobody's there"), { now: () => AWAY }));
      assert.equal(out.fired, 0);
      assert.equal((await allRuns())[0]!.status, "cancelled");
      const [n] = await notices();
      assert.equal(n!.kind, "schedule_paused");
      await cron.runJobsCron(cronDeps(async () => assert.fail("nobody's there"), { now: () => new Date(AWAY.getTime() + 300_000) }));
      assert.equal((await notices()).length, 1, "one notice, however long");
    });

    it("a job that enqueues itself stops: its token is refused past the cutoff, and works again after a visit", async () => {
      const run = await runningRun({ name: "looper" });
      const refused = await handler.handleJobs(post("jobs/enqueue", { name: "looper" }, awayJob(run.id)), ["enqueue"], awayDeps());
      assert.equal(refused.status, 403);
      assert.equal((await allRuns()).length, 1, "nothing queued");
      await store.noteOwnerSeen(productId, AWAY);
      assert.equal((await handler.handleJobs(post("jobs/enqueue", { name: "looper" }, awayJob(run.id)), ["enqueue"], awayDeps())).status, 202);
      await testDb.update(realSchema.jobRuns).set({ createdAt: AWAY });
      assert.equal((await store.claimQueued(10, AWAY, AWAY)).length, 1);
    });

    it("the owner's own enqueue isn't what's refused: a pass means they came", async () => {
      assert.equal((await handler.handleJobs(post("jobs/enqueue", { name: "digest" }, { "x-musemuse-owner": mintOwnerSession({ productId, subject: "owner-sub" }, AWAY).session }), ["enqueue"], awayDeps())).status, 202);
    });

    it("a webhook is refused past the cutoff until a visit, and a build's test hook isn't", async () => {
      const sha = (await import("node:crypto")).createHash("sha256").update("s").digest("hex");
      await store.saveWebhook(productId, "log", sha, NOW);
      const res = await handler.handleHook(hookAway("s"), [productId, "log"], hookDeps({ now: () => AWAY }));
      assert.equal(res.status, 403);
      assert.equal((await allRuns()).length, 0);
      await testDb.update(realSchema.jobRuns).set({ status: "done" });
      const made = (await (await handler.handleJobs(post("jobs/test-fire", { name: "log", hook: true }), ["test-fire"], jobsDeps(buildToken()))).json()) as { hook: { url: string } };
      assert.equal((await handler.handleHook(new Request(made.hook.url, { method: "POST", body: "{}" }), [productId, "log"], hookDeps({ now: () => AWAY }))).status, 202, "a build's test hook");
      await store.noteOwnerSeen(productId, AWAY);
      assert.equal((await handler.handleHook(hookAway("s"), [productId, "log"], hookDeps({ now: () => AWAY }))).status, 202);
    });

    it("a product with no visit recorded counts from when it was made", async () => {
      await testDb.update(realSchema.products).set({ ownerSeenAt: null, createdAt: new Date(NOW.getTime() - 20 * 86_400_000) }).where(eq(realSchema.products.id, productId));
      await store.jobsStore.queueRun({ productId, namespace: "live", name: "looper", trigger: "enqueue", budgetUsd: 0.1 });
      assert.deepEqual(await store.claimQueued(10, NOW, NOW), []);
    });
  });

  describe("schedules and the owner", () => {
    const schedule = async () => (await testDb.insert(realSchema.productSchedules).values({ productId, name: "digest", everyMinutes: 60, nextRunAt: new Date(NOW.getTime() - 1000) }).returning())[0]!;

    it("pause after 14 days with no visit, with one notice, and a visit starts them again", async () => {
      await schedule();
      const away = new Date(NOW.getTime() + 15 * 86_400_000);
      const out = await cron.runJobsCron(cronDeps(async () => assert.fail("paused"), { now: () => away }));
      assert.deepEqual([out.paused, out.fired], [1, 0]);
      const [s] = await testDb.select().from(realSchema.productSchedules);
      assert.equal(s!.pauseReason, "owner_away");
      assert.equal((await notices())[0]!.kind, "schedule_paused");
      await store.noteOwnerSeen(productId, away);
      const [back] = await testDb.select().from(realSchema.productSchedules);
      assert.deepEqual([back!.pausedAt, back!.pauseReason], [null, null]);
      assert.ok(back!.nextRunAt > away);
      const [p] = await testDb.select().from(realSchema.products);
      assert.equal(p!.ownerSeenAt!.getTime(), away.getTime());
    });

    it("don't pause at 13 days", async () => {
      await schedule();
      const soon = new Date(NOW.getTime() + 13 * 86_400_000);
      assert.equal((await cron.runJobsCron(cronDeps(closes(true), { now: () => soon }))).paused, 0);
    });

    it("a product with no visit recorded counts from when it was made", async () => {
      await testDb.update(realSchema.products).set({ ownerSeenAt: null, createdAt: new Date(NOW.getTime() - 20 * 86_400_000) }).where(eq(realSchema.products.id, productId));
      await schedule();
      assert.equal((await cron.runJobsCron(cronDeps(async () => assert.fail("paused")))).paused, 1);
    });

    it("pause when the product goes off, with its queue emptied, and a visit doesn't start them while it's off", async () => {
      await schedule();
      await store.jobsStore.queueRun({ productId, namespace: "live", name: "digest-2", trigger: "enqueue", budgetUsd: 0.1 });
      await store.jobsProductOff(productId);
      assert.equal((await testDb.select().from(realSchema.productSchedules))[0]!.pauseReason, "product_off");
      assert.equal((await allRuns())[0]!.status, "cancelled");
      await testDb.update(realSchema.products).set({ status: "disabled" }).where(eq(realSchema.products.id, productId));
      await store.noteOwnerSeen(productId, NOW);
      assert.equal((await testDb.select().from(realSchema.productSchedules))[0]!.pauseReason, "product_off", "still off");
      await testDb.update(realSchema.products).set({ status: "live" }).where(eq(realSchema.products.id, productId));
      await store.noteOwnerSeen(productId, NOW);
      assert.equal((await testDb.select().from(realSchema.productSchedules))[0]!.pausedAt, null);
    });

    it("go when a refinement's brief has no jobs: nothing fires, and what's queued is cancelled", async () => {
      const shipDeps: import("../ship").ShipJobsDeps = { readManifest: async () => null, syncSchedules: store.syncSchedules, clearSchedules: store.clearSchedules, now: () => NOW };
      const input = { buildId, productId, sandboxName: "sb", liveUrl: "https://digest.example.app" };
      await schedule();
      await store.jobsStore.queueRun({ productId, namespace: "live", name: "from-a-hook", trigger: "webhook", budgetUsd: 0.1 });
      const { runCapsShip, CAP_SHIP } = await import("@/lib/caps/ship-run");
      const lines = await runCapsShip({ ...input, brief: { title: "No jobs here" } as never }, ["jobs"], { ...CAP_SHIP, jobs: (i) => ship.shipJobs(i, shipDeps) });
      assert.match(lines.join(" "), /digest/);
      assert.equal((await testDb.select().from(realSchema.productSchedules)).length, 0);
      assert.equal((await allRuns())[0]!.status, "cancelled");
      const out = await cron.runJobsCron(cronDeps(async () => assert.fail("it's gone")));
      assert.deepEqual([out.queued, out.fired], [0, 0]);
    });

    it("a product that never had jobs is left alone, and says nothing", async () => {
      await testDb.update(realSchema.products).set({ ownerSeenAt: null }).where(eq(realSchema.products.id, productId));
      const shipDeps: import("../ship").ShipJobsDeps = { readManifest: async () => assert.fail("no manifest needed"), syncSchedules: store.syncSchedules, clearSchedules: store.clearSchedules, now: () => NOW };
      assert.equal(await ship.shipJobs({ buildId, productId, sandboxName: "sb", liveUrl: "https://digest.example.app", brief: { title: "No jobs" } as never }, shipDeps), null);
      assert.equal((await testDb.select().from(realSchema.products))[0]!.ownerSeenAt, null, "a deploy with no jobs isn't a visit");
    });

    it("come from the brief and manifest at deploy: a manifest narrows and can change the time, never adds or goes under 15 minutes", async () => {
      const input = { buildId, productId, sandboxName: "sb", liveUrl: "https://digest.example.app", brief: BRIEF as never };
      const deps = (manifest: unknown): import("../ship").ShipJobsDeps => ({ readManifest: async () => manifest, syncSchedules: store.syncSchedules, clearSchedules: store.clearSchedules, now: () => NOW });
      assert.match((await ship.shipJobs(input, deps(null))) ?? "", /Schedules on: digest/);
      let rows = await testDb.select().from(realSchema.productSchedules);
      assert.deepEqual(rows.map((r) => [r.name, r.everyMinutes, r.atMinute, r.tz]), [["digest", 1440, 450, "UTC"]]);
      await ship.shipJobs(input, deps({ jobs: { schedules: [{ name: "digest", every: "1 minute" }, { name: "sneaky", every: "1 hour" }] } }));
      rows = await testDb.select().from(realSchema.productSchedules);
      assert.deepEqual(rows.map((r) => [r.name, r.everyMinutes]), [["digest", 15]], "floored, and no new schedule");
      await testDb.update(realSchema.productSchedules).set({ pausedAt: NOW, pauseReason: "owner_away" });
      await store.jobsStore.queueRun({ productId, namespace: "live", name: "digest", trigger: "schedule", budgetUsd: 0.1 });
      await ship.shipJobs(input, deps({ jobs: { schedules: [] } }));
      assert.equal((await testDb.select().from(realSchema.productSchedules)).length, 0, "a refinement that removes it");
      assert.equal((await allRuns())[0]!.status, "cancelled");
      await ship.shipJobs(input, deps(null));
      assert.equal((await testDb.select().from(realSchema.productSchedules))[0]!.pausedAt, null);
    });
  });

  describe("cleanup and the record", () => {
    it("a build's rows go when it ends, live rows stay", async () => {
      const ns = `b:${buildId}`;
      await store.jobsStore.addNotice({ productId, namespace: ns, kind: "job", title: "Test", body: "" });
      await store.jobsStore.addNotice({ productId, namespace: "live", kind: "job", title: "Live", body: "" });
      await store.jobsStore.queueRun({ productId, namespace: ns, name: "a", trigger: "test", budgetUsd: 0.1 });
      await store.jobsStore.queueRun({ productId, namespace: "live", name: "a", trigger: "enqueue", budgetUsd: 0.1 });
      await store.jobsStore.saveTestWebhook(productId, ns, "log", "h");
      await cleanup.clearJobsBuild(buildId);
      assert.deepEqual((await notices()).map((n) => n.title), ["Live"]);
      assert.deepEqual((await allRuns()).map((r) => r.namespace), ["live"]);
      assert.equal((await testDb.select().from(realSchema.productWebhooks)).length, 0);
    });

    it("the hourly sweep takes old rows and a crashed build's, and leaves the rest", async () => {
      const now = NOW;
      const old = new Date(now.getTime() - JOBS_LIMITS.keepRunsMs - 1000);
      await testDb.insert(realSchema.jobRuns).values([
        { productId, name: "old", trigger: "schedule", budgetUsd: 0.1, status: "done", finishedAt: old },
        { productId, name: "recent", trigger: "schedule", budgetUsd: 0.1, status: "done", finishedAt: now },
        { productId, name: "crashed", trigger: "test", budgetUsd: 0.1, namespace: "b:gone", createdAt: new Date(now.getTime() - 2 * 86_400_000) },
      ]);
      await testDb.insert(realSchema.ownerNotices).values([
        { productId, kind: "job", title: "read long ago", readAt: new Date(now.getTime() - JOBS_LIMITS.keepNoticesMs - 1000) },
        { productId, kind: "job", title: "unread", createdAt: old },
      ]);
      await testDb.insert(realSchema.productWebhooks).values({ productId, name: "gone", secretHash: "h", revokedAt: new Date(now.getTime() - 2 * 86_400_000) });
      assert.equal(await cleanup.sweepJobs(now), 4);
      assert.deepEqual((await allRuns()).map((r) => r.name), ["recent"]);
      assert.deepEqual((await notices()).map((n) => n.title), ["unread"]);
    });

    it("the record counts from `since`, and only the build's own", async () => {
      const ns = `b:${buildId}`;
      const at = (ms: number) => new Date(NOW.getTime() + ms);
      await testDb.insert(realSchema.jobRuns).values([
        { productId, name: "before", trigger: "test", budgetUsd: 0.1, namespace: ns, status: "done", tick: 1, startedAt: at(-1000), finishedAt: at(-500), rowsWritten: 5 },
        { productId, name: "after", trigger: "test", budgetUsd: 0.1, namespace: ns, status: "done", tick: 2, startedAt: at(1000), finishedAt: at(2000), rowsWritten: 1 },
        { productId, name: "live", trigger: "schedule", budgetUsd: 0.1, status: "done", tick: 1, startedAt: at(1000), finishedAt: at(2000), rowsWritten: 9 },
      ]);
      const proof = await store.jobsProof(buildId, { since: NOW });
      assert.deepEqual([proof.fired, proof.done, proof.resumed, proof.rows], [1, 1, 1, 1]);
    });

    it("a person sees only their own products' live notices", async () => {
      await store.jobsStore.addNotice({ productId, namespace: "live", kind: "job", title: "Mine", body: "" });
      await store.jobsStore.addNotice({ productId, namespace: `b:${buildId}`, kind: "job", title: "Test", body: "" });
      assert.deepEqual((await store.listNotices(ownerId)).map((n) => n.title), ["Mine"]);
      const [other] = await testDb.insert(realSchema.users).values({ email: "other@example.com" }).returning();
      assert.equal((await store.listNotices(other!.id)).length, 0);
      assert.equal(await store.noticeOf(productId, "not-a-uuid"), null);
      const panel = await store.jobsPanel(productId);
      assert.deepEqual([panel.schedules.length, panel.runs.length], [0, 0]);
    });
  });
});

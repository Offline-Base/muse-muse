/**
 * The lab's queue on a real Postgres (PGlite): claims in priority order with selftest cleared and the deadline set, a token
 * that only works while its run owns the job, the caps and TTLs at enqueue, one retry and then failure, the sweep's silent
 * and expired jobs, the build log, and the retry list that has to match the agent's own.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/native/__tests__/queue.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import { macInput, type Seeded, type TestDb } from "./helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const SAVED = { ...process.env };
const HOUR = 3_600_000;

describe("the lab's queue", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let testDb: TestDb;
  let close: () => Promise<void>;
  let queue: typeof import("@/lib/native/queue");
  let seed: (origin?: "ship" | "agent") => Promise<Seeded>;

  before(async () => {
    const helpers = await import("./helpers");
    ({ db: testDb, close } = await helpers.makeTestDb());
    seed = (origin) => helpers.seedRun(testDb, origin);
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    process.env.NATIVE_LAB = "1";
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-the-queue";
    process.env.PLATFORM_URL = "https://platform.example.com";
    queue = await import(at("../queue.ts"));
  });
  after(async () => {
    await close();
    process.env = { ...SAVED };
  });
  beforeEach(async () => {
    await testDb.delete(realSchema.nativeArtifacts);
    await testDb.delete(realSchema.nativeJobs);
    await testDb.delete(realSchema.buildEvents);
  });

  /** The Windows box comes up unless a test says otherwise. Waking it for real has its own suite, lab-box.test.ts. */
  let wakeWindows = async (): Promise<{ started: boolean; reason: string }> => ({ started: true, reason: "started" });
  async function enqueue(s: Seeded, over: Partial<import("@/lib/native/queue").EnqueueInput> = {}) {
    return queue.enqueueJob({ runId: s.runId, buildId: s.buildId, productId: s.productId, kind: "desktop_mac", tier: "ship", input: macInput(), ...over }, { wakeWindows: () => wakeWindows() });
  }
  async function enqueued(s: Seeded, over: Partial<import("@/lib/native/queue").EnqueueInput> = {}) {
    const job = await enqueue(s, over);
    assert.ok(job.ok, JSON.stringify(job));
    return job.jobId;
  }
  const row = async (id: string) => (await testDb.select().from(realSchema.nativeJobs).where(eq(realSchema.nativeJobs.id, id)))[0]!;
  const events = async (buildId: string) =>
    (await testDb.select().from(realSchema.buildEvents).where(eq(realSchema.buildEvents.buildId, buildId))).map((e) => e.payload as unknown as Record<string, unknown>);

  it("claims the highest priority first, then the oldest", async () => {
    const s = await seed();
    const low = await enqueued(s, { tier: "backfill", kind: "ios_sim" });
    const shipFirst = await enqueued(s, { tier: "ship", kind: "android_emu" });
    const shipSecond = await enqueued(s, { tier: "ship", kind: "desktop_mac" });
    const agent = await enqueued(s, { tier: "agent", kind: "glasses_sim" });
    const kinds = ["ios_sim", "android_emu", "desktop_mac", "glasses_sim"];
    assert.equal((await queue.claimJob("mac", kinds))?.job.id, agent);
    assert.equal((await queue.claimJob("mac", kinds))?.job.id, shipFirst);
    assert.equal((await queue.claimJob("mac", kinds))?.job.id, shipSecond);
    assert.equal((await queue.claimJob("mac", kinds))?.job.id, low);
    assert.equal(await queue.claimJob("mac", kinds), null);
  });

  it("gives a job to one claim only, and sets everything in that one statement", async () => {
    const s = await seed();
    const id = await enqueued(s);
    await testDb.update(realSchema.nativeJobs).set({ selftest: { at: "old report" } }).where(eq(realSchema.nativeJobs.id, id));
    const [a, b] = await Promise.all([queue.claimJob("mac", ["desktop_mac"]), queue.claimJob("mac", ["desktop_mac"])]);
    const claimed = a ?? b;
    assert.ok(claimed && !(a && b), "exactly one claim got it");
    const job = await row(id);
    assert.equal(job.status, "claimed");
    assert.equal(job.attempts, 1);
    assert.equal(job.selftest, null, "the claim clears the report");
    assert.ok(job.claimedAt && job.heartbeatAt);
    assert.ok(Math.abs(job.deadlineAt!.getTime() - job.claimedAt!.getTime() - 240_000) < 2000, "the deadline is limitSeconds out");
    assert.notEqual(job.tokenHash, claimed.token, "only the hash is stored");
    assert.match(job.tokenHash!, /^[a-f0-9]{64}$/);
  });

  it("only offers what the box said it can run, on its own lane", async () => {
    const s = await seed();
    await enqueued(s, { kind: "desktop_windows" });
    await enqueued(s, { kind: "ios_sim" });
    assert.equal(await queue.claimJob("mac", ["android_emu"]), null);
    assert.equal(await queue.claimJob("mac", ["desktop_windows"]), null, "Windows jobs aren't a Mac's");
    assert.equal(await queue.claimJob("mac", ["nonsense"]), null);
    assert.equal(await queue.claimJob("mac", []), null);
    assert.equal((await queue.claimJob("windows", ["desktop_windows"]))?.job.kind, "desktop_windows");
    assert.equal((await queue.claimJob("mac", ["ios_sim"]))?.job.kind, "ios_sim");
  });

  it("won't claim a job past its TTL", async () => {
    const s = await seed();
    const id = await enqueued(s);
    await testDb.update(realSchema.nativeJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(realSchema.nativeJobs.id, id));
    assert.equal(await queue.claimJob("mac", ["desktop_mac"]), null);
  });

  it("sets the TTL and priority for each tier", async () => {
    const s = await seed();
    const cases = { agent: [30, 10], ship: [20, 45], batch: [20, 90], backfill: [10, 360] } as const;
    for (const [tier, [priority, minutes]] of Object.entries(cases)) {
      const job = await row(await enqueued(s, { tier: tier as keyof typeof cases, kind: "android_emu" }));
      assert.equal(job.priority, priority, tier);
      assert.ok(Math.abs(job.expiresAt.getTime() - job.createdAt.getTime() - minutes * 60_000) < 5000, tier);
      await testDb.delete(realSchema.nativeJobs);
    }
  });

  it("refuses when the lab is off, or the input can't run", async () => {
    const s = await seed();
    process.env.NATIVE_LAB = "";
    const off = await enqueue(s);
    assert.equal(off.ok === false && off.reason, "lab_off");
    process.env.NATIVE_LAB = "1";
    for (const limitSeconds of [10, 901, 1.5]) {
      const bad = await enqueue(s, { input: macInput({ limitSeconds }) });
      assert.equal(bad.ok === false && bad.reason, "bad_input", String(limitSeconds));
    }
    assert.equal((await testDb.select().from(realSchema.nativeJobs)).length, 0);
  });

  it("keeps at most 2 of a kind per product, while a phone and desktop product's four checks all fit", async () => {
    const s = await seed();
    for (const kind of ["ios_sim", "android_emu", "desktop_mac", "desktop_windows"] as const) await enqueued(s, { kind });
    await enqueued(s, { kind: "ios_sim" });
    const refused = await enqueue(s, { kind: "ios_sim" });
    assert.equal(refused.ok === false && refused.reason, "product_full");
    assert.equal((await enqueue(await seed(), { kind: "ios_sim" })).ok, true, "another product isn't held back");
  });

  it("frees a place when a job ends", async () => {
    const s = await seed();
    const first = await enqueued(s);
    await enqueued(s);
    assert.equal((await enqueue(s)).ok, false);
    await testDb.update(realSchema.nativeJobs).set({ status: "done" }).where(eq(realSchema.nativeJobs.id, first));
    assert.equal((await enqueue(s)).ok, true);
  });

  it("keeps at most 30 queued or running across every product", async () => {
    const first = await seed();
    const input = macInput();
    await testDb.insert(realSchema.nativeJobs).values(
      Array.from({ length: 30 }, () => ({
        runId: first.runId,
        buildId: first.buildId,
        productId: first.productId,
        lane: "mac" as const,
        kind: "desktop_mac" as const,
        input,
        expiresAt: new Date(Date.now() + HOUR),
      })),
    );
    const refused = await enqueue(await seed());
    assert.equal(refused.ok === false && refused.reason, "queue_full");
  });

  it("lets a build have one agent run going, whatever its size", async () => {
    const s = await seed();
    await enqueued(s, { tier: "agent", kind: "ios_sim" });
    await enqueued(s, { tier: "agent", kind: "android_emu" });
    const [second] = await testDb.insert(realSchema.nativeRuns).values({ productId: s.productId, buildId: s.buildId, origin: "agent", targets: ["web", "phone"] }).returning();
    const refused = await enqueue({ ...s, runId: second!.id }, { tier: "agent", kind: "desktop_mac" });
    assert.equal(refused.ok === false && refused.reason, "agent_busy");
    assert.equal((await enqueue({ ...s, runId: second!.id }, { tier: "ship", kind: "desktop_mac" })).ok, true, "a shipping check isn't an agent run");
  });

  it("hands a lab shell's job a selftest token at each claim, naming the job and the attempt, and never stores it", async () => {
    const { verifySelftestToken } = await import("@/lib/native/lab-token");
    const s = await seed();
    const id = await enqueued(s, { selftest: true, kind: "ios_sim" });
    assert.deepEqual((await row(id)).input.selftest, { platformUrl: "https://platform.example.com" });
    const first = (await queue.claimJob("mac", ["ios_sim"]))!;
    const selftest = first.job.input.selftest as { token: string; platformUrl: string };
    assert.deepEqual(verifySelftestToken(selftest.token), { jobId: id, attempt: 1 });
    assert.equal(selftest.platformUrl, "https://platform.example.com");
    assert.ok(!JSON.stringify(await row(id)).includes(selftest.token));
    const deadline = first.job.deadlineAt!.getTime();
    assert.ok(verifySelftestToken(selftest.token, new Date(deadline + 14 * 60_000)), "good while the job token is");
    assert.equal(verifySelftestToken(selftest.token, new Date(deadline + 16 * 60_000)), null);
    assert.equal((await row(await enqueued(s))).input.selftest, undefined);
  });

  it("says how far back a job is, counting priority and what's already running", async () => {
    const s = await seed();
    const running = await enqueued(s, { kind: "ios_sim" });
    await queue.claimJob("mac", ["ios_sim"]);
    const ship = await enqueue(s, { kind: "android_emu" });
    assert.ok(ship.ok);
    assert.equal(ship.ahead, 1, "one running");
    const later = await enqueue(s, { kind: "desktop_mac" });
    assert.ok(later.ok);
    assert.equal(later.ahead, 2);
    assert.equal(later.etaSeconds, 180);
    const urgent = await enqueue(s, { kind: "glasses_sim", tier: "agent" });
    assert.ok(urgent.ok);
    assert.equal(urgent.ahead, 1, "ahead of the queued ship checks");
    assert.equal((await queue.queuePosition(later.jobId))?.ahead, 3, "now behind the agent's job too");
    assert.equal(await queue.queuePosition(running), null, "a running job has no place in line");
    const windows = await enqueue(s, { kind: "desktop_windows" });
    assert.ok(windows.ok);
    assert.equal(windows.ahead, 0, "another lane's line is its own");
  });

  it("a token only works while its run owns the job", async () => {
    const s = await seed();
    const id = await enqueued(s);
    const first = (await queue.claimJob("mac", ["desktop_mac"]))!;
    assert.equal(await queue.recordHeartbeat(id, first.token), true);
    assert.equal(await queue.recordHeartbeat(id, "not-its-token"), false);
    assert.equal((await queue.ownedJob(id, first.token))?.id, id);
    assert.equal(await queue.ownedJob(id, "not-its-token"), null);

    // The sweep re-queues it: the old run is out of the job at once, before anything claims it.
    await testDb.update(realSchema.nativeJobs).set({ heartbeatAt: new Date(Date.now() - HOUR) }).where(eq(realSchema.nativeJobs.id, id));
    assert.deepEqual(await queue.requeueSilentJobs(), { requeued: 1, failed: 0 });
    assert.equal((await row(id)).tokenHash, null);
    assert.equal(await queue.recordHeartbeat(id, first.token), false);
    assert.equal(await queue.ownedJob(id, first.token), null);
    const stale = await queue.finishJob((await row(id))!, first.token, { outcome: "passed", summary: "x" }, []);
    assert.deepEqual(stale, { state: "gone" });
    assert.equal((await row(id)).status, "queued", "an old run's finish can't close the queued job");

    // The retry claims it: the old token still does nothing, and the new one works.
    const second = (await queue.claimJob("mac", ["desktop_mac"]))!;
    assert.equal(second.job.attempts, 2);
    assert.notEqual(second.token, first.token);
    assert.equal(await queue.recordHeartbeat(id, first.token), false);
    assert.equal(await queue.recordHeartbeat(id, second.token), true);
    assert.deepEqual(await queue.finishJob(await row(id), first.token, { outcome: "passed", summary: "x" }, []), { state: "gone" });
    assert.equal((await row(id)).status, "claimed");
  });

  it("stops a token 15 minutes after the job's deadline", async () => {
    const s = await seed();
    const id = await enqueued(s);
    const { token } = (await queue.claimJob("mac", ["desktop_mac"]))!;
    await testDb.update(realSchema.nativeJobs).set({ deadlineAt: new Date(Date.now() - 14 * 60_000) }).where(eq(realSchema.nativeJobs.id, id));
    assert.equal(await queue.recordHeartbeat(id, token), true);
    await testDb.update(realSchema.nativeJobs).set({ deadlineAt: new Date(Date.now() - 16 * 60_000) }).where(eq(realSchema.nativeJobs.id, id));
    assert.equal(await queue.recordHeartbeat(id, token), false);
  });

  it("closes a job and stores its files in one go, and a second finish changes nothing", async () => {
    const s = await seed();
    const id = await enqueued(s);
    const { token, job } = (await queue.claimJob("mac", ["desktop_mac"]))!;
    const artifact = { kind: "clip" as const, platform: "desktop_mac", device: "macOS 15", caption: "On a Mac", url: "https://x.blob.vercel-storage.com/a", pathname: "a", bytes: 10, sha256: null };
    const done = await queue.finishJob(job, token, { outcome: "passed", summary: "Checked on a Mac." }, [artifact]);
    assert.equal(done.state, "finished");
    const closed = await row(id);
    assert.equal(closed.status, "done");
    assert.equal(closed.tokenHash, null);
    assert.ok(closed.finishedAt);
    const rows = await testDb.select().from(realSchema.nativeArtifacts).where(eq(realSchema.nativeArtifacts.jobId, id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.check, "passed");
    assert.equal(rows[0]!.productId, s.productId);
    assert.equal(rows[0]!.runId, s.runId);
    assert.deepEqual(await queue.finishJob(job, token, { outcome: "passed", summary: "again" }, [artifact]), { state: "gone" });
    assert.equal((await testDb.select().from(realSchema.nativeArtifacts).where(eq(realSchema.nativeArtifacts.jobId, id))).length, 1);
  });

  it("maps outcomes to statuses, and a lab error isn't the product's failure", async () => {
    const s = await seed();
    const failedId = await enqueued(s, { kind: "ios_sim" });
    const failed = (await queue.claimJob("mac", ["ios_sim"]))!;
    await queue.finishJob(failed.job, failed.token, { outcome: "failed", summary: "It crashed." }, [
      { kind: "shot", platform: "ios_sim", device: null, caption: null, url: "u", pathname: "p", bytes: 1, sha256: null },
    ]);
    assert.equal((await row(failedId)).status, "failed");
    assert.equal((await testDb.select().from(realSchema.nativeArtifacts))[0]!.check, "failed");

    const labId = await enqueued(s, { kind: "android_emu" });
    const lab = (await queue.claimJob("mac", ["android_emu"]))!;
    const result = await queue.finishJob(lab.job, lab.token, { outcome: "lab_error", summary: "Not checked.", error: { code: "tool_missing", message: "x" } }, []);
    assert.equal(result.state, "finished");
    assert.equal((await row(labId)).status, "failed");
    const log = await events(s.buildId);
    assert.equal(log.find((e) => e.item === "check:android_emu" && e.title === "Not checked.")?.state, "skipped");
    assert.equal(log.find((e) => e.item === "check:ios_sim" && e.title === "It crashed.")?.state, "failed");
  });

  it("retries a lab error the box may do better at, once, and not the others", async () => {
    const s = await seed();
    const id = await enqueued(s);
    const first = (await queue.claimJob("mac", ["desktop_mac"]))!;
    const retried = await queue.finishJob(first.job, first.token, { outcome: "lab_error", summary: "x", error: { code: "agent_restarted", message: "y" } }, []);
    assert.equal(retried.state, "retrying");
    const queued = await row(id);
    assert.equal(queued.status, "queued");
    assert.equal(queued.tokenHash, null);
    assert.equal(queued.result, null);
    assert.equal(queued.deadlineAt, null);

    const second = (await queue.claimJob("mac", ["desktop_mac"]))!;
    assert.equal(second.job.attempts, 2);
    const final = await queue.finishJob(second.job, second.token, { outcome: "lab_error", summary: "Not checked.", error: { code: "agent_restarted", message: "y" } }, []);
    assert.equal(final.state, "finished");
    assert.equal((await row(id)).status, "failed");

    const other = await enqueued(s);
    const third = (await queue.claimJob("mac", ["desktop_mac"]))!;
    const noRetry = await queue.finishJob(third.job, third.token, { outcome: "lab_error", summary: "x", error: { code: "checksum_mismatch", message: "y" } }, []);
    assert.equal(noRetry.state, "finished");
    assert.equal((await row(other)).status, "failed");
  });

  it("retries the same codes the agent calls retryable", async () => {
    const { RETRYABLE_CODES } = (await import(at("../../../native/lab/lib/errors.mjs"))) as { RETRYABLE_CODES: string[] };
    assert.deepEqual([...queue.RETRYABLE_LAB_ERRORS].sort(), [...RETRYABLE_CODES].sort());
  });

  it("the sweep re-queues a silent job once, then fails it as a lab error", async () => {
    const s = await seed();
    const id = await enqueued(s);
    await queue.claimJob("mac", ["desktop_mac"]);
    assert.deepEqual(await queue.requeueSilentJobs(), { requeued: 0, failed: 0 }, "it only just claimed");
    const quiet = () => testDb.update(realSchema.nativeJobs).set({ heartbeatAt: new Date(Date.now() - 91_000) }).where(eq(realSchema.nativeJobs.id, id));
    await quiet();
    assert.deepEqual(await queue.requeueSilentJobs(), { requeued: 1, failed: 0 });
    await queue.claimJob("mac", ["desktop_mac"]);
    await quiet();
    assert.deepEqual(await queue.requeueSilentJobs(), { requeued: 0, failed: 1 });
    const job = await row(id);
    assert.equal(job.status, "failed");
    assert.equal(job.tokenHash, null);
    assert.equal(job.result?.outcome, "lab_error");
    assert.match(job.result?.summary ?? "", /^Not checked on a Mac/);
  });

  it("the sweep leaves a job with a recent heartbeat, and ends one that outlives its token however alive it seems", async () => {
    const s = await seed();
    const id = await enqueued(s);
    await queue.claimJob("mac", ["desktop_mac"]);
    await testDb.update(realSchema.nativeJobs).set({ heartbeatAt: new Date(Date.now() - 60_000) }).where(eq(realSchema.nativeJobs.id, id));
    assert.deepEqual(await queue.requeueSilentJobs(), { requeued: 0, failed: 0 });
    await testDb.update(realSchema.nativeJobs).set({ heartbeatAt: new Date(), deadlineAt: new Date(Date.now() - 16 * 60_000) }).where(eq(realSchema.nativeJobs.id, id));
    assert.deepEqual(await queue.requeueSilentJobs(), { requeued: 1, failed: 0 });
  });

  it("expires a queued job at its TTL: a shipped check gets a second try at low priority, an agent's doesn't", async () => {
    const s = await seed();
    const ship = await enqueued(s, { kind: "ios_sim", tier: "ship", selftest: true, input: macInput({ recordSeconds: 12 }) });
    const agent = await enqueued(s, { kind: "android_emu", tier: "agent" });
    const live = await enqueued(s, { kind: "desktop_mac", tier: "ship" });
    await testDb.update(realSchema.nativeJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(realSchema.nativeJobs.id, ship));
    await testDb.update(realSchema.nativeJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(realSchema.nativeJobs.id, agent));
    assert.deepEqual(await queue.expireQueuedJobs(), { expired: 2, backfilled: 1 });
    assert.equal((await row(ship)).status, "expired");
    assert.equal((await row(agent)).status, "expired");
    assert.equal((await row(live)).status, "queued");
    const jobs = await testDb.select().from(realSchema.nativeJobs);
    const backfill = jobs.find((j) => j.status === "queued" && j.kind === "ios_sim");
    assert.ok(backfill, "a second try is queued");
    assert.equal(backfill.priority, 10);
    assert.equal(backfill.input.recordSeconds, 12);
    assert.notEqual(backfill.id, ship);
    assert.ok(backfill.input.selftest, "and it's still a lab shell's job");
    const log = await events(s.buildId);
    assert.ok(log.some((e) => e.item === "check:android_emu" && e.state === "skipped" && String(e.title).includes("the device lab was busy")));
    assert.deepEqual(await queue.expireQueuedJobs(), { expired: 0, backfilled: 0 });
  });

  it("tells the build room when a second try finds no room, so the check doesn't sit on queued", async () => {
    const s = await seed();
    const id = await enqueued(s, { kind: "ios_sim", tier: "ship" });
    await testDb.update(realSchema.nativeJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(realSchema.nativeJobs.id, id));
    // Two more of the kind take the product's places just as the first expires. Written directly, since the limit counts it.
    const { id: _, ...copy } = await row(id);
    const later = new Date(Date.now() + 60_000);
    await testDb.insert(realSchema.nativeJobs).values([{ ...copy, expiresAt: later }, { ...copy, expiresAt: later }]);
    assert.deepEqual(await queue.expireQueuedJobs(), { expired: 1, backfilled: 0 });
    const last = (await events(s.buildId)).filter((e) => e.item === "check:ios_sim").at(-1)!;
    assert.equal(last.state, "skipped");
    assert.match(String(last.title), /the device lab was busy/);
  });

  it("does nothing to cancel with the lab off", async () => {
    const s = await seed();
    await enqueued(s, { tier: "agent" });
    process.env.NATIVE_LAB = "";
    try {
      assert.equal(await queue.cancelAgentJobs(s.buildId), 0);
    } finally {
      process.env.NATIVE_LAB = "1";
    }
  });

  it("a backfill that expires isn't tried a third time", async () => {
    const s = await seed();
    const id = await enqueued(s, { tier: "backfill" });
    await testDb.update(realSchema.nativeJobs).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(realSchema.nativeJobs.id, id));
    assert.deepEqual(await queue.expireQueuedJobs(), { expired: 1, backfilled: 0 });
  });

  it("cancels only the build's agent jobs, queued or running, and shuts out a running box", async () => {
    const s = await seed();
    const queuedId = await enqueued(s, { tier: "agent", kind: "ios_sim" });
    const runningId = await enqueued(s, { tier: "agent", kind: "android_emu" });
    const shipId = await enqueued(s, { tier: "ship", kind: "desktop_mac" });
    const otherBuild = await seed();
    const otherId = await enqueued(otherBuild, { tier: "agent", kind: "ios_sim" });
    const claimed = (await queue.claimJob("mac", ["android_emu"]))!;
    assert.equal(claimed.job.id, runningId);
    assert.equal(await queue.cancelAgentJobs(s.buildId), 2);
    assert.equal((await row(queuedId)).status, "canceled");
    assert.equal((await row(runningId)).status, "canceled");
    assert.equal((await row(shipId)).status, "queued");
    assert.equal((await row(otherId)).status, "queued");
    assert.equal(await queue.recordHeartbeat(runningId, claimed.token), false);
  });

  it("writes each step in the build's log in the shape the build room condenses", async () => {
    const { condenseNativeEvents } = await import("@/lib/types");
    const s = await seed("ship");
    await enqueued(s);
    const { job, token } = (await queue.claimJob("mac", ["desktop_mac"]))!;
    let runs = condenseNativeEvents((await events(s.buildId)) as Array<{ type: string }>);
    assert.equal(runs[0]!.origin, "ship");
    assert.equal(runs[0]!.items[0]!.state, "running");
    assert.equal(runs[0]!.active, true);
    await queue.finishJob(job, token, { outcome: "passed", summary: "Checked on a Mac: opened in 1.5 s." }, [
      { kind: "clip", platform: "desktop_mac", device: null, caption: "On a Mac", url: "https://b/clip.mp4", pathname: "p", bytes: 1, sha256: null },
      { kind: "poster", platform: "desktop_mac", device: null, caption: null, url: "https://b/poster.jpg", pathname: "q", bytes: 1, sha256: null },
    ]);
    runs = condenseNativeEvents((await events(s.buildId)) as Array<{ type: string }>);
    const item = runs[0]!.items[0]!;
    assert.equal(runs[0]!.active, false);
    assert.equal(item.item, "check:desktop_mac");
    assert.equal(item.target, "desktop");
    assert.equal(item.state, "done");
    assert.equal(item.title, "Checked on a Mac: opened in 1.5 s.");
    assert.deepEqual(item.media, [{ kind: "video", url: "https://b/clip.mp4", posterUrl: "https://b/poster.jpg", caption: "On a Mac" }]);
  });

  it("keeps a selftest report as sent, only while the job is running", async () => {
    const s = await seed();
    const id = await enqueued(s, { kind: "ios_sim" });
    const report = { v: 1, at: "2026-11-01T00:00:00.123Z", ok: true, nested: { keep: [1, 2] } };
    assert.equal(await queue.saveSelftest(id, 1, report), false, "still queued");
    const { token } = (await queue.claimJob("mac", ["ios_sim"]))!;
    assert.equal(await queue.saveSelftest(id, 2, report), false, "another attempt");
    assert.equal(await queue.saveSelftest(id, 1, report), true);
    assert.deepEqual((await queue.ownedJob(id, token))?.selftest, report);
  });

  it("takes a job whose input has text Postgres can't store, such as a product's name cut inside an emoji", async () => {
    const s = await seed();
    const name = "Demo \u{1F600}".slice(0, 6);
    const id = await enqueued(s, { input: macInput({ product: { name: `${name}\u0000`, slug: "demo" } }) });
    assert.deepEqual((await row(id)).input.product, { name: "Demo \ufffd", slug: "demo" });
  });

  it("a Windows job wakes the box, and comes straight out again if it can't start", async () => {
    const s = await seed();
    const asked: string[] = [];
    wakeWindows = async () => {
      asked.push("wake");
      return { started: true, reason: "started" };
    };
    await enqueued(s, { kind: "desktop_windows" });
    await enqueued(s, { kind: "ios_sim" });
    assert.deepEqual(asked, ["wake"], "only for Windows");

    for (const reason of ["over_budget", "blocked", "no_box", "failed"]) {
      await testDb.delete(realSchema.nativeJobs);
      wakeWindows = async () => ({ started: false, reason });
      const refused = await enqueue(s, { kind: "desktop_windows" });
      assert.equal(refused.ok === false && refused.reason, "box_down", reason);
      assert.equal((await testDb.select().from(realSchema.nativeJobs)).length, 0, "no row left behind");
    }
    assert.ok((await events(s.buildId)).some((e) => e.state === "skipped" && e.title === "Not checked on Windows this time: the Windows lab didn't start."));

    wakeWindows = async () => {
      throw new Error("EC2 is down");
    };
    const logged = mock.method(console, "error", () => {});
    assert.equal((await enqueue(s, { kind: "desktop_windows" })).ok, false);
    logged.mock.restore();

    wakeWindows = async () => ({ started: false, reason: "racing" });
    assert.equal((await enqueue(s, { kind: "desktop_windows" })).ok, true, "another caller is starting it");
    wakeWindows = async () => ({ started: true, reason: "started" });
  });

  it("reports a lane's activity for the idle backstop", async () => {
    const before = await queue.laneActivity("windows");
    assert.deepEqual(before, { queued: 0, claimed: 0, lastJobAt: null });
    const s = await seed();
    await enqueued(s, { kind: "desktop_windows" });
    assert.equal((await queue.laneActivity("windows")).queued, 1);
    const { job, token } = (await queue.claimJob("windows", ["desktop_windows"]))!;
    const running = await queue.laneActivity("windows");
    assert.equal(running.claimed, 1);
    assert.ok(running.lastJobAt instanceof Date);
    await queue.finishJob(job, token, { outcome: "passed", summary: "x" }, []);
    const finished = await queue.laneActivity("windows");
    assert.equal(finished.claimed, 0);
    assert.ok(finished.lastJobAt instanceof Date);
  });
});

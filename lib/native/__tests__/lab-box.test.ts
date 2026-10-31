/**
 * Keeping the lab boxes in order (lib/native/lab-box.ts): the pure plan, then the real thing on PGlite with AWS faked. The
 * point of it is the backstop: a Windows box that bills while nobody is using it has to stop, even when its agent never
 * starts, and the bill has to reach the ledger. The Mac is never stopped.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { eq, sql } from "drizzle-orm";
import * as realSchema from "@/lib/db/schema";
import type { BoxAws, WindowsFacts } from "@/lib/native/lab-box";
import { macInput, type Seeded, type TestDb } from "./helpers";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const SAVED = { ...process.env };
const MINUTE = 60_000;
const NOW = new Date("2026-11-02T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MINUTE);

/** A fake EC2 and SSM that remembers what it was told. */
function fakeAws(state = "stopped") {
  const calls: string[] = [];
  const aws: BoxAws & { state: string; failStart: boolean; ping: string | null } = {
    state,
    failStart: false,
    ping: "Online",
    async windowsBoxState() {
      calls.push("state");
      return this.state;
    },
    async startWindowsBox() {
      calls.push("start");
      if (this.failStart) throw new Error("no capacity");
      this.state = "pending";
    },
    async stopWindowsBox() {
      calls.push("stop");
      this.state = "stopping";
    },
    async labPing(lane) {
      calls.push(`ping:${lane}`);
      return this.ping;
    },
    async sendLabCommand(lane, action) {
      calls.push(`${action}:${lane}`);
      return "cmd-1";
    },
  };
  return Object.assign(aws, { calls });
}

describe("the lab boxes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let testDb: TestDb;
  let close: () => Promise<void>;
  let box: typeof import("@/lib/native/lab-box");
  let ledger: typeof import("@/lib/native/ledger");
  let queue: typeof import("@/lib/native/queue");
  let seed: () => Promise<Seeded>;

  before(async () => {
    const helpers = await import("./helpers");
    ({ db: testDb, close } = await helpers.makeTestDb());
    seed = () => helpers.seedRun(testDb);
    mock.module(at("../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    process.env.NATIVE_LAB = "1";
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-lab-box";
    process.env.PLATFORM_URL = "https://platform.example.com";
    box = await import(at("../lab-box.ts"));
    ledger = await import(at("../ledger.ts"));
    queue = await import(at("../queue.ts"));
  });
  after(async () => {
    await close();
    process.env = { ...SAVED };
  });
  beforeEach(async () => {
    await testDb.delete(realSchema.nativeJobs);
    await testDb.delete(realSchema.nativeSpend);
    await testDb.delete(realSchema.nativeBudget);
    await testDb.delete(realSchema.nativeLabs);
    process.env.NATIVE_WINDOWS_INSTANCE_ID = "i-0windows";
    process.env.NATIVE_MAC_INSTANCE_ID = "i-0mac";
    process.env.NATIVE_WINDOWS_HOURLY_USD = "1";
    process.env.NATIVE_WINDOWS_CAP_USD = "15";
    await box.setLabToken("windows", "w".repeat(64), "i-0windows");
    await box.setLabToken("mac", "m".repeat(64), "i-0mac");
  });

  const facts = (over: Partial<WindowsFacts> = {}): WindowsFacts => ({
    boxState: "running",
    control: { startedAt: ago(5).toISOString(), holdUsd: 2 },
    lastSeenAt: ago(0),
    queued: 0,
    claimed: 0,
    lastJobAt: null,
    holdAllowed: true,
    now: NOW,
    ...over,
  });
  const labRow = async (lane: "mac" | "windows") => (await testDb.select().from(realSchema.nativeLabs).where(eq(realSchema.nativeLabs.lane, lane)))[0]!;
  const setControl = (lane: "mac" | "windows", control: object, lastSeenAt: Date | null = null) =>
    testDb.update(realSchema.nativeLabs).set({ state: { control }, lastSeenAt }).where(eq(realSchema.nativeLabs.lane, lane));
  async function windowsJob(s: Seeded) {
    const job = await queue.enqueueJob({
      runId: s.runId,
      buildId: s.buildId,
      productId: s.productId,
      kind: "desktop_windows",
      tier: "ship",
      input: macInput({ app: { kind: "windows_zip", variant: "product", version: "1", url: "https://x.blob.vercel-storage.com/w.zip", sha256: "a".repeat(64) } }),
    }, { wakeWindows: async () => ({ started: true, reason: "started" }) });
    assert.ok(job.ok);
    return job.jobId;
  }

  describe("the plan", () => {
    it("leaves a healthy, recently used box alone", () => {
      assert.deepEqual(box.planWindows(facts()), { act: "none" });
    });

    it("stops a box with no jobs after 30 idle minutes, counting from the last job or the start", () => {
      const started = { startedAt: ago(120).toISOString(), holdUsd: 10 };
      assert.deepEqual(box.planWindows(facts({ control: started, lastJobAt: ago(29) })), { act: "none" });
      assert.deepEqual(box.planWindows(facts({ control: started, lastJobAt: ago(30) })), { act: "stop", reason: "idle" });
      assert.deepEqual(box.planWindows(facts({ control: { startedAt: ago(30).toISOString(), holdUsd: 2 } })), { act: "stop", reason: "idle" });
      assert.deepEqual(box.planWindows(facts({ control: started, lastJobAt: ago(40), queued: 1 })), { act: "none" }, "work is waiting");
      assert.deepEqual(box.planWindows(facts({ control: started, lastJobAt: ago(40), claimed: 1 })), { act: "none" }, "a job is running");
    });

    it("stops a box whose agent never spoke or went quiet, with work waiting or not, since nothing can run it", () => {
      const started = { startedAt: ago(11).toISOString(), holdUsd: 2 };
      assert.deepEqual(box.planWindows(facts({ control: started, lastSeenAt: null, queued: 3 })), { act: "stop", reason: "agent_silent" });
      assert.deepEqual(box.planWindows(facts({ control: started, lastSeenAt: ago(11) })), { act: "stop", reason: "agent_silent" });
      assert.deepEqual(box.planWindows(facts({ control: { startedAt: ago(9).toISOString(), holdUsd: 2 }, lastSeenAt: null })), { act: "none" }, "it may still be booting");
      assert.deepEqual(box.planWindows(facts({ control: { startedAt: ago(90).toISOString(), holdUsd: 2 }, lastSeenAt: ago(100) })), { act: "stop", reason: "agent_silent" });
    });

    it("starts counting afresh at a new start, however old the agent's last word", () => {
      assert.deepEqual(box.planWindows(facts({ control: { startedAt: ago(1).toISOString(), holdUsd: 2 }, lastSeenAt: ago(600), queued: 1 })), { act: "none" });
    });

    it("asks for the next hold before the first runs out, and adopts a box somebody started by hand", () => {
      assert.deepEqual(box.planWindows(facts({ control: { startedAt: ago(115).toISOString(), holdUsd: 2 }, claimed: 1 })), { act: "extend_hold" });
      assert.deepEqual(box.planWindows(facts({ control: { startedAt: ago(100).toISOString(), holdUsd: 2 }, claimed: 1 })), { act: "none" });
      assert.deepEqual(box.planWindows(facts({ control: {} })), { act: "extend_hold" });
    });

    it("stops a box the budget can't cover", () => {
      assert.deepEqual(box.planWindows(facts({ holdAllowed: false, claimed: 1 })), { act: "stop", reason: "over_budget" });
    });

    it("closes the session of a box that's stopped, then starts it only when there's work and no block", () => {
      assert.deepEqual(box.planWindows(facts({ boxState: "stopped" })), { act: "close_session" });
      assert.deepEqual(box.planWindows(facts({ boxState: "stopped", control: {} })), { act: "none" });
      assert.deepEqual(box.planWindows(facts({ boxState: "stopped", control: {}, queued: 1 })), { act: "start" });
      assert.deepEqual(box.planWindows(facts({ boxState: "stopped", control: { noStartUntil: new Date(NOW.getTime() + MINUTE).toISOString() }, queued: 1 })), { act: "none" });
      assert.deepEqual(box.planWindows(facts({ boxState: "stopped", control: { noStartUntil: ago(1).toISOString() }, queued: 1 })), { act: "start" });
    });

    it("waits while the box is changing state", () => {
      assert.deepEqual(box.planWindows(facts({ boxState: "stopping" })), { act: "none" });
      assert.deepEqual(box.planWindows(facts({ boxState: "shutting-down" })), { act: "none" });
    });
  });

  describe("waking Windows", () => {
    it("holds 2 hours, notes the session, then starts the box", async () => {
      const aws = fakeAws();
      assert.deepEqual(await box.wakeWindows(aws, NOW), { started: true, reason: "started" });
      assert.deepEqual(aws.calls, ["state", "start"]);
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.reservedUsd, 2);
      assert.equal(view.lanes.total.reservedUsd, 2);
      const lab = await labRow("windows");
      assert.equal(lab.state?.control?.startedAt, NOW.toISOString());
      assert.equal(lab.state?.control?.holdUsd, 2);
    });

    it("is safe to repeat while the box is up", async () => {
      const aws = fakeAws("running");
      assert.deepEqual(await box.wakeWindows(aws, NOW), { started: true, reason: "already_up" });
      assert.deepEqual(aws.calls, ["state"]);
      assert.equal((await ledger.spendView()).lanes.windows.reservedUsd, 0);
    });

    it("won't start past the budget, and calls EC2 for nothing but the state", async () => {
      process.env.NATIVE_WINDOWS_CAP_USD = "1";
      const aws = fakeAws();
      assert.deepEqual(await box.wakeWindows(aws, NOW), { started: false, reason: "over_budget" });
      assert.deepEqual(aws.calls, ["state"]);
      assert.equal((await labRow("windows")).state?.control?.startedAt ?? null, null);
    });

    it("gives back the hold when the start fails", async () => {
      const aws = fakeAws();
      aws.failStart = true;
      assert.deepEqual(await box.wakeWindows(aws, NOW), { started: false, reason: "failed" });
      assert.equal((await ledger.spendView()).lanes.windows.reservedUsd, 0);
      assert.equal((await labRow("windows")).state?.control?.startedAt, null);
    });

    it("loses a race cleanly: one session, one hold", async () => {
      // The other caller opened its session after this one read the row.
      await setControl("windows", {});
      const aws = fakeAws();
      const original = aws.windowsBoxState.bind(aws);
      aws.windowsBoxState = async () => {
        await setControl("windows", { startedAt: ago(0).toISOString(), holdUsd: 2 });
        return original();
      };
      assert.deepEqual(await box.wakeWindows(aws, NOW), { started: false, reason: "racing" });
      assert.equal(aws.calls.includes("start"), false);
      assert.equal((await ledger.spendView()).lanes.windows.reservedUsd, 0);
    });

    it("respects a block, and a box with no id or no token", async () => {
      await setControl("windows", { noStartUntil: new Date(NOW.getTime() + MINUTE).toISOString() });
      assert.deepEqual(await box.wakeWindows(fakeAws(), NOW), { started: false, reason: "blocked" });
      assert.deepEqual(await box.wakeWindows(fakeAws("running"), NOW), { started: true, reason: "already_up" }, "a box that's already up can take the job");
      delete process.env.NATIVE_WINDOWS_INSTANCE_ID;
      assert.deepEqual(await box.wakeWindows(fakeAws(), NOW), { started: false, reason: "no_box" });
    });

    it("bills a session that ended before it opens the next", async () => {
      await ledger.reserve("windows", 2, { ref: "old" });
      await setControl("windows", { startedAt: ago(30).toISOString(), holdUsd: 2 });
      const aws = fakeAws();
      await box.wakeWindows(aws, NOW);
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.committedUsd, 0.5);
      assert.equal(view.lanes.windows.reservedUsd, 2);
    });
  });

  describe("the sweep's look at Windows", () => {
    it("bills a session once when two callers close it together", async () => {
      await box.wakeWindows(fakeAws("stopped"), NOW);
      const stopped = fakeAws("stopped");
      const later = new Date(NOW.getTime() + 60 * MINUTE);
      await Promise.all([box.tickWindows(stopped, later), box.tickWindows(stopped, later)]);
      const commits = await testDb.select().from(realSchema.nativeSpend).where(eq(realSchema.nativeSpend.kind, "commit"));
      assert.equal(commits.length, 1);
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.committedUsd, 1, "one hour at $1");
      assert.equal(view.lanes.windows.reservedUsd, 0);
    });

    it("a close that can't reach the ledger leaves the session open, and the next sweep bills it", async () => {
      await box.wakeWindows(fakeAws("stopped"), NOW);
      const stopped = fakeAws("stopped");
      const later = new Date(NOW.getTime() + 60 * MINUTE);
      await testDb.execute(sql`alter table native_spend add constraint spend_refused check (false) not valid`);
      try {
        await assert.rejects(box.tickWindows(stopped, later));
      } finally {
        await testDb.execute(sql`alter table native_spend drop constraint spend_refused`);
      }
      assert.equal((await labRow("windows")).state?.control?.startedAt, NOW.toISOString(), "the session is still open");
      assert.equal((await ledger.spendView()).lanes.windows.committedUsd, 0);
      assert.equal((await box.tickWindows(stopped, later)).did, "close_session");
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.committedUsd, 1, "one hour at $1");
      assert.equal(view.lanes.windows.reservedUsd, 0);
      assert.equal(view.lanes.total.committedUsd, 1);
      assert.equal((await labRow("windows")).state?.control?.startedAt, null);
    });

    it("two sweeps at once keep one hold, so nothing is stranded when the box stops", async () => {
      await ledger.reserve("windows", 2);
      const startedAt = ago(115).toISOString();
      await setControl("windows", { startedAt, holdUsd: 2 }, ago(0));
      const s = await seed();
      await windowsJob(s);
      // Both sweeps have read the row before either goes on.
      const aws = fakeAws("running");
      let waiting = 0;
      let open!: () => void;
      const both = new Promise<void>((resolve) => (open = resolve));
      aws.windowsBoxState = async () => {
        waiting += 1;
        if (waiting === 2) open();
        await both;
        return "running";
      };
      const ticks = await Promise.all([box.tickWindows(aws, NOW), box.tickWindows(aws, NOW)]);
      assert.deepEqual(ticks.map((t) => t.did).sort(), ["extend_hold", "none"]);
      assert.equal((await ledger.spendView()).lanes.windows.reservedUsd, 4);
      const control = (await labRow("windows")).state?.control;
      assert.equal(control?.holdUsd, 4);
      assert.equal(control?.startedAt, startedAt);
      await box.tickWindows(fakeAws("stopped"), NOW);
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.reservedUsd, 0, "the box stopped and no hold is left");
      assert.equal(view.lanes.total.reservedUsd, 0);
    });

    it("gives a hold back when the session closed while it was being taken", async () => {
      await ledger.reserve("windows", 2);
      await setControl("windows", { startedAt: ago(115).toISOString(), holdUsd: 2 }, ago(0));
      await windowsJob(await seed());
      const aws = fakeAws("running");
      aws.windowsBoxState = async () => {
        await box.tickWindows(fakeAws("stopped"), NOW);
        return "running";
      };
      assert.equal((await box.tickWindows(aws, NOW)).did, "none");
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.reservedUsd, 0);
      assert.equal((await labRow("windows")).state?.control?.startedAt, null, "and the closed session stays closed");
    });

    it("won't start anything with the lab off", async () => {
      const aws = fakeAws("stopped");
      process.env.NATIVE_LAB = "";
      try {
        assert.deepEqual(await box.wakeWindows(aws, NOW), { started: false, reason: "no_box" });
      } finally {
        process.env.NATIVE_LAB = "1";
      }
      assert.equal((await ledger.spendView()).lanes.windows.reservedUsd, 0);
    });

    it("the backstop stops a box whose agent is crash-looping, and blocks restarting it for an hour", async () => {
      await windowsJob(await seed());
      await ledger.reserve("windows", 2);
      await setControl("windows", { startedAt: ago(15).toISOString(), holdUsd: 2 }, null);
      const aws = fakeAws("running");
      assert.deepEqual(await box.tickWindows(aws, NOW), { boxState: "running", did: "stop", note: "agent_silent" });
      assert.ok(aws.calls.includes("stop"));
      const control = (await labRow("windows")).state?.control;
      assert.equal(control?.stopReason, "agent_silent");
      assert.equal(control?.noStartUntil, new Date(NOW.getTime() + 60 * MINUTE).toISOString());

      // Next sweep: it has stopped, so the bill lands. The queued job doesn't start it again.
      aws.state = "stopped";
      assert.equal((await box.tickWindows(aws, new Date(NOW.getTime() + 5 * MINUTE))).did, "close_session");
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.reservedUsd, 0);
      assert.ok(Math.abs(view.lanes.windows.committedUsd - 0.34) < 0.011, String(view.lanes.windows.committedUsd));
      const after = await box.tickWindows(aws, new Date(NOW.getTime() + 10 * MINUTE));
      assert.equal(after.did, "none");
      assert.equal(aws.calls.includes("start"), false);

      // An hour on, the queued job may try again. (Its own TTL would end this eventually.)
      const later = await box.tickWindows(aws, new Date(NOW.getTime() + 61 * MINUTE));
      assert.equal(later.did, "start");
      assert.ok(aws.calls.includes("start"));
    });

    it("the backstop stops an idle box the agent's own stop didn't, with no block on a later start", async () => {
      await setControl("windows", { startedAt: ago(45).toISOString(), holdUsd: 2 }, ago(1));
      const aws = fakeAws("running");
      assert.deepEqual(await box.tickWindows(aws, NOW), { boxState: "running", did: "stop", note: "idle" });
      assert.equal((await labRow("windows")).state?.control?.noStartUntil, null);
    });

    it("starts the box for a queued job, and leaves a stopped idle box alone", async () => {
      const idle = fakeAws();
      assert.equal((await box.tickWindows(idle, NOW)).did, "none");
      assert.equal(idle.calls.includes("start"), false);
      await windowsJob(await seed());
      const busy = fakeAws();
      assert.equal((await box.tickWindows(busy, NOW)).did, "start");
      assert.ok(busy.calls.includes("start"));
    });

    it("keeps paying for a long job with further holds, and stops at the cap", async () => {
      process.env.NATIVE_WINDOWS_CAP_USD = "5";
      await ledger.reserve("windows", 2);
      await setControl("windows", { startedAt: ago(115).toISOString(), holdUsd: 2 }, ago(0));
      await testDb.update(realSchema.nativeLabs).set({ lastSeenAt: ago(0) }).where(eq(realSchema.nativeLabs.lane, "windows"));
      const s = await seed();
      await windowsJob(s);
      const claimed = (await queue.claimJob("windows", ["desktop_windows"]))!;
      assert.ok(claimed);
      const aws = fakeAws("running");
      assert.equal((await box.tickWindows(aws, NOW)).did, "extend_hold");
      assert.equal((await ledger.spendView()).lanes.windows.reservedUsd, 4);
      assert.equal((await labRow("windows")).state?.control?.holdUsd, 4);
      await testDb.update(realSchema.nativeLabs).set({ lastSeenAt: new Date(NOW.getTime() + 115 * MINUTE) }).where(eq(realSchema.nativeLabs.lane, "windows"));
      const late = await box.tickWindows(aws, new Date(NOW.getTime() + 115 * MINUTE));
      assert.deepEqual(late, { boxState: "running", did: "stop", note: "over_budget" });
    });

    it("adopts a box that was started by hand, so its hours reach the ledger", async () => {
      await setControl("windows", {}, ago(0));
      const aws = fakeAws("running");
      assert.equal((await box.tickWindows(aws, NOW)).did, "extend_hold");
      const control = (await labRow("windows")).state?.control;
      assert.equal(control?.startedAt, NOW.toISOString());
      assert.equal(control?.holdUsd, 2);
    });

    it("notes the box's state for the admin card, and skips a box with no id or no token", async () => {
      await box.tickWindows(fakeAws("stopped"), NOW);
      assert.equal((await labRow("windows")).state?.control?.boxState, "stopped");
      await testDb.delete(realSchema.nativeLabs).where(eq(realSchema.nativeLabs.lane, "windows"));
      const noToken = fakeAws("running");
      assert.equal((await box.tickWindows(noToken, NOW)).did, "skipped");
      assert.deepEqual(noToken.calls, []);
      delete process.env.NATIVE_WINDOWS_INSTANCE_ID;
      assert.equal((await box.tickWindows(fakeAws(), NOW)).did, "skipped");
    });
  });

  describe("the Mac", () => {
    it("restarts a quiet agent, at most once per 10 minutes, and never stops the box", async () => {
      const aws = fakeAws();
      assert.equal((await box.tickMac(aws, NOW)).did, "restart-agent", "never heard from");
      assert.deepEqual(aws.calls, ["ping:mac", "restart-agent:mac"]);
      assert.equal((await box.tickMac(aws, new Date(NOW.getTime() + 9 * MINUTE))).did, "none");
      assert.equal((await box.tickMac(aws, new Date(NOW.getTime() + 11 * MINUTE))).did, "restart-agent");
      assert.equal(aws.calls.filter((c) => c === "stop").length, 0);
    });

    it("leaves an agent that's talking alone", async () => {
      await testDb.update(realSchema.nativeLabs).set({ lastSeenAt: new Date(NOW.getTime() - 89_000) }).where(eq(realSchema.nativeLabs.lane, "mac"));
      const aws = fakeAws();
      assert.equal((await box.tickMac(aws, NOW)).did, "none");
      assert.deepEqual(aws.calls, []);
    });

    it("sends nothing if SSM can't reach the box", async () => {
      const aws = fakeAws();
      aws.ping = "ConnectionLost";
      assert.deepEqual(await box.tickMac(aws, NOW), { did: "none", note: "SSM says the Mac is ConnectionLost." });
      assert.deepEqual(aws.calls, ["ping:mac"]);
    });

    it("skips with no instance id", async () => {
      delete process.env.NATIVE_MAC_INSTANCE_ID;
      assert.equal((await box.tickMac(fakeAws(), NOW)).did, "skipped");
    });
  });

  describe("presence", () => {
    it("a box's report can't touch the platform's notes", async () => {
      await setControl("windows", { startedAt: "2026-11-01T00:00:00Z", holdUsd: 2 });
      await box.notePresence("windows", { version: "0.1.0", slots: 1, running: ["a"], kinds: ["desktop_windows"], capabilities: { ffmpeg: { ok: true } } });
      const lab = await labRow("windows");
      assert.equal(lab.state?.control?.startedAt, "2026-11-01T00:00:00Z");
      assert.equal(lab.version, "0.1.0");
      assert.deepEqual(lab.state?.running, ["a"]);
      assert.ok(lab.lastSeenAt);
    });

    it("knows a lane by its token hash", async () => {
      assert.equal(await box.laneForToken("w".repeat(64)), "windows");
      assert.equal(await box.laneForToken("x".repeat(64)), null);
    });

    it("says a box is online only while it's talking", async () => {
      assert.equal((await box.labView("mac", NOW)).online, false);
      await testDb.update(realSchema.nativeLabs).set({ lastSeenAt: new Date(NOW.getTime() - 30_000) }).where(eq(realSchema.nativeLabs.lane, "mac"));
      assert.equal((await box.labView("mac", NOW)).online, true);
      assert.equal((await box.labView("mac", new Date(NOW.getTime() + 61_000))).online, false);
    });
  });

  describe("the whole sweep", () => {
    it("runs every task, and one failing doesn't stop the others", async () => {
      const { sweepNative } = await import(at("../sweep.ts"));
      const s = await seed();
      const job = await queue.enqueueJob({ runId: s.runId, buildId: s.buildId, productId: s.productId, kind: "desktop_mac", tier: "ship", input: macInput() });
      assert.ok(job.ok);
      await queue.claimJob("mac", ["desktop_mac"]);
      await testDb.update(realSchema.nativeJobs).set({ heartbeatAt: new Date(Date.now() - 100_000) });
      const aws = fakeAws();
      aws.windowsBoxState = async () => {
        throw new Error("EC2 is down");
      };
      const result = await sweepNative(aws);
      assert.equal(result.ok, false);
      assert.deepEqual(result.windows, { ok: false, error: "EC2 is down" });
      assert.deepEqual(result.silent, { ok: true, value: { requeued: 1, failed: 0 } });
      assert.equal(result.spend.ok, true);
      assert.equal(result.mac.ok, true);
    });

    it("a job's holds add up to the cent, however many a long session takes", async () => {
      process.env.NATIVE_WINDOWS_HOURLY_USD = "0.083";
      await windowsJob(await seed());
      await queue.claimJob("windows", ["desktop_windows"]);
      const aws = fakeAws("running");
      for (const minutes of [0, 115, 238]) {
        const at = new Date(NOW.getTime() + minutes * MINUTE);
        await testDb.update(realSchema.nativeLabs).set({ lastSeenAt: at }).where(eq(realSchema.nativeLabs.lane, "windows"));
        assert.equal((await box.tickWindows(aws, at)).did, "extend_hold", String(minutes));
      }
      const view = await ledger.spendView();
      assert.equal(view.lanes.windows.reservedUsd, 0.51, "three holds of 17 cents");
      aws.state = "stopped";
      await box.tickWindows(aws, new Date(NOW.getTime() + 240 * MINUTE));
      const after = await ledger.spendView();
      assert.equal(after.lanes.windows.reservedUsd, 0, "and they all come back");
      assert.equal(after.lanes.windows.committedUsd, 0.34, "4 hours at $0.083, rounded up");
      assert.equal(after.lanes.total.reservedUsd, 0);
    });

    it("alerts once spend passes the line", async () => {
      const { sweepNative } = await import(at("../sweep.ts"));
      process.env.NATIVE_SPEND_ALERT_USD = "1";
      await ledger.reserve("device_farm", 2);
      const errors = mock.method(console, "error", () => {});
      const result = await sweepNative(fakeAws());
      assert.deepEqual(result.spend, { ok: true, value: { totalUsd: 2, alerting: true } });
      assert.match(String(errors.mock.calls[0]?.arguments[0]), /past the \$1 alert line/);
      errors.mock.restore();
      delete process.env.NATIVE_SPEND_ALERT_USD;
    });
  });
});

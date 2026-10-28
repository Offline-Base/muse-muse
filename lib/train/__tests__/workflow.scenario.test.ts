/**
 * Runs trainJob as a plain function with every step faked and sleep() moving a fake clock, to check the
 * orchestration: launch (and saving a launch the database didn't take), the 30 s check loop, that a failed check
 * doesn't end the watch, the hard stop at maxMinutes + 15, and that the instance is terminated at the end on every
 * path, by the id the workflow carries, including thrown errors and an outage that outlasts every retry. Judging runs
 * only after terminate returned "succeeded", 4 items at a time, and nothing it does changes the job's status.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/train/__tests__/workflow.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

type Call = { step: string; args: unknown[] };
type Check = { action: "wait" } | { action: "terminate"; status: "succeeded" | "failed" | "stopped"; reason: string };
type Ending = { status: "succeeded" | "failed" | "stopped"; reason: string };
type Launch =
  | { action: "watch"; maxMinutes: number; instanceId: string }
  | { action: "save"; maxMinutes: number; instanceId: string; launchedAt: string }
  | ({ action: "end"; instanceId?: string } & Ending);

interface Scenario {
  launch?: Launch;
  launchThrows?: Error;
  /** What saveLaunchStep answers, or throws. */
  save?: Launch | Error;
  /** One entry per check, in order. The last one repeats. A thrown entry makes that check throw. */
  checks?: Array<Check | Error>;
  /** How many terminateStep calls throw before one succeeds (Infinity: all of them). */
  terminateFailures?: number;
  /** How many abandonStep calls throw before one succeeds. */
  abandonFailures?: number;
  /** What terminateStep reports as the job's final status. Defaults to the ending's status. */
  finalStatus?: string;
  /** The eval indexes judgePlanStep answers (none by default), or an error it throws. */
  evals?: number[] | Error;
  /** Indexes whose judgeStep throws. */
  judgeFails?: number[];
  /** Whether saveEvalSummaryStep throws. */
  summaryFails?: boolean;
}

const POLL_MS = 30_000;
let scenario: Scenario = {};
let calls: Call[] = [];
let checksRun = 0;
let clock = 0;

function record(step: string, ...args: unknown[]) {
  calls.push({ step, args });
}

function named(step: string) {
  return calls.filter((c) => c.step === step);
}

/** Steps in the order they ran, without the sleeps. */
function order(): string[] {
  return calls.filter((c) => c.step !== "sleep").map((c) => c.step);
}

let terminateRuns = 0;
let abandonRuns = 0;

const fakeSteps = {
  launchStep: async (jobId: string) => {
    record("launchStep", jobId);
    if (scenario.launchThrows) throw scenario.launchThrows;
    return scenario.launch ?? { action: "watch", maxMinutes: 30, instanceId: "inst-1" };
  },
  saveLaunchStep: async (jobId: string, launch: Launch) => {
    record("saveLaunchStep", jobId, launch);
    if (scenario.save instanceof Error) throw scenario.save;
    return scenario.save ?? { action: "watch", maxMinutes: launch.action === "end" ? 30 : launch.maxMinutes, instanceId: launch.instanceId };
  },
  checkStep: async (jobId: string) => {
    record("checkStep", jobId);
    const list = scenario.checks ?? [{ action: "wait" }];
    const next = list[Math.min(checksRun, list.length - 1)]!;
    checksRun += 1;
    if (next instanceof Error) throw next;
    return next;
  },
  terminateStep: async (jobId: string, ending: Ending, instanceId?: string) => {
    record("terminateStep", jobId, ending, instanceId);
    terminateRuns += 1;
    if (terminateRuns <= (scenario.terminateFailures ?? 0)) throw new Error('Step "terminateStep" failed after 20 retries: down');
    return scenario.finalStatus ?? ending.status;
  },
  abandonStep: async (jobId: string, ending: Ending, instanceId?: string) => {
    record("abandonStep", jobId, ending, instanceId);
    abandonRuns += 1;
    if (abandonRuns <= (scenario.abandonFailures ?? 0)) throw new Error('Step "abandonStep" failed after 20 retries: down');
    return ending.status;
  },
};

/** Judge steps running right now, and the most that ran at once. */
let judging = 0;
let judgingPeak = 0;

const fakeJudge = {
  judgePlanStep: async (jobId: string) => {
    record("judgePlanStep", jobId);
    if (scenario.evals instanceof Error) throw scenario.evals;
    return { indexes: scenario.evals ?? [], task: "Explain errors." };
  },
  judgeStep: async (jobId: string, index: number, task: string | null) => {
    record("judgeStep", jobId, index, task);
    judging += 1;
    judgingPeak = Math.max(judgingPeak, judging);
    await new Promise((resolve) => setImmediate(resolve));
    judging -= 1;
    if (scenario.judgeFails?.includes(index)) throw new Error('Step "judgeStep" failed after 2 retries: bad JSON');
    return { baseScore: 5, tunedScore: 7, better: "tuned", costUsd: 0.001 };
  },
  saveEvalSummaryStep: async (jobId: string, items: unknown[], asked: number) => {
    record("saveEvalSummaryStep", jobId, items, asked);
    if (scenario.summaryFails) throw new Error("database down");
    return null;
  },
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let wf: typeof import("../workflow");

function reset(next: Scenario) {
  scenario = next;
  calls = [];
  checksRun = 0;
  terminateRuns = 0;
  abandonRuns = 0;
  judging = 0;
  judgingPeak = 0;
  clock = Date.UTC(2026, 9, 27, 12, 0, 0);
}

const terminated = (): Ending => named("terminateStep")[0]!.args[1] as Ending;

describe("training workflow orchestration", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(new URL("../steps.ts", import.meta.url).href, { namedExports: fakeSteps });
    mock.module(new URL("../judge.ts", import.meta.url).href, { namedExports: fakeJudge });
    mock.module("workflow", {
      namedExports: {
        sleep: async (ms: number) => {
          record("sleep", ms);
          clock += ms;
        },
      },
    });
    mock.method(Date, "now", () => clock);
    wf = await import("../workflow");
  });

  after(() => mock.restoreAll());

  beforeEach(() => reset({}));

  it("watches a job until the runner reports done, then terminates once with its status", async () => {
    reset({
      checks: [{ action: "wait" }, { action: "wait" }, { action: "terminate", status: "succeeded", reason: "The job finished." }],
    });
    assert.deepEqual(await wf.trainJob({ jobId: "j1" }), { status: "succeeded" });
    assert.deepEqual(order(), ["launchStep", "checkStep", "checkStep", "checkStep", "terminateStep", "judgePlanStep"]);
    assert.deepEqual(named("terminateStep")[0]!.args, ["j1", { status: "succeeded", reason: "The job finished." }, "inst-1"]);
    assert.deepEqual(
      named("sleep").map((c) => c.args[0]),
      [POLL_MS, POLL_MS, POLL_MS],
    );
    assert.equal(named("abandonStep").length, 0);
  });

  it("fails a job that reached its time limit", async () => {
    reset({
      checks: [{ action: "wait" }, { action: "terminate", status: "failed", reason: "Reached the 30-minute limit." }],
    });
    assert.deepEqual(await wf.trainJob({ jobId: "j2" }), { status: "failed" });
    assert.equal(named("terminateStep").length, 1);
    assert.deepEqual(terminated(), { status: "failed", reason: "Reached the 30-minute limit." });
  });

  it("stops at maxMinutes + 15 even when every check says wait", async () => {
    reset({ launch: { action: "watch", maxMinutes: 10, instanceId: "inst-1" }, checks: [{ action: "wait" }] });
    const startedAt = clock;
    assert.deepEqual(await wf.trainJob({ jobId: "j3" }), { status: "failed" });
    // 25 minutes of 30 s polls: the 50th sleep reaches the hard stop, so 49 checks ran.
    assert.equal(named("checkStep").length, 49);
    assert.equal(clock - startedAt, 25 * 60_000);
    assert.equal(named("terminateStep").length, 1);
    assert.deepEqual(terminated(), { status: "failed", reason: "Stopped after 25 minutes, past the job's time limit." });
    assert.equal(order().at(-1), "terminateStep");
  });

  it("stops a job an admin stopped", async () => {
    reset({ checks: [{ action: "wait" }, { action: "terminate", status: "stopped", reason: "Stopped by an admin." }] });
    assert.deepEqual(await wf.trainJob({ jobId: "j4" }), { status: "stopped" });
    assert.equal(named("checkStep").length, 2);
    assert.equal(named("terminateStep").length, 1);
    assert.deepEqual(terminated(), { status: "stopped", reason: "Stopped by an admin." });
  });

  it("fails a job whose instance never reports in", async () => {
    // decideCheck fails it 25 minutes after launch: 50 waits, then the terminate decision.
    const waits: Check[] = Array.from({ length: 49 }, () => ({ action: "wait" }));
    reset({
      checks: [...waits, { action: "terminate", status: "failed", reason: "No heartbeat 25 minutes after launch." }],
    });
    assert.deepEqual(await wf.trainJob({ jobId: "j5" }), { status: "failed" });
    assert.equal(named("checkStep").length, 50);
    assert.equal(named("terminateStep").length, 1);
    assert.deepEqual(terminated(), { status: "failed", reason: "No heartbeat 25 minutes after launch." });
  });

  it("still terminates when the launch throws, and never checks", async () => {
    reset({
      launchThrows: new Error(
        'Step "launchStep" failed after 1 retry: Lambda API POST /instance-operations/launch failed (400 insufficient-capacity): Not enough capacity\nstack line',
      ),
    });
    assert.deepEqual(await wf.trainJob({ jobId: "j6" }), { status: "failed" });
    assert.deepEqual(order(), ["launchStep", "terminateStep"]);
    assert.deepEqual(terminated(), {
      status: "failed",
      reason:
        "The launch failed: Lambda API POST /instance-operations/launch failed (400 insufficient-capacity): Not enough capacity",
    });
  });

  it("keeps watching when a check fails, and ends on a later check's decision", async () => {
    const outage = new Error('Step "checkStep" failed after 3 retries: The database did not answer: fetch failed');
    reset({
      checks: [{ action: "wait" }, outage, outage, { action: "wait" }, { action: "terminate", status: "succeeded", reason: "The job finished." }],
    });
    assert.deepEqual(await wf.trainJob({ jobId: "j7" }), { status: "succeeded" });
    assert.equal(named("checkStep").length, 5);
    assert.equal(named("terminateStep").length, 1);
    assert.deepEqual(terminated(), { status: "succeeded", reason: "The job finished." });
  });

  it("still stops at the hard stop when every check fails, and terminates by the launched id", async () => {
    reset({ launch: { action: "watch", maxMinutes: 10, instanceId: "inst-4" }, checks: [new Error("connection reset")] });
    assert.deepEqual(await wf.trainJob({ jobId: "j7b" }), { status: "failed" });
    assert.equal(named("checkStep").length, 49);
    assert.deepEqual(named("terminateStep")[0]!.args, [
      "j7b",
      { status: "failed", reason: "Stopped after 25 minutes, past the job's time limit." },
      "inst-4",
    ]);
  });

  it("saves a launch the database didn't take, then watches it", async () => {
    const save = { action: "save", maxMinutes: 30, instanceId: "inst-2", launchedAt: "2026-10-27T12:00:00.000Z" } as const;
    reset({ launch: save, checks: [{ action: "terminate", status: "succeeded", reason: "The job finished." }] });
    assert.deepEqual(await wf.trainJob({ jobId: "j11" }), { status: "succeeded" });
    assert.deepEqual(order(), ["launchStep", "saveLaunchStep", "checkStep", "terminateStep", "judgePlanStep"]);
    assert.deepEqual(named("saveLaunchStep")[0]!.args, ["j11", save]);
    assert.equal(order().at(-1), "judgePlanStep");
    assert.equal(named("terminateStep")[0]!.args[2], "inst-2");
  });

  it("terminates by id when the save never gets through", async () => {
    reset({
      launch: { action: "save", maxMinutes: 30, instanceId: "inst-3", launchedAt: "2026-10-27T12:00:00.000Z" },
      save: new Error('Step "saveLaunchStep" failed after 20 retries: The database did not answer: fetch failed'),
    });
    assert.deepEqual(await wf.trainJob({ jobId: "j12" }), { status: "failed" });
    assert.deepEqual(order(), ["launchStep", "saveLaunchStep", "terminateStep"]);
    assert.deepEqual(named("terminateStep")[0]!.args, [
      "j12",
      { status: "failed", reason: "The launch failed: The database did not answer: fetch failed" },
      "inst-3",
    ]);
  });

  it("terminates by id a launch that landed after the job ended", async () => {
    reset({ launch: { action: "end", status: "stopped", reason: "Stopped by an admin.", instanceId: "inst-5" } });
    assert.deepEqual(await wf.trainJob({ jobId: "j13" }), { status: "stopped" });
    assert.deepEqual(named("terminateStep")[0]!.args, ["j13", { status: "stopped", reason: "Stopped by an admin." }, "inst-5"]);
  });

  it("does not launch or check a job that ended before launch, but still terminates by name", async () => {
    reset({ launch: { action: "end", status: "stopped", reason: "Stopped by an admin." } });
    assert.deepEqual(await wf.trainJob({ jobId: "j8" }), { status: "stopped" });
    assert.deepEqual(order(), ["launchStep", "terminateStep"]);
    assert.equal(named("sleep").length, 0);
    assert.equal(named("terminateStep")[0]!.args[2], undefined, "no instance to terminate by id");
    assert.deepEqual(terminated(), { status: "stopped", reason: "Stopped by an admin." });
  });

  it("returns the status terminateStep settled on", async () => {
    // The runner's done landed after the check decided on the time limit.
    reset({
      checks: [{ action: "terminate", status: "failed", reason: "Reached the 30-minute limit." }],
      finalStatus: "succeeded",
    });
    assert.deepEqual(await wf.trainJob({ jobId: "j9" }), { status: "succeeded" });
  });

  it("hands over to the sweep when the terminate never succeeds", async () => {
    reset({
      checks: [{ action: "terminate", status: "succeeded", reason: "The job finished." }],
      terminateFailures: Infinity,
    });
    assert.deepEqual(await wf.trainJob({ jobId: "j10" }), { status: "succeeded" });
    assert.deepEqual(order(), ["launchStep", "checkStep", "terminateStep", "abandonStep", "judgePlanStep"]);
    assert.equal(named("terminateStep").length, 1);
    assert.deepEqual(named("abandonStep")[0]!.args, ["j10", { status: "succeeded", reason: "The job finished." }, "inst-1"]);
  });

  it("keeps trying to terminate, a minute apart, while both steps fail", async () => {
    reset({
      checks: [{ action: "terminate", status: "failed", reason: "Reached the 30-minute limit." }],
      terminateFailures: 3,
      abandonFailures: Infinity,
    });
    assert.deepEqual(await wf.trainJob({ jobId: "j14" }), { status: "failed" });
    assert.equal(named("terminateStep").length, 4, "retried, not abandoned");
    assert.equal(named("abandonStep").length, 3);
    assert.deepEqual(named("sleep").slice(1).map((c) => c.args[0]), [60_000, 60_000, 60_000]);
    assert.equal(order().at(-1), "terminateStep");
    for (const c of named("terminateStep")) assert.equal(c.args[2], "inst-1");
  });

  it("gives up after an hour when nothing gets through", async () => {
    reset({
      checks: [{ action: "terminate", status: "failed", reason: "Reached the 30-minute limit." }],
      terminateFailures: Infinity,
      abandonFailures: Infinity,
    });
    const startedAt = clock;
    assert.deepEqual(await wf.trainJob({ jobId: "j15" }), { status: "failed" });
    // The fake steps fail at once, so only the one-minute pauses move the clock: 60 of them, then one last round.
    assert.equal(named("terminateStep").length, 61);
    assert.equal(clock - startedAt, POLL_MS + 60 * 60_000);
  });
  describe("judging", () => {
    const done = (): Check => ({ action: "terminate", status: "succeeded", reason: "The job finished." });

    it("judges a job that succeeded only after terminate, 4 at a time, then saves the summary", async () => {
      reset({ checks: [done()], evals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
      assert.deepEqual(await wf.trainJob({ jobId: "j20" }), { status: "succeeded" });
      const steps = order();
      assert.equal(steps.indexOf("judgePlanStep"), steps.indexOf("terminateStep") + 1, "right after terminate returned");
      assert.deepEqual(
        named("judgeStep").map((c) => c.args),
        Array.from({ length: 10 }, (_, i) => ["j20", i, "Explain errors."]),
      );
      assert.equal(judgingPeak, 4);
      const [jobId, items, asked] = named("saveEvalSummaryStep")[0]!.args as [string, unknown[], number];
      assert.equal(jobId, "j20");
      assert.equal(items.length, 10);
      assert.equal(asked, 10);
      assert.equal(steps.at(-1), "saveEvalSummaryStep");
    });

    it("leaves out items whose judge step failed", async () => {
      reset({ checks: [done()], evals: [0, 1, 2], judgeFails: [1] });
      assert.deepEqual(await wf.trainJob({ jobId: "j21" }), { status: "succeeded" });
      assert.equal(named("judgeStep").length, 3);
      const [, items, asked] = named("saveEvalSummaryStep")[0]!.args as [string, unknown[], number];
      assert.equal(items.length, 2);
      assert.equal(asked, 3);
    });

    it("never changes the status when judging fails", async () => {
      reset({ checks: [done()], evals: new Error("database down") });
      assert.deepEqual(await wf.trainJob({ jobId: "j22" }), { status: "succeeded" });
      assert.equal(named("judgeStep").length, 0);
      reset({ checks: [done()], evals: [0], summaryFails: true });
      assert.deepEqual(await wf.trainJob({ jobId: "j23" }), { status: "succeeded" });
      assert.equal(named("terminateStep").length, 1, "terminated once, before judging");
    });

    it("skips the summary when there is nothing to judge", async () => {
      reset({ checks: [done()], evals: [] });
      assert.deepEqual(await wf.trainJob({ jobId: "j24" }), { status: "succeeded" });
      assert.equal(named("judgeStep").length + named("saveEvalSummaryStep").length, 0);
    });

    it("doesn't judge a job that failed or was stopped, even with eval items", async () => {
      for (const check of [
        { action: "terminate", status: "failed", reason: "Reached the 30-minute limit." },
        { action: "terminate", status: "stopped", reason: "Stopped by an admin." },
      ] as Check[]) {
        reset({ checks: [check], evals: [0, 1] });
        await wf.trainJob({ jobId: "j25" });
        assert.equal(named("judgePlanStep").length, 0);
      }
      // A late done that terminateStep settled on counts as succeeded.
      reset({ checks: [{ action: "terminate", status: "failed", reason: "Reached the 30-minute limit." }], finalStatus: "succeeded", evals: [0] });
      assert.deepEqual(await wf.trainJob({ jobId: "j26" }), { status: "succeeded" });
      assert.equal(named("judgeStep").length, 1);
    });
  });
});

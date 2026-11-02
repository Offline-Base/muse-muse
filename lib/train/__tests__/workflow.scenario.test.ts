/**
 * Runs trainJob as a plain function with every step faked and sleep() moving a fake clock, to check the
 * orchestration: launch (and saving a launch the database didn't take), the 30 s check loop, that a failed check
 * doesn't end the watch, the hard stop at maxMinutes + 15, and that the instance is terminated at the end on every
 * path, by the id the workflow carries, including thrown errors and an outage that outlasts every retry. Judging runs
 * only after terminate returned "succeeded", 4 items at a time, and nothing it does changes the job's status. Publishing
 * to the Hugging Face Hub comes last, after every ending: the plan step with the final status, then the story, the
 * dataset repo, the model repo and the finish, in that order, for the job the plan names and under its claim; a step
 * that fails fails the publishing with its reason, under that claim, and nothing in it throws or changes the status. publishToHub runs the same as an admin's
 * Publish. A local files job's plan (kind "gguf") publishes its GGUF repo instead: its commit, then its finish. The hub
 * steps are left out of order() and checked on their own (hubOrder()). A decide job (input mode "decide") is scored
 * instead of judged, right after terminate and whatever its ending, then the plan step; a scoring failure changes
 * nothing, and a chat job is never scored.
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
  /** The general checks judgePlanStep sets apart (TUNE_GENERAL_CHECKS), when the job sent any. */
  planChecks?: Record<string, { indexes: number[]; task: string }>;
  /** Whether saveEvalSummaryStep throws. */
  summaryFails?: boolean;
  /** What hubPlanStep answers (nothing to publish by default), or an error it throws. */
  hubPlan?: { action: "publish"; jobId: string; claim: string; kind?: "adapter" | "gguf" } | { action: "none" } | Error;
  /** The hub step that throws, as one that ran out of retries. */
  hubFailsAt?: string;
  /** Whether hubFailStep throws too. */
  hubFailFails?: boolean;
  /** Whether scoreDecisionStep throws, as one that ran out of retries. */
  scoreFails?: boolean;
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

const HUB_STEPS = new Set([
  "hubPlanStep",
  "hubStoryStep",
  "hubDatasetStep",
  "hubModelStep",
  "hubFinishStep",
  "hubGgufStep",
  "hubGgufFinishStep",
  "hubFailStep",
]);

/** Steps in the order they ran, without the sleeps and the hub steps. */
function order(): string[] {
  return calls.filter((c) => c.step !== "sleep" && !HUB_STEPS.has(c.step)).map((c) => c.step);
}

/** The hub steps in the order they ran. */
function hubOrder(): string[] {
  return calls.filter((c) => HUB_STEPS.has(c.step)).map((c) => c.step);
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
    return { indexes: scenario.evals ?? [], task: "Explain errors.", ...(scenario.planChecks ? { checks: scenario.planChecks } : {}) };
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
  saveEvalSummaryStep: async (jobId: string, items: unknown[], asked: number, ...rest: unknown[]) => {
    record("saveEvalSummaryStep", jobId, items, asked, ...rest);
    if (scenario.summaryFails) throw new Error("database down");
    return null;
  },
};

const fakeDecide = {
  scoreDecisionStep: async (jobId: string) => {
    record("scoreDecisionStep", jobId);
    if (scenario.scoreFails) throw new Error('Step "scoreDecisionStep" failed after 20 retries: The database did not answer: fetch failed');
    return { saved: "summary", items: 80, testRows: 80 };
  },
};

/** A hub step that records its call and throws when the scenario says it fails. */
function hubStep(name: string) {
  return async (jobId: string, claim: string) => {
    record(name, jobId, claim);
    if (scenario.hubFailsAt === name) throw new Error(`Step "${name}" failed after 3 retries: Hugging Face: committing to x failed: HTTP 500.`);
    return {};
  };
}

const fakeHub = {
  hubPlanStep: async (jobId: string, status: string, manual?: boolean) => {
    record("hubPlanStep", jobId, status, manual ?? false);
    if (scenario.hubPlan instanceof Error) throw scenario.hubPlan;
    return scenario.hubPlan ?? { action: "none" };
  },
  hubStoryStep: hubStep("hubStoryStep"),
  hubDatasetStep: hubStep("hubDatasetStep"),
  hubModelStep: hubStep("hubModelStep"),
  hubFinishStep: hubStep("hubFinishStep"),
  hubGgufStep: hubStep("hubGgufStep"),
  hubGgufFinishStep: hubStep("hubGgufFinishStep"),
  hubFailStep: async (jobId: string, claim: string, reason: string) => {
    record("hubFailStep", jobId, claim, reason);
    if (scenario.hubFailFails) throw new Error("database down");
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
    mock.module(new URL("../hub-steps.ts", import.meta.url).href, { namedExports: fakeHub });
    mock.module(new URL("../decide-steps.ts", import.meta.url).href, { namedExports: fakeDecide });
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

    it("judges the general checks after the task items, under their own task lines, and passes them apart to the summary", async () => {
      const planChecks = { general: { indexes: [9000, 9001], task: "General task." }, safety: { indexes: [9500], task: "Safety task." } };
      reset({ checks: [done()], evals: [0, 1], planChecks, judgeFails: [9001] });
      assert.deepEqual(await wf.trainJob({ jobId: "j26" }), { status: "succeeded" });
      assert.deepEqual(
        named("judgeStep").map((c) => c.args),
        [["j26", 0, "Explain errors."], ["j26", 1, "Explain errors."], ["j26", 9000, "General task."], ["j26", 9001, "General task."], ["j26", 9500, "Safety task."]],
      );
      const args = named("saveEvalSummaryStep")[0]!.args as [string, unknown[], number, { general: { items: unknown[]; asked: number }; safety: { items: unknown[]; asked: number } }];
      assert.equal(args[1].length, 2);
      assert.equal(args[2], 2, "asked counts the task items only");
      assert.equal(args[3].general.items.length, 1, "a check whose judge step failed is left out");
      assert.equal(args[3].general.asked, 2);
      assert.equal(args[3].safety.items.length, 1);

      // Without checks in the plan, the summary step gets exactly the three arguments it always did.
      reset({ checks: [done()], evals: [0, 1] });
      await wf.trainJob({ jobId: "j27" });
      assert.equal(named("saveEvalSummaryStep")[0]!.args.length, 3);
      assert.ok(named("judgeStep").every((c) => c.args[2] === "Explain errors."));
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

  describe("scoring a decide job", () => {
    const done = (): Check => ({ action: "terminate", status: "succeeded", reason: "The job finished." });
    const decide = (jobId: string) => wf.trainJob({ jobId, mode: "decide" });
    const all = () => calls.filter((c) => c.step !== "sleep").map((c) => c.step);

    it("scores a decide job right after terminate, instead of judging, then asks the plan step", async () => {
      reset({ checks: [{ action: "wait" }, done()], evals: [0, 1, 2] });
      assert.deepEqual(await decide("d1"), { status: "succeeded" });
      assert.deepEqual(order(), ["launchStep", "checkStep", "checkStep", "terminateStep", "scoreDecisionStep"]);
      assert.deepEqual(named("scoreDecisionStep")[0]!.args, ["d1"]);
      assert.equal(named("judgePlanStep").length + named("judgeStep").length + named("saveEvalSummaryStep").length, 0, "never judged");
      assert.equal(all().indexOf("hubPlanStep"), all().indexOf("scoreDecisionStep") + 1, "publishing comes after scoring");
      assert.deepEqual(named("hubPlanStep")[0]!.args, ["d1", "succeeded", false]);
    });

    it("scores a decide job whatever its ending, since its GPU sends the base scores before anything can fail", async () => {
      for (const [check, status] of [
        [{ action: "terminate", status: "failed", reason: "The adapter was saved, but the tuned model's scores failed." }, "failed"],
        [{ action: "terminate", status: "stopped", reason: "Stopped by an admin." }, "stopped"],
      ] as Array<[Check, string]>) {
        reset({ checks: [check] });
        assert.deepEqual(await decide("d2"), { status });
        assert.deepEqual(order(), ["launchStep", "checkStep", "terminateStep", "scoreDecisionStep"], status);
      }
      reset({ launchThrows: new Error("Lambda refused") });
      assert.deepEqual(await decide("d3"), { status: "failed" });
      assert.deepEqual(order(), ["launchStep", "terminateStep", "scoreDecisionStep"], "it finds nothing to score then");
      reset({ checks: [done()], terminateFailures: Infinity });
      assert.deepEqual(await decide("d4"), { status: "succeeded" });
      assert.deepEqual(order(), ["launchStep", "checkStep", "terminateStep", "abandonStep", "scoreDecisionStep"], "only once the GPU is ended or handed to the sweep");
    });

    it("never changes the status or stops publishing when scoring fails", async () => {
      reset({ checks: [done()], scoreFails: true, hubPlan: { action: "publish", jobId: "d5", claim: "claim-d5" } });
      assert.deepEqual(await decide("d5"), { status: "succeeded" });
      assert.equal(named("scoreDecisionStep").length, 1);
      assert.equal(named("terminateStep").length, 1, "terminated once, before scoring");
      assert.deepEqual(hubOrder(), ["hubPlanStep", "hubStoryStep", "hubDatasetStep", "hubModelStep", "hubFinishStep"]);
    });

    it("never scores a chat job, whose run is as it was", async () => {
      for (const input of [{ jobId: "c1" }, { jobId: "c1", mode: "chat" as const }]) {
        reset({ checks: [done()], evals: [0, 1] });
        assert.deepEqual(await wf.trainJob(input), { status: "succeeded" });
        assert.deepEqual(order(), ["launchStep", "checkStep", "terminateStep", "judgePlanStep", "judgeStep", "judgeStep", "saveEvalSummaryStep"]);
        reset({ checks: [{ action: "terminate", status: "failed", reason: "Reached the 30-minute limit." }], evals: [0] });
        await wf.trainJob(input);
        assert.deepEqual(order(), ["launchStep", "checkStep", "terminateStep"]);
      }
      reset({ hubPlan: { action: "publish", jobId: "c2", claim: "claim-c2" } });
      await wf.publishToHub({ jobId: "c2" });
      assert.equal(named("scoreDecisionStep").length, 0, "an admin's Publish scores nothing");
    });
  });

  describe("publishing to the Hugging Face Hub", () => {
    const done = (): Check => ({ action: "terminate", status: "succeeded", reason: "The job finished." });
    const publish = { action: "publish", jobId: "adapter-1", claim: "claim-1" } as const;

    it("asks the plan step after every ending, with the final status, after judging", async () => {
      reset({ checks: [done()], evals: [0, 1] });
      await wf.trainJob({ jobId: "j30" });
      assert.deepEqual(hubOrder(), ["hubPlanStep"]);
      assert.deepEqual(named("hubPlanStep")[0]!.args, ["j30", "succeeded", false]);
      const all = calls.filter((c) => c.step !== "sleep").map((c) => c.step);
      assert.equal(all.indexOf("hubPlanStep"), all.indexOf("saveEvalSummaryStep") + 1, "right after judging");
      for (const [check, status] of [
        [{ action: "terminate", status: "failed", reason: "Reached the 30-minute limit." }, "failed"],
        [{ action: "terminate", status: "stopped", reason: "Stopped by an admin." }, "stopped"],
      ] as Array<[Check, string]>) {
        reset({ checks: [check] });
        await wf.trainJob({ jobId: "j31" });
        assert.deepEqual(named("hubPlanStep")[0]!.args, ["j31", status, false], "a glimmer-publish job that didn't succeed is told");
      }
      reset({ launchThrows: new Error("Lambda refused") });
      await wf.trainJob({ jobId: "j32" });
      assert.deepEqual(named("hubPlanStep")[0]!.args, ["j32", "failed", false]);
    });

    it("publishes the job the plan names, in order, after terminate", async () => {
      reset({ checks: [done()], hubPlan: publish });
      assert.deepEqual(await wf.trainJob({ jobId: "publish-job-1" }), { status: "succeeded" });
      assert.deepEqual(hubOrder(), ["hubPlanStep", "hubStoryStep", "hubDatasetStep", "hubModelStep", "hubFinishStep"]);
      for (const step of ["hubStoryStep", "hubDatasetStep", "hubModelStep", "hubFinishStep"]) {
        assert.deepEqual(named(step)[0]!.args, ["adapter-1", "claim-1"], `${step} acts for the job the plan named, under its claim`);
      }
      assert.equal(named("terminateStep").length, 1);
    });

    it("fails the publishing with the step's reason, and never throws or changes the status", async () => {
      reset({ checks: [done()], hubPlan: publish, hubFailsAt: "hubModelStep" });
      assert.deepEqual(await wf.trainJob({ jobId: "j33" }), { status: "succeeded" });
      assert.deepEqual(hubOrder(), ["hubPlanStep", "hubStoryStep", "hubDatasetStep", "hubModelStep", "hubFailStep"]);
      assert.deepEqual(named("hubFailStep")[0]!.args, ["adapter-1", "claim-1", "Hugging Face: committing to x failed: HTTP 500."]);

      reset({ checks: [done()], hubPlan: publish, hubFailsAt: "hubStoryStep", hubFailFails: true });
      assert.deepEqual(await wf.trainJob({ jobId: "j34" }), { status: "succeeded" }, "a fail step that fails is swallowed too");

      reset({ checks: [done()], hubPlan: new Error("database down") });
      assert.deepEqual(await wf.trainJob({ jobId: "j35" }), { status: "succeeded" });
      assert.deepEqual(hubOrder(), ["hubPlanStep"], "no claim, so nothing to fail");
    });

    it("publishes a local files job's GGUF repo once it ended, with its own two steps under its claim", async () => {
      const gguf = { action: "publish", jobId: "quant-1", claim: "claim-q", kind: "gguf" } as const;
      reset({ checks: [done()], hubPlan: gguf });
      assert.deepEqual(await wf.trainJob({ jobId: "quant-1" }), { status: "succeeded" });
      assert.deepEqual(hubOrder(), ["hubPlanStep", "hubGgufStep", "hubGgufFinishStep"], "no story, dataset or adapter steps");
      for (const step of ["hubGgufStep", "hubGgufFinishStep"]) assert.deepEqual(named(step)[0]!.args, ["quant-1", "claim-q"]);
      const all = calls.filter((c) => c.step !== "sleep").map((c) => c.step);
      assert.ok(all.indexOf("terminateStep") < all.indexOf("hubPlanStep"), "only after the GPU is shut down");

      reset({ checks: [done()], hubPlan: gguf, hubFailsAt: "hubGgufStep" });
      assert.deepEqual(await wf.trainJob({ jobId: "quant-2" }), { status: "succeeded" }, "a failed commit never changes the status");
      assert.deepEqual(hubOrder(), ["hubPlanStep", "hubGgufStep", "hubFailStep"]);
      assert.deepEqual(named("hubFailStep")[0]!.args, ["quant-1", "claim-q", "Hugging Face: committing to x failed: HTTP 500."]);

      reset({ hubPlan: gguf });
      assert.deepEqual(await wf.publishToHub({ jobId: "quant-1" }), { published: true }, "and an admin's Publish runs the same");
      assert.deepEqual(hubOrder(), ["hubPlanStep", "hubGgufStep", "hubGgufFinishStep"]);
    });

    it("runs the same publishing for an admin's Publish", async () => {
      reset({ hubPlan: { action: "publish", jobId: "j36", claim: "claim-36" } });
      assert.deepEqual(await wf.publishToHub({ jobId: "j36" }), { published: true });
      assert.deepEqual(named("hubPlanStep")[0]!.args, ["j36", "succeeded", true]);
      assert.deepEqual(hubOrder(), ["hubPlanStep", "hubStoryStep", "hubDatasetStep", "hubModelStep", "hubFinishStep"]);
      assert.deepEqual(order(), [], "no GPU step");
      reset({});
      assert.deepEqual(await wf.publishToHub({ jobId: "j37" }), { published: false });
      reset({ hubPlan: { action: "publish", jobId: "j38", claim: "claim-38" }, hubFailsAt: "hubFinishStep" });
      assert.deepEqual(await wf.publishToHub({ jobId: "j38" }), { published: false });
      assert.equal(named("hubFailStep").length, 1);
    });
  });
});

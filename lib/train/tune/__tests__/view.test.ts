/**
 * A run's room from its rows (lib/train/tune/view.ts, and components/train/room/steps.ts for the chat kit): the stage at every point a run reaches, the settings
 * and cost it shows, the verdict, the one thing it offers next (Start training with the full form for admins, then the
 * job), why it waits (the tuneRun workflow's heartbeat, its ending, a stop: lib/train/tune/marks.ts), and the
 * same run on the chat kit's rows, working step, end row and mascot. Pure: the rows are made up here.
 *
 *   npx tsx --test lib/train/tune/__tests__/view.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatasetHead, TrainJobRow } from "@/lib/train/logic";
import { TUNE_ART, tuneArt, tuneCurrentStep, tuneRunning, tuneSteps, tuneStepsEnd } from "@/components/train/room/steps";
import { NO_MARKS, runMarks, TUNE_HEARTBEAT_FRESH_MS, waitText, type RunMarks } from "@/lib/train/tune/marks";
import { examplesProblem, fullFormHref, tuneRunView } from "@/lib/train/tune/view";
import type { TrainEventView } from "@/lib/train/types";

const DS = "1b2c3d4e-0000-4000-8000-000000000002";
const JOB = "8f1d2c3b-0000-4000-8000-000000000001";
const t0 = Date.parse("2026-11-01T12:00:00.000Z");
const NOW = new Date(t0 + 30 * 60_000);
const CEILINGS = { maxMinutes: 120, maxUsd: 5 };

function dataset(over: Partial<DatasetHead> = {}): DatasetHead {
  return {
    id: DS,
    title: "a bakery's counter helper",
    task: "Answer questions for a made-up bakery.",
    status: "generating",
    requested: 200,
    trainCount: 0,
    evalCount: 0,
    costUsd: 1.4,
    error: null,
    createdBy: null,
    createdAt: new Date(t0),
    finishedAt: null,
    workflowRunId: "wrun_1",
    writerModel: "muse-wonder-1.0",
    ...over,
  } as DatasetHead;
}

const ready = (over: Partial<DatasetHead> = {}) =>
  dataset({ status: "ready", trainCount: 180, evalCount: 20, costUsd: 4.2, finishedAt: new Date(t0 + 20 * 60_000), ...over });

function job(over: Partial<TrainJobRow> = {}): TrainJobRow {
  return {
    id: JOB,
    recipe: "glimmer-lora",
    title: "a bakery's counter helper",
    status: "running",
    params: { datasetId: DS, maxSteps: 120, learningRate: 0.0002, loraRank: 16, dryRun: 0 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 129,
    maxMinutes: 90,
    maxUsd: 5,
    instanceId: "i-1",
    instanceIp: null,
    instanceName: "mm-train-8f1d2c3b-glimmer-lora",
    tokenHash: null,
    workflowRunId: null,
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 0.5,
    createdBy: null,
    createdAt: new Date(t0 + 21 * 60_000),
    launchedAt: new Date(t0 + 22 * 60_000),
    firstHeartbeatAt: null,
    lastHeartbeatAt: null,
    finishedAt: null,
    terminatedAt: null,
    evalSummary: null,
    judgeModel: null,
    hub: null,
    ...over,
  } as unknown as TrainJobRow;
}

const summary = { items: 20, tunedWins: 18, baseWins: 1, ties: 1, avgBaseScore: 3.1, avgTunedScore: 8.4, judgeCostUsd: 0.25 };

function evalEvents(judged: number): TrainEventView[] {
  const out: TrainEventView[] = [];
  for (let i = 0; i < 20; i++) {
    out.push({ id: i + 1, type: "eval", payload: { type: "eval", index: i, prompt: `Q${i}`, reference: "R", base: "B", tuned: "T" }, at: NOW.toISOString() });
  }
  for (let i = 0; i < judged; i++) {
    out.push({ id: 100 + i, type: "judgement", payload: { type: "judgement", index: i, baseScore: 3, tunedScore: 8, better: "tuned", note: "n" }, at: NOW.toISOString() });
  }
  return out;
}

const view = (d: DatasetHead, j: TrainJobRow | null = null, events: TrainEventView[] = [], written: number | null = null, now = NOW, marks?: RunMarks) =>
  tuneRunView({ dataset: d, written, job: j, events, marks }, now, CEILINGS);

/** The tuneRun workflow's heartbeat rows, one a minute in `state` from `from` to `to` minutes before NOW. */
function beats(state: string, from: number, to: number) {
  const rows = [];
  for (let m = from; m >= to; m--) rows.push({ key: `tune-run:${DS}:${state}`, windowStart: new Date(NOW.getTime() - m * 60_000), count: 1 });
  return rows;
}

describe("a run's stage", () => {
  it("writes, with how many so far and what it cost", () => {
    const v = view(dataset(), null, [], 84);
    assert.equal(v.stage, "writing");
    assert.equal(v.written, 84);
    assert.equal(v.next, null);
    assert.deepEqual(tuneCurrentStep(v), { title: "Writing examples", description: "Muse Wonder has written 84 of 200. Writing them all takes about 20 minutes." });
    assert.equal(TUNE_ART[v.stage], "building");
    assert.equal(tuneRunning(v), true);
    const rows = tuneSteps(v);
    assert.deepEqual(rows.map((r) => [r.id, r.state]), [["plan", "done"], ["writing", "running"]]);
    assert.equal(rows[1]!.description, "84 of 200 · $1.40 so far");
    assert.equal(tuneStepsEnd(v), undefined);
  });

  it("waits once its examples are ready with nothing trying to train them, and offers Start training and the full form", () => {
    const v = view(ready());
    assert.equal(v.stage, "waiting");
    assert.equal(v.hold?.reason, "not_started");
    assert.deepEqual(v.next, { kind: "start", start: `/api/train/runs/${DS}/start`, fullForm: `/fine-tuning?dataset=${DS}#new-job` });
    assert.equal(fullFormHref(DS), `/fine-tuning?dataset=${DS}#new-job`);
    assert.equal(tuneCurrentStep(v), null, "nothing runs while it waits on a person");
    assert.equal(tuneRunning(v), false);
    assert.deepEqual(tuneSteps(v).map((r) => [r.id, r.state]), [["plan", "done"], ["writing", "done"], ["checking", "done"]]);
    assert.equal(tuneSteps(v)[2]!.description, "180 to train on, 20 kept aside to score it");
    assert.equal(v.costSoFarUsd, 4.2);
  });

  it("fails when the examples leave too few to train on or score with", () => {
    const v = view(ready({ trainCount: 12, evalCount: 8 }));
    assert.equal(v.stage, "failed");
    assert.equal(v.problem, examplesProblem({ trainCount: 12, evalCount: 8 }));
    assert.match(v.problem!, /12 examples to train on and 8 to score with/);
    assert.equal(TUNE_ART[v.stage], "present");
    assert.equal(tuneSteps(v).at(-1)!.state, "failed");
    assert.equal(tuneStepsEnd(v), "unfinished");
  });

  it("fails with the dataset's reason, or when writing stalled for hours", () => {
    const failed = view(dataset({ status: "failed", error: "The platform's daily spend cap is reached, so the dataset stopped." }));
    assert.equal(failed.stage, "failed");
    assert.match(failed.problem!, /spend cap/);
    assert.equal(tuneSteps(failed)[1]!.state, "failed");
    const stalled = view(dataset(), null, [], 10, new Date(t0 + 7 * 60 * 60_000));
    assert.equal(stalled.stage, "failed");
    assert.equal(tuneSteps(stalled)[1]!.state, "failed");
  });

  it("trains on the job made from its dataset, with that job's settings and a link to it", () => {
    const v = view(ready(), job({ params: { datasetId: DS, maxSteps: 200, learningRate: 0.0001, loraRank: 32, dryRun: 0 } }));
    assert.equal(v.stage, "training");
    assert.deepEqual(v.next, { kind: "job", href: `/fine-tuning/${JOB}` });
    assert.equal(v.plan.steps, 200);
    assert.equal(v.plan.loraRank, 32);
    assert.equal(v.gpuLabel, "1x A100 SXM4 (40 GB)");
    const rows = tuneSteps(v);
    assert.equal(rows.at(-1)!.id, "training");
    assert.equal(rows.at(-1)!.state, "running");
    assert.equal(tuneCurrentStep(v)?.title, "Training on a GPU");
  });

  it("scores once training succeeded, then is ready with the verdict", () => {
    const done = { status: "succeeded" as const, finishedAt: new Date(t0 + 25 * 60_000), terminatedAt: new Date(t0 + 26 * 60_000), costUsd: 1.5 };
    const scoring = view(ready(), job(done), evalEvents(5));
    assert.equal(scoring.stage, "scoring");
    assert.equal(tuneCurrentStep(scoring)?.description, "Judged 5 of 20 kept-aside prompts");
    assert.equal(scoring.verdict, null);

    const v = view(ready(), job({ ...done, evalSummary: summary }), evalEvents(20));
    assert.equal(v.stage, "ready");
    assert.deepEqual(v.verdict, { passed: true, words: "Tuned won 18 of 20 kept-aside prompts (8.4 vs 3.1).", scored: true });
    assert.equal(v.evals.length, 20);
    assert.equal(v.costSoFarUsd, 4.2 + 1.5 + 0.25);
    assert.equal(TUNE_ART[v.stage], "shield");
    assert.equal(tuneArt(v), "shield");
    assert.deepEqual(tuneSteps(v).map((r) => r.id), ["plan", "writing", "checking", "training", "scoring", "ready"]);
    assert.equal(tuneStepsEnd(v), "done");
  });

  it("is ready without a pass when judging was skipped, and says why", () => {
    const v = view(
      ready(),
      job({ status: "succeeded", terminatedAt: new Date(t0 + 26 * 60_000), evalSummary: { ...summary, items: 0, tunedWins: 0, baseWins: 0, ties: 0, note: "The judge's spend cap was reached." } as never }),
    );
    assert.equal(v.stage, "ready");
    assert.deepEqual(v.verdict, { passed: false, scored: false, words: "The judge's spend cap was reached. It wasn't scored, so it hasn't passed." });
    assert.equal(tuneArt(v), "present", "only a judged run gets the pair");
  });

  it("says a run whose judging never finished wasn't scored, presenting, not Scored", () => {
    const done = { status: "succeeded" as const, finishedAt: new Date(t0 + 25 * 60_000), terminatedAt: new Date(t0 + 26 * 60_000), costUsd: 1.5 };
    // Long past the judge's wait, with no summary saved: evalState says judging didn't finish.
    const late = tuneRunView({ dataset: ready(), written: null, job: job(done), events: evalEvents(5) }, new Date(t0 + 24 * 60 * 60_000), CEILINGS);
    assert.equal(late.stage, "ready");
    assert.deepEqual(late.verdict, { passed: false, scored: false, words: "Judging didn't finish, so the items below have no verdicts. It wasn't scored, so it hasn't passed." });
    assert.equal(tuneArt(late), "present");
    assert.equal(tuneSteps(late).at(-1)!.description, late.verdict!.words);
    assert.doesNotMatch(JSON.stringify(tuneSteps(late)), /"Scored\."/);

    const none = view(ready(), job(done));
    assert.equal(none.stage, "ready");
    assert.deepEqual(none.verdict, { passed: false, scored: false, words: "It had no kept-aside prompts to score, so it hasn't passed." });
    assert.equal(tuneArt(none), "present");
  });

  it("ends failed or stopped with its job", () => {
    const failed = view(ready(), job({ status: "failed", error: "Traceback\nCUDA out of memory", terminatedAt: new Date(NOW) }));
    assert.equal(failed.stage, "failed");
    assert.equal(failed.problem, "CUDA out of memory");
    assert.equal(tuneSteps(failed).at(-1)!.state, "failed");
    const stopped = view(ready(), job({ status: "stopped", terminatedAt: new Date(NOW) }));
    assert.equal(stopped.stage, "stopped");
    assert.equal(tuneStepsEnd(stopped), "stopped");
    assert.equal(TUNE_ART.stopped, "present");
  });

  it("reads the run's marks: its steps, heartbeat, ending and stop, and nobody else's", () => {
    const rows = [
      { key: `tune-settings:${DS}:steps`, windowStart: new Date("2100-01-01T00:00:00.000Z"), count: 300 },
      ...beats("gpu_busy", 12, 2),
      ...beats("checking", 14, 13),
      { key: `tune-run:other-run:paused`, windowStart: NOW, count: 1 },
      { key: `tune-run-end:${DS}:waited_gpu_busy`, windowStart: new Date("2100-01-01T00:00:00.000Z"), count: 1 },
    ];
    const marks = runMarks(DS, rows);
    assert.equal(marks.steps, 300);
    assert.equal(marks.stopped, false);
    assert.equal(marks.ended, "waited_gpu_busy");
    assert.equal(marks.heartbeat?.state, "gpu_busy");
    assert.equal(marks.heartbeat?.since.getTime(), NOW.getTime() - 12 * 60_000, "since the first minute of the same reason");
    assert.equal(marks.heartbeat?.at.getTime(), NOW.getTime() - 2 * 60_000);
    assert.equal(runMarks(DS, [{ key: `tune-run-stopped:${DS}`, windowStart: new Date(0), count: 1 }]).stopped, true);
    assert.deepEqual(runMarks(DS, []), NO_MARKS);
  });

  it("checks, then waits for a GPU with the reason the workflow's heartbeat gives, and takes the run's own steps", () => {
    const checking = view(ready(), null, [], null, NOW, runMarks(DS, beats("checking", 1, 0)));
    assert.equal(checking.stage, "checking");
    assert.equal(checking.hold, null);
    assert.equal(checking.next, null, "nothing to press while it checks");
    assert.equal(tuneRunning(checking), true);
    assert.deepEqual(tuneSteps(checking).map((r) => [r.id, r.state]), [["plan", "done"], ["writing", "done"], ["checking", "running"]]);

    const marks = runMarks(DS, [...beats("too_many_active", 20, 3), { key: `tune-settings:${DS}:steps`, windowStart: new Date("2100-01-01T00:00:00.000Z"), count: 300 }]);
    const busy = view(ready(), null, [], null, NOW, marks);
    assert.equal(busy.stage, "waiting");
    assert.deepEqual(busy.hold, { reason: "too_many_active", text: waitText("too_many_active"), since: new Date(NOW.getTime() - 20 * 60_000).toISOString() });
    assert.equal(busy.next?.kind, "start", "Start training asks again at once");
    assert.deepEqual(tuneCurrentStep(busy), { title: "Waiting for a GPU", description: waitText("too_many_active") });
    assert.deepEqual(tuneSteps(busy).at(-1), { id: "waiting", title: "Waiting for a GPU", description: waitText("too_many_active"), state: "running" });
    assert.equal(busy.plan.steps, 300, "the steps the run was started with");
    assert.ok(busy.plan.trainMinutes > view(ready()).plan.trainMinutes, "and their time");

    // A heartbeat that stopped coming: nothing is trying any more, so it's Start training again.
    const stale = view(ready(), null, [], null, new Date(NOW.getTime() + TUNE_HEARTBEAT_FRESH_MS + 4 * 60_000), marks);
    assert.equal(stale.hold?.reason, "not_started");
    assert.equal(tuneCurrentStep(stale), null);
  });

  it("says why training didn't start, fails a run whose examples failed the check, and stops a stopped one", () => {
    const keep = new Date("2100-01-01T00:00:00.000Z");
    const waited = view(ready(), null, [], null, NOW, runMarks(DS, [{ key: `tune-run-end:${DS}:waited_gpu_busy`, windowStart: keep, count: 1 }]));
    assert.equal(waited.stage, "waiting");
    assert.equal(waited.hold?.reason, "not_started");
    assert.equal(waited.hold?.text, "It waited 2 hours and training didn't start. No Muse Glimmer GPU is free on Lambda right now. Start training tries again.");
    const refused = view(ready(), null, [], null, NOW, runMarks(DS, [{ key: `tune-run-end:${DS}:lambda_not_configured`, windowStart: keep, count: 1 }]));
    assert.match(refused.hold!.text, /^Training didn't start: Lambda isn't connected on this deployment\. Start training tries again\.$/);

    const long = view(ready(), null, [], null, NOW, runMarks(DS, [{ key: `tune-run-end:${DS}:too_long`, windowStart: keep, count: 1 }]));
    assert.equal(long.stage, "failed");
    assert.match(long.problem!, /longer than Muse Glimmer trains on/);
    assert.equal(long.next, null);
    assert.equal(tuneSteps(long).at(-1)!.state, "failed");

    const stopped = view(ready(), null, [], null, NOW, { ...NO_MARKS, stopped: true });
    assert.equal(stopped.stage, "stopped");
    assert.equal(stopped.hold?.reason, "stopped");
    assert.equal(stopped.next, null, "nothing launches for a stopped run");
    // A job that started before the stop is still the run's.
    assert.equal(view(ready(), job(), [], null, NOW, { ...NO_MARKS, stopped: true }).stage, "training");
  });

  it("keeps every word free of em dashes", () => {
    const all = [view(dataset(), null, [], 3), view(ready()), view(ready(), job()), view(ready(), job({ status: "succeeded", evalSummary: summary }), evalEvents(20))];
    for (const v of all) {
      const text = JSON.stringify([tuneSteps(v), tuneCurrentStep(v), v.hold, v.verdict, v.problem]);
      assert.equal(text.includes(String.fromCharCode(0x2014)), false);
    }
  });
});

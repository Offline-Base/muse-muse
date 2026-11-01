/**
 * A fine-tuning run at every stage its room shows (components/train/room/TrainRoom.tsx), built from made-up rows by the
 * same tuneRunView the route and the page use: writing, waiting with Ready to train, training, scoring, ready (passed,
 * not passed, and not scored because judging never finished), failed while writing, failed while training, and stopped. Not a test file: tune-room.test.tsx renders them.
 * The bakery and its questions are made up.
 */
import type { JobLiveDemo } from "@/components/train/LiveDemo";
import type { DatasetHead, TrainJobRow } from "@/lib/train/logic";
import type { TuneRunView, TuneStage } from "@/lib/train/tune/types";
import { tuneRunView } from "@/lib/train/tune/view";
import type { LiveDemoView, TrainEventView } from "@/lib/train/types";

export const RUN_ID = "1b2c3d4e-0000-4000-8000-000000000002";
export const JOB_ID = "8f1d2c3b-0000-4000-8000-000000000001";
export const SERVE_ID = "8f1d2c3b-0000-4000-8000-000000000009";
export const T0 = Date.parse("2026-11-01T12:00:00.000Z");
export const CEILINGS = { maxMinutes: 120, maxUsd: 5 };
/** What no page of the room may show: the GPU's IP and its instance name. */
export const INSTANCE_DETAILS = /203\.0\.113\.9|mm-train-/;

const minutes = (m: number) => new Date(T0 + m * 60_000);

export function datasetRow(over: Partial<DatasetHead> = {}): DatasetHead {
  return {
    id: RUN_ID,
    title: "a made-up bakery's counter helper",
    task: "Answer questions for a made-up bakery: hours, allergens and cake orders.\n\nWrite in the style of these examples, which are the person's own:\n- Q: Open Sunday?\n  A: 8 to 2.",
    status: "ready",
    requested: 200,
    trainCount: 180,
    evalCount: 20,
    costUsd: 4.2,
    error: null,
    createdBy: null,
    createdAt: minutes(0),
    finishedAt: minutes(20),
    workflowRunId: null,
    writerModel: "muse-wonder-1.0",
    ...over,
  } as DatasetHead;
}

export function jobRow(over: Partial<TrainJobRow> = {}): TrainJobRow {
  return {
    id: JOB_ID,
    recipe: "glimmer-lora",
    title: "a made-up bakery's counter helper",
    status: "running",
    params: { datasetId: RUN_ID, maxSteps: 120, learningRate: 0.0002, loraRank: 16, dryRun: 0 },
    instanceType: "gpu_1x_a100_sxm4",
    region: "us-east-1",
    priceCentsPerHour: 129,
    maxMinutes: 90,
    maxUsd: 5,
    instanceId: "i-made-up",
    instanceIp: "203.0.113.9",
    instanceName: "mm-train-8f1d2c3b-glimmer-lora",
    tokenHash: null,
    workflowRunId: null,
    stopRequested: false,
    progress: null,
    artifacts: [],
    summary: null,
    error: null,
    costUsd: 0.6,
    createdBy: null,
    createdAt: minutes(21),
    launchedAt: minutes(22),
    firstHeartbeatAt: minutes(30),
    lastHeartbeatAt: minutes(40),
    finishedAt: null,
    terminatedAt: null,
    evalSummary: null,
    judgeModel: "muse-wonder-1.0",
    hub: null,
    ...over,
  } as unknown as TrainJobRow;
}

const QUESTIONS = ["Nut-free cupcakes?", "Open on Sunday?", "Can I order a cake for Friday?", "Do you have vegan bread?"];

/** `total` kept-aside prompts with both answers, and the first `judged` of them judged. */
export function evalEvents(judged: number, total = 20, tunedWins = judged): TrainEventView[] {
  const at = minutes(70).toISOString();
  const out: TrainEventView[] = [];
  for (let i = 0; i < total; i++) {
    out.push({ id: i + 1, type: "eval", payload: { type: "eval", index: i, prompt: QUESTIONS[i % QUESTIONS.length]!, reference: "On Fridays.", base: "Maybe.", tuned: "On Fridays, order a day ahead." }, at });
  }
  for (let i = 0; i < judged; i++) {
    const tuned = i < tunedWins;
    out.push({ id: 100 + i, type: "judgement", payload: { type: "judgement", index: i, baseScore: tuned ? 3 : 8, tunedScore: tuned ? 8 : 3, better: tuned ? "tuned" : "base", note: "Made-up note." }, at });
  }
  return out;
}

const trained = { status: "succeeded" as const, finishedAt: minutes(64), terminatedAt: minutes(65), costUsd: 1.5 };
const passed = { items: 20, tunedWins: 18, baseWins: 1, ties: 1, avgBaseScore: 3.1, avgTunedScore: 8.4, judgeCostUsd: 0.25 };
const notPassed = { items: 20, tunedWins: 6, baseWins: 12, ties: 2, avgBaseScore: 6.2, avgTunedScore: 4.9, judgeCostUsd: 0.25 };

function run(dataset: DatasetHead, job: TrainJobRow | null, events: TrainEventView[] = [], written: number | null = null, at = 30): TuneRunView {
  return tuneRunView({ dataset, written, job, events }, minutes(at), CEILINGS);
}

export interface RoomFixture {
  stage: TuneStage;
  view: TuneRunView;
}

/** Each stage the room draws, by name. */
export const ROOM_FIXTURES = {
  writing: { stage: "writing", view: run(datasetRow({ status: "generating", trainCount: 0, evalCount: 0, costUsd: 1.4, finishedAt: null }), null, [], 84, 10) },
  waiting: { stage: "waiting", view: run(datasetRow(), null) },
  training: { stage: "training", view: run(datasetRow(), jobRow(), [], null, 40) },
  scoring: { stage: "scoring", view: run(datasetRow(), jobRow(trained), evalEvents(5), null, 70) },
  ready: { stage: "ready", view: run(datasetRow(), jobRow({ ...trained, evalSummary: passed }), evalEvents(20), null, 90) },
  // Trained, with its kept-aside prompts answered, but judging never finished: a day on, with no summary saved.
  readyUnscored: { stage: "ready", view: run(datasetRow(), jobRow(trained), evalEvents(0), null, 24 * 60) },
  readyNotPassed: { stage: "ready", view: run(datasetRow(), jobRow({ ...trained, evalSummary: notPassed }), evalEvents(20, 20, 6), null, 90) },
  failedWriting: { stage: "failed", view: run(datasetRow({ status: "failed", trainCount: 0, evalCount: 0, error: "The platform's daily spend cap is reached, so the dataset stopped." }), null) },
  failedTraining: { stage: "failed", view: run(datasetRow(), jobRow({ status: "failed", error: "Traceback (most recent call last)\nCUDA out of memory", finishedAt: minutes(50), terminatedAt: minutes(51) }), [], null, 60) },
  stopped: { stage: "stopped", view: run(datasetRow(), jobRow({ status: "stopped", stopRequested: true, finishedAt: minutes(45), terminatedAt: minutes(46) }), [], null, 60) },
} satisfies Record<string, RoomFixture>;

export type RoomFixtureName = keyof typeof ROOM_FIXTURES;

/** A ready run's live demo as the page reads it (app/fine-tuning/runs/live.ts): one open and live, or one to start. */
export const LIVE_DEMOS: { live: JobLiveDemo; start: JobLiveDemo } = {
  live: {
    kind: "demo",
    demo: { serveJobId: SERVE_ID, state: "live", minutes: 30, endsAt: minutes(120).toISOString() } satisfies LiveDemoView,
  },
  start: {
    kind: "start",
    adapterTitle: "a made-up bakery's counter helper",
    ceilings: CEILINGS,
    maxActive: 1,
    dailyUsd: 20,
    blocked: null,
    publicPage: true,
  },
};

/** The Hugging Face card's and Local files' setup, as the page passes it to admins. */
export const HUB = { offReason: null, maxActive: 1, dailyUsd: 20 };

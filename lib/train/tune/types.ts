/**
 * A fine-tuning run started the way a build starts (docs/TRAINING.md "Fine-tune like a build"): one box, a plan card,
 * Start. The run is a dataset row, so the room is keyed by the dataset's id and the training job is found by its
 * params.datasetId (lib/train/tune/store.ts). No migration. Pure types, shared by the routes, the pages and the tests.
 */
import type { PartnerEvalView } from "@/lib/train/partner/logic";
import type { EvalRow } from "@/components/train/format";
import type { DatasetView, TrainJobView } from "@/lib/train/types";

/** "chat" answers in its own words; "decision" picks one of a few labels (tg-decide's decision models). */
export type TuneKind = "chat" | "decision";

/** A checked base other than r30b (lib/train/bases.ts), for the estimates and the plan's words. */
export interface TuneBase {
  repo: string;
  revision: string;
  /** Step time over r30b's, and the weights' bytes to download. Estimates; absent on a run's room before its job exists. */
  scale?: number;
  bytes?: number;
  /** The license duties and what has never been run, as the plan shows them. */
  dutiesText?: string;
}

/** What a run trains with. Fixed defaults (planSettings); Advanced changes `examples` and `steps`. */
export interface TuneSettings {
  /** Examples Muse Wonder writes: the dataset's `requested`, 20 to 1000. */
  examples: number;
  recipe: "glimmer-lora";
  steps: number;
  loraRank: number;
  learningRate: number;
  studentPrompt: "short";
  /** Signed as 0, so plan hashes don't change. TUNE_AUTO_PUBLISH decides at launch (./auto-publish.ts). */
  publish: 0;
  /** The GPU asked for first. Another Muse Glimmer GPU when it isn't free. */
  gpu: string;
  /** The training job's limits: its time and its hard dollar ceiling. */
  maxMinutes: number;
  maxUsd: number;
  /** Set only with TUNE_ANY_BASE and a base picked. Never signed: Start checks it again. */
  base?: TuneBase;
}

/**
 * What a run is expected to cost and take. Meta's part is an estimate (Muse Wonder's cost per example isn't measured
 * yet); the GPU's is the job's hard dollar limit. Recomputed on the server whenever it counts (planCost).
 */
export interface TrainPlanCost {
  metaLowUsd: number;
  metaHighUsd: number;
  gpuMaxUsd: number;
  /** Scoring base against tuned, on Meta's API: an estimate. */
  scoreLowUsd: number;
  scoreHighUsd: number;
  /** Writing, training and scoring, in whole minutes, roughly. */
  minutes: number;
  /** The GPU's part of `minutes`: booting, loading the model, training and answering the kept-aside prompts. */
  trainMinutes: number;
}

/** Where a plan's examples come from: a task Muse Wonder writes for, a dataset that already exists, or a build (later). */
export type TrainPlanSource = { kind: "task" } | { kind: "dataset"; datasetId: string } | { kind: "build"; buildId: string; productId: string } | { kind: "folder"; hash: string; mode: "rows" | "write" };

/** A plan as POST /api/train/plan answers it, before `token` and `exp` are added. */
export interface TrainPlanBody {
  v: 1;
  kind: TuneKind;
  /** The model's role, which becomes the dataset's title ("You are " + name, lib/train/recipes/index.ts). */
  name: string;
  tagline: string;
  /** The dataset's task: the person's words, with their own rows folded in as style examples (foldExamples). */
  task: string;
  /** Up to three things a person might ask it, for the card. */
  samples: string[];
  /** The person's rows: how many they gave, and how many fit into the task. */
  examples: { given: number; used: number };
  settings: TuneSettings;
  cost: TrainPlanCost;
  source: TrainPlanSource;
}

/**
 * The signed plan. `token` is mac("train-plan", [callerId, sha256(canonicalJson(body)), exp]), so Start never asks
 * Muse Wonder again and can't start a task the plan didn't show. `exp` is an ISO time.
 */
export interface TrainPlan extends TrainPlanBody {
  token: string;
  exp: string;
}

/** The person's own rows, parsed in the browser from a CSV, a JSONL file or pasted pairs (lib/train/tune/examples.ts). */
export interface ExampleRow {
  prompt: string;
  answer: string;
}

/**
 * Where a run stands, in the order a run goes: the examples are written, then checked, then it waits for a GPU, trains,
 * is scored, and is ready. Failed and stopped end it early.
 */
export type TuneStage = "writing" | "checking" | "waiting" | "training" | "scoring" | "ready" | "failed" | "stopped";

/**
 * Why a run waits. "not_started": the examples are ready and nothing is trying to train on them (the tuneRun workflow
 * ended or never started), so the room offers Start training. The rest are the tuneRun workflow's waiting reasons,
 * from its heartbeat (lib/train/tune/marks.ts): it tries the launch again every 5 minutes, for up to 2 hours.
 * "stopped": stopped before training.
 */
export type TuneHoldReason =
  | "not_started"
  | "gpu_busy"
  | "too_many_active"
  | "daily_cap"
  | "sweep_not_running"
  | "paused"
  | "lambda_unavailable"
  | "launching"
  | "stopped";

export interface TuneVerdict {
  passed: boolean;
  /** One sentence for the room, such as "Tuned won 18 of 20 kept-aside prompts (8.4 vs 3.1)." */
  words: string;
}

/** A run's verdict once it ended: `scored` is false when nothing was judged (judging didn't finish or had nothing to judge). */
export interface RunVerdict extends TuneVerdict {
  scored: boolean;
}

/** GET /api/train/runs/{id}: a run as its room shows it. Admins only today, so the job is the full admin view. */
export interface TuneRunView {
  id: string;
  /** Set when it trains on Fireworks, on plain Muse Glimmer 30B rather than r30b. */
  trainer?: "fireworks";
  title: string;
  task: string;
  stage: TuneStage;
  /** The settings the run trains with and what it is expected to cost, recomputed from the dataset. */
  plan: TuneSettings & TrainPlanCost;
  /** The GPU's name, such as "1x A100 SXM4 (40 GB)". */
  gpuLabel: string;
  dataset: DatasetView;
  /** Examples written so far while the dataset is being written, else null. */
  written: number | null;
  job: TrainJobView | null;
  evals: EvalRow[];
  verdict: RunVerdict | null;
  /** The person asked only for the examples (MAKE_CHAT_ALL): nothing trains unless they start it. */
  datasetOnly?: boolean;
  hold: { reason: TuneHoldReason; text: string; since: string } | null;
  /** Why it failed or stopped, in a sentence, else null. */
  problem: string | null;
  /** What Meta and the GPU have charged so far: the examples, the GPU and the scoring. */
  costSoFarUsd: number;
  /** PARTNER_EVALS: the newest partner eval of its job ("Evaluated on Baseten"), when one was recorded. */
  partnerEval?: PartnerEvalView;
  /** One card per partner with anything recorded ("Evaluated on Baseten", "Evaluated on Modal", ...), when there are any. */
  partnerEvals?: PartnerEvalView[];
  /**
   * The one thing the room offers next: Start training (POST `start`, runs/{id}/start) while the examples are ready
   * and no job trains on them, with the full New job form for admins (`fullForm`); the job's page once there is one.
   */
  next: { kind: "start"; start: string; fullForm: string; autoUpload?: boolean } | { kind: "job"; href: string } | null;
}

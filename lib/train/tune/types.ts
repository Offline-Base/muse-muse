/**
 * A fine-tuning run started the way a build starts (docs/TRAINING.md "Fine-tune like a build"): one box, a plan card,
 * Start. The run is a dataset row, so the room is keyed by the dataset's id and the training job is found by its
 * params.datasetId (lib/train/tune/store.ts). No migration. Pure types, shared by the routes, the pages and the tests.
 */
import type { EvalRow } from "@/components/train/format";
import type { DatasetView, TrainJobView } from "@/lib/train/types";

/** "chat" answers in its own words; "decision" picks one of a few labels (tg-decide's decision models). */
export type TuneKind = "chat" | "decision";

/** What a run trains with. Fixed defaults today (planSettings); Advanced v1 changes only `examples`. */
export interface TuneSettings {
  /** Examples Muse Wonder writes: the dataset's `requested`, 20 to 1000. */
  examples: number;
  recipe: "glimmer-lora";
  steps: number;
  loraRank: number;
  learningRate: number;
  studentPrompt: "short";
  /** Publishing to Hugging Face stays off unless someone presses Publish later. */
  publish: 0;
  /** The GPU asked for first. Another Muse Glimmer GPU when it isn't free. */
  gpu: string;
  /** The training job's limits: its time and its hard dollar ceiling. */
  maxMinutes: number;
  maxUsd: number;
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
export type TrainPlanSource = { kind: "task" } | { kind: "dataset"; datasetId: string } | { kind: "build"; buildId: string; productId: string };

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
 * Why a run waits. "not_started": the examples are ready and no training job was started for them yet. Until U3's
 * tuneRun launches training on its own, that is every ready run (the room's "Ready to train" button).
 */
export type TuneHoldReason = "not_started" | "gpu_busy" | "too_many_active" | "daily_cap" | "sweep_not_running" | "paused" | "stopped";

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
  hold: { reason: TuneHoldReason; text: string; since: string } | null;
  /** Why it failed or stopped, in a sentence, else null. */
  problem: string | null;
  /** What Meta and the GPU have charged so far: the examples, the GPU and the scoring. */
  costSoFarUsd: number;
  /**
   * The one thing the room offers next. Until U3 lands, a run whose examples are ready has no training yet, and this is
   * the full New job form with the dataset picked (`/fine-tuning?dataset=<id>#new-job`). U3 replaces it with Start
   * training (runs/{id}/start).
   */
  next: { kind: "full_form"; href: string } | { kind: "job"; href: string } | null;
}

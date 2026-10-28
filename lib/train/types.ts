/**
 * Fine-tuning jobs on the owner's Lambda Cloud account (docs/TRAINING.md). Admin only. The platform holds
 * LAMBDA_API_KEY; a job's GPU instance only gets a one-time job token for reporting back.
 */

/** Recipes the platform can run. Each maps to a Python script in lib/train/recipes. */
export type RecipeId = "smoke" | "glimmer-lora";

export type TrainStatus =
  | "queued" // row created, workflow not yet launching
  | "launching" // asking Lambda for an instance
  | "booting" // instance requested, no heartbeat yet
  | "running" // the runner on the instance has reported in
  | "succeeded"
  | "failed"
  | "stopped"; // an admin stopped it

export const TRAIN_TERMINAL: readonly TrainStatus[] = ["succeeded", "failed", "stopped"];

export function isTrainTerminal(status: TrainStatus): boolean {
  return TRAIN_TERMINAL.includes(status);
}

/**
 * Media types a job may upload (app/api/train/jobs/[id]/upload/route.ts): what Python's mimetypes names for model
 * files, configs, logs and metrics. Nothing a browser renders as a page or runs as script (no text/html, image/svg+xml
 * or application/xhtml+xml), since uploads are public on the owner's Blob host. runner.py keeps the same list and
 * sends any other type as application/octet-stream.
 */
export const TRAIN_UPLOAD_TYPES: readonly string[] = [
  "application/octet-stream",
  "application/json",
  "application/x-ndjson",
  "application/gzip",
  "application/zip",
  "application/x-tar",
  "application/yaml",
  "application/x-yaml",
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/yaml",
  "text/x-python",
  "image/png",
  "image/jpeg",
];

/** A file the job produced, such as a LoRA adapter, uploaded to Vercel Blob through the platform. */
export interface TrainArtifact {
  name: string;
  kind: "adapter" | "checkpoint" | "metrics" | "log" | "other";
  url: string;
  bytes: number;
}

/** The latest progress the runner reported. */
export interface TrainProgress {
  step?: number;
  totalSteps?: number;
  loss?: number;
  message?: string;
}

/** What the runner on the instance may POST to /api/train/jobs/{id}/events, with `Authorization: Bearer <job token>`. */
export type TrainCallback =
  | { type: "heartbeat"; message?: string }
  | { type: "progress"; step?: number; totalSteps?: number; loss?: number; message?: string }
  | { type: "log"; text: string }
  | { type: "artifact"; artifact: TrainArtifact }
  | { type: "done"; summary?: string; metrics?: Record<string, number | string> }
  | { type: "failed"; error: string };

/** One row of the job's event log, shown on the job page. */
export type TrainEventBody =
  | TrainCallback
  | { type: "status"; status: TrainStatus; message?: string }
  | { type: "instance"; instanceId: string; instanceType: string; region: string; ip?: string | null }
  | { type: "terminated"; reason: string };

/** A GPU type a recipe can run on, in order of preference. */
export interface GpuChoice {
  instanceType: string;
  /** For the admin page; Lambda's own description is shown when it has one. */
  label: string;
}

export interface RecipeParamField {
  key: string;
  label: string;
  kind: "text" | "url" | "number";
  /** Shown under the field. */
  help?: string;
  required?: boolean;
  default?: string | number;
  min?: number;
  max?: number;
}

export interface Recipe {
  id: RecipeId;
  title: string;
  /** One or two sentences for the admin page. */
  description: string;
  gpus: GpuChoice[];
  /** Hard limits used when the admin doesn't set lower ones. */
  defaultMaxMinutes: number;
  defaultMaxUsd: number;
  params: RecipeParamField[];
  /** The Python script the runner imports as `recipe` (it must define run(ctx)). */
  script: string;
}

export interface TrainLimits {
  maxMinutes: number;
  maxUsd: number;
}

/** Decisions the workflow's check step can make. */
export type TrainCheck =
  | { action: "wait" }
  | { action: "terminate"; status: Extract<TrainStatus, "succeeded" | "failed" | "stopped">; reason: string };

/** GET /api/train/jobs and /api/train/jobs/{id}: a job as the admin pages show it. Dates are ISO strings. */
export interface TrainJobView {
  id: string;
  recipe: RecipeId;
  title: string;
  status: TrainStatus;
  params: Record<string, string | number>;
  instanceType: string;
  region: string;
  priceCentsPerHour: number;
  maxMinutes: number;
  maxUsd: number;
  instanceId: string | null;
  instanceIp: string | null;
  stopRequested: boolean;
  progress: TrainProgress | null;
  artifacts: TrainArtifact[];
  summary: string | null;
  error: string | null;
  /** Final cost once terminated, otherwise the running estimate. */
  costUsd: number;
  createdAt: string;
  launchedAt: string | null;
  lastHeartbeatAt: string | null;
  finishedAt: string | null;
  terminatedAt: string | null;
}

export interface TrainEventView {
  id: number;
  type: TrainEventBody["type"];
  payload: TrainEventBody;
  at: string;
}

/** GET /api/train/gpus: Lambda instance types a recipe can use, with live capacity. */
export interface GpuOption {
  instanceType: string;
  description: string;
  priceCentsPerHour: number;
  /** Regions with capacity right now. Empty means none free. */
  regions: string[];
  recipes: RecipeId[];
}

/** A recipe without its script, for the admin page. */
export type RecipeView = Omit<Recipe, "script">;

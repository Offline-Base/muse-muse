/**
 * Fine-tuning jobs on the owner's Lambda Cloud account (docs/TRAINING.md). Admin only. The platform holds
 * LAMBDA_API_KEY; a job's GPU instance only gets a one-time job token for reporting back.
 */

/**
 * Recipes the platform can run. Each maps to a Python script in lib/train/recipes. "glimmer-serve" serves one trained
 * glimmer-lora adapter for a fixed number of minutes, for the live demo on its public result page (docs/TRAINING.md
 * "Live demo").
 */
export type RecipeId = "smoke" | "glimmer-lora" | "glimmer-serve";

/**
 * The port a glimmer-serve job's demo server listens on (HTTPS with a self-signed certificate). The serve firewall
 * ruleset opens it, the "serving" callback must name it, and the platform's proxy connects to it.
 */
export const SERVE_PORT = 8443;

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
  | { type: "failed"; error: string }
  /** One held-out prompt answered by the base and the tuned model, sent before "done". Fields are cut to 3,500 chars. */
  | { type: "eval"; index: number; prompt: string; reference: string; base: string; tuned: string }
  /**
   * A glimmer-serve job's demo server is up: HTTPS on `port` (SERVE_PORT) with a self-signed certificate whose SHA-256
   * fingerprint is `certSha256` (64 lowercase hex characters). The platform pins it; the IP comes from Lambda, never
   * from the callback.
   */
  | { type: "serving"; port: number; certSha256: string; model?: string; adapterJobId?: string };

/** One row of the job's event log, shown on the job page. */
export type TrainEventBody =
  | TrainCallback
  | { type: "status"; status: TrainStatus; message?: string }
  | { type: "instance"; instanceId: string; instanceType: string; region: string; ip?: string | null }
  | { type: "terminated"; reason: string }
  /** Muse Spark 1.3's verdict on one eval item, scored 1 to 10 against the reference answer. */
  | { type: "judgement"; index: number; baseScore: number; tunedScore: number; better: "base" | "tuned" | "tie"; note: string };

/** A GPU type a recipe can run on, in order of preference. */
export interface GpuChoice {
  instanceType: string;
  /** For the admin page; Lambda's own description is shown when it has one. */
  label: string;
}

export interface RecipeParamField {
  key: string;
  label: string;
  /**
   * "dataset" is a select of ready training datasets; its value is the dataset id. "adapter" is a select of succeeded
   * glimmer-lora jobs whose adapter is on a model cache filesystem (AdapterOption); its value is that job's id.
   */
  kind: "text" | "url" | "number" | "dataset" | "adapter";
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
  /**
   * Keeps a model cache on the region's Lambda filesystem "muse-muse-cache-<region>": launch mounts it (creating it
   * once) and job.json gets its mount path as cacheDir. Job creation prefers regions that already have one.
   */
  usesCache?: boolean;
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
  /** Set once the platform has judged the job's eval items. */
  evalSummary: EvalSummary | null;
  /**
   * A glimmer-serve job's demo server, once it reported "serving": when it started and when it is expected to stop
   * (its minutes, or the job's limits when those come first). Null or absent otherwise. Never the certificate.
   */
  serving?: TrainServingView | null;
}

/** When a glimmer-serve job's demo server started answering, and when it is expected to stop. ISO strings. */
export interface TrainServingView {
  startedAt: string;
  endsAt: string;
}

/**
 * training_jobs.serve_endpoint: where a glimmer-serve job's demo server answers. `ip` is the instance's IP from Lambda
 * (null until Lambda reported one), `port` and `certSha256` (the self-signed certificate's SHA-256 fingerprint, 64
 * lowercase hex characters) come from its "serving" callback, and `startedAt` (ISO) is when that arrived. Platform
 * only: the proxy connects to it, and none of it is ever sent to a browser.
 */
export interface ServeEndpoint {
  ip: string | null;
  port: number;
  certSha256: string;
  startedAt: string;
}

/** A trained adapter a glimmer-serve job can serve, for the "adapter" select. Dates are ISO strings. */
export interface AdapterOption {
  /** The glimmer-lora job's id: the param's value. */
  jobId: string;
  title: string;
  /** The region of the cache filesystem that holds it, where a serve job must launch. */
  region: string;
  /** The title of the dataset it was trained on, when that dataset still exists. */
  datasetTitle: string | null;
  finishedAt: string | null;
  evalSummary: EvalSummary | null;
}

/**
 * A live demo of a trained adapter, as the public result page shows it (lib/train/store.ts getLiveDemo). Never the IP,
 * the serving key or the certificate. "starting": the serve job is launching or loading the model; "live": its demo
 * server answers through POST /api/lab/{adapterJobId}/try. `endsAt` (ISO) is when serving is expected to stop, null
 * before the GPU launched.
 */
export interface LiveDemoView {
  serveJobId: string;
  state: "starting" | "live";
  minutes: number;
  endsAt: string | null;
}

/** POST /api/lab/{adapterJobId}/try: both answers to one prompt, from the same GPU, and how long the GPU took. */
export interface TryLiveAnswer {
  base: string;
  tuned: string;
  ms: number;
}

/**
 * The error codes POST /api/lab/{adapterJobId}/try answers with: 404 no_live_demo (none running for that adapter, or
 * its GPU is shutting down), 409
 * busy (another prompt is being answered), 429 rate_limited (with `scope` "ip" or "demo"), 504 timeout (no answer in
 * 120 s), 502 demo_unavailable (the GPU couldn't be reached, its certificate didn't match, or it answered with an
 * error), 403 cross_site. A bad prompt is a 400 with a sentence.
 */
export type TryLiveError = "no_live_demo" | "busy" | "rate_limited" | "timeout" | "demo_unavailable" | "cross_site";

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

/** How the tuned model did against the base model on the held-out prompts, judged by Muse Spark 1.3. */
export interface EvalSummary {
  items: number;
  tunedWins: number;
  baseWins: number;
  ties: number;
  avgBaseScore: number;
  avgTunedScore: number;
  /** What judging cost on Meta's API. */
  judgeCostUsd: number;
}

export type DatasetStatus = "generating" | "ready" | "failed";

/** One training conversation in the OpenAI messages format Unsloth and TRL take. */
export interface TrainExample {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

/** A held-out prompt with Muse Spark 1.3's answer as the reference. */
export interface EvalExample {
  prompt: string;
  reference: string;
}

/** GET /api/train/datasets: a dataset Muse Spark 1.3 wrote from a task description. */
export interface DatasetView {
  id: string;
  title: string;
  task: string;
  status: DatasetStatus;
  requested: number;
  trainCount: number;
  evalCount: number;
  costUsd: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

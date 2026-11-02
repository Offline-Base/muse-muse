/**
 * Fine-tuning jobs on the owner's Lambda Cloud account (docs/TRAINING.md). Admin only. The platform holds
 * LAMBDA_API_KEY; a job's GPU instance only gets a one-time job token for reporting back.
 */
import type { DecideScoreItem, DecisionSpec } from "@/lib/decide/types";

/**
 * Recipes the platform can run. Each maps to a Python script in lib/train/recipes. "glimmer-serve" serves one trained
 * glimmer-lora adapter for a fixed number of minutes, for the live demo on its public result page (docs/TRAINING.md
 * "Live demo"). "glimmer-publish" uploads one trained adapter from the model cache in its region to the Hugging Face
 * Hub, for an adapter its own job didn't upload (docs/TRAINING.md "Hugging Face Hub"). "glimmer-quantize" merges one
 * judged adapter into the base and makes its GGUF files in three sizes (docs/TRAINING.md "Local files").
 */
export type RecipeId = "smoke" | "glimmer-lora" | "glimmer-serve" | "glimmer-publish" | "glimmer-quantize" | "rl-grpo";

/** Reinforcement learning with TRL GRPO on made-up arithmetic (TUNE_RL; lib/train/recipes/rl.ts). */
export const RL_RECIPE = "rl-grpo" satisfies RecipeId;

/**
 * The recipe that uploads a trained adapter's files to the Hugging Face Hub from the model cache, and nothing else. The
 * platform commits them once its job succeeded.
 */
export const PUBLISH_RECIPE = "glimmer-publish" satisfies RecipeId;

/**
 * The recipe that makes a judged adapter's local files: the adapter merged into the 16-bit base, converted to GGUF,
 * quantized to each build in QUANT_LEVELS (lib/train/local-files.ts), checked, and uploaded to its own GGUF repo on the
 * Hugging Face Hub, which its job publishes once it succeeded.
 */
export const QUANT_RECIPE = "glimmer-quantize" satisfies RecipeId;
/**
 * The image a glimmer-quantize job launches on: the pinned llama.cpp Ubuntu binaries need glibc 2.38, and Lambda's default
 * image is Ubuntu 22.04 with glibc 2.35, where every tool stops before it starts (seen on a real A10, Nov 1 2026).
 */
export const QUANT_IMAGE_FAMILY = "lambda-stack-24-04";

/**
 * A glimmer-quantize job's params. adapterJobId (the glimmer-lora job whose adapter it merges) and publish are the
 * admin's; the platform writes the other three itself when the job is created, so no caller chooses them: levels (the
 * builds, QUANT_LEVELS joined with commas), slug (the dataset slug the adapter's repos are named with) and
 * trainChannel (1 when the adapter learned to open the final channel itself, else 0, so the files need tuned.jinja).
 */
export interface GlimmerQuantizeParams {
  adapterJobId: string;
  publish: number;
  levels: string;
  slug: string;
  trainChannel: number;
}

/**
 * A glimmer-publish job's params: the glimmer-lora job whose adapter it uploads. Its job runs in that job's region, with
 * that region's model cache mounted, and finds the adapter at <cache>/models/<adapterJobId>/. Both calls to
 * POST /api/train/jobs/{id}/hub act for that job.
 */
export interface GlimmerPublishParams {
  adapterJobId: string;
}

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
  | { type: "serving"; port: number; certSha256: string; model?: string; adapterJobId?: string }
  /**
   * A decide mode job's scores for one part (docs/DECISION_MODELS.md "Callbacks and caps"), sent before "done": for each
   * item, its index in the part and the base and tuned model's log-probability of each shown letter (tuned null when it
   * wasn't scored). At most DECIDE_CALLBACK_ITEMS_MAX items a callback. Logged as one "decide" event, at most
   * DECIDE_ITEMS_MAX items a job, an index sent again counted once.
   */
  | { type: "decide"; part: DecidePart; items: DecideScoreItem[] };

/** The two parts a decide job scores: dev (only to fit T) and test (part=eval of the dataset route). */
export type DecidePart = "dev" | "test";

/** One row of the job's event log, shown on the job page. */
export type TrainEventBody =
  | TrainCallback
  | { type: "status"; status: TrainStatus; message?: string }
  | { type: "instance"; instanceId: string; instanceType: string; region: string; ip?: string | null }
  | { type: "terminated"; reason: string }
  /** The judge's verdict on one eval item (the job's judgeModel), scored 1 to 10 against the reference answer. */
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
  /** A number that must be whole (epochs, a 0 or 1 switch). */
  whole?: boolean;
  /** A text field's only values, lowercase: what is given is trimmed and lowercased before it is checked. */
  choices?: string[];
  /**
   * The job modes (the recipe's "mode" param, "chat" when it isn't set) this field is for, when not all of them. In any
   * other mode it takes no default and a value for it is refused (validateParams).
   */
  modes?: string[];
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
   * The model that judged its eval items, or is judging them (judgeModelOf in lib/train/models.ts): Muse Spark 1.3 for
   * a job judged before the judge was recorded (Oct 29, 2026), null while no judge has started. Absent from older
   * servers.
   */
  judgeModel?: string | null;
  /**
   * A glimmer-serve job's demo server, once it reported "serving": when it started and when it is expected to stop
   * (its minutes, or the job's limits when those come first). Null or absent otherwise. Never the certificate.
   */
  serving?: TrainServingView | null;
  /**
   * A glimmer-lora job's Hugging Face state (docs/TRAINING.md "Hugging Face Hub"), once it has one: where publishing stands,
   * why it waits or failed, and the repos. Never the files the GPU sent or an upload URL. Null or absent otherwise.
   */
  hub?: HubView | null;
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
  /**
   * "decide" for a decision model's adapter (listed only when asked for, listAdapterOptions' opts.decide): glimmer-serve
   * serves it at POST /decide, and nothing else takes it yet. Absent for a chat adapter.
   */
  mode?: "decide";
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

/** How the tuned model did against the base model on the held-out prompts, judged blind by the job's judgeModel. */
export interface EvalSummary {
  items: number;
  tunedWins: number;
  baseWins: number;
  ties: number;
  avgBaseScore: number;
  avgTunedScore: number;
  /** What judging cost on Meta's API, the general checks included when there are any. */
  judgeCostUsd: number;
  /**
   * The fixed general-ability and safety checks (TUNE_GENERAL_CHECKS, lib/train/general-checks.ts), judged the same way
   * but kept out of the task's numbers above. Absent for a job that didn't answer them.
   */
  general?: EvalCheckSummary;
  safety?: EvalCheckSummary;
}

/** One check set's results: like the task's, plus how many of its prompts the job sent to be judged. */
export interface EvalCheckSummary {
  items: number;
  asked: number;
  tunedWins: number;
  baseWins: number;
  ties: number;
  avgBaseScore: number;
  avgTunedScore: number;
  judgeCostUsd: number;
}

export type DatasetStatus = "generating" | "ready" | "failed";

/**
 * What a dataset holds: "chat" examples a Muse model wrote (train and eval), or a person's labeled "decision" rows
 * (docs/DECISION_MODELS.md; training_datasets.decision and decision_rows).
 */
export type DatasetKind = "chat" | "decision";

/** One training conversation in the OpenAI messages format Unsloth and TRL take. */
export interface TrainExample {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

/** A held-out prompt with the dataset writer's answer as the reference. */
export interface EvalExample {
  prompt: string;
  reference: string;
}

/** GET /api/train/datasets: a dataset a Muse model (writerModel) wrote from a task description. */
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
  /**
   * The model that wrote its prompts and answers (writerModelOf in lib/train/models.ts): Muse Spark 1.3 for a dataset
   * made before the writer was recorded (Oct 29, 2026). Absent from older servers, which means the same.
   * "person" for a decision dataset a person uploaded (PERSON_WRITER).
   */
  writerModel?: string;
  /** "decision" for a decision dataset. Absent for a chat dataset, and from older servers: both mean "chat". */
  kind?: DatasetKind;
  /**
   * A decision dataset's definition (its question, labels, seed and rows per split, overall and per label), without
   * its rows. Absent for chat datasets. trainCount and evalCount are its train and test rows.
   */
  decision?: DecisionSpec;
}

// ---------------------------------------------------------------------------------------------------------------
// Publishing to the Hugging Face Hub (docs/TRAINING.md "Hugging Face Hub")

/**
 * Where a glimmer-lora job's publishing stands (training_jobs.hub.status):
 * - "off": publishing to the Hub is off here (HF_TOKEN or HF_NAMESPACE isn't set), with the reason.
 * - "waiting": it publishes once something else is done: the job's run, its judging, or an upload of its adapter's
 *   files, with the reason.
 * - "uploading": the GPU has the plan and is uploading the adapter's files straight to the Hub's storage.
 * - "uploaded": every file in the plan is on the Hub. The platform commits them once the job is judged.
 * - "publishing": the platform is writing the cards and committing the model and dataset repos.
 * - "published": both repos are committed and verified, and public unless HF_PUBLIC asks for private (`public` says
 *   which, as the Hub reported it).
 * - "failed": an upload or the publishing failed, with the reason. Publish on the job page tries again.
 */
export type HubStatus = "off" | "waiting" | "uploading" | "uploaded" | "publishing" | "published" | "failed";

/** One of the adapter's large files, which the GPU uploads straight to the Hub's storage through the LFS bridge. */
export interface HubFile {
  /** A file name in the repo's root, one of HUB_FILE_NAMES, such as "adapter_model.safetensors". */
  path: string;
  size: number;
  /** The lowercase hex SHA-256 of its bytes: its LFS oid. */
  sha256: string;
}

/**
 * training_jobs.hub: a glimmer-lora job's Hugging Face state. Platform only, and never the HF token or an upload URL,
 * which are never stored. The admin page gets HubView, the public pages only the links once it is published.
 */
export interface HubState {
  status: HubStatus;
  /** A plain sentence: why it is off, waiting or failed. */
  reason?: string | null;
  /** "<namespace>/<name>" of the model repo, once the platform made it. */
  modelRepo?: string | null;
  /** "<namespace>/<name>" of the dataset repo, which every job trained on the dataset shares. */
  datasetRepo?: string | null;
  /** The repos' pages, set once they are published. */
  modelUrl?: string | null;
  datasetUrl?: string | null;
  /**
   * True when both repos were public on the Hub once publishing finished (read back from the Hub, not assumed from
   * HF_PUBLIC). The public pages link only to public repos.
   */
  public?: boolean;
  /**
   * The adapter's files the GPU uploads itself, through the LFS bridge: the manifest the model repo's commit
   * references by oid. The small files the Hub keeps as regular files aren't in it: they are in `small`.
   */
  files?: HubFile[];
  /**
   * The adapter's small files (its config, the tokenizer's config, the chat template) as base64, at most
   * HUB_SMALL_FILE_MAX_BYTES each and HUB_SMALL_TOTAL_MAX_BYTES in all, from the latest plan only. The platform commits
   * them with the cards (adapter_config.json as a checked, normalized copy). The job lists leave them out.
   */
  small?: Record<string, string>;
  /** The LFS oids the Hub has: the GPU reported them uploaded, or the Hub already had them. */
  uploaded?: string[];
  /** The job whose GPU made the current plan: the job itself, or the glimmer-publish job that uploaded for it. */
  uploaderJobId?: string | null;
  /** The glimmer-publish job started for it, when its own job didn't upload the files. */
  publishJobId?: string | null;
  /**
   * When an admin's Publish began starting a glimmer-publish job (an ISO time), until it is started or refused: a second
   * Publish meanwhile starts none. One older than a few minutes was left by a request that died.
   */
  uploadStartingAt?: string | null;
  /**
   * The publishing run's claim while the status is "publishing": a random id hubPlanStep took, which every later step
   * of that run checks before it writes, so a run that lost its claim (a stale one taken again) changes nothing.
   */
  claim?: string | null;
  /** The commits that published it. */
  modelCommit?: string | null;
  datasetCommit?: string | null;
  /**
   * The GGUF repo the adapter's committed card points local apps to, or null for none, as hubModelStep wrote it:
   * hubFinishStep decides the pointer again once the model repo's visibility is set, and commits the card again when
   * it differs.
   */
  cardGguf?: string | null;
  /**
   * Why it was made, as an admin wrote it with Publish. It leads the card's "Why this exists", and the story builds on
   * it. "" when an admin cleared it, which wins over the job's "why" param; null or absent when Publish never set one,
   * so the param's counts (effectiveWhy in lib/train/logic.ts).
   */
  why?: string | null;
  /**
   * The rest of "Why this exists": a model's story (storyBy "spark", the value's name from before the model was
   * recorded), or the template's when the model couldn't write one.
   */
  story?: string | null;
  storyBy?: "spark" | "template" | null;
  /**
   * The model that wrote a "spark" story (STORY_MODEL in lib/train/hub-cards.ts). Null or absent means Muse Spark 1.3,
   * which wrote every story saved before the model was recorded (Oct 29, 2026; storyModelOf in lib/train/models.ts).
   */
  storyModel?: string | null;
  /** What the story's model charged for it. */
  storyCostUsd?: number | null;
  /** ISO times. */
  publishedAt?: string | null;
  updatedAt?: string | null;
}

/** A job's Hugging Face state as the admin job page shows it (GET /api/train/jobs/{id}/publish, TrainJobView.hub). */
export interface HubView {
  status: HubStatus;
  reason: string | null;
  modelRepo: string | null;
  datasetRepo: string | null;
  /** Set once published. */
  modelUrl: string | null;
  datasetUrl: string | null;
  /** The why the card prints: the one saved with Publish, else the job's "why" param (effectiveWhy). */
  why: string | null;
  /** "spark" when a model wrote the story (storyModel says which), "template" for the template's, null for none yet. */
  storyBy: "spark" | "template" | null;
  /** The model that wrote the story when storyBy is "spark" (storyModelOf), else null. Absent from older servers. */
  storyModel?: string | null;
  /** True once both repos are public. */
  public: boolean;
  /** True for a "publishing" state left by a run that stopped (HUB_PUBLISHING_STALE_MS old), which Retry starts again. */
  stale: boolean;
  /** How many of the files in the plan the Hub has, of how many. */
  filesUploaded: number;
  filesTotal: number;
  publishJobId: string | null;
  publishedAt: string | null;
}

/** The Hugging Face links the public pages get, only once a job is published. */
export interface PublicHubLinks {
  modelUrl: string;
  datasetUrl: string | null;
}

/** The first bytes of a file the Hub's preupload looks at (sample, base64). */
export const HUB_SAMPLE_BYTES = 512;
/** One small file, and all of them together, decoded. */
export const HUB_SMALL_FILE_MAX_BYTES = 1024 * 1024;
export const HUB_SMALL_TOTAL_MAX_BYTES = 3 * 1024 * 1024;
/** Files in one plan (a Hub commit gives up past about 100), and the largest one. A rank 128 adapter is about 3 GB. */
export const HUB_FILES_MAX = 100;
export const HUB_FILE_MAX_BYTES = 10 * 1024 ** 3;
/** The longest "why" an admin may write: the glimmer-lora "why" param's own cap (PARAM_TEXT_MAX in logic.ts). */
export const HUB_WHY_MAX = 2000;
/**
 * The only names of the adapter folder's files that are published, each in the folder's root: PEFT's weights and
 * config, and the files the tokenizer and processor save. Any other file (a checkpoint folder, optimizer.pt,
 * training_args.bin, PEFT's README.md, a full model's config.json or weights, a case variant of one of these) gets no
 * upload and stays out of the commit. runner.py's HUB_NAMES is the same list (a test keeps them equal).
 */
export const HUB_FILE_NAMES: readonly string[] = [
  "adapter_model.safetensors",
  "adapter_config.json",
  "tokenizer.json",
  "tokenizer.model",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "vocab.json",
  "merges.txt",
  "chat_template.jinja",
  "chat_template.json",
  "preprocessor_config.json",
  "processor_config.json",
  "video_preprocessor_config.json",
];
/**
 * Of those, the configs the platform reads before it publishes them: each must come whole in the plan's small files (a
 * JSON object with no "auto_map", which would point a loader at code from another repo), or it is left out.
 * adapter_config.json must also name the recipe's base model.
 */
export const HUB_CHECKED_NAMES: readonly string[] = [
  "adapter_config.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "chat_template.json",
  "preprocessor_config.json",
  "processor_config.json",
  "video_preprocessor_config.json",
];

/**
 * A glimmer-quantize job's files on the Hub: each GGUF file at most this big (Q6_K of Muse Glimmer 30B is 22.87 GB,
 * Q8_0 29.61), and only these small files besides them, each carried whole in the plan's small files for the platform
 * to check and commit: the system message, Ollama's params, and tuned.jinja for an adapter trained before trainChannel.
 * The GGUF files' own names follow ggufFileName in lib/train/hub-cards.ts; runner.py keeps the same rule.
 */
export const HUB_GGUF_FILE_MAX_BYTES = 32 * 1024 ** 3;
export const HUB_GGUF_SMALL_NAMES: readonly string[] = ["system", "params", "tuned.jinja"];

/** POST /api/train/jobs/{id}/hub {action: "plan"}: one file of the adapter's folder. */
export interface HubPlanFile {
  path: string;
  size: number;
  /** Lowercase hex. */
  sha256: string;
  /** Base64 of the first HUB_SAMPLE_BYTES bytes (all of them for a shorter file). */
  sample: string;
}

/**
 * POST /api/train/jobs/{id}/hub with the job token: the GPU's upload plan. `files` names every file of the adapter's
 * folder; `small` (path to base64) carries the small ones whole (each must also be in `files`, with its size and
 * sha256), which the platform keeps on the job and commits itself when the Hub's preupload marks them "regular". Every
 * other file gets an upload in the answer. A plan again from the same GPU (runner.py sends the whole plan once more
 * when a presigned URL answered 403, so it expired) replaces the plan before, keeping the oids the Hub already has.
 */
export interface HubPlanRequest {
  action: "plan";
  files: HubPlanFile[];
  small?: Record<string, string>;
  /**
   * The files to answer uploads for now, when not all of them: runner.py plans one file at a time once the platform
   * answered 413 plan_too_large with perFile, since every part URL of three multi-GB files would pass the answer's cap.
   * The plan is still the whole folder, which replaces the one before.
   */
  only?: string[];
}

/**
 * How the GPU uploads one file. "none": the Hub already has it. "basic": one PUT of the whole file to `href`, with
 * `header`. "multipart": PUT bytes [(n-1)*chunkSize, n*chunkSize) to each part's url, keep each answer's ETag, then POST
 * {"oid", "parts": [{"partNumber", "etag"}]} to `completionUrl` with Content-Type application/vnd.git-lfs+json. None of
 * these take an Authorization header. The URLs are credentials while they last: never log or store them. A 403 means
 * one expired: send the whole plan again, once per file, and take its fresh URLs.
 */
export type HubUpload =
  | { path: string; oid: string; size: number; transfer: "none" }
  | { path: string; oid: string; size: number; transfer: "basic"; href: string; header: Record<string, string> }
  | {
      path: string;
      oid: string;
      size: number;
      transfer: "multipart";
      chunkSize: number;
      parts: Array<{ partNumber: number; url: string }>;
      completionUrl: string;
    };

/** The plan's answer: why nothing is uploaded, or the model repo and how to upload each file. */
export type HubPlanResponse = { skip: string } | { repo: string; uploads: HubUpload[] };

/** POST /api/train/jobs/{id}/hub {action: "done"} -> 204: what the GPU uploaded and what failed. */
export interface HubDoneRequest {
  action: "done";
  uploaded: Array<{ path: string; oid: string; size: number }>;
  failed?: Array<{ path: string; error: string }>;
}

/** POST /api/train/jobs/{id}/publish: an admin's "why", optional. */
export interface HubPublishRequest {
  why?: string;
}

/** POST and GET /api/train/jobs/{id}/publish. */
export interface HubPublishResponse {
  hub: HubView | null;
  /** Why publishing is off here (env.hubOffReason), or null. */
  offReason: string | null;
  /** "publish" when it commits now, "upload" when a glimmer-publish job was started first. POST only. */
  started?: "publish" | "upload";
  /** The glimmer-publish job, when one was started. */
  publishJobId?: string;
}

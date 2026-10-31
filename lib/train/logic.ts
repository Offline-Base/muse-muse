/**
 * Pure decisions for fine-tuning jobs (docs/TRAINING.md). No Node APIs and no I/O, so the training workflow can import
 * this file and unit tests can run it directly.
 */
import { noEmDashes } from "@/lib/brief/normalize";
import type { trainingDatasets, trainingJobs } from "@/lib/db/schema";
// format.ts imports promptKey and promptWords from this file. Only functions below call into it, never this file's
// top level, so either file may load first.
import {
  combineGroups,
  labelGroups,
  letterMass,
  letterProbabilities,
  logprobsProblem,
  pickDecision,
  standInDecision,
  temperedDecision,
} from "@/lib/decide/format";
import type {
  CalibrationRow,
  DecideScoreItem,
  DecisionItemKey,
  DecisionScoringInput,
  DecisionSideSummary,
  DecisionSummary,
  LabelScore,
  ReliabilityBin,
  WilsonRate,
} from "@/lib/decide/types";
import type { LambdaInstance } from "@/lib/train/lambda";
import type { QuantLevel } from "@/lib/train/local-files";
import { judgeModelOf, storyModelOf, writerModelOf } from "@/lib/train/models";
import {
  HUB_WHY_MAX,
  isTrainTerminal,
  QUANT_RECIPE,
  SERVE_PORT,
  type DatasetView,
  type EvalSummary,
  type HubState,
  type HubView,
  type LiveDemoView,
  type Recipe,
  type RecipeId,
  type ServeEndpoint,
  type TrainCheck,
  type TrainEventBody,
  type TrainJobView,
  type TrainLimits,
  type TrainServingView,
  type TrainStatus,
} from "@/lib/train/types";

/** A job with no heartbeat this long after launch never booted. */
export const BOOT_GRACE_MS = 25 * 60_000;
/** A job that has reported in before and then goes quiet this long is gone. */
export const SILENCE_MS = 10 * 60_000;
/** How often the workflow checks a running job. */
export const POLL_MS = 30_000;

/** A job's limits never go below these, whatever the admin, the recipe or the ceilings say. */
export const MIN_MAX_MINUTES = 1;
export const MIN_MAX_USD = 0.1;

/** Text recipe params are trimmed and cut to this many characters. URL params longer than this are refused. */
export const PARAM_TEXT_MAX = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INSTANCE_NAME_PREFIX = "mm-train-";
/** Lambda's limit on instance names. */
export const INSTANCE_NAME_MAX = 64;

/** Text caps for event log rows (docs/TRAINING.md: log text cut to 4 KB). */
export const EVENT_LOG_MAX = 4096;
/** Each text field of an eval callback is cut to this many characters (the runner cuts them too). */
export const EVAL_TEXT_MAX = 3500;
/** Eval callbacks one job may record. Past this the events route answers 409 eval_limit. */
export const EVALS_MAX = 60;
const JUDGE_NOTE_MAX = 300;
export const EVENT_ERROR_MAX = 4096;
export const EVENT_MESSAGE_MAX = 2000;
const METRICS_MAX_KEYS = 50;
const METRIC_KEY_MAX = 100;
const METRIC_VALUE_MAX = 500;
const ARTIFACT_NAME_MAX = 200;
const ARTIFACT_URL_MAX = 2000;

/** A training_jobs row as Drizzle returns it. */
export type TrainJobRow = typeof trainingJobs.$inferSelect;

/** A training_datasets row without its examples or decision rows, which can run to megabytes. */
export type DatasetHead = Omit<typeof trainingDatasets.$inferSelect, "train" | "eval" | "decisionRows">;

/** What decideCheck needs from a job. A training_jobs row has all of it. */
export interface JobState {
  status: TrainStatus;
  stopRequested: boolean;
  error: string | null;
  priceCentsPerHour: number;
  maxMinutes: number;
  maxUsd: number;
  launchedAt: Date | null;
  firstHeartbeatAt: Date | null;
  lastHeartbeatAt: Date | null;
}

function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * What Lambda charges for the job so far: the hourly price over the time since launch (until terminatedAt once it's
 * terminated), with every started minute counted in full. Zero before launch.
 */
export function estimateCostUsd(
  job: { priceCentsPerHour: number; launchedAt: Date | null; terminatedAt: Date | null },
  now: Date,
): number {
  if (!job.launchedAt) return 0;
  const end = job.terminatedAt ?? now;
  const ms = end.getTime() - job.launchedAt.getTime();
  if (!(ms > 0) || !(job.priceCentsPerHour > 0)) return 0;
  const minutes = Math.ceil(ms / 60_000);
  return roundUsd(((job.priceCentsPerHour / 100) * minutes) / 60);
}

function asked(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A job's limits: what the admin asked for, capped by the platform ceilings (TRAIN_JOB_MAX_MINUTES, TRAIN_JOB_MAX_USD).
 * The recipe's defaults only fill in a limit nobody asked for, capped the same way, so a recipe can run past its
 * defaults when the admin asks and the ceilings allow it. Never under 1 minute or $0.10. Minutes are whole and dollars
 * are whole cents, both rounded down. A missing or non-numeric ask counts as no ask.
 */
export function clampLimits(
  recipe: Pick<Recipe, "defaultMaxMinutes" | "defaultMaxUsd">,
  ask: Partial<TrainLimits>,
  ceilings: TrainLimits,
): TrainLimits {
  const minutes = Math.min(asked(ask.maxMinutes) ?? recipe.defaultMaxMinutes, ceilings.maxMinutes);
  const usd = Math.min(asked(ask.maxUsd) ?? recipe.defaultMaxUsd, ceilings.maxUsd);
  return {
    maxMinutes: Math.max(MIN_MAX_MINUTES, Number.isFinite(minutes) ? Math.floor(minutes) : MIN_MAX_MINUTES),
    // The small nudge keeps float error from turning 1.15 into 1.14.
    maxUsd: Math.max(MIN_MAX_USD, Number.isFinite(usd) ? Math.floor(usd * 100 + 1e-6) / 100 : MIN_MAX_USD),
  };
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Checks the admin's params against the recipe's fields. Unknown keys are refused. A missing or blank value takes the
 * field's default, and a required field with no default must be set. Numbers may come as numeric strings (from a form)
 * and must sit within min and max. Text is trimmed and cut to 2000 characters. URLs must be https.
 */
export function validateParams(
  recipe: Recipe,
  raw: unknown,
): { ok: true; value: Record<string, string | number> } | { ok: false; error: string } {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, error: "params must be an object." };
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const fields = new Map(recipe.params.map((f) => [f.key, f]));
  const unknown = Object.keys(input).filter((k) => !fields.has(k));
  if (unknown.length) return { ok: false, error: `Unknown parameter: ${unknown.join(", ")}.` };

  const value: Record<string, string | number> = {};
  for (const field of recipe.params) {
    const given = input[field.key];
    if (isBlank(given)) {
      if (field.default !== undefined) value[field.key] = field.default;
      else if (field.required) return { ok: false, error: `${field.label} is required.` };
      continue;
    }
    if (field.kind === "number") {
      const n = typeof given === "number" ? given : typeof given === "string" ? Number(given.trim()) : NaN;
      if (!Number.isFinite(n)) return { ok: false, error: `${field.label} must be a number.` };
      if (field.min !== undefined && n < field.min) return { ok: false, error: `${field.label} must be at least ${field.min}.` };
      if (field.max !== undefined && n > field.max) return { ok: false, error: `${field.label} must be at most ${field.max}.` };
      value[field.key] = n;
      continue;
    }
    if (typeof given !== "string") return { ok: false, error: `${field.label} must be text.` };
    const text = given.trim();
    if (field.kind === "dataset") {
      // Whether it exists and is ready is checked against the database by the jobs route.
      if (!UUID_RE.test(text)) return { ok: false, error: `${field.label} must be one of the training datasets.` };
      value[field.key] = text.toLowerCase();
      continue;
    }
    if (field.kind === "adapter") {
      // Whether that job's adapter can be served is checked against the database by the jobs route (adapterProblem).
      if (!UUID_RE.test(text)) return { ok: false, error: `${field.label} must be one of the trained adapters.` };
      value[field.key] = text.toLowerCase();
      continue;
    }
    if (field.kind === "url") {
      if (text.length > PARAM_TEXT_MAX) return { ok: false, error: `${field.label} is too long.` };
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        return { ok: false, error: `${field.label} must be an https URL.` };
      }
      if (url.protocol !== "https:" || !url.hostname) return { ok: false, error: `${field.label} must be an https URL.` };
      value[field.key] = text;
      continue;
    }
    value[field.key] = text.slice(0, PARAM_TEXT_MAX);
  }
  return { ok: true, value };
}

function fail(reason: string): TrainCheck {
  return { action: "terminate", status: "failed", reason };
}

/**
 * What the workflow's check step does next, in this order: a stop request stops the job; a status the runner already
 * set (done or failed) ends it with that status; an instance that was terminated or preempted outside the platform,
 * the time limit, the dollar limit, no heartbeat 25 minutes after launch, 10 minutes of silence after the first
 * heartbeat, and an unhealthy instance all fail it. Otherwise it waits. `instance` is null when Lambda no longer has it.
 */
export function decideCheck(
  job: JobState,
  instance: { status: LambdaInstance["status"] } | null,
  now: Date,
): TrainCheck {
  if (job.stopRequested) return { action: "terminate", status: "stopped", reason: "Stopped by an admin." };
  if (isTrainTerminal(job.status)) {
    const status = job.status as Extract<TrainStatus, "succeeded" | "failed" | "stopped">;
    const reason =
      status === "succeeded"
        ? "The job finished."
        : status === "failed"
          ? job.error || "The job reported a failure."
          : "Stopped by an admin.";
    return { action: "terminate", status, reason };
  }
  if (!instance) return fail("The instance is gone from Lambda.");
  if (instance.status === "preempted") return fail("Lambda preempted the instance.");
  if (instance.status === "terminated" || instance.status === "terminating") {
    return fail("The instance was terminated outside the platform.");
  }

  const t = now.getTime();
  const launched = job.launchedAt?.getTime();
  if (launched !== undefined) {
    if (t - launched >= job.maxMinutes * 60_000) return fail(`Reached the ${job.maxMinutes}-minute limit.`);
    const cost = estimateCostUsd({ priceCentsPerHour: job.priceCentsPerHour, launchedAt: job.launchedAt, terminatedAt: null }, now);
    if (cost >= job.maxUsd) return fail(`Reached the $${job.maxUsd.toFixed(2)} limit.`);
    if (!job.firstHeartbeatAt && t - launched >= BOOT_GRACE_MS) {
      return fail(`No heartbeat ${BOOT_GRACE_MS / 60_000} minutes after launch.`);
    }
  }
  const lastSeen = job.lastHeartbeatAt ?? job.firstHeartbeatAt;
  if (job.firstHeartbeatAt && lastSeen && t - lastSeen.getTime() >= SILENCE_MS) {
    return fail(`No heartbeat for ${SILENCE_MS / 60_000} minutes.`);
  }
  if (instance.status === "unhealthy") return fail("Lambda reports the instance as unhealthy.");
  return { action: "wait" };
}

/** `mm-train-<first 8 chars of the job id>-<recipe>`, lowercase, at most 64 characters. Launch and sweep find instances by it. */
export function instanceNameFor(jobId: string, recipe: RecipeId): string {
  const name = `${INSTANCE_NAME_PREFIX}${jobId.slice(0, 8)}-${recipe}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return name.slice(0, INSTANCE_NAME_MAX).replace(/-+$/g, "");
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A job as the admin pages show it. Dates become ISO strings; cost is the final cost once terminated, else a live estimate. */
export function toJobView(row: TrainJobRow, now: Date): TrainJobView {
  return {
    id: row.id,
    recipe: row.recipe,
    title: row.title,
    status: row.status,
    params: row.params ?? {},
    instanceType: row.instanceType,
    region: row.region,
    priceCentsPerHour: row.priceCentsPerHour,
    maxMinutes: row.maxMinutes,
    maxUsd: row.maxUsd,
    instanceId: row.instanceId,
    instanceIp: row.instanceIp,
    stopRequested: row.stopRequested,
    progress: row.progress ?? null,
    artifacts: row.artifacts ?? [],
    summary: row.summary,
    error: row.error,
    costUsd: row.terminatedAt ? row.costUsd : estimateCostUsd(row, now),
    createdAt: row.createdAt.toISOString(),
    launchedAt: iso(row.launchedAt),
    lastHeartbeatAt: iso(row.lastHeartbeatAt),
    finishedAt: iso(row.finishedAt),
    terminatedAt: iso(row.terminatedAt),
    evalSummary: row.evalSummary ?? null,
    judgeModel: judgeModelOf(row),
    ...(row.recipe === SERVE_RECIPE ? { serving: servingView(row) } : {}),
    ...(row.hub ? { hub: toHubView(row.hub, row.params, now) } : {}),
  };
}

/** A "publishing" state this old was left by a workflow that died, so publishing may start again. */
export const HUB_PUBLISHING_STALE_MS = 30 * 60_000;

/** True while a workflow is publishing the job: "publishing", and not left that way by one that died. */
export function hubBusy(hub: HubState | null | undefined, now: number): boolean {
  if (hub?.status !== "publishing") return false;
  const at = Date.parse(hub.updatedAt ?? "");
  return Number.isFinite(at) && now - at < HUB_PUBLISHING_STALE_MS;
}

/**
 * The admin's why, as the cards print it: the one saved with Publish ("" when an admin cleared it, which wins), else
 * the job's "why" param. No em dashes, at most HUB_WHY_MAX characters, null when there is none.
 */
export function effectiveWhy(hub: HubState | null | undefined, params: Record<string, string | number> | null | undefined): string | null {
  const raw = typeof hub?.why === "string" ? hub.why : typeof params?.why === "string" ? params.why : "";
  const why = noEmDashes(raw).trim().slice(0, HUB_WHY_MAX);
  return why || null;
}

/**
 * A job's Hugging Face state as the admin job page shows it (docs/TRAINING.md "Hugging Face Hub"): where it stands, why,
 * the repos, the why the card prints (from the job's params when Publish never saved one), who wrote the story, how
 * many of the planned files the Hub has, and whether a "publishing" state was left by a run that stopped. Never the
 * small files' content, the story's cost, the claim or an upload URL (none is ever stored).
 */
export function toHubView(hub: HubState, params: Record<string, string | number> | null = null, now: Date = new Date()): HubView {
  const files = Array.isArray(hub.files) ? hub.files : [];
  const have = new Set(Array.isArray(hub.uploaded) ? hub.uploaded : []);
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    status: hub.status,
    reason: text(hub.reason),
    modelRepo: text(hub.modelRepo),
    datasetRepo: text(hub.datasetRepo),
    modelUrl: text(hub.modelUrl),
    datasetUrl: text(hub.datasetUrl),
    why: effectiveWhy(hub, params),
    storyBy: hub.storyBy === "spark" || hub.storyBy === "template" ? hub.storyBy : null,
    storyModel: storyModelOf(hub),
    public: hub.public === true,
    stale: hub.status === "publishing" && !hubBusy(hub, now.getTime()),
    filesUploaded: files.filter((f) => have.has(f.sha256)).length,
    filesTotal: files.length,
    publishJobId: text(hub.publishJobId),
    publishedAt: text(hub.publishedAt),
  };
}

function head(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

/** Keeps the end, where the last log lines and the traceback's cause are. */
function tail(text: unknown, max: number): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return s.length > max ? s.slice(s.length - max) : s;
}

function optionalHead(text: unknown, max: number): string | undefined {
  return text === undefined || text === null ? undefined : head(text, max);
}

/**
 * An event body with its text cut to size before it's stored: log text and errors keep their last 4 KB, messages and
 * summaries their first 2000 characters, metrics at most 50 keys. Other fields pass through.
 */
export function capEventBody(body: TrainEventBody): TrainEventBody {
  switch (body.type) {
    case "log":
      return { type: "log", text: tail(body.text, EVENT_LOG_MAX) };
    case "failed":
      return { type: "failed", error: tail(body.error, EVENT_ERROR_MAX) };
    case "heartbeat":
      return { type: "heartbeat", ...withMessage(body.message) };
    case "progress":
      return { ...body, ...withMessage(body.message) };
    case "status":
      return { ...body, ...withMessage(body.message) };
    case "terminated":
      return { type: "terminated", reason: head(body.reason, EVENT_MESSAGE_MAX) };
    case "artifact":
      return {
        type: "artifact",
        artifact: {
          ...body.artifact,
          name: head(body.artifact.name, ARTIFACT_NAME_MAX),
          url: head(body.artifact.url, ARTIFACT_URL_MAX),
        },
      };
    case "done": {
      const out: Extract<TrainEventBody, { type: "done" }> = { type: "done" };
      if (body.summary !== undefined) out.summary = head(body.summary, EVENT_MESSAGE_MAX);
      if (body.metrics && typeof body.metrics === "object") out.metrics = capMetrics(body.metrics);
      return out;
    }
    case "eval":
      return {
        type: "eval",
        index: body.index,
        prompt: head(body.prompt, EVAL_TEXT_MAX),
        reference: head(body.reference, EVAL_TEXT_MAX),
        base: head(body.base, EVAL_TEXT_MAX),
        tuned: head(body.tuned, EVAL_TEXT_MAX),
      };
    case "judgement":
      return { ...body, note: head(body.note, JUDGE_NOTE_MAX) };
    case "serving": {
      const out: Extract<TrainEventBody, { type: "serving" }> = {
        type: "serving",
        port: body.port,
        certSha256: certFingerprint(body.certSha256) ?? "",
      };
      if (body.model !== undefined) out.model = head(body.model, SERVE_TEXT_MAX);
      if (body.adapterJobId !== undefined) out.adapterJobId = head(body.adapterJobId, SERVE_TEXT_MAX);
      return out;
    }
    default:
      return body;
  }
}

function withMessage(message: unknown): { message?: string } {
  const m = optionalHead(message, EVENT_MESSAGE_MAX);
  return m === undefined ? {} : { message: m };
}

function capMetrics(metrics: Record<string, number | string>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(metrics).slice(0, METRICS_MAX_KEYS)) {
    out[head(key, METRIC_KEY_MAX)] = typeof value === "number" ? value : head(value, METRIC_VALUE_MAX);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Datasets (lib/train/datasets.ts) and judging (lib/train/judge.ts)

/** How many examples an admin may ask for. */
export const DATASET_MIN_COUNT = 20;
export const DATASET_MAX_COUNT = 1000;
/** A task description is at least this long, and at most DATASET_TASK_MAX characters. */
export const DATASET_TASK_MIN = 20;
export const DATASET_TASK_MAX = 2000;
/** Fewer answered examples than this and the dataset fails: eval needs 8 and train needs some. */
export const DATASET_MIN_EXAMPLES = 16;
/** Eval holds out this share of the examples, within EVAL_MIN and EVAL_MAX items. */
const EVAL_SHARE = 0.1;
const EVAL_MIN = 8;
const EVAL_MAX = 40;
/** Training examples always keep at least this many after the eval items are held out. */
const TRAIN_MIN = 8;

/** How many of `n` answered examples are held out for eval: 10%, at least 8 and at most 40, never leaving under 8 to train on. */
export function evalHoldoutCount(n: number): number {
  const total = Math.max(0, Math.floor(n));
  const wanted = Math.min(EVAL_MAX, Math.max(EVAL_MIN, Math.round(total * EVAL_SHARE)));
  return Math.max(0, Math.min(wanted, total - TRAIN_MIN));
}

/**
 * The positions of the eval items among `n` examples, ascending: spread evenly, so every prompt batch (each leans to a
 * different style) is represented. Deterministic, so a retried split picks the same ones.
 */
export function evalIndexes(n: number): number[] {
  const k = evalHoldoutCount(n);
  return Array.from({ length: k }, (_, i) => Math.floor(((i + 0.5) * n) / k));
}

/** Two prompts are the same when they match after folding accents and case and dropping everything but letters and digits. */
export function promptKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The prompts in `incoming` that aren't blank or already in `existing` (or earlier in `incoming`), at most `max` of them. */
export function dedupePrompts(existing: string[], incoming: string[], max: number): string[] {
  const seen = new Set(existing.map(promptKey));
  const out: string[] = [];
  for (const raw of incoming) {
    if (out.length >= max) break;
    const text = typeof raw === "string" ? raw.trim() : "";
    const key = promptKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Two prompts are near-duplicates when the sets of words in their promptKey overlap this much (Jaccard: the words they
 * share over the words either has). It catches a reordering, a typo or a changed word or two, such as "How do I reset
 * my password?" and "how can i reset my password", not a paraphrase in other words.
 */
export const NEAR_DUPLICATE_JACCARD = 0.7;

/** The distinct words of a prompt after promptKey. */
export function promptWords(text: string): Set<string> {
  return new Set(promptKey(text).split(" ").filter(Boolean));
}

/** True when two word sets (promptWords) share at least NEAR_DUPLICATE_JACCARD of their words. */
export function isNearDuplicate(a: Set<string>, b: Set<string>): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (!small.size) return false;
  // Jaccard is at most |small| / |big|, so most pairs end here.
  if (small.size < NEAR_DUPLICATE_JACCARD * big.size) return false;
  let shared = 0;
  for (const w of small) if (big.has(w)) shared += 1;
  return shared / (small.size + big.size - shared) >= NEAR_DUPLICATE_JACCARD;
}

/**
 * Which examples to hold out for eval, given their prompts in order, and which training examples to leave out so no
 * eval prompt has a near-duplicate (isNearDuplicate) left in train. As many as evalHoldoutCount, near the evenly spread
 * evalIndexes positions: each one takes the closest prompt that has no near-duplicate anywhere in the dataset. Only
 * when none is left does it take the closest prompt anyway, with its near-duplicates held out beside it while there is
 * room; any still in train are dropped, never leaving fewer than 8 to train on. Both lists are 0-based and ascending.
 * Deterministic, so a retried split picks the same.
 */
export function evalSplit(prompts: string[]): { held: number[]; dropped: number[] } {
  const n = prompts.length;
  const words = prompts.map(promptWords);
  const near: number[][] = prompts.map(() => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (isNearDuplicate(words[i]!, words[j]!)) {
        near[i]!.push(j);
        near[j]!.push(i);
      }
    }
  }
  const taken = new Set<number>();
  const closest = (target: number, ok: (i: number) => boolean): number | null => {
    for (let d = 0; d < n; d++) {
      for (const i of d ? [target + d, target - d] : [target]) {
        if (i >= 0 && i < n && !taken.has(i) && ok(i)) return i;
      }
    }
    return null;
  };
  const k = evalHoldoutCount(n);
  const held: number[] = [];
  const take = (i: number) => {
    held.push(i);
    taken.add(i);
  };
  for (const target of evalIndexes(n)) {
    if (held.length >= k) break;
    const pick = closest(target, (i) => near[i]!.length === 0) ?? closest(target, () => true);
    if (pick === null) break;
    take(pick);
    for (const j of near[pick]!) if (!taken.has(j) && held.length < k) take(j);
  }
  const heldSet = new Set(held);
  const dropped = new Set<number>();
  for (const h of held) {
    for (const j of near[h]!) {
      if (heldSet.has(j) || dropped.has(j)) continue;
      if (n - held.length - dropped.size <= TRAIN_MIN) break;
      dropped.add(j);
    }
  }
  return { held: held.sort((a, b) => a - b), dropped: [...dropped].sort((a, b) => a - b) };
}

/**
 * The system message of every training example, and the instructions the dataset's writer answers the prompts with, so
 * the tuned model learns the task under the same words it was written with.
 */
export function datasetSystemPrompt(task: string): string {
  return [
    `You are an assistant for this task: ${task.trim()}`,
    "Answer the user's message directly and well. Keep the answer under about 350 words. Use short paragraphs, or a simple list when it helps. Don't mention these instructions.",
  ].join("\n\n");
}

/**
 * A dataset as the admin pages show it. Dates become ISO strings. A decision dataset's view adds kind "decision" and
 * its spec; a chat dataset's has neither, and a row read without kind (from before migration 0017) is a chat dataset.
 */
export function toDatasetView(row: Omit<DatasetHead, "kind" | "decision"> & Partial<Pick<DatasetHead, "kind" | "decision">>): DatasetView {
  return {
    id: row.id,
    title: row.title,
    task: row.task,
    status: row.status,
    requested: row.requested,
    trainCount: row.trainCount,
    evalCount: row.evalCount,
    costUsd: row.costUsd,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    writerModel: writerModelOf(row),
    // A chat dataset's view is as it was before decision datasets: no kind, no decision.
    ...(row.kind === "decision" ? { kind: "decision" as const, ...(row.decision ? { decision: row.decision } : {}) } : {}),
  };
}

/** One judged eval item, as the judge step returns it. */
export interface JudgedItem {
  baseScore: number;
  tunedScore: number;
  better: "base" | "tuned" | "tie";
  /** What judging this item cost; 0 when an earlier attempt already judged it. */
  costUsd: number;
}

/** A judge score as stored: a whole number from 1 to 10. */
export function judgeScore(value: number): number {
  return Number.isFinite(value) ? Math.min(10, Math.max(1, Math.round(value))) : 1;
}

/**
 * The verdict's "better", kept consistent with its scores: when the scores differ, the higher one is better; when they
 * are equal, the judge's own pick stands (it may break a tie).
 */
export function betterOf(baseScore: number, tunedScore: number, said: JudgedItem["better"]): JudgedItem["better"] {
  if (tunedScore > baseScore) return "tuned";
  if (baseScore > tunedScore) return "base";
  return said;
}

/** The job's eval summary from its judged items. Averages are rounded to hundredths, the cost to millionths. */
export function summarizeJudgements(items: JudgedItem[]): EvalSummary {
  const n = items.length;
  const avg = (pick: (i: JudgedItem) => number) => (n ? Math.round((items.reduce((s, i) => s + pick(i), 0) / n) * 100) / 100 : 0);
  return {
    items: n,
    tunedWins: items.filter((i) => i.better === "tuned").length,
    baseWins: items.filter((i) => i.better === "base").length,
    ties: items.filter((i) => i.better === "tie").length,
    avgBaseScore: avg((i) => i.baseScore),
    avgTunedScore: avg((i) => i.tunedScore),
    judgeCostUsd: roundUsd(items.reduce((s, i) => s + (i.costUsd || 0), 0)),
  };
}

/**
 * The eval summary judging saves when it ends without a verdict (skipped, or none of the items could be judged): no
 * items, and `note` says why. The job page reads judging's outcome from the job's own eval summary, never from the log,
 * which the job's runner can also write to.
 */
export type UnjudgedSummary = EvalSummary & { note: string };

export function unjudgedSummary(note: string): UnjudgedSummary {
  return {
    items: 0,
    tunedWins: 0,
    baseWins: 0,
    ties: 0,
    avgBaseScore: 0,
    avgTunedScore: 0,
    judgeCostUsd: 0,
    note: head(note.trim(), JUDGE_NOTE_MAX) || "Judging ended without a verdict.",
  };
}

/** Why judging ended without a verdict, from the job's eval summary, or null when it judged items or hasn't ended. */
export function unjudgedNote(summary: EvalSummary | null | undefined): string | null {
  if (!summary || summary.items > 0) return null;
  const note = (summary as Partial<UnjudgedSummary>).note;
  return typeof note === "string" && note.trim() ? note.trim() : "Judging ended without a verdict.";
}

// ---------------------------------------------------------------------------------------------------------------
// How long a glimmer-lora run takes (the jobs route refuses one that can't fit its limits, the New job card shows it)

/**
 * Seconds one glimmer-lora optimizer step can take on each GPU, on the safe side: Muse Glimmer 30B in 4 bits, batch 1
 * with gradient accumulation 4, conversations of up to 2,048 tokens. A GPU not listed counts as the slowest.
 */
export const GLIMMER_STEP_SECONDS: Readonly<Record<string, number>> = {
  gpu_1x_h100_sxm5: 5,
  gpu_1x_h100_pcie: 6,
  gpu_1x_a100_sxm4: 12,
};
const GLIMMER_STEP_SECONDS_OTHER = 12;
/**
 * Minutes a glimmer-lora run spends outside training in a region that holds the model cache: booting, loading the
 * 21 GB model, answering the eval prompts with the base and the tuned model, saving and uploading the adapter.
 */
export const GLIMMER_OVERHEAD_MINUTES = 20;
/** The same in a region without the cache, which also installs the Python packages and downloads the model first. */
export const GLIMMER_OVERHEAD_NO_CACHE_MINUTES = 45;

/** How long a run is likely to take at most. */
export interface RunEstimate {
  steps: number;
  secondsPerStep: number;
  /** The training steps, in whole minutes rounded up. */
  trainMinutes: number;
  overheadMinutes: number;
  /** trainMinutes plus overheadMinutes. */
  minutes: number;
  /** Whether the overhead assumes the region holds the model cache. */
  cached: boolean;
  /** "quantize" for a glimmer-quantize job, which has no training steps: its minutes are all overhead. */
  what?: "train" | "quantize";
}

/**
 * Minutes a glimmer-quantize job takes at most, all of it on its one GPU: booting, the venvs, the llama.cpp build, the
 * 59.6 GB bf16 download, the merge, the conversion, Q8_0 and three sizes, the file checks and a 53.5 GB upload
 * (docs/VIBE_TUNING.md "GPU, time and cost of one quantize job"), and with the region's venvs already on its model cache.
 * Estimates until the first real run measures them.
 */
export const QUANT_MINUTES = 90;
export const QUANT_CACHED_MINUTES = 80;

/**
 * How long a job's run is likely to take at most on `instanceType`, in a region that holds the model cache or not. Null
 * when there is no estimate for the recipe (glimmer-lora and glimmer-quantize have one) or the run doesn't train
 * (dryRun 1).
 */
export function runEstimate(
  recipe: RecipeId | string,
  params: Record<string, string | number | undefined>,
  instanceType: string,
  cached: boolean,
): RunEstimate | null {
  if (recipe === QUANT_RECIPE) {
    const minutes = cached ? QUANT_CACHED_MINUTES : QUANT_MINUTES;
    return { steps: 0, secondsPerStep: 0, trainMinutes: 0, overheadMinutes: minutes, minutes, cached, what: "quantize" };
  }
  if (recipe !== "glimmer-lora") return null;
  if (Number(params.dryRun) === 1) return null;
  const raw = params.maxSteps;
  const asked = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : NaN;
  // The recipe's default (lib/train/recipes/index.ts) when it isn't set.
  const steps = Number.isFinite(asked) && asked > 0 ? Math.ceil(asked) : 120;
  const secondsPerStep = GLIMMER_STEP_SECONDS[instanceType] ?? GLIMMER_STEP_SECONDS_OTHER;
  const trainMinutes = Math.ceil((steps * secondsPerStep) / 60);
  const overheadMinutes = cached ? GLIMMER_OVERHEAD_MINUTES : GLIMMER_OVERHEAD_NO_CACHE_MINUTES;
  return { steps, secondsPerStep, trainMinutes, overheadMinutes, minutes: trainMinutes + overheadMinutes, cached };
}

/**
 * The whole minutes a job can run before one of its limits stops it: its time limit, or less when its dollar limit
 * runs out first at the GPU's hourly price (decideCheck stops it at either). estimateCostUsd counts every started
 * minute in full, so the dollar limit stops a job as soon as it starts the minute that reaches it: $4.29 at $4.29 an
 * hour allows 59 minutes, not 60. launchStep stamps the runner's deadline from this.
 */
export function usableMinutes(limits: TrainLimits, priceCentsPerHour: number | null): number {
  if (!(priceCentsPerHour && priceCentsPerHour > 0)) return limits.maxMinutes;
  const byDollars = Math.ceil((limits.maxUsd * 100 * 60) / priceCentsPerHour - 1e-9) - 1;
  return Math.max(0, Math.min(limits.maxMinutes, byDollars));
}

/** What the run's estimate covers, for the sentences below. */
function overheadText(e: RunEstimate): string {
  return e.cached
    ? "booting, loading the model and answering the eval prompts"
    : "booting, installing the packages, downloading the model and answering the eval prompts";
}

/**
 * Null when the run fits the job's limits, otherwise why it doesn't, as the jobs route answers it (400): the estimate,
 * what it is made of, and what the job can run for.
 */
export function runFitProblem(e: RunEstimate, usable: number, gpuLabel: string): string | null {
  if (e.minutes <= usable) return null;
  if (e.what === "quantize") {
    return (
      `Making local files on ${gpuLabel} needs about ${e.minutes} minutes (the merge, the conversion, three sizes and their ` +
      `checks, and the upload), but this job's limits stop it after ${usable} minutes. Raise the time or dollar limit, or pick a faster GPU.`
    );
  }
  return (
    `${e.steps} training steps on ${gpuLabel} need about ${e.minutes} minutes (${e.trainMinutes} of training at about ` +
    `${e.secondsPerStep} s a step, plus about ${e.overheadMinutes} for ${overheadText(e)}${e.cached ? "" : ", since this region has no model cache yet"}), ` +
    `but this job's limits stop it after ${usable} minutes. Lower the training steps, raise the time or dollar limit, or pick a faster GPU.`
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The live demo: a glimmer-serve job serves one trained glimmer-lora adapter (docs/TRAINING.md "Live demo")

/** The recipe that serves an adapter. Only its jobs get the demo firewall ruleset, a serving key and a serve endpoint. */
export const SERVE_RECIPE: RecipeId = "glimmer-serve";
/** The recipe whose adapters a serve job can serve. */
export const ADAPTER_RECIPE: RecipeId = "glimmer-lora";
/** The serve recipe's param that names the adapter (kind "adapter"), and its minutes param. */
export const SERVE_ADAPTER_PARAM = "adapterJobId";
export const SERVE_MINUTES_PARAM = "minutes";
/** Minutes a serve job serves when it isn't told, and the bounds its minutes param takes. */
export const SERVE_MINUTES_DEFAULT = 30;
export const SERVE_MINUTES_MIN = 10;
export const SERVE_MINUTES_MAX = 120;
/** Minutes a serve job gets on top of its serving minutes, to boot, mount the cache and load the 4-bit model. */
export const SERVE_BOOT_MINUTES = 15;
/**
 * How long before the runner's deadline a serve job's demo server stops taking prompts, so the answer in progress
 * finishes and the runner posts done in time. The recipe's Python has the same number (SERVE_MARGIN_SECONDS in
 * lib/train/recipes/serve.ts); a test keeps them equal.
 */
export const SERVE_STOP_MARGIN_SECONDS = 180;
/**
 * The hourly price a serve job's default dollar limit is sized for: an H100 SXM5 at Lambda's price on 2026-10-27
 * ($4.29 an hour), the priciest GPU it may get. An A100 or an H100 PCIe then has room to spare.
 */
export const SERVE_SIZING_CENTS_PER_HOUR = 429;
const SERVE_TEXT_MAX = 200;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** True for the recipe that serves an adapter. */
export function isServeRecipe(recipe: RecipeId | string | null | undefined): boolean {
  return recipe === SERVE_RECIPE;
}

/**
 * A certificate's SHA-256 fingerprint as the platform stores and compares it: 64 lowercase hex characters, from that
 * or from the colon-separated uppercase form openssl and Node print ("AB:CD:..."). Null for anything else.
 */
export function certFingerprint(text: unknown): string | null {
  if (typeof text !== "string" || text.length > 200) return null;
  const hex = text.trim().replace(/:/g, "").toLowerCase();
  return FINGERPRINT_RE.test(hex) ? hex : null;
}

/** The minutes a serve job serves: its minutes param, whole, within 10 to 120, or 30 when it has none. */
export function serveMinutes(params: Record<string, string | number | undefined> | null | undefined): number {
  const raw = params?.[SERVE_MINUTES_PARAM];
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return SERVE_MINUTES_DEFAULT;
  return Math.min(SERVE_MINUTES_MAX, Math.max(SERVE_MINUTES_MIN, Math.floor(n)));
}

/**
 * The defaults clampLimits fills in for a job nobody set limits for. A serve job's depend on its minutes: those plus
 * SERVE_BOOT_MINUTES, and dollars for that long (one minute more, rounded up to the cent) at
 * SERVE_SIZING_CENTS_PER_HOUR, so the dollar limit never stops it before the time limit on any GPU it can get. Every
 * other recipe keeps its own.
 */
export function recipeDefaults(
  recipe: Pick<Recipe, "id" | "defaultMaxMinutes" | "defaultMaxUsd">,
  params: Record<string, string | number | undefined>,
): Pick<Recipe, "defaultMaxMinutes" | "defaultMaxUsd"> {
  if (!isServeRecipe(recipe.id)) return { defaultMaxMinutes: recipe.defaultMaxMinutes, defaultMaxUsd: recipe.defaultMaxUsd };
  const minutes = serveMinutes(params) + SERVE_BOOT_MINUTES;
  return { defaultMaxMinutes: minutes, defaultMaxUsd: Math.ceil(((minutes + 1) * SERVE_SIZING_CENTS_PER_HOUR) / 60) / 100 };
}

/**
 * Null when a serve job's limits leave time to boot, load the model and serve all its minutes on the GPU it gets,
 * otherwise why not, as the jobs route answers it (400).
 */
export function serveFitProblem(minutes: number, usable: number, gpuLabel: string): string | null {
  const needed = minutes + SERVE_BOOT_MINUTES;
  if (needed <= usable) return null;
  return (
    `A ${minutes}-minute live demo needs about ${needed} minutes of GPU time (about ${SERVE_BOOT_MINUTES} to boot and load the model), ` +
    `but this job's limits stop it after ${usable} minutes on ${gpuLabel}. Pick fewer minutes, or raise the time or dollar limit.`
  );
}

/** The metrics of a job's "done" callback, as its event log keeps them. */
export type DoneMetrics = Record<string, string | number>;

/**
 * Why a job's adapter can't be served, as the jobs route answers it (400 after the param's label), or null when it
 * can: a glimmer-lora job that succeeded, wasn't a dry run (whose adapter is a stand-in), and whose done metrics say it
 * saved the adapter on the cache filesystem (cache_used "yes" and adapter_dir ending in models/<its id>), so a serve
 * job in its region finds it at <cache>/models/<id>/.
 */
export function adapterProblem(
  job: Pick<TrainJobRow, "id" | "recipe" | "status" | "params"> | null,
  metrics: DoneMetrics | null,
): string | null {
  if (!job) return "that job doesn't exist.";
  if (job.recipe !== ADAPTER_RECIPE) return "that job isn't a Muse Glimmer LoRA job, so it has no adapter to serve.";
  if (job.status !== "succeeded") return "that job didn't succeed, so it has no adapter to serve.";
  if (Number(job.params?.dryRun) >= 1) return "that job was a dry run, so its adapter is a stand-in.";
  const dir = typeof metrics?.adapter_dir === "string" ? metrics.adapter_dir.replace(/\/+$/, "") : "";
  if (metrics?.cache_used !== "yes" || !dir.endsWith(`/models/${job.id}`)) {
    return "that job's adapter isn't on a model cache filesystem, so a GPU can't load it.";
  }
  return null;
}

/**
 * When a serve job is expected to stop serving: its minutes after its demo server came up, or SERVE_STOP_MARGIN_SECONDS
 * before the end of the time its limits allow (usableMinutes from launch, which the runner's deadline never passes)
 * when that comes first, since the server stops that long before the deadline. Before it serves, only the latter. Null
 * before launch.
 */
export function serveEndsAt(
  job: Pick<TrainJobRow, "params" | "maxMinutes" | "maxUsd" | "priceCentsPerHour" | "launchedAt" | "serveEndpoint">,
): Date | null {
  if (!job.launchedAt) return null;
  const limit =
    job.launchedAt.getTime() +
    usableMinutes({ maxMinutes: job.maxMinutes, maxUsd: job.maxUsd }, job.priceCentsPerHour) * 60_000 -
    SERVE_STOP_MARGIN_SECONDS * 1000;
  const started = job.serveEndpoint ? Date.parse(job.serveEndpoint.startedAt) : NaN;
  if (!Number.isFinite(started)) return new Date(limit);
  return new Date(Math.min(limit, started + serveMinutes(job.params) * 60_000));
}

/** A serve job's demo server for the admin job page: when it came up and when it is expected to stop. */
function servingView(row: TrainJobRow): TrainServingView | null {
  const started = row.serveEndpoint ? Date.parse(row.serveEndpoint.startedAt) : NaN;
  const ends = serveEndsAt(row);
  if (!Number.isFinite(started) || !ends) return null;
  return { startedAt: new Date(started).toISOString(), endsAt: ends.toISOString() };
}

/** The endpoint a serve job's proxy may connect to: one with an IP from Lambda, the demo port and a fingerprint. */
export function usableEndpoint(endpoint: ServeEndpoint | null | undefined): (ServeEndpoint & { ip: string }) | null {
  if (!endpoint || typeof endpoint.ip !== "string" || !endpoint.ip) return null;
  if (endpoint.port !== SERVE_PORT || !certFingerprint(endpoint.certSha256)) return null;
  return { ...endpoint, ip: endpoint.ip, certSha256: certFingerprint(endpoint.certSha256)! };
}

/**
 * A serve job as the public result page shows it: "live" once it is running with a usable endpoint, "starting" while
 * it launches and loads the model, null when it has ended or an admin asked to stop it. Only the job id, the state,
 * the minutes and when it is expected to stop: never the IP, the key or the fingerprint.
 */
export function toLiveDemoView(
  row: Pick<
    TrainJobRow,
    "id" | "status" | "stopRequested" | "params" | "maxMinutes" | "maxUsd" | "priceCentsPerHour" | "launchedAt" | "serveEndpoint"
  >,
  now: Date,
): LiveDemoView | null {
  if (isTrainTerminal(row.status) || row.stopRequested) return null;
  const ends = serveEndsAt(row);
  if (ends && ends.getTime() <= now.getTime()) return null;
  const live = row.status === "running" && usableEndpoint(row.serveEndpoint) !== null;
  return { serveJobId: row.id, state: live ? "live" : "starting", minutes: serveMinutes(row.params), endsAt: ends ? ends.toISOString() : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Local files: a glimmer-quantize job makes a judged adapter's GGUF files (docs/TRAINING.md "Local files")

/** True for the recipe that makes an adapter's local files. */
export function isQuantRecipe(recipe: RecipeId | string | null | undefined): boolean {
  return recipe === QUANT_RECIPE;
}

/**
 * The closeness check's limit for each build: its mean KL divergence from the merged model's Q8_0, over the held-out
 * prompts and their references, may be at most this, about twice what the base model's published builds measure. A
 * build over it isn't published; the others still are. QUANT_PY has the same numbers (a test keeps them equal).
 */
export const QUANT_KL_MAX: Readonly<Record<QuantLevel, number>> = { Q3_K_M: 0.08, Q4_K_M: 0.03, Q6_K: 0.005 };

/**
 * The share of held-out prompts Q4_K_M must answer with a final answer, under the prompt a stock app sends, or nothing
 * is published. QUANT_PY has the same number.
 */
export const QUANT_CHANNEL_MIN = 0.9;

/** 1 when a glimmer-lora job trained with trainChannel 1 (its files open the final channel themselves), else 0. */
export function trainChannelOf(params: Record<string, string | number> | null | undefined): 0 | 1 {
  return Number(params?.trainChannel) === 1 ? 1 : 0;
}

/**
 * Why a job's adapter can't have local files made, as the jobs route answers it (400 after the param's label), or null
 * when it can. On top of adapterProblem (a glimmer-lora job that succeeded and saved a real adapter on its region's
 * cache): it was judged, with its GPU shut down, so its files have results to stand on; and it trained under the short
 * student prompt, whose one-line system message the files and their card give to every local app.
 */
export function quantProblem(
  job: Pick<TrainJobRow, "params" | "terminatedAt" | "evalSummary">,
  metrics: DoneMetrics | null,
): string | null {
  if (!job.terminatedAt || !job.evalSummary || unjudgedNote(job.evalSummary) !== null) {
    return "that job isn't judged yet, so its local files would have no results to stand on.";
  }
  const asRun = typeof metrics?.student_prompt === "string" ? metrics.student_prompt : job.params?.studentPrompt;
  // A job from before the param trained under the dataset's whole task prompt, as "full" does now.
  const prompt = asRun === undefined || asRun === null ? "full" : String(asRun).trim().toLowerCase() || "short";
  if (prompt !== "short") {
    return "that adapter trained under its dataset's whole task prompt, and local files need the one-line system message of the short student prompt.";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Decision models: scoring a decide job (docs/DECISION_MODELS.md "Scoring (logic.ts)"). Deterministic: no judge, no
// Meta call, and the same input always gives the same summary.

/** The Wilson interval's z: a 95% interval. */
export const WILSON_Z = 1.96;
/** T is fit within these bounds by golden-section search on log T, this many steps. */
export const DECIDE_T_MIN = 0.25;
export const DECIDE_T_MAX = 10;
export const DECIDE_T_STEPS = 60;
/** With fewer scored dev rows than this, T stays 1 and confidence isn't calibrated. */
export const DECIDE_T_MIN_ROWS = 20;
/** Equal-width bins of the top probability, for ECE and the reliability chart. */
export const DECIDE_BINS = 10;
/** In dev log loss the right option's probability counts as at least this, so a row that gave it 0 stays finite. */
const DECIDE_P_FLOOR = 1e-12;

/**
 * `right` of `total` with its Wilson 95% interval (z = 1.96), which stays inside 0 to 1 and is honest for the small
 * test sets a person's model can have. No rows gives rate 0 and the interval 0 to 1: nothing is known.
 */
export function wilsonRate(right: number, total: number): WilsonRate {
  if (!(total > 0)) return { right: 0, total: 0, rate: 0, low: 0, high: 1 };
  if (!(right >= 0 && right <= total)) throw new Error("right must be from 0 to total.");
  const p = right / total;
  const z2 = WILSON_Z * WILSON_Z;
  const scale = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / scale;
  const half = (WILSON_Z / scale) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return { right, total, rate: p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/**
 * Per label precision, recall, F1 and support, macro F1, and the confusion matrix, from each row's right label and
 * pick (null for `none`). `none` isn't a class: a `none` pick is a miss for the row's label and counts against no
 * other. Macro F1 is the mean F1 of the labels that have test rows or were picked (the rest have no F1 to speak of),
 * every such label weighted the same. The matrix's rows are the right label and its columns the pick, both in label
 * order, then a last `none` column. A division by 0 counts as 0.
 */
export function labelScores(
  labels: ReadonlyArray<{ id: string; name: string }>,
  rows: ReadonlyArray<{ label: string; pick: string | null }>,
): { perLabel: LabelScore[]; macroF1: number; confusion: number[][] } {
  const at = new Map(labels.map((l, i) => [l.id, i]));
  const confusion = labels.map(() => new Array<number>(labels.length + 1).fill(0));
  for (const r of rows) {
    const i = at.get(r.label);
    const j = r.pick === null ? labels.length : at.get(r.pick);
    if (i === undefined) throw new Error(`The label ${JSON.stringify(r.label)} isn't one of this decision's labels.`);
    if (j === undefined) throw new Error(`The pick ${JSON.stringify(r.pick)} isn't one of this decision's labels.`);
    confusion[i]![j]! += 1;
  }
  const picked = labels.map((_, j) => confusion.reduce((s, row) => s + row[j]!, 0));
  const perLabel = labels.map((l, i): LabelScore => {
    const tp = confusion[i]![i]!;
    const support = confusion[i]!.reduce((s, n) => s + n, 0);
    const precision = picked[i] ? tp / picked[i]! : 0;
    const recall = support ? tp / support : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { id: l.id, name: l.name, precision, recall, f1, support };
  });
  const counted = perLabel.filter((s, i) => s.support > 0 || picked[i]! > 0);
  const macroF1 = counted.length ? counted.reduce((s, l) => s + l.f1, 0) / counted.length : 0;
  return { perLabel, macroF1, confusion };
}

/**
 * Expected calibration error and the reliability bins: each row's top probability (its pick's confidence) goes in one
 * of 10 equal-width bins (bin i holds i/10 up to (i+1)/10, the last also 1), and ECE is the gap between each bin's
 * accuracy and its mean confidence, weighted by its share of the rows. No rows gives 0.
 */
export function calibrationBins(points: ReadonlyArray<{ confidence: number; right: boolean }>): {
  ece: number;
  bins: ReliabilityBin[];
} {
  const sums = Array.from({ length: DECIDE_BINS }, () => ({ rows: 0, right: 0, confidence: 0 }));
  for (const p of points) {
    if (!Number.isFinite(p.confidence)) throw new Error("A confidence must be a number from 0 to 1.");
    const bin = sums[Math.min(DECIDE_BINS - 1, Math.max(0, Math.floor(p.confidence * DECIDE_BINS)))]!;
    bin.rows += 1;
    bin.confidence += p.confidence;
    if (p.right) bin.right += 1;
  }
  let ece = 0;
  const bins = sums.map((b, i): ReliabilityBin => {
    const accuracy = b.rows ? b.right / b.rows : 0;
    const confidence = b.rows ? b.confidence / b.rows : 0;
    if (b.rows) ece += (b.rows / points.length) * Math.abs(accuracy - confidence);
    return { from: i / DECIDE_BINS, to: (i + 1) / DECIDE_BINS, rows: b.rows, accuracy, confidence };
  });
  return { ece, bins };
}

/** Each calibration row's log-probabilities, the right one floored at DECIDE_P_FLOOR. */
function calibrationLogs(rows: readonly CalibrationRow[]): Array<{ logs: number[]; right: number }> {
  return rows.map((r, n) => {
    if (!Number.isInteger(r.right) || r.right < 0 || r.right >= r.p.length) {
      throw new Error(`Calibration row ${n + 1} has no right option.`);
    }
    const logs = r.p.map((p) => {
      if (!(p >= 0) || !Number.isFinite(p)) throw new Error(`Calibration row ${n + 1} has a probability that isn't a number from 0 to 1.`);
      return Math.log(p);
    });
    logs[r.right] = Math.max(logs[r.right]!, Math.log(DECIDE_P_FLOOR));
    return { logs, right: r.right };
  });
}

function meanLogLoss(rows: ReadonlyArray<{ logs: number[]; right: number }>, T: number): number {
  if (!rows.length) return 0;
  let sum = 0;
  for (const r of rows) {
    const scaled = r.logs.map((l) => l / T);
    // Finite: the right option is floored.
    const max = Math.max(...scaled);
    let total = 0;
    for (const s of scaled) total += Math.exp(s - max);
    sum += max + Math.log(total) - scaled[r.right]!;
  }
  return sum / rows.length;
}

/**
 * Mean log loss at T: for each row, minus the log of the right option's probability once every option's
 * log-probability is divided by T and renormalized (applyTemperature), the right one floored at 1e-12.
 */
export function decisionLogLoss(rows: readonly CalibrationRow[], T: number): number {
  if (!(T > 0) || !Number.isFinite(T)) throw new Error("T must be a positive number.");
  return meanLogLoss(calibrationLogs(rows), T);
}

/**
 * One temperature for a model, fit on its dev rows only: the T from 0.25 to 10 with the lowest dev log loss
 * (decisionLogLoss), by golden-section search on log T, 60 steps, rounded to 4 decimals. The loss is convex in 1/T, so
 * the search finds its one minimum. T stays 1 unless it lowers the loss, and with fewer than 20 rows it stays 1 and
 * `calibrated` is false. T divides every option's log-probability, which keeps their order, and the pick is made
 * before T anyway (temperedDecision): it never changes the winner, so it never changes accuracy.
 */
export function fitTemperature(rows: readonly CalibrationRow[]): { T: number; calibrated: boolean } {
  if (rows.length < DECIDE_T_MIN_ROWS) return { T: 1, calibrated: false };
  const prepared = calibrationLogs(rows);
  const logT = goldenSectionMin(
    (x) => meanLogLoss(prepared, Math.exp(x)),
    Math.log(DECIDE_T_MIN),
    Math.log(DECIDE_T_MAX),
    DECIDE_T_STEPS,
  );
  const fit = Math.min(DECIDE_T_MAX, Math.max(DECIDE_T_MIN, Math.round(Math.exp(logT) * 1e4) / 1e4));
  return { T: meanLogLoss(prepared, fit) < meanLogLoss(prepared, 1) ? fit : 1, calibrated: true };
}

/**
 * Where f is lowest on [lo, hi], for an f with one minimum there: golden-section search. Two probes split the bracket
 * in the golden ratio. Each step drops the end past the higher probe (past the upper one on a tie), and the lower
 * probe already sits where the smaller bracket needs one of its two, so a step calls f once. After `steps` steps the
 * bracket is 0.618^steps of its first width, and its middle is the answer.
 */
function goldenSectionMin(f: (x: number) => number, lo: number, hi: number, steps: number): number {
  const ratio = (Math.sqrt(5) - 1) / 2;
  const probeAt = (x: number) => ({ x, y: f(x) });
  let near = probeAt(hi - ratio * (hi - lo)); // the probe nearer lo
  let far = probeAt(lo + ratio * (hi - lo)); // the probe nearer hi
  for (let step = 0; step < steps; step++) {
    if (near.y <= far.y) {
      hi = far.x;
      far = near;
      near = probeAt(hi - ratio * (hi - lo));
    } else {
      lo = near.x;
      near = far;
      far = probeAt(lo + ratio * (hi - lo));
    }
  }
  return (lo + hi) / 2;
}

type DecideSide = "base" | "tuned";

/**
 * A side's log-probabilities for an item: one per letter. Null when there are none to use: missing, the wrong length,
 * or numbers that can't be log-probabilities (logprobsProblem: above all the probability, or none on any letter).
 */
function sideLogprobs(score: DecideScoreItem | undefined, side: DecideSide, letters: number): number[] | null {
  const lp = side === "base" ? score?.base : score?.tuned;
  if (!Array.isArray(lp) || lp.length !== letters || !letters) return null;
  return logprobsProblem(lp) === null ? lp : null;
}

/** A part's rows in row order, each with its items (regular or decline ones) in group order. */
function itemsByRow(items: readonly DecisionItemKey[], rows: number, decline: boolean): Array<[number, DecisionItemKey[]]> {
  const byRow = new Map<number, DecisionItemKey[]>();
  for (const item of items) {
    if (Boolean(item.decline) !== decline) continue;
    if (!Number.isInteger(item.row) || item.row < 0 || item.row >= rows) {
      throw new Error(`Item ${item.index} is for row ${item.row}, which the split doesn't have.`);
    }
    byRow.set(item.row, [...(byRow.get(item.row) ?? []), item]);
  }
  return [...byRow.entries()].sort((x, y) => x[0] - y[0]).map(([row, list]) => [row, list.sort((x, y) => x.group - y.group)]);
}

interface ScoredRow {
  combined: { labels: Array<{ id: string; p: number }>; none: number };
  mass: number[];
}

/** A row on one side: its groups combined, before T, and each rendering's letter mass. Null if any rendering lacks a score. */
function scoredRow(items: readonly DecisionItemKey[], scores: ReadonlyMap<number, DecideScoreItem>, side: DecideSide): ScoredRow | null {
  const groups: Array<{ labelIds: Array<string | null>; p: number[] }> = [];
  const mass: number[] = [];
  for (const item of items) {
    const lp = sideLogprobs(scores.get(item.index), side, item.labelIds.length);
    if (!lp) return null;
    groups.push({ labelIds: item.labelIds, p: letterProbabilities(lp) });
    mass.push(letterMass(lp));
  }
  return groups.length ? { combined: combineGroups(groups), mass } : null;
}

/** The first score sent for each index: a retried callback counts once. */
function firstScores(scores: readonly DecideScoreItem[]): Map<number, DecideScoreItem> {
  const out = new Map<number, DecideScoreItem>();
  for (const s of scores) if (s && Number.isInteger(s.index) && !out.has(s.index)) out.set(s.index, s);
  return out;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * A decide job's eval_summary from the GPU's scores (docs/DECISION_MODELS.md "Scoring (logic.ts)"), the pure step
 * scoreDecisionStep saves. For base Glimmer zero-shot and the tuned adapter alike: accuracy with its Wilson interval,
 * macro F1, per label scores, the confusion matrix, the `none` rate, the decline check, T fit on dev rows only,
 * ECE raw and with T, the reliability bins and letter mass. Then the baselines, always picking the commonest train
 * label and the word-overlap stand-in, on the same test rows.
 *
 * A row's renderings are combined (combineGroups) and picked before T, as serving does (temperedDecision). Base and
 * tuned are compared on the same rows: a test row counts only when every rendering of it has usable scores for base,
 * and for tuned when the job scored tuned; the rest are unscoredRows. `tuned` is null when no test item has tuned
 * scores (scoreOnly, or a failed tuned pass). The EvalSummary fields follow summarizeJudgements' meaning: `items` the
 * scored test rows, `tunedWins` the rows tuned got right and base got wrong, `baseWins` the reverse, `ties` the rest,
 * and the judge's averages and cost 0.
 */
export function summarizeDecisions(input: DecisionScoringInput): DecisionSummary {
  const { labels, dev, test } = input;
  if (labels.length < 2) throw new Error("A decision has at least 2 labels.");
  if (new Set(labels.map((l) => l.id)).size !== labels.length) throw new Error("Two labels have the same id.");
  const devScores = firstScores(dev.scores);
  const testScores = firstScores(test.scores);
  const hasTuned = test.items.some((it) => sideLogprobs(testScores.get(it.index), "tuned", it.labelIds.length) !== null);
  const sides: DecideSide[] = hasTuned ? ["base", "tuned"] : ["base"];

  // Test rows, and decline rows, that every side scored.
  const onEverySide = (byRow: Array<[number, DecisionItemKey[]]>) =>
    byRow.flatMap(([row, items]) => {
      const per = sides.map((s) => scoredRow(items, testScores, s));
      return per.every((p) => p !== null) ? [{ row, label: test.rows[row]!.label, per: per as ScoredRow[] }] : [];
    });
  const rows = onEverySide(itemsByRow(test.items, test.rows.length, false));
  const declines = onEverySide(itemsByRow(test.items, test.rows.length, true));
  const devByRow = itemsByRow(dev.items, dev.rows.length, false);

  const summarizeSide = (k: number): { summary: DecisionSideSummary; right: boolean[] } => {
    const side = sides[k]!;
    const calibration: CalibrationRow[] = [];
    for (const [row, items] of devByRow) {
      const scored = scoredRow(items, devScores, side);
      if (!scored) continue;
      const right = labels.findIndex((l) => l.id === dev.rows[row]!.label);
      if (right < 0) throw new Error(`Dev row ${row + 1}'s label isn't one of this decision's labels.`);
      const p = new Map(scored.combined.labels.map((l) => [l.id, l.p]));
      calibration.push({ p: [...labels.map((l) => p.get(l.id) ?? 0), scored.combined.none], right });
    }
    const { T, calibrated } = fitTemperature(calibration);
    const picks = rows.map(({ label, per }) => {
      const raw = pickDecision(labels, per[k]!.combined);
      const soft = temperedDecision(labels, per[k]!.combined, T);
      return { label, pick: raw.id, right: raw.id === label, raw: raw.confidence, withT: soft.confidence };
    });
    const right = picks.filter((p) => p.right).length;
    const { perLabel, macroF1, confusion } = labelScores(labels, picks);
    const raw = calibrationBins(picks.map((p) => ({ confidence: p.raw, right: p.right })));
    const withT = calibrationBins(picks.map((p) => ({ confidence: p.withT, right: p.right })));
    const declined = declines.filter((d) => pickDecision(labels, d.per[k]!.combined).id === null).length;
    const mass = [...rows, ...declines].flatMap((r) => r.per[k]!.mass);
    return {
      right: picks.map((p) => p.right),
      summary: {
        accuracy: wilsonRate(right, picks.length),
        macroF1,
        perLabel,
        confusion,
        noneRate: picks.length ? picks.filter((p) => p.pick === null).length / picks.length : 0,
        decline: declines.length ? { rows: declines.length, declined, rate: declined / declines.length } : null,
        T,
        calibrated,
        ece: { raw: raw.ece, withT: withT.ece },
        reliability: withT.bins,
        letterMass: { median: median(mass), min: mass.length ? Math.min(...mass) : 0 },
      },
    };
  };

  const base = summarizeSide(0);
  const tuned = hasTuned ? summarizeSide(1) : null;
  let tunedWins = 0;
  let baseWins = 0;
  if (tuned) {
    base.right.forEach((b, i) => {
      if (tuned.right[i] && !b) tunedWins += 1;
      if (b && !tuned.right[i]) baseWins += 1;
    });
  }

  const trainCount = (id: string) => {
    const n = Number(input.trainCounts[id]);
    return Number.isFinite(n) ? n : 0;
  };
  const commonest = labels.reduce((best, l) => (trainCount(l.id) > trainCount(best.id) ? l : best), labels[0]!);
  const standInRight = rows.filter(({ row, label }) => standInDecision({ state: test.rows[row]!.input, labels }).id === label).length;
  const tooLong = Number(input.tooLong);

  return {
    items: rows.length,
    tunedWins,
    baseWins,
    ties: rows.length - tunedWins - baseWins,
    avgBaseScore: 0,
    avgTunedScore: 0,
    judgeCostUsd: 0,
    kind: "decision",
    labels: labels.map((l) => ({ id: l.id, name: l.name })),
    groups: labelGroups(labels).length,
    devRows: dev.rows.length,
    testRows: test.rows.length,
    unscoredRows: test.rows.length - rows.length,
    tooLong: Number.isFinite(tooLong) && tooLong > 0 ? Math.floor(tooLong) : 0,
    base: base.summary,
    tuned: tuned ? tuned.summary : null,
    baselines: {
      commonest: { id: commonest.id, accuracy: wilsonRate(rows.filter((r) => r.label === commonest.id).length, rows.length) },
      standIn: { accuracy: wilsonRate(standInRight, rows.length) },
    },
  };
}

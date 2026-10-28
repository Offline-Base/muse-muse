/**
 * Pure decisions for fine-tuning jobs (docs/TRAINING.md). No Node APIs and no I/O, so the training workflow can import
 * this file and unit tests can run it directly.
 */
import type { trainingDatasets, trainingJobs } from "@/lib/db/schema";
import type { LambdaInstance } from "@/lib/train/lambda";
import {
  isTrainTerminal,
  type DatasetView,
  type EvalSummary,
  type Recipe,
  type RecipeId,
  type TrainCheck,
  type TrainEventBody,
  type TrainJobView,
  type TrainLimits,
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

/** A training_datasets row without its examples, which can run to megabytes. */
export type DatasetHead = Omit<typeof trainingDatasets.$inferSelect, "train" | "eval">;

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

function asked(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Infinity;
}

/**
 * A job's limits: the lowest of what the admin asked for, the recipe's defaults and the platform ceilings, and never
 * under 1 minute or $0.10. Minutes are whole and dollars are whole cents, both rounded down. A missing or non-numeric
 * ask counts as no ask.
 */
export function clampLimits(recipe: Recipe, ask: Partial<TrainLimits>, ceilings: TrainLimits): TrainLimits {
  const minutes = Math.min(asked(ask.maxMinutes), recipe.defaultMaxMinutes, ceilings.maxMinutes);
  const usd = Math.min(asked(ask.maxUsd), recipe.defaultMaxUsd, ceilings.maxUsd);
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
 * The system message of every training example, and the instructions Muse Spark 1.3 answers the prompts with, so the
 * tuned model learns the task under the same words it was written with.
 */
export function datasetSystemPrompt(task: string): string {
  return [
    `You are an assistant for this task: ${task.trim()}`,
    "Answer the user's message directly and well. Keep the answer under about 350 words. Use short paragraphs, or a simple list when it helps. Don't mention these instructions.",
  ].join("\n\n");
}

/** A dataset as the admin pages show it. Dates become ISO strings. */
export function toDatasetView(row: DatasetHead): DatasetView {
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

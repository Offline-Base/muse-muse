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
}

/**
 * How long a job's run is likely to take at most on `instanceType`, in a region that holds the model cache or not. Null
 * when there is no estimate for the recipe (only glimmer-lora has one) or the run doesn't train (dryRun 1).
 */
export function runEstimate(
  recipe: RecipeId | string,
  params: Record<string, string | number | undefined>,
  instanceType: string,
  cached: boolean,
): RunEstimate | null {
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
  return (
    `${e.steps} training steps on ${gpuLabel} need about ${e.minutes} minutes (${e.trainMinutes} of training at about ` +
    `${e.secondsPerStep} s a step, plus about ${e.overheadMinutes} for ${overheadText(e)}${e.cached ? "" : ", since this region has no model cache yet"}), ` +
    `but this job's limits stop it after ${usable} minutes. Lower the training steps, raise the time or dollar limit, or pick a faster GPU.`
  );
}

import type { IconName } from "@/components/icons";
import { bytes, dayLabel, elapsedMs, groupThousands, modelLabel, plural, truncate, usd, type Tone } from "@/lib/format";
import { tokenCost } from "@/lib/meta/pricing";
import type { LocalFiles, QuantLevel } from "@/lib/train/local-files";
import type { DecisionRow, DecisionSpec, DecisionSummary, WilsonRate } from "@/lib/decide/types";
import { NONE_OPTION } from "@/lib/decide/format";
import { isDecisionSummary, judgeModelOf, modelName, writerModelOf } from "@/lib/train/models";
import {
  CHAT_MODE,
  clampLimits,
  DATASET_MAX_COUNT,
  DECIDE_MODE,
  DATASET_MIN_COUNT,
  estimateCostUsd,
  evalHoldoutCount,
  isServeRecipe,
  jobMode,
  MIN_MAX_MINUTES,
  MODE_PARAM,
  MIN_MAX_USD,
  QUANT_CHANNEL_MIN,
  QUANT_KL_MAX,
  recipeDefaults,
  runEstimate,
  SERVE_BOOT_MINUTES,
  SERVE_MINUTES_PARAM,
  SERVE_RECIPE,
  SERVE_SIZING_CENTS_PER_HOUR,
  serveFitProblem,
  serveMinutes,
  unjudgedNote,
  usableMinutes,
  type DecideRunSize,
  type DecisionRowPick,
  type JobMode,
} from "@/lib/train/logic";
import {
  HUB_WHY_MAX,
  isTrainTerminal,
  type AdapterOption,
  type DatasetStatus,
  type DatasetView,
  type EvalSummary,
  type GpuOption,
  type HubStatus,
  type HubView,
  type Recipe,
  type RecipeParamField,
  type RecipeView,
  type TrainEventBody,
  type TrainEventView,
  type TrainJobView,
  type TrainLimits,
  type TrainProgress,
  type TrainStatus,
  type TryLiveAnswer,
} from "@/lib/train/types";

/**
 * Display helpers for the fine-tuning pages (docs/TRAINING.md "Admin pages"). Pure functions only, like lib/format.ts,
 * so server pages and client components can share them and tests can run them directly.
 */

export const TRAIN_STATUS_LABEL: Record<TrainStatus, string> = {
  queued: "Queued",
  launching: "Launching",
  booting: "Booting",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  stopped: "Stopped",
};

/** The status as the pages say it. A job asked to stop reads "Stopping" until it ends. */
export function trainStatusLabel(status: TrainStatus, stopRequested = false): string {
  if (stopRequested && !isTrainTerminal(status)) return "Stopping";
  return TRAIN_STATUS_LABEL[status] ?? status;
}

/** Pill color: green for succeeded, red for failed, grey for stopped, blue while it runs. */
export function trainTone(status: TrainStatus): Tone {
  switch (status) {
    case "succeeded":
      return "live";
    case "failed":
      return "failed";
    case "stopped":
      return "neutral";
    default:
      return "building";
  }
}

/** What the job page says while the job runs. */
export function workingText(status: TrainStatus, stopRequested: boolean): string {
  if (stopRequested) return "Stopping the job and shutting down the GPU";
  switch (status) {
    case "queued":
      return "Waiting to start";
    case "launching":
      return "Asking Lambda for a GPU";
    case "booting":
      return "The GPU is booting. The first report usually comes within a few minutes";
    case "running":
      return "Running on the GPU";
    default:
      return trainStatusLabel(status);
  }
}

/** A recipe without its Python script, for the admin page and the browser. */
export function toRecipeView(r: Recipe): RecipeView {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    gpus: r.gpus,
    defaultMaxMinutes: r.defaultMaxMinutes,
    defaultMaxUsd: r.defaultMaxUsd,
    params: r.params,
    ...(r.usesCache ? { usesCache: true } : {}),
  };
}

/**
 * The highest limits a new job can ask for: the platform ceilings (TRAIN_JOB_MAX_MINUTES, TRAIN_JOB_MAX_USD), rounded
 * down like clampLimits in lib/train/logic.ts, which caps an ask at them whatever the recipe's defaults.
 */
export function limitBounds(ceilings: TrainLimits): TrainLimits {
  return {
    maxMinutes: Math.max(MIN_MAX_MINUTES, Math.floor(ceilings.maxMinutes)),
    maxUsd: Math.max(MIN_MAX_USD, Math.floor(ceilings.maxUsd * 100 + 1e-6) / 100),
  };
}

/** The limits the form starts with: the recipe's defaults under the ceilings, what a job gets when it asks for none. */
export function limitDefaults(recipe: Pick<RecipeView, "defaultMaxMinutes" | "defaultMaxUsd">, ceilings: TrainLimits): TrainLimits {
  return clampLimits(recipe, {}, ceilings);
}

/** "$0.75/h". */
export function pricePerHour(cents: number): string {
  return `${usd(cents / 100)}/h`;
}

/** The most a job can cost before its own limits stop it: its time limit at the GPU's price, capped by its dollar limit. */
export function maxCostUsd(priceCentsPerHour: number, limits: TrainLimits): number {
  if (!(priceCentsPerHour > 0) || !(limits.maxMinutes > 0)) return 0;
  const byTime = (priceCentsPerHour / 100) * (limits.maxMinutes / 60);
  return Math.ceil(Math.min(byTime, limits.maxUsd) * 100 - 1e-6) / 100;
}

/** One GPU a recipe can run on, with Lambda's live price and capacity when the platform has them. */
export interface GpuRow {
  instanceType: string;
  label: string;
  /** Null when Lambda didn't list this type. */
  priceCentsPerHour: number | null;
  free: boolean;
}

/**
 * The recipe's GPUs in its order of preference, joined with GET /api/train/gpus. With `onlyRegion` (a glimmer-serve
 * job, which launches only where its adapter's cache is, as pickGpu does) a GPU is free only when it has capacity there.
 */
export function gpuRows(recipe: Pick<RecipeView, "gpus">, options: GpuOption[], onlyRegion?: string | null): GpuRow[] {
  const byType = new Map(options.map((o) => [o.instanceType, o]));
  return recipe.gpus.map((choice) => {
    const o = byType.get(choice.instanceType);
    // The gpus route lists a type Lambda doesn't offer with price 0 and no regions.
    const offered = Boolean(o && o.priceCentsPerHour > 0);
    const regions = o ? (onlyRegion ? o.regions.filter((r) => r === onlyRegion) : o.regions) : [];
    return {
      instanceType: choice.instanceType,
      label: o?.description?.trim() || choice.label,
      priceCentsPerHour: offered && o ? o.priceCentsPerHour : null,
      free: Boolean(offered && regions.length),
    };
  });
}

/** The option text in the GPU select: "1x A10 (24 GB) · $0.75/h", with "no capacity" when none is free. */
export function gpuRowText(row: GpuRow): string {
  const parts = [row.label, row.priceCentsPerHour === null ? "not offered" : pricePerHour(row.priceCentsPerHour)];
  if (row.priceCentsPerHour !== null && !row.free) parts.push("no capacity");
  return parts.join(" · ");
}

/** What "Auto" launches: the first GPU in the recipe's order that has capacity, as pickGpu does. */
export function autoGpu(rows: GpuRow[]): GpuRow | null {
  return rows.find((r) => r.free) ?? null;
}

/**
 * The GPU the cost estimate uses on Auto. A recipe that keeps the model cache prefers a region that already has it, and
 * only the platform knows which those are, so Auto may take any free GPU: the priciest free one keeps "up to" honest.
 * Otherwise it is autoGpu's pick.
 */
export function autoCostGpu(rows: GpuRow[], usesCache = false): GpuRow | null {
  if (!usesCache) return autoGpu(rows);
  let best: GpuRow | null = null;
  for (const r of rows) {
    if (r.free && r.priceCentsPerHour !== null && (!best || r.priceCentsPerHour > (best.priceCentsPerHour ?? 0))) best = r;
  }
  return best;
}

/**
 * The GPU the run-time estimate uses on Auto: the slowest free one (the one runEstimate gives the most seconds a step),
 * since Auto may take any free GPU near the model cache. Otherwise autoGpu's pick.
 */
export function autoTimeGpu(recipe: Pick<RecipeView, "id">, rows: GpuRow[], usesCache = false): GpuRow | null {
  if (!usesCache) return autoGpu(rows);
  const step = (r: GpuRow) => runEstimate(recipe.id, {}, r.instanceType, true)?.secondsPerStep ?? 0;
  let slowest: GpuRow | null = null;
  for (const r of rows) if (r.free && (!slowest || step(r) > step(slowest))) slowest = r;
  return slowest;
}

/** The New job card's line on how long the run takes, and whether it is a warning. */
export interface RunHint {
  text: string;
  warn: boolean;
}

/**
 * How long the run takes on `gpu` with these params, in a region with the model cache and without it, and whether that
 * fits the job's limits: the estimate the jobs route checks (runEstimate in lib/train/logic.ts), which refuses a run
 * that can't fit. `auto` says the GPU is Auto's slowest pick. Null for a recipe without an estimate, a dry run or no GPU.
 * A decide mode job needs `decide`, what its dataset makes it run (decideRunSize), and is null without it.
 */
export function runTimeHint(
  recipe: Pick<RecipeView, "id">,
  params: Record<string, string | number | undefined>,
  gpu: GpuRow | null,
  limits: TrainLimits,
  auto = false,
  decide: DecideRunSize | null = null,
): RunHint | null {
  if (!gpu) return null;
  const warm = runEstimate(recipe.id, params, gpu.instanceType, true, decide);
  const cold = runEstimate(recipe.id, params, gpu.instanceType, false, decide);
  if (!warm || !cold) return null;
  const usable = usableMinutes(limits, gpu.priceCentsPerHour);
  const on = auto ? `on Auto (up to ${gpu.label})` : `on ${gpu.label}`;
  if (warm.what === "decide") return decideTimeHint(warm, cold, on, usable, limits);
  if (warm.what === "quantize") {
    // It always runs in its adapter's region, which holds the model cache.
    const lead = `Making the local files ${on}: about ${warm.minutes} minutes, for the merge, the conversion, three sizes and their checks, and the upload.`;
    if (warm.minutes <= usable) return { text: lead, warn: false };
    return { text: `${lead} The job's limits stop it after ${usable} minutes, so it would be refused. Raise the time or dollar limit.`, warn: true };
  }
  const lead =
    `${plural(warm.steps, "training step")} ${on}: about ${warm.minutes} minutes in a region with the model cache, about ` +
    `${cold.minutes} without it (about ${warm.secondsPerStep} s a step, plus ${warm.overheadMinutes} or ` +
    `${cold.overheadMinutes} minutes to boot, set up and answer the eval prompts).`;
  if (cold.minutes <= usable) return { text: lead, warn: false };
  const limit = usable < limits.maxMinutes ? `${usable} minutes (the dollar limit runs out first)` : `${usable} minutes`;
  if (warm.minutes <= usable) {
    return {
      text: `${lead} The job's limits stop it after ${limit}, so it is refused if it lands in a region without the cache. Raise the limits or lower the steps to be sure.`,
      warn: true,
    };
  }
  return {
    text: `${lead} The job's limits stop it after ${limit}, so it would be refused. Lower the training steps, raise the time or dollar limit, or pick a faster GPU.`,
    warn: true,
  };
}

/**
 * runTimeHint for a decide mode job: its training renderings and steps, the prompts each model scores, how long that
 * takes with the model cache and without, and whether the job's limits cover it, as the jobs route checks it.
 */
function decideTimeHint(
  warm: NonNullable<ReturnType<typeof runEstimate>>,
  cold: NonNullable<ReturnType<typeof runEstimate>>,
  on: string,
  usable: number,
  limits: TrainLimits,
): RunHint {
  const scored = groupThousands(warm.scored ?? 0);
  const work = warm.scoreOnly
    ? `Scoring ${scored} prompts with base Glimmer ${on}, with nothing trained`
    : `Training on ${groupThousands(warm.renderings ?? 0)} renderings (${plural(warm.steps, "step")} of 32) and scoring ${scored} prompts before and after ${on}`;
  const parts = warm.scoreOnly
    ? `${warm.scoreMinutes} of scoring`
    : `${warm.trainMinutes} of training and ${warm.scoreMinutes} of scoring`;
  const lead =
    `${work}: about ${warm.minutes} minutes in a region with the model cache, about ${cold.minutes} without it ` +
    `(${parts}, plus ${warm.overheadMinutes} or ${cold.overheadMinutes} to boot and load the model). ` +
    "The rates are estimates until a real run measures them.";
  if (cold.minutes <= usable) return { text: lead, warn: false };
  const limit = usable < limits.maxMinutes ? `${usable} minutes (the dollar limit runs out first)` : `${usable} minutes`;
  if (warm.minutes <= usable) {
    return {
      text: `${lead} The job's limits stop it after ${limit}, so it is refused if it lands in a region without the cache. Raise the limits or lower the epochs to be sure.`,
      warn: true,
    };
  }
  return {
    text: `${lead} The job's limits stop it after ${limit}, so it would be refused. Lower the epochs, raise the time or dollar limit, or pick a faster GPU.`,
    warn: true,
  };
}

/**
 * The New job card's line for a glimmer-serve job: how long it serves on `gpu` plus the time to boot and load the model,
 * and a warning when the job's limits there can't cover both, which the jobs route refuses (serveFitProblem). `auto`
 * says the GPU is Auto's priciest pick, the one whose price leaves the fewest minutes. Null for any other recipe or
 * without a GPU.
 */
export function serveTimeHint(
  recipe: Pick<RecipeView, "id">,
  params: Record<string, string | number | undefined>,
  gpu: GpuRow | null,
  limits: TrainLimits,
  auto = false,
): RunHint | null {
  if (!isServeRecipe(recipe.id) || !gpu) return null;
  const minutes = serveMinutes(params);
  const usable = usableMinutes(limits, gpu.priceCentsPerHour);
  const label = auto ? `${gpu.label}, the priciest GPU Auto may take` : gpu.label;
  const problem = serveFitProblem(minutes, usable, label);
  if (problem) return { text: problem, warn: true };
  return {
    text:
      `${plural(minutes, "minute")} live ${auto ? `on Auto (up to ${gpu.label})` : `on ${gpu.label}`}, after about ` +
      `${SERVE_BOOT_MINUTES} to boot, mount the model cache and load the model. The job's limits allow ${usable} minutes.`,
    warn: false,
  };
}

/** Lambda's price for a persistent filesystem, per GB a month, and about how much one region's model cache holds. */
export const CACHE_USD_PER_GB_MONTH = 0.2;
export const CACHE_GB = 40;

/**
 * The fine-tuning page's note on what the model cache costs while nobody trains: Lambda bills each region's
 * filesystem by the GB every month, outside every job, daily and spend limit, and the platform never deletes one.
 */
export function cacheCostText(recipes: Array<Pick<RecipeView, "title" | "usesCache">>): string | null {
  const titles = recipes.filter((r) => r.usesCache).map((r) => r.title);
  if (!titles.length) return null;
  const monthly = usd(Math.round(CACHE_USD_PER_GB_MONTH * CACHE_GB));
  return (
    `${titles.join(" and ")} keeps its packages and model on a Lambda filesystem in each region it runs in ` +
    `(muse-muse-cache-<region>, about ${CACHE_GB} GB, more with each job's adapter). Lambda bills it every month, about ` +
    `${usd(CACHE_USD_PER_GB_MONTH)} a GB or ${monthly} a region, even when no GPU runs, and none of the limits here count it. ` +
    "The platform never deletes one: delete a region's filesystem in the Lambda console when you no longer need it."
  );
}

/** The GPU's name for a job: the recipe's label for its type, else the type itself. */
export function gpuName(recipe: Pick<RecipeView, "gpus"> | null, instanceType: string): string {
  return recipe?.gpus.find((g) => g.instanceType === instanceType)?.label ?? instanceType;
}

// ---------- Error replies as plain sentences ----------

function field(body: unknown, key: string): string | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The stable code a route answered with: `code` when there is one, else `error` (lib/http.ts errorJson). */
export function errorCode(body: unknown): string | null {
  return field(body, "code") ?? field(body, "error");
}

const isCode = (s: string) => /^[a-z][a-z0-9_]*$/.test(s);

const LAMBDA_NOT_CONFIGURED = "Lambda isn't connected yet. Set LAMBDA_API_KEY on this deployment, then try again.";

/** Why jobs can't start from a local copy of the platform (env.platformUrl isn't public). */
export const NOT_PUBLIC_TEXT =
  "This copy of Muse Muse runs on a local address, so the GPU couldn't report back to it. Start jobs from the deployed site.";

const LAMBDA_UNAVAILABLE = "Lambda didn't answer just now. Try again in a moment.";

/**
 * Why jobs can't start while the 5-minute sweep that shuts down lost GPUs can't run here, by the reason
 * POST /api/train/jobs gives with sweep_not_configured (app/api/train/shared.ts sweepOffReason), or
 * "sweep_not_running" when it can run but hasn't lately (sweepRunning).
 */
export function sweepOffText(reason: string | null | undefined): string {
  if (reason === "not_production") {
    return "Jobs only start from the production site. Vercel runs the 5-minute check that shuts down lost GPUs there and nowhere else.";
  }
  if (reason === "sweep_not_running") {
    return "The 5-minute check that shuts down lost GPUs hasn't run in the last 15 minutes, so jobs can't start. Check the train-sweep cron in Vercel, or run it once by hand with CRON_SECRET.";
  }
  return "CRON_SECRET isn't set on this deployment, so the 5-minute check that shuts down lost GPUs can't run. Set it, then start the job.";
}

function num(body: unknown, key: string): number | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * What the New job card says when POST /api/train/jobs refuses. The route's extras (`max` on too_many_active,
 * `spentUsd`, `committedUsd` and `dailyUsd` on daily_cap) win over the page's own copies of the limits.
 */
export function startErrorText(status: number, body: unknown, limits: { maxActive: number; dailyUsd: number }): string {
  const code = errorCode(body);
  switch (code) {
    case "too_many_active": {
      const max = num(body, "max") ?? limits.maxActive;
      return `A job is already using a GPU, and only ${plural(max, "job")} can hold one at a time. Wait for it to finish, or stop it first.`;
    }
    case "no_capacity": {
      const region = field(body, "region");
      return region
        ? `Lambda has no free GPU for this in ${region} right now, and a live demo can only run there, where its adapter's model cache is. Try again in a few minutes.`
        : "Lambda has no free GPU of that kind right now. Pick another GPU, or try again in a few minutes.";
    }
    case "demo_running":
      return "A live demo of this adapter is already starting or running, so another one wasn't started.";
    case "quant_running":
      return "Local files of this adapter are already being made, so another job wasn't started.";
    case "quant_off":
      return `Making local files is off here: ${field(body, "reason") ?? "it isn't switched on"}.`;
    case "adapter_not_published":
      return field(body, "reason") ?? "Publish the adapter to Hugging Face first.";
    case "hub_off":
      return `Publishing to Hugging Face is off here: ${field(body, "reason") ?? "it isn't set up"}, and local files go to the Hub.`;
    case "daily_cap": {
      const cap = usd(num(body, "dailyUsd") ?? limits.dailyUsd);
      const spent = num(body, "spentUsd");
      const committed = num(body, "committedUsd");
      // committedUsd counts unfinished jobs at their full dollar limit, so it is only worth naming when it is higher.
      const held = spent !== null && committed !== null && committed - spent >= 0.005;
      const lead =
        spent === null
          ? `This job could take today's training spend past the ${cap} daily cap.`
          : held
            ? `Training has spent ${usd(spent)} of the ${cap} daily cap today, jobs still running could bring that to ${usd(committed)}, and this job's dollar limit would pass it.`
            : `Training has spent ${usd(spent)} of the ${cap} daily cap today, and this job's dollar limit would pass it.`;
      return `${lead} Lower the dollar limit, or start it after midnight UTC.`;
    }
    case "platform_not_public":
      return NOT_PUBLIC_TEXT;
    case "sweep_not_configured":
      return sweepOffText(field(body, "reason"));
    case "sweep_not_running":
      return sweepOffText("sweep_not_running");
    case "lambda_not_configured":
      return LAMBDA_NOT_CONFIGURED;
    case "lambda_unavailable":
      return LAMBDA_UNAVAILABLE;
    case "start_failed":
      return "The job's workflow couldn't start, so no GPU was launched. Try again in a moment.";
  }
  if (status === 401) return "Sign in as an admin to start jobs.";
  if (status === 403) return "Only admins can start fine-tuning jobs.";
  const message = field(body, "message") ?? field(body, "error");
  if (status === 400) return message && !isCode(message) ? message : "Check the fields and try again.";
  if (status === 413) return "That request is too large.";
  return `Couldn't start the job${code && isCode(code) ? ` (${code})` : ""}. Try again in a moment.`;
}

/** What the GPU field says when GET /api/train/gpus fails. */
export function gpuErrorText(status: number, body: unknown): string {
  if (errorCode(body) === "lambda_not_configured") return LAMBDA_NOT_CONFIGURED;
  if (status === 401 || status === 403) return "Only admins can see GPU prices.";
  if (errorCode(body) === "lambda_unavailable") return `Couldn't get GPU prices. ${LAMBDA_UNAVAILABLE}`;
  return "Couldn't get GPU prices from Lambda. Check again in a moment.";
}

/** The Stop button on the job page: its label, the note under it, and the confirm question. */
export interface StopControl {
  label: string;
  note: string;
  confirm: string;
}

/**
 * What Stop offers for a job, or null once there is nothing to stop: the GPU is confirmed shut down (terminatedAt), or
 * the job ended without ever launching one. Until then Stop can be pressed again, since Lambda may not have confirmed
 * the terminate. Nothing here promises how soon the GPU goes; Lambda bills until it does.
 */
export function stopControl(
  job: Pick<TrainJobView, "status" | "stopRequested" | "instanceId" | "terminatedAt">,
): StopControl | null {
  if (job.terminatedAt) return null;
  const ended = isTrainTerminal(job.status);
  if (ended && !job.instanceId) return null;
  const again = "Ask Lambda again to shut down this job's GPU? Anything not uploaded yet is lost.";
  if (!job.stopRequested && !ended) {
    return {
      label: "Stop job",
      note: "Stops the job and shuts down its GPU right away.",
      confirm: "Stop this job? Its GPU shuts down right away, and anything not uploaded yet is lost.",
    };
  }
  if (!job.stopRequested) {
    return {
      label: "Shut down GPU",
      note: "Shutting down the GPU. Lambda bills until it's gone. If this doesn't clear in a few minutes, shut it down here.",
      confirm: "Shut down this job's GPU now? The job already ended.",
    };
  }
  if (!job.instanceId) {
    return {
      label: "Try stop again",
      note: "Stop requested. The job won't train, and any GPU it gets is shut down. A check every 5 minutes is the backstop.",
      confirm: "Ask again to stop this job?",
    };
  }
  return {
    label: "Try stop again",
    note: "Stop requested. Lambda bills until the GPU is gone. If this doesn't clear in a few minutes, try again or check Lambda's dashboard.",
    confirm: again,
  };
}

/** What the Stop button says when POST /api/train/jobs/{id}/stop fails. */
export function stopErrorText(status: number, body: unknown): string {
  if (status === 401 || status === 403) return "Only admins can stop jobs.";
  if (status === 404) return "This job wasn't found.";
  if (status === 409) return "This job already ended, and no GPU is left to shut down.";
  const code = errorCode(body);
  return `Couldn't stop the job${code && isCode(code) ? ` (${code})` : ""}. Try again, and check Lambda's dashboard if the GPU keeps running.`;
}

// ---------- Time and cost ----------

type JobTimes = Pick<TrainJobView, "status" | "createdAt" | "launchedAt" | "finishedAt" | "terminatedAt">;

/** GPU time once launched (until terminated, which is what Lambda bills), else time since the job was queued. */
export function jobElapsedMs(job: JobTimes, now: number): number {
  if (job.launchedAt) return elapsedMs(job.launchedAt, job.terminatedAt, now);
  if (isTrainTerminal(job.status)) return job.finishedAt ? elapsedMs(job.createdAt, job.finishedAt, now) : 0;
  return elapsedMs(job.createdAt, null, now);
}

/**
 * The cost to show: the final cost once terminated, else the running estimate at `now` (never below what the server
 * last reported, so a slow clock can't make it go down).
 */
export function liveCostUsd(
  job: Pick<TrainJobView, "priceCentsPerHour" | "launchedAt" | "terminatedAt" | "costUsd">,
  now: number,
): number {
  if (job.terminatedAt) return job.costUsd;
  const est = estimateCostUsd(
    { priceCentsPerHour: job.priceCentsPerHour, launchedAt: job.launchedAt ? new Date(job.launchedAt) : null, terminatedAt: null },
    new Date(now),
  );
  return Math.max(job.costUsd || 0, est);
}

/** True once nothing about the job can change: it ended and its GPU is gone (or never existed). */
export function isSettled(job: Pick<TrainJobView, "status" | "instanceId" | "terminatedAt">): boolean {
  return isTrainTerminal(job.status) && (Boolean(job.terminatedAt) || !job.instanceId);
}

/** "14:05:12", read in UTC so the server and the browser agree. */
export function clockUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ---------- Event log ----------

/** A loss with four significant digits: 0.5123, 12.35. */
export function formatLoss(loss: number): string {
  return Number.isFinite(loss) ? String(Number(loss.toPrecision(4))) : String(loss);
}

/** "Step 3 of 10 · loss 0.5123 · warming up". */
export function progressText(p: TrainProgress): string {
  const parts: string[] = [];
  if (typeof p.step === "number") parts.push(typeof p.totalSteps === "number" ? `Step ${p.step} of ${p.totalSteps}` : `Step ${p.step}`);
  else if (typeof p.totalSteps === "number") parts.push(`${p.totalSteps} steps`);
  if (typeof p.loss === "number") parts.push(`loss ${formatLoss(p.loss)}`);
  if (p.message) parts.push(p.message);
  return parts.join(" · ") || "Working";
}

/** How one event reads in the log: an icon, a short lead, the text, and preformatted detail for logs and errors. */
export interface EventLine {
  icon: IconName;
  lead: string;
  text: string;
  tone?: "ok" | "bad" | "warn";
  /** Log output or a traceback, shown in a scrolling block. */
  detail?: string;
  href?: string;
}

/** `jobId` lets an artifact link to its file (artifactHref); without it an artifact shows as text. */
export function eventLine(body: TrainEventBody, jobId?: string): EventLine {
  switch (body.type) {
    case "status": {
      const label = TRAIN_STATUS_LABEL[body.status] ?? body.status;
      const tone = body.status === "succeeded" ? "ok" : body.status === "failed" ? "bad" : body.status === "stopped" ? "warn" : undefined;
      const icon: IconName = body.status === "succeeded" ? "check" : body.status === "failed" ? "alert" : body.status === "stopped" ? "power" : "info";
      return { icon, lead: label, text: body.message ?? "", tone };
    }
    case "instance":
      return {
        icon: "monitor",
        lead: "GPU launched",
        text: `${body.instanceType} in ${body.region}${body.ip ? `, IP ${body.ip}` : ""}. Instance ${body.instanceId.slice(0, 8)}.`,
      };
    case "terminated":
      return { icon: "power", lead: "GPU shut down", text: body.reason };
    case "heartbeat":
      return { icon: "refresh", lead: "Heartbeat", text: body.message ?? "" };
    case "progress":
      return { icon: "chart", lead: "Progress", text: progressText(body) };
    case "log":
      return { icon: "terminal", lead: "Log", text: "", detail: body.text };
    case "artifact": {
      const a = body.artifact;
      return {
        icon: "file",
        lead: "Uploaded",
        text: `${a.name} (${a.kind}, ${bytes(Math.max(0, Number(a.bytes) || 0))})`,
        href: (jobId ? artifactHref(a.url, jobId) : null) ?? undefined,
      };
    }
    case "done":
      return { icon: "check", lead: "Done", text: body.summary ?? "The recipe finished.", tone: "ok" };
    case "failed":
      return { icon: "alert", lead: "Failed", text: "", detail: body.error, tone: "bad" };
    case "eval":
      return { icon: "clipboard", lead: "Eval item", text: `${itemNumber(body.index)}: ${truncate(String(body.prompt ?? ""), 90)}` };
    case "serving": {
      // Admins only: the job page's log. The public pages never read it.
      const cert = String(body.certSha256 ?? "");
      return {
        icon: "monitor",
        lead: "Serving",
        text:
          `The live demo's server answers on port ${body.port}` +
          `${body.model ? ` with ${truncate(String(body.model), 80)}` : ""}` +
          `${cert ? `, pinned to the certificate whose SHA-256 starts ${cert.slice(0, 12)}` : ""}.`,
        tone: "ok",
      };
    }
    case "decide": {
      const items = Array.isArray(body.items) ? body.items : [];
      const tuned = items.some((i) => Array.isArray(i?.tuned));
      return {
        icon: "chart",
        lead: "Scores",
        text: `${plural(items.length, `${body.part === "dev" ? "dev" : "test"} item`)} scored, ${tuned ? "base and tuned" : "base only"}.`,
      };
    }
    case "judgement":
      return {
        icon: "check",
        lead: "Judged",
        text: `Item ${itemNumber(body.index)}: base ${body.baseScore}, tuned ${body.tunedScore}, ${verdictLabel(body.better).toLowerCase()}.${body.note ? ` ${body.note}` : ""}`,
      };
    default:
      return { icon: "info", lead: String((body as { type?: unknown }).type ?? "Event"), text: "" };
  }
}

/** Event types the log folds when they come back to back. */
export type FoldType = "heartbeat" | "progress" | "eval" | "judgement" | "decide";
const FOLDED: readonly string[] = ["heartbeat", "progress", "eval", "judgement", "decide"] satisfies FoldType[];

/** One row of the log: a single event, or a run of heartbeats, progress reports, eval items or judgements folded together. */
export type LogItem =
  | { kind: "one"; event: TrainEventView }
  | { kind: "fold"; type: FoldType; events: TrainEventView[] };

/**
 * Folds back-to-back heartbeats, progress reports, eval items and judgements, so a long run stays readable. The eval
 * items and their verdicts are shown in full in the results below the log.
 */
export function groupEvents(events: TrainEventView[]): LogItem[] {
  const out: LogItem[] = [];
  for (const ev of events) {
    const type = ev.payload?.type ?? ev.type;
    if (FOLDED.includes(type)) {
      const last = out[out.length - 1];
      if (last && last.kind === "fold" && last.type === type) last.events.push(ev);
      else out.push({ kind: "fold", type: type as FoldType, events: [ev] });
      continue;
    }
    out.push({ kind: "one", event: ev });
  }
  return out;
}

/** Adds new events to the log in id order, skipping any it already has. Returns the same array when nothing is new. */
export function mergeEvents(list: TrainEventView[], incoming: TrainEventView[]): TrainEventView[] {
  const seen = new Set(list.map((e) => e.id));
  const fresh = incoming.filter((e) => e && typeof e.id === "number" && !seen.has(e.id));
  if (!fresh.length) return list;
  return [...list, ...fresh].sort((a, b) => a.id - b.id);
}

/** A traceback's last line names the error, so short views show that one. */
export function errorHeadline(text: string | null | undefined): string {
  return (
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ""
  );
}

/** A link the log can show: http(s) only, since an artifact's URL comes from the instance. Null otherwise. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The link for one of a job's artifacts: an https file under models/<jobId>/ on a Vercel Blob public host, with no
 * credentials, port, query or fragment. The events route already holds artifacts to the deployment's own store; this
 * keeps an older or odd row from linking anywhere else. Null otherwise, and the artifact shows as text.
 */
export function artifactHref(url: string | null | undefined, jobId: string): string | null {
  const href = safeHref(url);
  if (!href) return null;
  const u = new URL(href);
  const folder = `/models/${jobId.toLowerCase()}/`;
  const ok =
    u.protocol === "https:" &&
    /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/.test(u.hostname) &&
    !u.username &&
    !u.password &&
    !u.port &&
    !u.search &&
    !u.hash &&
    u.pathname.startsWith(folder) &&
    u.pathname.length > folder.length;
  return ok ? href : null;
}

/** The metrics from the job's last "done" event, for the result table. */
export function doneMetrics(events: TrainEventView[]): Array<[string, string]> {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i].payload;
    if (p?.type === "done") {
      return Object.entries(p.metrics ?? {}).map(([k, v]) => [k, typeof v === "number" ? String(Number(v.toPrecision(6))) : String(v)]);
    }
  }
  return [];
}

/**
 * The events the job page keeps: every eval item and judgement (the results need them all) and the last `max` of the
 * rest, in id order. `dropped` is how many older ones were left out.
 */
export function keepEvents(events: TrainEventView[], max: number): { kept: TrainEventView[]; dropped: number } {
  const others = events.filter((e) => !isEvalEvent(e));
  if (others.length <= max) return { kept: events, dropped: 0 };
  const cut = others[others.length - max]?.id ?? 0;
  const kept = events.filter((e) => isEvalEvent(e) || e.id >= cut);
  return { kept, dropped: events.length - kept.length };
}

function isEvalEvent(e: TrainEventView): boolean {
  const type = e.payload?.type ?? e.type;
  // A decide job's scores are kept too: at most 80 events, and the job page counts them.
  return type === "eval" || type === "judgement" || type === "decide";
}

// ---------- Datasets ----------

export const DATASET_STATUS_LABEL: Record<DatasetStatus, string> = {
  generating: "Writing",
  ready: "Ready",
  failed: "Failed",
};

/** Pill color: blue while it is written, green once ready, red when it failed. */
export function datasetTone(status: DatasetStatus): Tone {
  return status === "ready" ? "live" : status === "failed" ? "failed" : "building";
}

/**
 * A dataset still writing after this long has most likely lost its workflow (docs/TRAINING.md "Datasets": it stays
 * "generating" and nothing bills for it), so the pages stop polling for it and say so.
 */
export const DATASET_STALE_MS = 6 * 60 * 60_000;

export function isDatasetStalled(d: Pick<DatasetView, "status" | "createdAt">, now: number): boolean {
  if (d.status !== "generating") return false;
  const t = Date.parse(d.createdAt);
  return Number.isFinite(t) && now - t > DATASET_STALE_MS;
}

/**
 * The examples a dataset holds: "270 train · 30 eval" once ready, "112 of 300 answered" while it is written (`written`
 * is what the store's datasetProgress counts), and what was asked for when it failed before the split.
 */
export function datasetCountsText(
  d: Pick<DatasetView, "status" | "requested" | "trainCount" | "evalCount" | "kind" | "decision">,
  written: number | null = null,
): string {
  if (d.kind === "decision" && d.decision) return decisionCountsText(d.decision);
  if (d.status === "generating") return written ? `${written} of ${d.requested} answered` : `Writing prompts for ${d.requested}`;
  if (d.status === "failed" && !d.trainCount && !d.evalCount) return `${d.requested} asked for`;
  return `${d.trainCount} train · ${d.evalCount} eval`;
}

/** An option in the New job card's dataset select: "Bakery helper · 270 train, 30 eval". */
export function datasetOptionText(
  d: Pick<DatasetView, "title" | "status" | "trainCount" | "evalCount" | "kind" | "decision">,
): string {
  if (d.kind === "decision" && d.decision) {
    return `${d.title} · ${plural(d.decision.labels.length, "label")}, ${d.decision.split.train} train, ${d.decision.split.test} test`;
  }
  if (d.status !== "ready") return `${d.title} · ${d.status === "generating" ? "still writing" : "failed"}`;
  return `${d.title} · ${d.trainCount} train, ${d.evalCount} eval`;
}

/**
 * The model that writes new datasets, judges new runs and tells new Hub stories (DATASET_MODEL, JUDGE_MODEL and
 * STORY_MODEL in lib/train, which the pages don't import, since those files are workflow code). Copy about what the lab
 * does next names it. Muse Spark 1.3 did all three before Oct 29, 2026, so copy about a record names the model from the
 * record instead (writerName, judgeName, storyModelOf).
 */
export const WRITER_MODEL = "muse-wonder-1.0";
export const WRITER_NAME = modelLabel(WRITER_MODEL);

/**
 * The model that wrote a dataset, from its record (writerModelOf): "Muse Wonder", or "Muse Spark 1.3" when it has none.
 * A decision dataset's writer isn't a model: "The person who uploaded it" (modelName).
 */
export function writerName(dataset: { writerModel?: string | null } | null | undefined): string {
  return modelName(writerModelOf(dataset));
}

/**
 * The model that judged a job, is judging it or will (judgeModelOf): the one on its record, Muse Spark 1.3 for a job
 * judged before the judge was recorded, else the lab's judge now (WRITER_MODEL), for a job no judge has started on.
 */
export function judgeName(job: { judgeModel?: string | null; evalSummary?: EvalSummary | null }): string {
  return modelLabel(judgeModelOf(job) ?? WRITER_MODEL);
}

/**
 * Rough tokens per example, low and high: one answer call (the task's instructions and the prompt in; up to about 350
 * words out, with low reasoning) plus a 25th of a prompt batch. lib/train/datasets.ts has the real sizes. Muse Spark
 * 1.3 used about 720 output tokens an example (docs/TRAINING.md "Datasets"); Muse Wonder bills its reasoning as output
 * too and hasn't been measured here, so the range runs from Spark's count to more than twice it.
 */
const PER_EXAMPLE = {
  low: { inputTokens: 350, outputTokens: 700 },
  high: { inputTokens: 450, outputTokens: 1600 },
};

/** What writing `count` examples might cost on Meta's API at WRITER_MODEL's prices (lib/meta/pricing.ts), in USD. */
export function datasetCostRange(count: number): { low: number; high: number } {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return {
    low: Math.floor(tokenCost(WRITER_MODEL, PER_EXAMPLE.low) * n * 100) / 100,
    high: Math.ceil(tokenCost(WRITER_MODEL, PER_EXAMPLE.high) * n * 100) / 100,
  };
}

/**
 * Rough minutes to write `count` examples with Muse Wonder: prompt batches of 25 one after another (about 45 s each),
 * then answers in chunks of 12, 6 at a time (about a minute and a half for every two chunks). That is 1.5 times what
 * this allowed for Muse Spark 1.3, since a Muse Wonder call takes 1.4 to 2 times as long.
 */
export function datasetMinutes(count: number): number {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return Math.ceil(Math.ceil(n / 25) * 0.75 + Math.ceil(n / 24) * 1.5);
}

/** "a few minutes", "about 20 minutes", "about an hour". */
export function roughMinutes(minutes: number): string {
  if (minutes < 5) return "a few minutes";
  if (minutes < 50) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  if (minutes < 90) return "about an hour";
  return `about ${Math.round(minutes / 30) / 2} hours`;
}

/** True for a whole number of examples the route takes. */
export function datasetCountOk(count: number): boolean {
  return Number.isInteger(count) && count >= DATASET_MIN_COUNT && count <= DATASET_MAX_COUNT;
}

/** The New dataset card's cost line. */
export function datasetCostHint(count: number): string {
  if (!datasetCountOk(count)) return `Pick ${DATASET_MIN_COUNT} to ${groupThousands(DATASET_MAX_COUNT)} examples to see the cost.`;
  const { low, high } = datasetCostRange(count);
  return `About ${usd(low)} to ${usd(high)} on Meta's API at ${WRITER_NAME}'s prices, and ${roughMinutes(datasetMinutes(count))} to write. About ${evalHoldoutCount(count)} are held out to judge the tuned model.`;
}

/** Why datasets can't start on this deployment: no MODEL_API_KEY. */
export const META_NOT_CONFIGURED_TEXT = `Meta's API isn't connected on this deployment, so ${WRITER_NAME} can't write datasets. Set MODEL_API_KEY, then try again.`;

/** Why datasets can't start right now: the platform's daily spend cap on Meta's API (DAILY_SPEND_CAP_USD). */
export const SPEND_PAUSED_TEXT =
  "The platform's daily spend cap on Meta's API is reached, so new datasets can't start until midnight UTC.";

/** What the New dataset card says when it can't start, by the reason the page found or the route answered. */
export function datasetBlockedText(reason: string | null | undefined): string | null {
  if (reason === "meta_not_configured") return META_NOT_CONFIGURED_TEXT;
  if (reason === "paused") return SPEND_PAUSED_TEXT;
  return null;
}

/** What the New dataset card says when POST /api/train/datasets refuses. */
export function datasetStartErrorText(status: number, body: unknown): string {
  const code = errorCode(body);
  const blocked = datasetBlockedText(code);
  if (blocked) return blocked;
  if (code === "start_failed") return "The dataset's workflow couldn't start, so nothing was written. Try again in a moment.";
  if (status === 401) return "Sign in as an admin to make datasets.";
  if (status === 403) return "Only admins can make datasets.";
  const message = field(body, "message") ?? field(body, "error");
  if (status === 400) return message && !isCode(message) ? message : "Check the fields and try again.";
  if (status === 413) return "That task description is too long.";
  return `Couldn't start the dataset${code && isCode(code) ? ` (${code})` : ""}. Try again in a moment.`;
}

// ---------- Eval results ----------

/** "Item 3" counts from 1; the runner's index counts from 0. */
export function itemNumber(index: number): number {
  return (Number.isFinite(index) ? Math.floor(index) : 0) + 1;
}

/** The model a recipe tunes, as the results name it: "Glimmer" for glimmer-lora. */
export function tunedModelName(recipe: string): string {
  return recipe === "glimmer-lora" ? "Glimmer" : "model";
}

type Better = Extract<TrainEventBody, { type: "judgement" }>["better"];

export function verdictLabel(better: Better): string {
  return better === "tuned" ? "Tuned better" : better === "base" ? "Base better" : "Tie";
}

/** Pill color for a verdict: green when the tuned model won, amber when the base did, grey for a tie. */
export function verdictTone(better: Better): Tone {
  return better === "tuned" ? "live" : better === "base" ? "partial" : "neutral";
}

/** An average score as the results show it: one decimal. */
export function scoreText(score: number): string {
  return Number.isFinite(score) ? score.toFixed(1) : "0.0";
}

/** One held-out prompt with both answers and, once judged, the verdict. */
export interface EvalRow {
  index: number;
  prompt: string;
  reference: string;
  base: string;
  tuned: string;
  judgement: { baseScore: number; tunedScore: number; better: Better; note: string } | null;
}

const asText = (v: unknown) => (typeof v === "string" ? v : "");
const asScore = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The job's eval items in index order, each with its judgement. The first event per index counts, as in the store. */
export function evalRows(events: TrainEventView[]): EvalRow[] {
  const items = new Map<number, EvalRow>();
  const verdicts = new Map<number, EvalRow["judgement"]>();
  for (const ev of events) {
    const p = ev.payload;
    if (p?.type === "eval" && Number.isInteger(p.index) && !items.has(p.index)) {
      items.set(p.index, {
        index: p.index,
        prompt: asText(p.prompt),
        reference: asText(p.reference),
        base: asText(p.base),
        tuned: asText(p.tuned),
        judgement: null,
      });
    } else if (p?.type === "judgement" && Number.isInteger(p.index) && !verdicts.has(p.index)) {
      const better: Better = p.better === "tuned" || p.better === "base" ? p.better : "tie";
      verdicts.set(p.index, { baseScore: asScore(p.baseScore), tunedScore: asScore(p.tunedScore), better, note: asText(p.note) });
    }
  }
  return [...items.values()]
    .sort((a, b) => a.index - b.index)
    .map((r) => ({ ...r, judgement: verdicts.get(r.index) ?? null }));
}

/** After the job ends, the page waits this long for judging before it stops polling and says it didn't finish. */
export const JUDGE_WAIT_MS = 20 * 60_000;

/** Where a job's eval results stand. */
export type EvalState =
  | { state: "none" }
  /** The job is still running: it sends its eval items before "done", and judging starts once its GPU shuts down. */
  | { state: "answering" }
  | { state: "judging"; judged: number; total: number }
  | { state: "judged"; summary: EvalSummary }
  /** Judging didn't run or judged nothing, with the reason saved on the job, or the job didn't succeed. */
  | { state: "unjudged"; reason: string };

/**
 * Where the job's eval results stand, from the job's own state only: its eval summary (lib/train/judge.ts saves one
 * when judging ends, with a note when it was skipped or judged nothing) and its status, plus the eval items and the
 * platform's judgement events in `rows`. Never from log text, which the job's runner can write to.
 */
export function evalState(
  job: Pick<TrainJobView, "status" | "evalSummary" | "finishedAt" | "terminatedAt">,
  rows: EvalRow[],
  now: number,
): EvalState {
  const note = unjudgedNote(job.evalSummary);
  if (job.evalSummary && note === null) return { state: "judged", summary: job.evalSummary };
  if (!rows.length) return { state: "none" };
  if (!isTrainTerminal(job.status)) return { state: "answering" };
  if (job.status !== "succeeded") return { state: "unjudged", reason: "Not judged, since the job didn't succeed." };
  if (note) return { state: "unjudged", reason: note };
  const ended = Date.parse(job.terminatedAt ?? job.finishedAt ?? "");
  if (Number.isFinite(ended) && now - ended > JUDGE_WAIT_MS) {
    return { state: "unjudged", reason: "Judging didn't finish, so the items below have no verdicts." };
  }
  return { state: "judging", judged: rows.filter((r) => r.judgement).length, total: rows.length };
}

/** The summary strip as one sentence, for tests and screen readers. `judge` is the judge's name (judgeName). */
export function evalSummaryText(s: EvalSummary, model: string, judge: string): string {
  return (
    `Tuned ${model} beat base on ${s.tunedWins} of ${s.items}, base won ${s.baseWins}, ties ${s.ties}; ` +
    `average score base ${scoreText(s.avgBaseScore)}, tuned ${scoreText(s.avgTunedScore)}, judged by ${judge}.`
  );
}

// ---------- Live demo (docs/TRAINING.md "Live demo") ----------

/** The longest app idea the live demo takes. POST /api/lab/{id}/try and the GPU's own server both cap it here. */
export const TRY_PROMPT_MAX = 600;

/** The example in the Try it live box. */
export const TRY_PLACEHOLDER =
  "A menu board for my bakery that updates from a photo of today's chalkboard, with prices and allergens.";

/** How long the browser waits for both answers: the proxy's 120 s, plus room for the trip there and back. */
export const TRY_WAIT_MS = 150_000;

/** The Try it live box checks the page again this often while its demo is starting. */
export const DEMO_REFRESH_MS = 15_000;

/** The minutes the Start a live demo control offers. */
export const DEMO_MINUTE_CHOICES: readonly number[] = [10, 15, 20, 30, 45, 60, 90, 120];

/** What the Start a live demo control knows about one choice of minutes. */
export interface DemoPlan {
  minutes: number;
  /** The limits the jobs route gives a demo of these minutes when it asks for none: recipeDefaults under the ceilings. */
  limits: TrainLimits;
  /** False when the time limit can't cover the minutes plus the boot time, so the route refuses it on any GPU. */
  fits: boolean;
  /** Set when the dollar limit can't cover it on the priciest GPU a demo may get, so it may be refused there. */
  warn: string | null;
}

/**
 * A live demo of `minutes` under the platform ceilings, as POST /api/train/jobs works it out for a glimmer-serve job
 * that asks for no limits: its minutes plus SERVE_BOOT_MINUTES, dollars sized for the priciest GPU, both capped.
 */
export function demoPlan(minutes: number, ceilings: TrainLimits): DemoPlan {
  const params = { [SERVE_MINUTES_PARAM]: minutes };
  const served = serveMinutes(params);
  const defaults = recipeDefaults({ id: SERVE_RECIPE, defaultMaxMinutes: 0, defaultMaxUsd: 0 }, params);
  const limits = clampLimits(defaults, {}, ceilings);
  const needed = served + SERVE_BOOT_MINUTES;
  const fits = limits.maxMinutes >= needed;
  const usable = usableMinutes(limits, SERVE_SIZING_CENTS_PER_HOUR);
  const warn =
    fits && usable < needed
      ? `The ${usd(limits.maxUsd)} dollar limit covers ${usable} minutes on the priciest GPU a demo may get ` +
        `(${usd(SERVE_SIZING_CENTS_PER_HOUR / 100)} an hour), less than the ${needed} this one needs, so it is refused ` +
        "if that is the only one free. Pick fewer minutes to be sure it starts."
      : null;
  return { minutes: served, limits, fits, warn };
}

/** "14:05", read in UTC. */
function hhmmUtc(iso: string): string {
  return clockUtc(iso).slice(0, 5);
}

/** "29 minutes left", "Less than a minute left", "Ending now", or null without an end time. */
export function timeLeftText(endsAt: string | null | undefined, now: number): string | null {
  const end = Date.parse(endsAt ?? "");
  if (!Number.isFinite(end)) return null;
  const ms = end - now;
  if (ms <= 0) return "Ending now";
  if (ms < 60_000) return "Less than a minute left";
  return `${plural(Math.floor(ms / 60_000), "minute")} left`;
}

/**
 * A glimmer-serve job's demo server as the admin job page says it: not up yet, serving with the time left, or when it
 * served once the job ended. Reads TrainJobView.serving, which never has the certificate.
 */
export function servingText(
  job: Pick<TrainJobView, "status" | "stopRequested" | "finishedAt" | "serving">,
  now: number,
): string {
  const s = job.serving ?? null;
  if (isTrainTerminal(job.status)) {
    if (!s) return "The demo server never came up.";
    const finished = Date.parse(job.finishedAt ?? "");
    const end = Number.isFinite(finished) && finished < Date.parse(s.endsAt) ? (job.finishedAt as string) : s.endsAt;
    return `Served from ${hhmmUtc(s.startedAt)} to ${hhmmUtc(end)} UTC.`;
  }
  if (job.stopRequested) return s ? "Stopping the live demo." : "Stopping before the demo server came up.";
  if (!s) {
    return `Not serving yet. The GPU boots, mounts the model cache and loads the model, which takes up to about ${SERVE_BOOT_MINUTES} minutes.`;
  }
  const left = timeLeftText(s.endsAt, now);
  return `Serving since ${hhmmUtc(s.startedAt)} UTC, until about ${hhmmUtc(s.endsAt)} UTC${left ? ` (${left.toLowerCase()})` : ""}.`;
}

/** What the job page says while the job runs: workingText, or for a glimmer-serve job whether it serves yet. */
export function jobWorkingText(job: Pick<TrainJobView, "recipe" | "status" | "stopRequested" | "serving">): string {
  if (isServeRecipe(job.recipe) && job.status === "running" && !job.stopRequested) {
    return job.serving ? "Serving the live demo" : "Loading the model for the live demo";
  }
  return workingText(job.status, job.stopRequested);
}

/**
 * The option text in the New job card's adapter select, most telling first, since a long one is cut off at the end:
 * "Bakery LoRA · tuned won 40 of 40 · Oct 27 · us-east-1 · Bakery helper".
 */
export function adapterOptionText(
  a: Pick<AdapterOption, "title" | "datasetTitle" | "region" | "finishedAt" | "evalSummary">,
): string {
  const parts = [a.title];
  if (isDecisionSummary(a.evalSummary) && a.evalSummary.items > 0) {
    const side = a.evalSummary.tuned ?? a.evalSummary.base;
    parts.push(`${a.evalSummary.tuned ? "tuned" : "base"} right on ${side.accuracy.right} of ${side.accuracy.total}`);
  } else if (a.evalSummary && unjudgedNote(a.evalSummary) === null) {
    parts.push(`tuned won ${a.evalSummary.tunedWins} of ${a.evalSummary.items}`);
  }
  if (a.finishedAt) parts.push(dayLabel(a.finishedAt));
  if (a.region) parts.push(a.region);
  if (a.datasetTitle && a.datasetTitle !== a.title) parts.push(a.datasetTitle);
  return parts.join(" · ");
}

/** "7 minutes" from seconds, never under a minute. */
function waitText(seconds: number): string {
  return plural(Math.max(1, Math.ceil(seconds / 60)), "minute");
}

/** What the Try it live box says when POST /api/lab/{id}/try refuses, by the route's codes (TryLiveError). */
export function tryErrorText(status: number, body: unknown): string {
  const code = errorCode(body);
  switch (code) {
    case "no_live_demo":
      return "This live demo has ended, so no GPU is answering now.";
    case "busy":
      return "The GPU is answering someone else's idea right now, one at a time. Try again in a few seconds.";
    case "rate_limited": {
      const wait = num(body, "retryAfterSeconds");
      const when = wait === null ? "in a few minutes" : `in ${waitText(wait)}`;
      return field(body, "scope") === "demo"
        ? `The live demo has answered as many ideas as it takes this hour. Try again ${when}.`
        : `That's as many ideas as the demo takes from you for now. Try again ${when}.`;
    }
    case "timeout":
      return "The GPU didn't finish both answers within 2 minutes. Try again, or try a shorter idea.";
    case "demo_unavailable":
      return "Couldn't reach the live demo's GPU just now. Try again in a moment.";
    case "cross_site":
      return "Open this page on Muse Muse itself to try the live demo.";
  }
  if (status === 400) {
    const message = field(body, "error");
    return message && !isCode(message) ? message : "Check the idea and try again.";
  }
  if (status === 413) return "That idea is too long.";
  return `The live demo couldn't answer${code && isCode(code) ? ` (${code})` : ""}. Try again in a moment.`;
}

/** Both answers from a POST /api/lab/{id}/try reply, or null when it isn't one. */
export function tryAnswerOf(data: unknown): TryLiveAnswer | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.base !== "string" || typeof d.tuned !== "string") return null;
  const ms = typeof d.ms === "number" && Number.isFinite(d.ms) && d.ms >= 0 ? d.ms : 0;
  return { base: d.base, tuned: d.tuned, ms };
}

// ---------- Hugging Face Hub (docs/TRAINING.md "Hugging Face Hub") ----------

export const HUB_STATUS_LABEL: Record<HubStatus, string> = {
  off: "Off",
  waiting: "Waiting",
  uploading: "Uploading",
  uploaded: "Uploaded",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
};

/** Pill color: green once published, red when it failed, grey when it is off, blue while anything moves. */
export function hubTone(status: HubStatus | null): Tone {
  if (status === "published") return "live";
  if (status === "failed") return "failed";
  if (status === "off" || status === null) return "neutral";
  return "building";
}

/**
 * True for a stored "off" saved while publishing was off here, now that it is on: nothing rewrites it once HF_TOKEN
 * and HF_NAMESPACE are set, and the job only waits for Publish.
 */
function staleOff(hub: HubView | null, offReason: string | null): boolean {
  return hub?.status === "off" && !offReason;
}

/**
 * The card's pill: "Not published" for no state, a stale "off", or a bare "waiting" (one a Publish left behind when it
 * saved a why or started no upload job: no reason, no files, no upload job), and "Stopped" for a "publishing" left by
 * a run that stopped.
 */
export function hubPill(hub: HubView | null, offReason: string | null): { label: string; tone: Tone } {
  const bare = hub?.status === "waiting" && !hub.reason && !hub.publishJobId && hub.filesTotal === 0;
  if (!hub || staleOff(hub, offReason) || bare) return { label: "Not published", tone: "neutral" };
  if (hub.status === "publishing" && hub.stale) return { label: "Stopped", tone: "failed" };
  return { label: HUB_STATUS_LABEL[hub.status], tone: hubTone(hub.status) };
}

/** The longest "why" the card takes (the publish route's cap). */
export const WHY_MAX = HUB_WHY_MAX;

/**
 * A link to a repo on the Hugging Face Hub: https, no credentials, port, query or fragment. Null otherwise, and the
 * page shows the repo's name as text.
 */
export function hubHref(url: string | null | undefined): string | null {
  const href = safeHref(url);
  if (!href) return null;
  const u = new URL(href);
  return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash ? href : null;
}

/** What the job page's Hugging Face card knows about a job. */
type HubJob = Pick<TrainJobView, "recipe" | "status" | "params" | "terminatedAt" | "evalSummary" | "judgeModel" | "hub">;

/**
 * Why a job can't be published to the Hub, as the publish route checks it (hubJobProblem in lib/train/hub-cards.ts),
 * or null when it can.
 */
export function hubJobBlock(job: HubJob): string | null {
  if (job.recipe !== "glimmer-lora") return "Only Muse Glimmer LoRA jobs are published to Hugging Face.";
  if (jobMode(job.params) === DECIDE_MODE) {
    return "It is a decision model, and publishing one (the adapter alone, with a decision card, never the person's rows) isn't built yet.";
  }
  if (Number(job.params?.dryRun) >= 1) return "This was a dry run, so its adapter is a stand-in and isn't published.";
  if (!isTrainTerminal(job.status)) return `It publishes once the job succeeds and ${judgeName(job)} has judged it.`;
  if (job.status !== "succeeded") return "This job didn't succeed, so it has no adapter to publish.";
  if (!job.terminatedAt || !job.evalSummary) return `It publishes once ${judgeName(job)} has judged it.`;
  if (unjudgedNote(job.evalSummary)) return "It wasn't judged, so its model card would have no results to show.";
  return null;
}

/** True when the job's "publish" param is 0: it isn't published unless an admin presses Publish. */
export function publishParamOff(params: Record<string, string | number> | null | undefined): boolean {
  const v = params?.publish;
  return v !== undefined && v !== "" && Number(v) === 0;
}

/** The sentence under the Hugging Face card's title: where publishing stands, in plain words. */
export function hubStatusText(job: HubJob, offReason: string | null): string {
  const hub = job.hub ?? null;
  if (hub?.status === "published") {
    const when = hub.publishedAt ? ` ${dayLabel(hub.publishedAt)}` : "";
    return hub.public
      ? `Published${when}: the adapter with its model card, and its training data with the dataset card.`
      : `Published${when}, and private on Hugging Face, so the public pages don't link to it.`;
  }
  if (offReason) return `Publishing to Hugging Face is off here: ${offReason}.`;
  const block = hubJobBlock(job);
  if (block) return block;
  const notUp = publishParamOff(job.params)
    ? "This job was started with Publish to Hugging Face set to 0, so it isn't published unless you press Publish."
    : "Its adapter's files never reached Hugging Face. Publish uploads them from the model cache with a short GPU job, then publishes.";
  if (!hub) return notUp;
  switch (hub.status) {
    case "off":
      // Saved while publishing was off here. It is on now, and the job waits for Publish.
      return hub.filesTotal > 0 && hub.filesUploaded === hub.filesTotal ? "Every file of the adapter is on Hugging Face. Press Publish to publish it." : notUp;
    case "publishing":
      return hub.stale
        ? "Publishing stopped partway: the run doing it hasn't moved for 30 minutes. Retry starts it again."
        : "Writing the cards and committing the model and dataset repos.";
    case "uploading":
      return hub.filesTotal
        ? `The GPU is uploading the adapter's files: ${hub.filesUploaded} of ${hub.filesTotal} are on Hugging Face.`
        : "The GPU is uploading the adapter's files.";
    case "uploaded":
      return "Every file of the adapter is on Hugging Face. Publishing starts in a moment, or press Publish to start it now.";
    default:
      return hub.reason ?? (hub.status === "failed" ? "Publishing failed." : hub.filesTotal === 0 ? notUp : "Waiting to publish.");
  }
}

/** The card's Publish button, or null when there is nothing to press. */
export interface HubControl {
  label: string;
  confirm: string;
}

/**
 * What the Hugging Face card offers: Publish for a job that can be published and isn't yet, Retry after a failure or a
 * "publishing" a stopped run left, Publish again (to update the cards) once published. Null while publishing is off,
 * the job can't be published, or the GPU uploads or the platform publishes. While an upload job is recorded it stays:
 * the route answers upload_running while that job runs, and starts another once it has ended.
 */
export function hubControl(job: HubJob, offReason: string | null): HubControl | null {
  if (offReason || hubJobBlock(job)) return null;
  const hub = job.hub ?? null;
  const stopped = hub?.status === "publishing" && hub.stale;
  if ((hub?.status === "publishing" && !stopped) || hub?.status === "uploading") return null;
  const uploaded = Boolean(hub && hub.filesTotal > 0 && hub.filesUploaded === hub.filesTotal);
  const upload = uploaded
    ? ""
    : " Its adapter's files go up first, from the model cache, with a short GPU job on Lambda that the usual limits cover.";
  if (hub?.status === "published") {
    return { label: "Publish again", confirm: "Publish this job's cards to Hugging Face again? Only what changed is committed." };
  }
  if (hub?.status === "failed" || stopped) return { label: "Retry", confirm: `Try publishing this job to Hugging Face again?${upload}` };
  return { label: "Publish to Hugging Face", confirm: `Publish this adapter and its training data to Hugging Face?${upload}` };
}

/** What the Hugging Face card says when POST /api/train/jobs/{id}/publish refuses. */
export function publishErrorText(status: number, body: unknown, limits: { maxActive: number; dailyUsd: number }): string {
  const code = errorCode(body);
  switch (code) {
    case "not_publishable":
      return field(body, "reason") ?? "This job can't be published.";
    case "hub_off":
      return `Publishing to Hugging Face is off here: ${field(body, "reason") ?? "it isn't set up"}.`;
    case "publishing":
      return "It is being published right now. This card updates when it is done.";
    case "upload_running":
      return "A job is already uploading this adapter's files. It publishes once that job succeeds.";
    case "hub_refused":
      // The Hub client's own sentence, "Hugging Face: creating the repo failed ...: HTTP 403, ...".
      return field(body, "reason") ?? "Hugging Face refused, without saying why.";
    case "hub_unavailable":
      return "Hugging Face didn't answer just now. Try again in a moment.";
    case "start_failed":
      return "Publishing couldn't start. Try again in a moment.";
  }
  if (status === 400) {
    const message = field(body, "error");
    return message && !isCode(message) ? message : `Check the why (at most ${groupThousands(WHY_MAX)} characters) and try again.`;
  }
  if (status === 404) return "This job wasn't found.";
  // The rest are POST /api/train/jobs's refusals of the upload job.
  return startErrorText(status, body, limits);
}

/** A GET or POST /api/train/jobs/{id}/publish answer's hub view, or null when it has none. */
export function hubViewOf(data: unknown): HubView | null {
  const hub = data && typeof data === "object" ? (data as { hub?: unknown }).hub : null;
  if (!hub || typeof hub !== "object") return null;
  const h = hub as Record<string, unknown>;
  return typeof h.status === "string" && h.status in HUB_STATUS_LABEL ? (h as unknown as HubView) : null;
}

// ---------- Local files (docs/TRAINING.md "Local files") ----------

/** The builds a local files job can make, smallest first (QUANT_LEVELS, as QUANT_KL_MAX lists them). */
export const BUILD_LEVELS = Object.keys(QUANT_KL_MAX) as QuantLevel[];

/** Settings labels for the params the platform writes onto a local files job itself (quantParams), which no field lists. */
export const WRITTEN_PARAM_LABELS: ReadonlyMap<string, string> = new Map([
  ["levels", "Builds"],
  ["slug", "Name in the files"],
  ["trainChannel", "Adapter trained with trainChannel"],
]);

/** The raw metrics of the job's last "done" event, or null when it has none. */
export function doneMetricsOf(events: TrainEventView[]): Record<string, string | number> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i].payload;
    if (p?.type === "done") return p.metrics ?? {};
  }
  return null;
}

/** One build of a local files job, as its card shows it. `passed` is null while it wasn't measured. */
export interface QuantRow {
  level: QuantLevel;
  bytes: number | null;
  klMean: number | null;
  klMax: number;
  topTokenPct: number | null;
  passed: boolean | null;
}

const metricNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The builds a local files job was asked for (its levels param), with what its done metrics measured of each. */
export function quantRows(params: Record<string, string | number> | null | undefined, metrics: Record<string, string | number> | null): QuantRow[] {
  const asked = String(params?.levels ?? "")
    .split(",")
    .map((l) => l.trim());
  return BUILD_LEVELS.filter((level) => asked.includes(level)).map((level) => {
    const key = level.toLowerCase();
    const passed = metrics?.[`${key}_passed`];
    return {
      level,
      bytes: metricNumber(metrics?.[`${key}_bytes`]),
      klMean: metricNumber(metrics?.[`${key}_kl_mean`]),
      klMax: QUANT_KL_MAX[level],
      topTokenPct: metricNumber(metrics?.[`${key}_top_token_pct`]),
      passed: passed === "yes" ? true : passed === "no" ? false : null,
    };
  });
}

/** "16.94 GB", as the Hub and the apps show a build's size. */
export function buildSize(n: number): string {
  return `${(Math.max(0, n) / 1e9).toFixed(2)} GB`;
}

/**
 * One build on a local files job's card: its result, size, mean KL divergence from Q8_0 with its limit, and how often
 * its top token is the same, as far as the job measured them.
 */
export function quantRowText(r: QuantRow): string {
  if (r.bytes === null && r.klMean === null) return "Not made yet";
  return [
    r.passed === null ? "Not checked yet" : r.passed ? "Passed" : "Left out",
    r.bytes === null ? null : buildSize(r.bytes),
    r.klMean === null ? null : `mean KL ${r.klMean.toFixed(4)}, limit ${r.klMax.toFixed(4)}`,
    r.topTokenPct === null ? null : `top token the same ${r.topTokenPct.toFixed(1)}%`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The channel check as one sentence, from a local files job's metrics, or null before it ran. */
export function quantChannelText(metrics: Record<string, string | number> | null): string | null {
  const final = metricNumber(metrics?.channel_final);
  const total = metricNumber(metrics?.channel_total);
  if (final === null || !total) return null;
  return `Q4_K_M gave a final answer to ${final} of ${total} held-out prompts under a stock app's prompt (${Math.round(QUANT_CHANNEL_MIN * 100)}% needed).`;
}

/** How many answers agreed with the adapter's own eval answers, as one sentence, or null without a count. */
export function quantAgreementText(metrics: Record<string, string | number> | null): string | null {
  const same = metricNumber(metrics?.agreement);
  const total = metricNumber(metrics?.agreement_total);
  if (same === null || !total) return null;
  return `${same} of ${total} start with the same 200 characters as the adapter's own eval answers (shown, not checked).`;
}

type QuantJob = Pick<TrainJobView, "status" | "terminatedAt" | "hub">;

/** The sentence under a local files job's card title: where its files and their GGUF repo stand, in plain words. */
export function ggufStatusText(job: QuantJob, offReason: string | null): string {
  const hub = job.hub ?? null;
  if (hub?.status === "published") {
    const when = hub.publishedAt ? ` ${dayLabel(hub.publishedAt)}` : "";
    return hub.public
      ? `Published${when}: the builds that passed, with their card, in their own repo next to the adapter's.`
      : `Published${when}, and private on Hugging Face, so the public pages don't link to it.`;
  }
  if (!isTrainTerminal(job.status)) return "The GPU merges the adapter, makes each build, checks them and uploads the ones that pass.";
  // The card links the adapter's page, where Make local files starts another job.
  if (job.status !== "succeeded") return "The job didn't finish, so nothing was published.";
  if (offReason) return `Publishing to Hugging Face is off here: ${offReason}.`;
  if (!hub) return "Its files passed their checks. Publishing starts once the job is done.";
  switch (hub.status) {
    case "publishing":
      return hub.stale
        ? "Publishing stopped partway: the run doing it hasn't moved for 30 minutes. Retry starts it again."
        : "Writing the card and committing the GGUF repo.";
    case "uploaded":
      return "Every file is on Hugging Face. Publishing starts in a moment, or press Publish to start it now.";
    default:
      return hub.reason ?? (hub.status === "failed" ? "Publishing failed." : "Waiting to publish.");
  }
}

/**
 * What a local files job's card offers: Publish once its files are on the Hub, Retry after a failure or a stopped run,
 * Publish again once published. Null while publishing is off, the job runs or didn't succeed, its files never all
 * reached the Hub (they are gone with its GPU), or the platform publishes.
 */
export function ggufControl(job: QuantJob, offReason: string | null): HubControl | null {
  const hub = job.hub ?? null;
  if (offReason || job.status !== "succeeded" || !job.terminatedAt || !hub) return null;
  const stopped = hub.status === "publishing" && hub.stale;
  if (hub.status === "publishing" && !stopped) return null;
  if (hub.filesTotal === 0 || hub.filesUploaded !== hub.filesTotal) return null;
  if (hub.status === "published") return { label: "Publish again", confirm: "Publish these local files' card to Hugging Face again? Only what changed is committed." };
  if (hub.status === "failed" || stopped) return { label: "Retry", confirm: "Try publishing these local files to Hugging Face again?" };
  return { label: "Publish to Hugging Face", confirm: "Publish these local files to their repo on Hugging Face?" };
}

/** A local files job of an adapter, as GET /api/train/jobs/{id}/quantize answers it. */
export interface QuantJobSummary {
  id: string;
  title: string;
  status: TrainStatus;
  createdAt: string;
  finishedAt: string | null;
  terminatedAt: string | null;
  error: string | null;
  hub: HubView | null;
}

/** GET /api/train/jobs/{id}/quantize: what Make local files needs on an adapter's page. */
export interface QuantState {
  quantOff: string | null;
  hubOff: string | null;
  problem: string | null;
  latest: QuantJobSummary | null;
  files: LocalFiles | null;
}

/** The answer of GET /api/train/jobs/{id}/quantize, or null when it isn't one. */
export function quantStateOf(data: unknown): QuantState | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const latest = d.latest && typeof d.latest === "object" && typeof (d.latest as { id?: unknown }).id === "string" ? (d.latest as QuantJobSummary) : null;
  const files = d.files && typeof d.files === "object" && Array.isArray((d.files as { files?: unknown }).files) ? (d.files as LocalFiles) : null;
  return { quantOff: text(d.quantOff), hubOff: text(d.hubOff), problem: text(d.problem), latest, files };
}

/** The hub view of the job whose files the card shows, when it is the newest job: whether they wait or failed to publish. */
function filesHub(state: QuantState): HubView | null {
  return state.files && state.latest?.id === state.files.quantJobId ? state.latest.hub : null;
}

/** True while files that passed their checks are being published: Make local files again would only pay for them twice. */
export function makeFilesPublishing(state: QuantState | null): boolean {
  if (!state?.files || state.files.repo) return false;
  const status = filesHub(state)?.status;
  return status !== "failed" && status !== "waiting" && status !== "off";
}

/** The Make local files card's pill: what the adapter's files are now. */
export function makeFilesPill(state: QuantState | null): { label: string; tone: Tone } {
  if (!state) return { label: "Checking", tone: "neutral" };
  if (state.latest && !isTrainTerminal(state.latest.status)) return { label: "Making", tone: "building" };
  if (state.files?.repo) return { label: state.files.public ? "Published" : "Private", tone: "live" };
  if (state.files) {
    // Files that passed but aren't published: publishing now, waiting for the adapter, or failed (makeFilesText says why).
    if (makeFilesPublishing(state)) return { label: "Publishing", tone: "building" };
    return filesHub(state)?.status === "failed" ? { label: "Not published", tone: "failed" } : { label: "Waiting", tone: "neutral" };
  }
  if (state.latest?.status === "failed") return { label: "Failed", tone: "failed" };
  return { label: state.quantOff || state.hubOff ? "Off" : "Not made", tone: "neutral" };
}

/** The sentence under the Make local files card's title. */
export function makeFilesText(state: QuantState): string {
  const latest = state.latest;
  if (latest && !isTrainTerminal(latest.status)) return `Making the local files: "${latest.title}" is ${trainStatusLabel(latest.status).toLowerCase()}.`;
  if (state.files) {
    const builds = state.files.files.map((f) => `${f.level} (${buildSize(f.bytes)})`).join(", ");
    if (state.files.repo) return `${builds} ${state.files.files.length === 1 ? "is" : "are"} on Hugging Face${state.files.public ? "" : ", private"}.`;
    // When the files are the newest job's, its hub view says whether they wait or failed to publish.
    const hub = filesHub(state);
    if (hub?.reason && (hub.status === "failed" || hub.status === "waiting" || hub.status === "off")) return `${builds} passed their checks. ${hub.reason}`;
    return `${builds} passed their checks and ${state.files.files.length === 1 ? "is" : "are"} publishing.`;
  }
  if (state.quantOff) return `Making local files is off here: ${state.quantOff}.`;
  if (state.hubOff) return `Publishing to Hugging Face is off here: ${state.hubOff}, and local files go to the Hub.`;
  if (state.problem) return state.problem;
  if (latest?.status === "failed") return `The last try failed: ${errorClause(latest.error) || "the job didn't say why"}. Its log has the details.`;
  return "GGUF builds in three sizes, for LM Studio, llama.cpp and Ollama, each checked against the merged model before it is published.";
}

/** A job's error as a clause after a colon: its last line, starting lowercase and without its own full stop. */
function errorClause(text: string | null | undefined): string {
  const line = errorHeadline(text).replace(/[.\s]+$/, "");
  // A sentence that starts with a name or a code ("Q4_K_M", "CUDA") keeps its capitals.
  return /^[A-Z][a-z]/.test(line) ? `${line[0].toLowerCase()}${line.slice(1)}` : line;
}

/** Why Make local files can't be pressed now, or null when it can. */
export function makeFilesBlock(state: QuantState | null): string | null {
  if (!state) return "Checking whether this adapter can have local files made.";
  if (state.quantOff || state.hubOff || state.problem) return makeFilesText(state);
  if (state.latest && !isTrainTerminal(state.latest.status)) return "A local files job of this adapter is running.";
  return null;
}

// ---------- Decision models (docs/DECISION_MODELS.md) ----------

/** True for a Muse Glimmer LoRA job in decide mode: one trained, or scored, as a decision model. */
export function isDecideJob(job: { recipe: string; params?: Record<string, unknown> | null }): boolean {
  return job.recipe === "glimmer-lora" && jobMode(job.params) === DECIDE_MODE;
}

/** A decision dataset's rows per split: "280 train · 40 dev · 80 test". */
export function decisionCountsText(spec: Pick<DecisionSpec, "split">): string {
  return `${groupThousands(spec.split.train)} train · ${groupThousands(spec.split.dev)} dev · ${groupThousands(spec.split.test)} test`;
}

/** A share as a whole percent: "89%". */
export function percentText(rate: number): string {
  return `${Math.round(Math.max(0, Math.min(1, Number.isFinite(rate) ? rate : 0)) * 100)}%`;
}

/** A Wilson interval as the pages say it: "81% to 94%". */
export function intervalText(r: WilsonRate): string {
  return `${percentText(r.low)} to ${percentText(r.high)}`;
}

/** "right on 71 of 80 held-out examples (89%)". */
export function rightText(r: WilsonRate): string {
  return `right on ${groupThousands(r.right)} of ${groupThousands(r.total)} held-out ${r.total === 1 ? "example" : "examples"} (${percentText(r.rate)})`;
}

/** Precision, recall, F1 and letter mass with two decimals: "0.87". */
export function twoPlaces(x: number): string {
  return (Number.isFinite(x) ? x : 0).toFixed(2);
}

/** An expected calibration error as a percent with one decimal: "3.4%". */
export function eceText(x: number): string {
  return `${((Number.isFinite(x) ? x : 0) * 100).toFixed(1)}%`;
}

/** What the New job card's mode select calls each mode. */
export const MODE_LABELS: Readonly<Record<JobMode, string>> = {
  [CHAT_MODE]: "Chat: learn a chat dataset's answers",
  [DECIDE_MODE]: "Decide: pick one label for each input",
};

/**
 * Params decide mode doesn't use: Publish to Hugging Face, which is always 0 there (a person's rows are never
 * published, and publishing a decision model on its own isn't built), and the Hub card's story.
 */
const DECIDE_HIDDEN: ReadonlySet<string> = new Set(["publish", "why"]);

/** Whether the New job card shows a recipe param in `mode`: not when the field is for another mode only. */
export function paramShown(f: Pick<RecipeParamField, "key" | "modes">, mode: JobMode): boolean {
  if (f.modes && !f.modes.includes(mode)) return false;
  return !(mode === DECIDE_MODE && DECIDE_HIDDEN.has(f.key));
}

/** The mode a form's params ask for: "decide" when its mode param says so, else "chat". */
export function formMode(values: Record<string, string | undefined>): JobMode {
  return (values[MODE_PARAM] ?? "").trim().toLowerCase() === DECIDE_MODE ? DECIDE_MODE : CHAT_MODE;
}

/** The datasets a mode trains on: decision datasets in decide mode, chat datasets otherwise (datasetModeProblem). */
export function datasetsForMode<T extends Pick<DatasetView, "kind">>(datasets: readonly T[], mode: JobMode): T[] {
  return datasets.filter((d) => (d.kind === "decision") === (mode === DECIDE_MODE));
}

/** A label's name by id, or the `none` option's text for null. */
export function labelName(labels: ReadonlyArray<{ id: string; name: string }>, id: string | null): string {
  if (id === null) return NONE_OPTION;
  return labels.find((l) => l.id === id)?.name ?? id;
}

/** Where a decide job's numbers stand on its admin page. */
export type DecisionState =
  /** The GPU is still scoring and training: the numbers come after it shuts down. */
  | { state: "running" }
  /** The job ended and scoreDecisionStep hasn't saved its summary yet. */
  | { state: "scoring" }
  | { state: "scored"; summary: DecisionSummary }
  /** No numbers, and why: from the saved note, or because nothing came. A summary with no scored row is kept. */
  | { state: "unscored"; reason: string; summary: DecisionSummary | null };

/**
 * Where a decide job's numbers stand, from its own state only: its eval summary (scoreDecisionStep saves one after
 * any ending, with a note when it couldn't score), its status and when it ended. `sent` says whether its log holds
 * any "decide" event: a job that didn't succeed and sent none has nothing to score, so nothing is saved for it.
 */
export function decisionState(
  job: Pick<TrainJobView, "status" | "evalSummary" | "finishedAt" | "terminatedAt">,
  now: number,
  sent: boolean,
): DecisionState {
  const s = job.evalSummary;
  if (isDecisionSummary(s)) {
    if (s.items > 0) return { state: "scored", summary: s };
    return { state: "unscored", reason: s.note ?? "No held-out row could be scored.", summary: s };
  }
  const note = unjudgedNote(s);
  if (s && note) return { state: "unscored", reason: note, summary: null };
  if (!isTrainTerminal(job.status)) return { state: "running" };
  if (job.status !== "succeeded" && !sent) {
    return { state: "unscored", reason: "The job ended before its GPU sent any scores, so there is nothing to score.", summary: null };
  }
  const ended = Date.parse(job.terminatedAt ?? job.finishedAt ?? "");
  if (Number.isFinite(ended) && now - ended > JUDGE_WAIT_MS) {
    return { state: "unscored", reason: "Scoring didn't finish, so there are no numbers yet.", summary: null };
  }
  return { state: "scoring" };
}

/** The results strip's sentence: what each model got right on the held-out test rows. */
export function decisionHeadline(s: DecisionSummary): string {
  const base = s.base.accuracy;
  if (!s.tuned) return `Base Glimmer was ${rightText(base)}, with nothing trained.`;
  return `The tuned model was ${rightText(s.tuned.accuracy)}; base Glimmer was right on ${groupThousands(base.right)} (${percentText(base.rate)}).`;
}

/** The results in one sentence, for screen readers and tests. */
export function decisionSummaryText(s: DecisionSummary): string {
  const side = (name: string, x: DecisionSummary["base"]) =>
    `${name} ${percentText(x.accuracy.rate)} (${intervalText(x.accuracy)}), macro F1 ${twoPlaces(x.macroF1)}`;
  const sides = s.tuned ? `${side("tuned", s.tuned)}; ${side("base", s.base)}` : side("base", s.base);
  return `Accuracy on ${groupThousands(s.items)} held-out rows: ${sides}. Scored with no judge. It can be wrong.`;
}

/** How confident a side's answers are, honestly: calibrated on dev rows, or the model's own probability. */
export function calibrationText(side: DecisionSummary["base"], devRows: number): string {
  if (!side.calibrated) {
    return "Fewer than 20 dev rows were scored, so confidence is the model's own probability, not calibrated.";
  }
  return (
    `Confidence is calibrated on ${groupThousands(devRows)} dev rows (T = ${side.T.toFixed(2)}): an answer at 90% was ` +
    "right about 9 times in 10 on rows like those, which is only as good as the test rows show."
  );
}

/** The labels with fewer test rows than this get a note: one row moves their scores by 10 points or more. */
export const SMALL_LABEL_ROWS = 10;

/** The plain sentences under the strip: what the numbers rest on and where they are weak. */
export function decisionNotes(s: DecisionSummary, opts: { trainRows?: number | null; succeeded?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.succeeded === false) out.push("The job didn't succeed, so these are only the scores its GPU sent before it stopped.");
  if (s.tuned && opts.trainRows) {
    out.push(
      `The tuned model is a small LoRA adapter on Muse Glimmer 30B, trained on ${groupThousands(opts.trainRows)} of this ` +
        "dataset's examples. The test rows were held out before training, and both models were scored on the same ones.",
    );
  }
  if (s.unscoredRows > 0) {
    out.push(
      `${groupThousands(s.unscoredRows)} of the ${groupThousands(s.testRows)} test rows had no usable score (too long, or not sent), so every number leaves them out.`,
    );
  }
  const small = (s.tuned ?? s.base).perLabel.filter((l) => l.support < SMALL_LABEL_ROWS);
  if (small.length) {
    const names = small.map((l) => l.name);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    out.push(`${list} ${small.length === 1 ? "has" : "have"} under ${SMALL_LABEL_ROWS} test rows, so one row moves ${small.length === 1 ? "its" : "their"} scores by 10 points or more.`);
  }
  if (s.groups > 1) {
    out.push(
      `With more than 4 labels, each row is asked as ${s.groups} prompts and the answers are combined by a fixed rule, so how well confidence is calibrated is only what the test rows show.`,
    );
  }
  out.push("It can be wrong: check anything that matters.");
  return out;
}

/** One test row the model missed, as an admin's results page lists it. Never on the public page. */
export interface WrongAnswer {
  /** The row in the test split, 0 on. */
  row: number;
  input: string;
  /** The right label's id. */
  label: string;
  /** What the listed model picked (null for `none`) and its confidence after T. */
  pick: string | null;
  confidence: number;
  /** Base Glimmer's pick on the same row, when the list is the tuned model's. */
  base?: { pick: string | null; right: boolean };
}

/**
 * The test rows the model missed: the tuned model's misses, or base Glimmer's for a job that scored only the base,
 * the most confident first, at most `max` of them. `rows` is the test split in order. The picks come from
 * decisionRowPicks, the same rows and picks behind the accuracy.
 */
export function wrongAnswers(
  picks: readonly DecisionRowPick[],
  rows: readonly DecisionRow[],
  max: number,
): { model: "tuned" | "base"; total: number; shown: WrongAnswer[] } {
  const model = picks.some((p) => p.tuned) ? "tuned" : "base";
  const missed = picks.flatMap((p): WrongAnswer[] => {
    const side = model === "tuned" ? p.tuned : p.base;
    if (!side || side.pick === p.label) return [];
    const input = rows[p.row]?.input ?? "";
    return [
      {
        row: p.row,
        input,
        label: p.label,
        pick: side.pick,
        confidence: side.confidence,
        ...(model === "tuned" ? { base: { pick: p.base.pick, right: p.base.pick === p.label } } : {}),
      },
    ];
  });
  missed.sort((a, b) => b.confidence - a.confidence || a.row - b.row);
  return { model, total: missed.length, shown: missed.slice(0, Math.max(0, max)) };
}

/** A reliability bin with rows, placed for the chart: x its mean confidence, y its accuracy, both 0 to 1. */
export interface ReliabilityPoint {
  x: number;
  y: number;
  rows: number;
  from: number;
  to: number;
}

/** The bins that hold rows, in order, as chart points. */
export function reliabilityPoints(bins: ReadonlyArray<{ from: number; to: number; rows: number; accuracy: number; confidence: number }>): ReliabilityPoint[] {
  const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  return bins.filter((b) => b.rows > 0).map((b) => ({ x: clamp(b.confidence), y: clamp(b.accuracy), rows: b.rows, from: b.from, to: b.to }));
}

/**
 * Why a decision upload was refused, from POST /api/train/datasets' 400 {error, problems}: the sentence and each
 * problem, whose message already names its line ("Line 14 ..." for CSV and JSONL, "Row 3 ..." for JSON rows). Other
 * statuses read as one line.
 */
export function decisionUploadErrorText(status: number, body: unknown): { error: string; problems: string[] } {
  if (status === 400) {
    const list = (body as { problems?: unknown } | null)?.problems;
    const problems = Array.isArray(list)
      ? list.flatMap((p: unknown) => {
          const message = (p as { message?: unknown } | null)?.message;
          return typeof message === "string" && message.trim() ? [message.trim()] : [];
        })
      : [];
    const error = field(body, "error");
    return { error: error && !isCode(error) ? error : "Check the fields and try again.", problems };
  }
  if (status === 401) return { error: "Sign in as an admin to make datasets.", problems: [] };
  if (status === 403) return { error: "Only admins can make datasets.", problems: [] };
  if (status === 413) return { error: "That upload is over 4 MB. Split it, or send fewer rows (3,000 at most).", problems: [] };
  const code = errorCode(body);
  return { error: `Couldn't save the dataset${code && isCode(code) ? ` (${code})` : ""}. Try again in a moment.`, problems: [] };
}

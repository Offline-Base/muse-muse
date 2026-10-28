import type { IconName } from "@/components/icons";
import { bytes, elapsedMs, groupThousands, plural, truncate, usd, type Tone } from "@/lib/format";
import { tokenCost } from "@/lib/meta/pricing";
import {
  DATASET_MAX_COUNT,
  DATASET_MIN_COUNT,
  estimateCostUsd,
  evalHoldoutCount,
  MIN_MAX_MINUTES,
  MIN_MAX_USD,
} from "@/lib/train/logic";
import {
  isTrainTerminal,
  type DatasetStatus,
  type DatasetView,
  type EvalSummary,
  type GpuOption,
  type Recipe,
  type RecipeView,
  type TrainEventBody,
  type TrainEventView,
  type TrainJobView,
  type TrainLimits,
  type TrainProgress,
  type TrainStatus,
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
 * The highest limits a new job can ask for: the lower of the recipe's defaults and the platform ceilings, rounded down
 * like clampLimits in lib/train/logic.ts. The form starts with these.
 */
export function limitBounds(recipe: Pick<RecipeView, "defaultMaxMinutes" | "defaultMaxUsd">, ceilings: TrainLimits): TrainLimits {
  const minutes = Math.min(recipe.defaultMaxMinutes, ceilings.maxMinutes);
  const dollars = Math.min(recipe.defaultMaxUsd, ceilings.maxUsd);
  return {
    maxMinutes: Math.max(MIN_MAX_MINUTES, Math.floor(minutes)),
    maxUsd: Math.max(MIN_MAX_USD, Math.floor(dollars * 100 + 1e-6) / 100),
  };
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

/** The recipe's GPUs in its order of preference, joined with GET /api/train/gpus. */
export function gpuRows(recipe: Pick<RecipeView, "gpus">, options: GpuOption[]): GpuRow[] {
  const byType = new Map(options.map((o) => [o.instanceType, o]));
  return recipe.gpus.map((choice) => {
    const o = byType.get(choice.instanceType);
    // The gpus route lists a type Lambda doesn't offer with price 0 and no regions.
    const offered = Boolean(o && o.priceCentsPerHour > 0);
    return {
      instanceType: choice.instanceType,
      label: o?.description?.trim() || choice.label,
      priceCentsPerHour: offered && o ? o.priceCentsPerHour : null,
      free: Boolean(offered && o?.regions.length),
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
    case "no_capacity":
      return "Lambda has no free GPU of that kind right now. Pick another GPU, or try again in a few minutes.";
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
export type FoldType = "heartbeat" | "progress" | "eval" | "judgement";
const FOLDED: readonly string[] = ["heartbeat", "progress", "eval", "judgement"] satisfies FoldType[];

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
  return type === "eval" || type === "judgement";
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
  d: Pick<DatasetView, "status" | "requested" | "trainCount" | "evalCount">,
  written: number | null = null,
): string {
  if (d.status === "generating") return written ? `${written} of ${d.requested} answered` : `Writing prompts for ${d.requested}`;
  if (d.status === "failed" && !d.trainCount && !d.evalCount) return `${d.requested} asked for`;
  return `${d.trainCount} train · ${d.evalCount} eval`;
}

/** An option in the New job card's dataset select: "Bakery helper · 270 train, 30 eval". */
export function datasetOptionText(d: Pick<DatasetView, "title" | "status" | "trainCount" | "evalCount">): string {
  if (d.status !== "ready") return `${d.title} · ${d.status === "generating" ? "still writing" : "failed"}`;
  return `${d.title} · ${d.trainCount} train, ${d.evalCount} eval`;
}

/** The model that writes datasets and judges eval items (DATASET_MODEL and JUDGE_MODEL in lib/train). */
export const WRITER_MODEL = "muse-spark-1.3";
export const WRITER_NAME = "Muse Spark 1.3";

/**
 * Rough tokens per example, low and high: one answer call (the task's instructions and the prompt in; up to about 350
 * words out, with low reasoning) plus a 25th of a prompt batch. lib/train/datasets.ts has the real sizes.
 */
const PER_EXAMPLE = {
  low: { inputTokens: 350, outputTokens: 700 },
  high: { inputTokens: 450, outputTokens: 1600 },
};

/** What writing `count` examples might cost on Meta's API at Muse Spark 1.3's prices (lib/meta/pricing.ts), in USD. */
export function datasetCostRange(count: number): { low: number; high: number } {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return {
    low: Math.floor(tokenCost(WRITER_MODEL, PER_EXAMPLE.low) * n * 100) / 100,
    high: Math.ceil(tokenCost(WRITER_MODEL, PER_EXAMPLE.high) * n * 100) / 100,
  };
}

/**
 * Rough minutes to write `count` examples: prompt batches of 25 one after another (about 30 s each), then answers in
 * chunks of 24, 6 at a time (about a minute each).
 */
export function datasetMinutes(count: number): number {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return Math.ceil(Math.ceil(n / 25) * 0.5 + Math.ceil(n / 24));
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
export const META_NOT_CONFIGURED_TEXT =
  "Meta's API isn't connected on this deployment, so Muse Spark 1.3 can't write datasets. Set MODEL_API_KEY, then try again.";

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
  /** Judging didn't run or judged nothing, with the reason the workflow logged, or the job didn't succeed. */
  | { state: "unjudged"; reason: string };

/** The workflow's own word on judging that didn't happen (lib/train/judge.ts logs "Judging skipped: ..." or "Judging failed: ..."). */
function judgingNote(events: TrainEventView[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i].payload;
    if (p?.type === "log" && /^Judging (skipped|failed)\b/.test(p.text ?? "")) return p.text.trim().split("\n")[0];
  }
  return null;
}

export function evalState(
  job: Pick<TrainJobView, "status" | "evalSummary" | "finishedAt" | "terminatedAt">,
  events: TrainEventView[],
  rows: EvalRow[],
  now: number,
): EvalState {
  if (job.evalSummary) return { state: "judged", summary: job.evalSummary };
  if (!rows.length) return { state: "none" };
  if (!isTrainTerminal(job.status)) return { state: "answering" };
  if (job.status !== "succeeded") return { state: "unjudged", reason: "Not judged, since the job didn't succeed." };
  const note = judgingNote(events);
  if (note) return { state: "unjudged", reason: note };
  const ended = Date.parse(job.terminatedAt ?? job.finishedAt ?? "");
  if (Number.isFinite(ended) && now - ended > JUDGE_WAIT_MS) {
    return { state: "unjudged", reason: "Judging didn't finish, so the items below have no verdicts." };
  }
  return { state: "judging", judged: rows.filter((r) => r.judgement).length, total: rows.length };
}

/** The summary strip as one sentence, for tests and screen readers. */
export function evalSummaryText(s: EvalSummary, model: string): string {
  return (
    `Tuned ${model} beat base on ${s.tunedWins} of ${s.items}, base won ${s.baseWins}, ties ${s.ties}; ` +
    `average score base ${scoreText(s.avgBaseScore)}, tuned ${scoreText(s.avgTunedScore)}, judged by ${WRITER_NAME}.`
  );
}

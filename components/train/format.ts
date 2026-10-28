import type { IconName } from "@/components/icons";
import { bytes, elapsedMs, plural, usd, type Tone } from "@/lib/format";
import { estimateCostUsd, MIN_MAX_MINUTES, MIN_MAX_USD } from "@/lib/train/logic";
import {
  isTrainTerminal,
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
    default:
      return { icon: "info", lead: String((body as { type?: unknown }).type ?? "Event"), text: "" };
  }
}

/** One row of the log: a single event, or a run of heartbeats or progress reports folded together. */
export type LogItem =
  | { kind: "one"; event: TrainEventView }
  | { kind: "fold"; type: "heartbeat" | "progress"; events: TrainEventView[] };

/** Folds back-to-back heartbeats and back-to-back progress reports, so a long run stays readable. */
export function groupEvents(events: TrainEventView[]): LogItem[] {
  const out: LogItem[] = [];
  for (const ev of events) {
    const type = ev.payload?.type ?? ev.type;
    if (type === "heartbeat" || type === "progress") {
      const last = out[out.length - 1];
      if (last && last.kind === "fold" && last.type === type) last.events.push(ev);
      else out.push({ kind: "fold", type, events: [ev] });
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

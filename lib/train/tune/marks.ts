/**
 * What a run keeps besides its dataset and its job (lib/train/tune/store.ts, "What a run keeps"), put together, and
 * what each waiting reason and each ending says in the room. Pure and browser-safe: the store reads the rows, the view
 * and the tests pass them in.
 */
import type { TuneHoldReason } from "@/lib/train/tune/types";

/** How often the tuneRun workflow tries the launch again while it waits. */
export const TUNE_RETRY_MS = 5 * 60_000;
/** How long it keeps trying after the examples were checked. Then Start training tries again. */
export const TUNE_LAUNCH_WINDOW_MS = 2 * 60 * 60_000;
/** A heartbeat this recent means the workflow is still at it: two retries' worth, and a minute to spare. */
export const TUNE_HEARTBEAT_FRESH_MS = 2 * TUNE_RETRY_MS + 60_000;

/** Why a launch waits and is tried again, not refused (launchForRun in run-launch.ts). */
export type TuneWaitReason = Extract<
  TuneHoldReason,
  "gpu_busy" | "too_many_active" | "daily_cap" | "sweep_not_running" | "paused" | "lambda_unavailable" | "launching"
>;

export const WAIT_REASONS: readonly TuneWaitReason[] = [
  "gpu_busy",
  "too_many_active",
  "daily_cap",
  "sweep_not_running",
  "paused",
  "lambda_unavailable",
  "launching",
];

export function isWaitReason(v: string): v is TuneWaitReason {
  return (WAIT_REASONS as readonly string[]).includes(v);
}

/** Endings of the examples check: the run fails with the sentence, and Start training doesn't offer itself. */
export const CHECK_CODES = ["too_few", "too_long", "content", "decision"] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

export function isCheckCode(v: string): v is CheckCode {
  return (CHECK_CODES as readonly string[]).includes(v);
}

export interface RunMarks {
  /** The training steps the run was started with, or null for the default. */
  steps: number | null;
  /** Set only when the run was started to upload by itself (saveRunAutoPublish). */
  autoPublish?: boolean;
  /** The checked base the run trains on (TUNE_ANY_BASE), when one was picked. */
  base?: { repo: string; revision: string };
  /** Set when a visitor started the run (OPEN_TRAIN): who the visitor limits count, and never an upload. */
  visitor?: { trainerId: string; ip: string };
  /** Stopped before training: nothing launches for it any more. */
  stopped: boolean;
  /** Why the workflow ended without a job (a check code, a launch refusal, "waited_<reason>"), or null. */
  ended: string | null;
  /** The newest heartbeat within the hour: its state, when it came, and the first of that state kept. */
  heartbeat: { state: string; at: Date; since: Date } | null;
}

export const NO_MARKS: RunMarks = { steps: null, stopped: false, ended: null, heartbeat: null };

/** The run's marks from its rows (readRunMarkRows). Rows of another run are ignored. */
export function runMarks(datasetId: string, rows: ReadonlyArray<{ key: string; windowStart: Date; count: number }>): RunMarks {
  const marks: RunMarks = { steps: null, stopped: false, ended: null, heartbeat: null };
  const beats: Array<{ state: string; at: Date }> = [];
  for (const row of rows) {
    if (row.key === `tune-settings:${datasetId}:steps`) marks.steps = row.count > 0 ? row.count : null;
    else if (row.key === `tune-settings:${datasetId}:auto-publish`) {
      if (row.count > 0) marks.autoPublish = true;
    }
    else if (row.key.startsWith(`tune-settings:${datasetId}:visitor:`)) {
      const held = row.key.slice(`tune-settings:${datasetId}:visitor:`.length);
      const at = held.indexOf("@");
      if (at > 0) marks.visitor = { trainerId: held.slice(0, at), ip: held.slice(at + 1) };
    }
    else if (row.key.startsWith(`tune-settings:${datasetId}:base:`)) {
      const [repo, revision] = row.key.slice(`tune-settings:${datasetId}:base:`.length).split("@") as [string, string | undefined];
      if (revision) marks.base = { repo, revision };
    }
    else if (row.key === `tune-run-stopped:${datasetId}`) marks.stopped = true;
    else if (row.key.startsWith(`tune-run-end:${datasetId}:`)) marks.ended = row.key.slice(`tune-run-end:${datasetId}:`.length) || null;
    else if (row.key.startsWith(`tune-run:${datasetId}:`)) beats.push({ state: row.key.slice(`tune-run:${datasetId}:`.length), at: row.windowStart });
  }
  if (beats.length) {
    beats.sort((a, b) => b.at.getTime() - a.at.getTime());
    const newest = beats[0]!;
    const since = beats.filter((b) => b.state === newest.state).reduce((min, b) => (b.at < min ? b.at : min), newest.at);
    marks.heartbeat = { state: newest.state, at: newest.at, since };
  }
  return marks;
}

/** The heartbeat, when it is recent enough to say the workflow is still at it. */
export function freshHeartbeat(marks: RunMarks, now: number): RunMarks["heartbeat"] {
  const beat = marks.heartbeat;
  return beat && now - beat.at.getTime() <= TUNE_HEARTBEAT_FRESH_MS ? beat : null;
}

const TRIES = "It tries again every 5 minutes, for up to 2 hours.";

/** What the room says while the run waits for this reason. */
export function waitText(reason: TuneWaitReason): string {
  switch (reason) {
    case "gpu_busy":
      return `No Muse Glimmer GPU is free on Lambda right now. ${TRIES}`;
    case "too_many_active":
      return `Another training job or live demo is using the platform's GPUs. ${TRIES}`;
    case "daily_cap":
      return `Training's daily budget is used up for now: every unfinished job counts at its full limit until it ends. ${TRIES}`;
    case "sweep_not_running":
      return `The 5-minute check that shuts down lost GPUs hasn't run lately, so no GPU starts until it does. ${TRIES}`;
    case "paused":
      return `The platform's daily spend cap on Meta's API is reached, and scoring the run needs it, so the GPU waits. ${TRIES}`;
    case "lambda_unavailable":
      return `Lambda didn't answer. ${TRIES}`;
    case "launching":
      return "Starting a GPU.";
  }
}

/** Why the examples check stopped the run. */
export function checkText(code: CheckCode): string {
  switch (code) {
    case "too_few":
      return "There weren't enough examples to train on and to score with, so training didn't start.";
    case "too_long":
      return "Too many examples are longer than Muse Glimmer trains on (2,048 tokens), so training didn't start.";
    case "content":
      return "The examples didn't pass the content check, so training didn't start.";
    case "decision":
      return "These are decision rows, and a run here trains chat models. Train it from the full form in decide mode.";
  }
}

/** Why training didn't start, for a launch that ended without a job (not a check): the sentence before Start training. */
export function endedText(code: string): string {
  if (code.startsWith("waited_")) {
    const reason = code.slice("waited_".length);
    const why = isWaitReason(reason) ? waitText(reason).replace(` ${TRIES}`, "") : "";
    return `It waited 2 hours and training didn't start.${why ? ` ${why}` : ""}`;
  }
  switch (code) {
    case "lambda_not_configured":
      return "Training didn't start: Lambda isn't connected on this deployment.";
    case "platform_not_public":
      return "Training didn't start: the GPU couldn't report back to this deployment over https.";
    case "sweep_not_configured":
      return "Training didn't start: the 5-minute check that shuts down lost GPUs can't run on this deployment.";
    case "gpu_limit":
      return "Training didn't start: too little is left of the GPU limit.";
    case "start_failed":
      return "Training didn't start: its workflow couldn't start, so nothing was launched.";
    case "stopped":
      return "This run was stopped before training.";
    case "visitor_daily_run":
    case "ip_daily_run":
      return "Training didn't start: that's today's runs for visitors from here. Try again tomorrow.";
    case "ip_lifetime_usd":
      return "Training didn't start: this network has used its whole GPU limit for visitors.";
    case "error":
      return "Training didn't start: the platform's database stopped answering partway.";
    default:
      return "Training didn't start: the launch was refused. Start training says why.";
  }
}

/**
 * Keeps the lab boxes running or stopped, and their bills in the ledger. Starts and stops happen only here.
 *
 * - **Windows** bills by the hour. A start holds 2 hours in the ledger, more holds follow while it runs, and the sweep
 *   commits what it really ran once it has stopped.
 * - **The backstop.** The box's agent stops the box after 20 idle minutes, but that can't run if the agent crash-loops or
 *   never starts. So the sweep stops it too: after 30 minutes with no jobs, or 10 minutes with no word from the agent. A
 *   box whose agent never spoke can't be started again for an hour, so a queue of jobs can't keep paying for a broken box.
 * - **The Mac** never stops, since stopping scrubs it for hours and its host bills either way. If its agent goes quiet, the
 *   sweep sends restart-agent, at most once per 10 minutes.
 *
 * planWindows is pure, and it decides. Everything else does what it says.
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { cleanForJsonb } from "@/lib/native/agent-http";
import { commitIf, release, reserve, windowsHoldUsd, windowsUsd } from "@/lib/native/ledger";
import { laneActivity, SILENT_AFTER_MS } from "@/lib/native/queue";
import type { NativeLabControl, NativeLane } from "@/lib/native/types";

const MINUTE = 60_000;
/** The platform's idle stop. Longer than the agent's own 20 minutes, so a healthy box stops itself first. */
export const WINDOWS_IDLE_STOP_MS = 30 * MINUTE;
/** How long a running box may go with no word from its agent. A start takes up to 6 minutes to reach a claim call. */
export const WINDOWS_SILENT_STOP_MS = 10 * MINUTE;
/** No automatic start for this long after stopping a box whose agent stayed silent. */
export const WINDOWS_NO_START_MS = 60 * MINUTE;
/** The Mac: at most one restart-agent in this long. */
export const MAC_RESTART_EVERY_MS = 10 * MINUTE;
/** Ask for the next hold this close to the end of the current one. */
const HOLD_MARGIN_MS = 10 * MINUTE;

/** The calls this file needs. Tests pass fakes. The default loads lib/native/aws.ts only when one is made. */
export interface BoxAws {
  windowsBoxState(): Promise<string>;
  startWindowsBox(): Promise<void>;
  stopWindowsBox(): Promise<void>;
  labPing(lane: NativeLane): Promise<string | null>;
  sendLabCommand(lane: NativeLane, action: "restart-agent"): Promise<string>;
}

const realAws: BoxAws = {
  windowsBoxState: async () => (await import("@/lib/native/aws")).windowsBoxState(),
  startWindowsBox: async () => (await import("@/lib/native/aws")).startWindowsBox(),
  stopWindowsBox: async () => (await import("@/lib/native/aws")).stopWindowsBox(),
  labPing: async (lane) => (await import("@/lib/native/aws")).labPing(lane),
  sendLabCommand: async (lane, action) => (await import("@/lib/native/aws")).sendLabCommand(lane, action),
};

/** Merges into native_labs.state.control. A claim call only ever writes the box's own fields beside it. */
async function noteControl(lane: NativeLane, patch: Partial<NativeLabControl>): Promise<void> {
  await db().execute(sql`update native_labs
    set state = coalesce(state, '{}'::jsonb) || jsonb_build_object('control', coalesce(state->'control', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)
    where lane = ${lane}`);
}

async function labRow(lane: NativeLane) {
  const [row] = await db().select().from(schema.nativeLabs).where(eq(schema.nativeLabs.lane, lane));
  return row ?? null;
}

function anyRows(result: unknown): boolean {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])).length > 0;
}

function sessionRef(startedAt: string): string {
  return `windows-start:${startedAt}`;
}

/** The test that nothing changed the Windows session since `control` was read. Holds are added to, so a stale write would lose one. */
function sameSession(control: NativeLabControl) {
  return sql`coalesce(state->'control'->>'startedAt', '') = ${control.startedAt ?? ""}
    and coalesce((state->'control'->>'holdUsd')::numeric, 0) = ${control.holdUsd ?? 0}::numeric`;
}

export type WindowsPlan =
  | { act: "none" }
  | { act: "start" }
  | { act: "stop"; reason: "idle" | "agent_silent" | "over_budget" }
  | { act: "close_session" }
  | { act: "extend_hold" };

export interface WindowsFacts {
  boxState: string;
  control: NativeLabControl;
  lastSeenAt: Date | null;
  queued: number;
  claimed: number;
  lastJobAt: Date | null;
  /** False when the last extend_hold was refused. */
  holdAllowed: boolean;
  now: Date;
}

/** The sweep's next move for the Windows box. One at a time: the next sweep sees what it led to. */
export function planWindows(f: WindowsFacts): WindowsPlan {
  const now = f.now.getTime();
  const up = f.boxState === "running" || f.boxState === "pending";
  const down = f.boxState === "stopped" || f.boxState === "terminated";
  const startedAt = f.control.startedAt ? Date.parse(f.control.startedAt) : null;
  if (down) {
    if (startedAt !== null) return { act: "close_session" };
    const blocked = f.control.noStartUntil ? Date.parse(f.control.noStartUntil) > now : false;
    return f.queued > 0 && !blocked ? { act: "start" } : { act: "none" };
  }
  if (!up) return { act: "none" };
  if (!f.holdAllowed) return { act: "stop", reason: "over_budget" };
  const since = startedAt ?? now;
  const heardAt = Math.max(since, f.lastSeenAt?.getTime() ?? 0);
  if (now - heardAt >= WINDOWS_SILENT_STOP_MS) return { act: "stop", reason: "agent_silent" };
  if (f.queued === 0 && f.claimed === 0) {
    const busyAt = Math.max(since, f.lastJobAt?.getTime() ?? 0);
    if (now - busyAt >= WINDOWS_IDLE_STOP_MS) return { act: "stop", reason: "idle" };
  }
  // The first hold counts too: a box somebody started by hand has none yet.
  const heldUntil = since + ((f.control.holdUsd ?? 0) / env.nativeWindowsHourlyUsd) * 3_600_000;
  if (startedAt === null || now >= heldUntil - HOLD_MARGIN_MS) return { act: "extend_hold" };
  return { act: "none" };
}

export type WakeResult = { started: boolean; reason: "already_up" | "started" | "no_box" | "over_budget" | "blocked" | "failed" | "racing" };

/**
 * Starts the Windows box if the ledger allows. The hold comes first, so a refusal costs nothing, and the session is noted
 * before the start, so a crash can't leave a running box nobody is billing for. Safe to call from several places at once.
 */
export async function wakeWindows(aws: BoxAws = realAws, now: Date = new Date()): Promise<WakeResult> {
  if (!env.nativeLab || !env.nativeWindowsInstanceId) return { started: false, reason: "no_box" };
  const lab = await labRow("windows");
  if (!lab) return { started: false, reason: "no_box" };
  const control = lab.state?.control ?? {};
  const state = await aws.windowsBoxState();
  if (state === "running" || state === "pending") return { started: true, reason: "already_up" };
  if (control.noStartUntil && Date.parse(control.noStartUntil) > now.getTime()) return { started: false, reason: "blocked" };
  if (state !== "stopped") return { started: false, reason: "racing" };
  if (control.startedAt) await closeSession(control, now);
  const holdUsd = windowsHoldUsd();
  const startedAt = now.toISOString();
  const held = await reserve("windows", holdUsd, { ref: sessionRef(startedAt), note: "A Windows box start." });
  if (!held.ok) return { started: false, reason: "over_budget" };
  // Only one caller gets to open the session.
  const opened = await db().execute(sql`update native_labs
    set state = coalesce(state, '{}'::jsonb) || jsonb_build_object('control', coalesce(state->'control', '{}'::jsonb) || ${JSON.stringify({ startedAt, holdUsd, stopReason: null })}::jsonb)
    where lane = 'windows' and coalesce(state->'control'->>'startedAt', '') = ''
    returning lane`);
  if (!anyRows(opened)) {
    await release("windows", holdUsd, { ref: sessionRef(startedAt), note: "Another start got there first." });
    return { started: false, reason: "racing" };
  }
  try {
    await aws.startWindowsBox();
    return { started: true, reason: "started" };
  } catch (err) {
    console.error("[native/lab-box] could not start the Windows box:", err instanceof Error ? err.message : err);
    await noteControl("windows", { startedAt: null, holdUsd: 0 });
    await release("windows", holdUsd, { ref: sessionRef(startedAt), note: "The start failed." });
    return { started: false, reason: "failed" };
  }
}

/** Commits the hours a session really ran, gives back its holds and marks the box as not billing. */
async function closeSession(control: NativeLabControl, now: Date): Promise<void> {
  if (!control.startedAt) return;
  const hours = (now.getTime() - Date.parse(control.startedAt)) / 3_600_000;
  // Only one caller gets to close a session, since the sweep and a wake can both find it. The close and its bill land
  // together: a failure leaves the session open for the next sweep, and a commit can't run twice.
  await commitIf(
    "windows",
    { usd: windowsUsd(hours), holdUsd: control.holdUsd ?? 0, ref: sessionRef(control.startedAt), note: `${hours.toFixed(2)} hours.` },
    sql`update native_labs
      set state = state || jsonb_build_object('control', (state->'control') || ${JSON.stringify({ startedAt: null, holdUsd: 0 })}::jsonb)
      where lane = 'windows' and ${sameSession(control)}
      returning lane`,
  );
}

export interface WindowsTick {
  boxState: string | null;
  did: WindowsPlan["act"] | "skipped";
  note?: string;
}

/** One sweep's look at the Windows box. */
export async function tickWindows(aws: BoxAws = realAws, now: Date = new Date()): Promise<WindowsTick> {
  if (!env.nativeWindowsInstanceId) return { boxState: null, did: "skipped", note: "NATIVE_WINDOWS_INSTANCE_ID isn't set." };
  const lab = await labRow("windows");
  if (!lab) return { boxState: null, did: "skipped", note: "The Windows lab has no token yet." };
  const control = lab.state?.control ?? {};
  const boxState = await aws.windowsBoxState();
  await noteControl("windows", { boxState, boxStateAt: now.toISOString() });
  const activity = await laneActivity("windows");
  const facts: WindowsFacts = { boxState, control, lastSeenAt: lab.lastSeenAt, ...activity, holdAllowed: true, now };
  let plan = planWindows(facts);
  if (plan.act === "extend_hold") {
    const startedAt = control.startedAt ?? now.toISOString();
    const holdUsd = windowsHoldUsd();
    const held = await reserve("windows", holdUsd, { ref: sessionRef(startedAt), note: "More time on the Windows box." });
    if (held.ok) {
      // Of two sweeps at once, one keeps its hold and the other gives it back, so what the ledger holds matches the session.
      const patch = JSON.stringify({ startedAt, holdUsd: (control.holdUsd ?? 0) + holdUsd });
      const noted = await db().execute(sql`update native_labs
        set state = coalesce(state, '{}'::jsonb) || jsonb_build_object('control', coalesce(state->'control', '{}'::jsonb) || ${patch}::jsonb)
        where lane = 'windows' and ${sameSession(control)}
        returning lane`);
      if (anyRows(noted)) return { boxState, did: "extend_hold" };
      await release("windows", holdUsd, { ref: sessionRef(startedAt), note: "Another sweep got there first." });
      return { boxState, did: "none", note: "racing" };
    }
    plan = planWindows({ ...facts, holdAllowed: false });
  }
  if (plan.act === "stop") {
    await aws.stopWindowsBox();
    await noteControl("windows", {
      stopReason: plan.reason,
      stopAt: now.toISOString(),
      noStartUntil: plan.reason === "agent_silent" ? new Date(now.getTime() + WINDOWS_NO_START_MS).toISOString() : null,
    });
    return { boxState, did: "stop", note: plan.reason };
  }
  if (plan.act === "close_session") {
    await closeSession(control, now);
    return { boxState, did: "close_session" };
  }
  if (plan.act === "start") {
    const woke = await wakeWindows(aws, now);
    return { boxState, did: woke.started ? "start" : "none", note: woke.reason };
  }
  return { boxState, did: "none" };
}

export interface MacTick {
  did: "none" | "skipped" | "restart-agent";
  note?: string;
}

/** Restarts a quiet Mac agent through the control document, if SSM can reach the box. */
export async function tickMac(aws: BoxAws = realAws, now: Date = new Date()): Promise<MacTick> {
  if (!env.nativeMacInstanceId) return { did: "skipped", note: "NATIVE_MAC_INSTANCE_ID isn't set." };
  const lab = await labRow("mac");
  if (!lab) return { did: "skipped", note: "The Mac lab has no token yet." };
  if (lab.lastSeenAt && now.getTime() - lab.lastSeenAt.getTime() < SILENT_AFTER_MS) return { did: "none" };
  const last = lab.state?.control?.restartAt;
  if (last && now.getTime() - Date.parse(last) < MAC_RESTART_EVERY_MS) return { did: "none", note: "Restarted recently." };
  const ping = await aws.labPing("mac");
  if (ping !== "Online") return { did: "none", note: `SSM says the Mac is ${ping ?? "unknown"}.` };
  await aws.sendLabCommand("mac", "restart-agent");
  await noteControl("mac", { restartAt: now.toISOString() });
  return { did: "restart-agent" };
}

export interface LabView {
  lane: NativeLane;
  known: boolean;
  online: boolean;
  lastSeenAt: Date | null;
  version: string | null;
  running: string[];
  queued: number;
  claimed: number;
  control: NativeLabControl;
}

/** Whether each box has spoken lately, for the planner and the admin card. Reads the database only. */
export async function labView(lane: NativeLane, now: Date = new Date()): Promise<LabView> {
  const [lab, activity] = await Promise.all([labRow(lane), laneActivity(lane)]);
  return {
    lane,
    known: Boolean(lab),
    online: Boolean(lab?.lastSeenAt && now.getTime() - lab.lastSeenAt.getTime() < SILENT_AFTER_MS),
    lastSeenAt: lab?.lastSeenAt ?? null,
    version: lab?.version ?? null,
    running: lab?.state?.running ?? [],
    queued: activity.queued,
    claimed: activity.claimed,
    control: lab?.state?.control ?? {},
  };
}

/** Claim's first job: every call counts as presence, whatever it goes on to ask. The box's fields only, never `control`. */
export async function notePresence(
  lane: NativeLane,
  input: { version: string | null; slots: number | null; running: string[]; kinds: string[]; capabilities: Record<string, unknown> | null },
): Promise<void> {
  const own = cleanForJsonb({ slots: input.slots, running: input.running, kinds: input.kinds, capabilities: input.capabilities });
  await db().execute(sql`update native_labs
    set last_seen_at = now(), version = ${cleanForJsonb(input.version)}::text, state = coalesce(state, '{}'::jsonb) || ${JSON.stringify(own)}::jsonb
    where lane = ${lane}`);
}

/** The lane a lab token belongs to, or null. */
export async function laneForToken(tokenHash: string): Promise<NativeLane | null> {
  const [row] = await db().select({ lane: schema.nativeLabs.lane }).from(schema.nativeLabs).where(eq(schema.nativeLabs.tokenHash, tokenHash));
  return row?.lane ?? null;
}

/** Sets a lane's token, for scripts/native/lab.ts. */
export async function setLabToken(lane: NativeLane, tokenHash: string, instanceId: string | null): Promise<void> {
  await db()
    .insert(schema.nativeLabs)
    .values({ lane, tokenHash, instanceId })
    .onConflictDoUpdate({ target: schema.nativeLabs.lane, set: { tokenHash, ...(instanceId ? { instanceId } : {}) } });
}

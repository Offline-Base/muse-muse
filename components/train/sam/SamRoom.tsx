"use client";

import { useCallback, useEffect, useState } from "react";
import { StepList, type StepItem, type StepsEnd } from "@/components/chat";
import { SamReport } from "@/components/train/sam/SamReport";
import { relativeTime, usd } from "@/lib/format";
import { canStop, SAM_STAGE_LABELS, SAM_STAGES } from "@/lib/train/sam/logic";
import type { SamRunView, SamStage, SamStatus } from "@/lib/train/sam/types";

/** The office board that takes SAM tune runs (scripts/edge/sam3/tune/, sam-tune-worker.service). */
export const OFFICE_BOARD = "jetson-03";
/** How often the room asks for the run while it can still change, as TrainRoom does. */
export const POLL_MS = 5_000;
/** The board polls every 20 s; past this it isn't answering. */
export const BOARD_FRESH_MS = 120_000;

const ACTIVE: readonly SamStatus[] = ["queued", "claimed", "running"];

/** Whether the run can still change without a person doing anything, so the room keeps asking. */
export function samActive(status: SamStatus): boolean {
  return ACTIVE.includes(status);
}

/** "jetson-03 ready, last seen 20 s ago", or why no board is taking runs. */
export function boardLine(boardSeenAt: string | null, now: number): { ready: boolean; text: string } {
  const t = boardSeenAt ? Date.parse(boardSeenAt) : NaN;
  if (!Number.isFinite(t)) return { ready: false, text: "The office board isn't taking runs right now." };
  const age = Math.max(0, now - t);
  if (age <= BOARD_FRESH_MS) {
    const ago = age < 60_000 ? `${Math.round(age / 1000)} s ago` : `${Math.round(age / 60_000)} min ago`;
    return { ready: true, text: `${OFFICE_BOARD} ready, last seen ${ago}` };
  }
  return { ready: false, text: `The office board was last seen ${relativeTime(boardSeenAt, now)}. It isn't taking runs right now.` };
}

/** The line under the board's while a run waits its turn. */
export function queueLine(view: Pick<SamRunView, "status" | "queueAhead">): string | null {
  if (view.status !== "queued") return null;
  return view.queueAhead > 0 ? `Waiting for the office board, ${view.queueAhead} ahead` : "Waiting for the office board, next in line";
}

function stageTitle(stage: SamStage, step?: number, steps?: number): string {
  if (stage === "claimed") return `Claimed by ${OFFICE_BOARD}`;
  if (stage === "training" && step !== undefined && steps) return `Training step ${step} of ${steps}`;
  return SAM_STAGE_LABELS[stage];
}

/**
 * The steps list: the queue, then every stage the board reached, in order. The stage it is on runs (or failed, when the
 * run failed or stopped there), the ones before it are done. A draft has no steps yet.
 */
export function samSteps(view: Pick<SamRunView, "status" | "stage">): { steps: StepItem[]; end?: StepsEnd } {
  const { status } = view;
  if (status === "draft") return { steps: [] };
  const ended = status === "done" || status === "failed" || status === "stopped";
  const end: StepsEnd | undefined = status === "done" ? "done" : status === "stopped" ? "stopped" : status === "failed" ? "unfinished" : undefined;
  const at = view.stage?.stage ?? (status === "queued" ? null : status === "done" ? "done" : "claimed");
  const steps: StepItem[] = [
    { id: "queue", title: "In the office board's queue", state: status === "queued" ? "running" : at === null && ended ? "failed" : "done" },
  ];
  if (at === null) return { steps, end };
  const upTo = SAM_STAGES.indexOf(at);
  for (const [i, stage] of SAM_STAGES.entries()) {
    if (stage === "done" || i > upTo) break;
    const current = i === upTo;
    const state = !current || status === "done" ? "done" : ended ? "failed" : "running";
    steps.push({
      id: stage,
      title: current ? stageTitle(stage, view.stage?.step, view.stage?.steps) : stageTitle(stage),
      description: current && view.stage?.line ? view.stage.line : undefined,
      state,
    });
  }
  return { steps, end };
}

function isRun(v: unknown, id: string): v is SamRunView {
  return Boolean(v && typeof v === "object" && (v as SamRunView).id === id && typeof (v as SamRunView).status === "string");
}

const STATUS_TEXT: Record<SamStatus, string> = {
  draft: "Not started",
  queued: "In the queue",
  claimed: "On the board",
  running: "On the board",
  done: "Done",
  failed: "Didn't finish",
  stopped: "Stopped",
};

/**
 * A SAM 3.1 tune run's room at /fine-tuning/sam/{id}, for admins (SAM_TUNE): whether the office board is taking runs
 * and how many runs are ahead, the stages it reached on StepList, Start for a draft, Stop until training ends, the
 * report once it is done, and Show it to visitors. Polls GET /api/train/sam/{id} every 5 s while the run can change.
 */
export function SamRoom({ initial, serverNow }: { initial: SamRunView; serverNow: number }) {
  const [view, setView] = useState(initial);
  const [now, setNow] = useState(serverNow);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = initial.id;
  const active = samActive(view.status);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/train/sam/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { run?: unknown };
      if (isRun(data.run, id)) setView(data.run);
      setNow(Date.now());
    } catch {
      // The room keeps what it has and asks again.
    }
  }, [id]);

  // Read the clock after the first render, so the server's and the browser's first renders match.
  useEffect(() => setNow(Date.now()), []);

  // Poll while the run can change. A hidden tab skips its turn and catches up as soon as it's shown again.
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      timer = null;
      if (stopped) return;
      if (!document.hidden) await refresh();
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    const onVisible = () => {
      if (document.hidden || !timer) return;
      clearTimeout(timer);
      void tick();
    };
    timer = setTimeout(tick, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, refresh]);

  const act = async (what: "start" | "stop" | "shown", body?: object) => {
    setBusy(what);
    setError(null);
    try {
      const res = await fetch(`/api/train/sam/${id}/${what}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json().catch(() => ({}))) as { run?: unknown; message?: unknown; error?: unknown };
      if (!res.ok) {
        setError(typeof data.message === "string" ? data.message : `That didn't work (${typeof data.error === "string" ? data.error : res.status}).`);
        return;
      }
      // Ask for the run again either way: an answer without the view must not leave a started run looking like a
      // draft, since the room only polls while the run can change.
      if (isRun(data.run, id)) setView(data.run);
      else await refresh();
      setNow(Date.now());
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const board = boardLine(view.boardSeenAt, now);
  const queue = queueLine(view);
  const { steps, end } = samSteps(view);
  const stoppable = (view.status === "draft" || active) && canStop(view.stage?.stage);

  return (
    <div className="sam-room">
      <h1 className="sam-title">Teach SAM 3.1 &quot;{view.word}&quot;</h1>
      <p className="sam-sub">
        {STATUS_TEXT[view.status]}. Compared with Meta&apos;s SAM 3.1 asked &quot;{view.generic}&quot; and &quot;toy&quot;.{" "}
        {view.data === "builtin-muse" ? "The built-in Muse photos." : "Your own photos."} {usd(view.costUsd)} spent of {usd(view.maxUsd)}.
      </p>

      <div className="sam-card">
        <p className={`sam-board${board.ready ? " is-ready" : ""}`}>
          <span className="sam-dot" aria-hidden="true" />
          {board.text}
        </p>
        {queue ? <p className="sam-queue">{queue}</p> : null}
      </div>

      {error ? (
        <p className="sam-error" role="alert">
          {error}
        </p>
      ) : null}

      {view.status === "draft" || stoppable || (view.status === "done" && view.report) ? (
        <div className="sam-actions">
          {view.status === "draft" ? (
            <button type="button" className="sam-btn" disabled={busy !== null} onClick={() => void act("start")}>
              {busy === "start" ? "Starting" : "Start"}
            </button>
          ) : null}
          {stoppable ? (
            <button type="button" className="sam-btn is-quiet" disabled={busy !== null} onClick={() => void act("stop")}>
              {busy === "stop" ? "Stopping" : "Stop"}
            </button>
          ) : null}
          {view.status === "done" && view.report ? (
            <button type="button" className="sam-btn is-quiet" disabled={busy !== null} onClick={() => void act("shown", { shown: !view.shown })}>
              {view.shown ? "Hide it from visitors" : "Show it to visitors"}
            </button>
          ) : null}
        </div>
      ) : null}

      {steps.length ? (
        <div className="sam-card">
          <h2 className="sam-card-title">Steps</h2>
          <StepList steps={steps} end={end} label="Steps on the office board" />
        </div>
      ) : null}

      {view.status === "done" && view.report ? <SamReport report={view.report} /> : null}
    </div>
  );
}

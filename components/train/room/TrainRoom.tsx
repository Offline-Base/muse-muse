"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlanViewCard } from "@/components/build/PlanCard";
import { SourceList, StepList, StepsPanel, TitleChip, UserBubble, WorkingStep, type SourceItem } from "@/components/chat";
import { Icon } from "@/components/icons";
import { EvalResults } from "@/components/train/EvalResults";
import { evalState, judgeName, tunedModelName, writerName } from "@/components/train/format";
import { GLIMMER_NAME } from "@/components/train/results";
import { planViewFromRun, roleTitle } from "@/components/train/room/plan";
import { WhereItRuns } from "@/components/train/room/WhereItRuns";
import { usd } from "@/lib/format";
import { TUNE_ART, tuneCurrentStep, tuneRunning, tuneSteps, tuneStepsEnd } from "@/lib/train/tune/steps";
import type { TuneRunView } from "@/lib/train/tune/types";

/** The steps panel, for the buttons that open it. */
const PANEL_ID = "tune-steps-panel";
/** How often the room asks for the run while something runs, and while it waits on a person. */
const POLL_MS = 5_000;
const WAIT_POLL_MS = 30_000;

/** What the browser that started a run kept of its plan (TrainComposer): the tagline, the sample and the rows used. */
export const KEPT_PLAN_KEY = (runId: string) => `mm:tune-plan:${runId}`;

function readKept(runId: string): { tagline?: string; samples?: string[]; used?: number } | null {
  try {
    const raw = window.sessionStorage.getItem(KEPT_PLAN_KEY(runId));
    return raw ? (JSON.parse(raw) as { tagline?: string; samples?: string[]; used?: number }) : null;
  } catch {
    return null;
  }
}

function isRunView(v: unknown, id: string): v is TuneRunView {
  return Boolean(v && typeof v === "object" && (v as TuneRunView).id === id && typeof (v as TuneRunView).stage === "string");
}

/** The person's words, without the rows folded into the task after them. */
export function askedText(task: string): string {
  return task.split("\n\nWrite in the style of these examples")[0]!.trim();
}

/**
 * A fine-tuning run's room at /fine-tuning/runs/{id} (docs/TRAINING.md "Fine-tune like a build"), on the build room's
 * chat kit: the title chip, the person's words as a bubble, the working step while something runs, the plan card with
 * the mascot for the stage, then what's next: Ready to train (the full form, until U3), the verdict and the eval
 * results, or why it stopped. The steps panel lists the stages it reached. Polls GET /api/train/runs/{id}.
 */
export function TrainRoom({ initial, admin, serverNow }: { initial: TuneRunView; admin: boolean; serverNow: number }) {
  const [view, setView] = useState(initial);
  const [panelOpen, setPanelOpen] = useState(false);
  const [kept, setKept] = useState<ReturnType<typeof readKept>>(null);
  const [now, setNow] = useState(serverNow);
  const id = initial.id;
  const running = tuneRunning(view);
  const waiting = view.stage === "waiting";

  // Read after the first render, so the server's and the browser's first renders match.
  useEffect(() => {
    setKept(readKept(id));
    setNow(Date.now());
  }, [id]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/train/runs/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { run?: unknown };
      if (isRunView(data.run, id)) setView(data.run);
      setNow(Date.now());
    } catch {
      // The room keeps what it has and asks again.
    }
  }, [id]);

  useEffect(() => {
    if (!running && !waiting) return;
    const t = setInterval(() => void refresh(), running ? POLL_MS : WAIT_POLL_MS);
    return () => clearInterval(t);
  }, [running, waiting, refresh]);

  const current = tuneCurrentStep(view);
  const art = TUNE_ART[view.stage];
  const planView = useMemo(() => planViewFromRun(view, kept), [view, kept]);
  const title = roleTitle(view.title);
  const job = view.job;
  const scored = job ? evalState(job, view.evals, now) : null;
  const sources: SourceItem[] = [
    { id: "writer", title: writerName(view.dataset), detail: "Wrote the examples", kind: "model" },
    { id: "glimmer", title: GLIMMER_NAME, detail: "The model it tunes", kind: "model" },
  ];

  return (
    <div className="room chat-split tune-room" data-settled="true">
      <div className="room-main">
        <div className="room-top">
          <TitleChip as="h1">{title}</TitleChip>
        </div>
        <p className="sr-only" aria-live="polite">
          {current ? (current.description ?? current.title) : ""}
        </p>

        <ol className="convo" aria-label="Fine-tuning run">
          <li className="turn-user">
            <UserBubble text={askedText(view.task)} />
          </li>

          {current ? (
            <li className="room-working">
              <WorkingStep title={current.title} description={current.description} />
              <p className="room-working-meta">
                {usd(view.costSoFarUsd)} so far
                <StepsToggle open={panelOpen} onClick={() => setPanelOpen((o) => !o)} />
              </p>
            </li>
          ) : null}

          <li className="room-plan">
            <PlanViewCard
              view={planView}
              art={art}
              running={running || waiting}
              more={
                current ? null : (
                  <button type="button" className="link-btn room-steps-link" aria-expanded={panelOpen} aria-controls={PANEL_ID} onClick={() => setPanelOpen((o) => !o)}>
                    {panelOpen ? "Hide steps" : "Show steps"}
                    <Icon name="chevronRight" size={16} />
                  </button>
                )
              }
            />
          </li>

          {waiting && view.next?.kind === "full_form" ? (
            <li className="room-answer">
              <p>{view.hold?.text ?? "The examples are ready."}</p>
              {/* U3 replaces this one spot with Start training (POST /api/train/runs/{id}/start) once the tuneRun workflow lands. */}
              <div className="row-actions" data-u3="ready-to-train">
                <a className="btn btn-primary" href={view.next.href}>
                  Ready to train
                  <Icon name="chevronRight" size={18} />
                </a>
              </div>
              <p className="muted small">
                Opens the full New job form with these examples picked, Muse Glimmer LoRA and its defaults. Training starting on its own after Start comes next.
              </p>
              <p className="room-meta">{usd(view.costSoFarUsd)} so far</p>
            </li>
          ) : null}

          {view.stage === "ready" ? (
            <li className="room-answer">
              <p className="tune-verdict">
                <Icon name={view.verdict?.passed ? "checkCircle" : "alertCircle"} size={18} />
                <span>
                  {view.verdict?.passed ? "Ready. " : "Ready, but it didn't pass. "}
                  {view.verdict?.words ?? ""}
                </span>
              </p>
              {job && scored ? (
                <EvalResults state={scored} rows={view.evals} model={tunedModelName(job.recipe)} writer={writerName(view.dataset)} judge={judgeName(job)} />
              ) : null}
              {view.next?.kind === "job" ? (
                <div className="row-actions">
                  <Link className="btn btn-primary" href={view.next.href}>
                    Try it live and publish
                    <Icon name="chevronRight" size={18} />
                  </Link>
                </div>
              ) : null}
              <WhereItRuns jobHref={view.next?.kind === "job" ? view.next.href : null} admin={admin} />
              <p className="room-meta">{usd(view.costSoFarUsd)} in all</p>
            </li>
          ) : null}

          {(view.stage === "training" || view.stage === "scoring") && view.next?.kind === "job" ? (
            <li className="room-answer">
              <p className="muted small">
                The GPU&apos;s log, its limits and Stop are on <Link href={view.next.href}>the job&apos;s page</Link>.
              </p>
            </li>
          ) : null}

          {view.stage === "failed" || view.stage === "stopped" ? (
            <li className="room-answer">
              <p>{view.stage === "stopped" ? "This run was stopped." : "This run didn't finish."}</p>
              {view.problem ? <p>{view.problem}</p> : null}
              <div className="row-actions">
                <Link className="btn btn-outline" href="/fine-tuning/new">
                  <Icon name="plus" size={18} />
                  Start another
                </Link>
              </div>
              <p className="room-meta">{usd(view.costSoFarUsd)} in all</p>
            </li>
          ) : null}
        </ol>
      </div>

      <div className="room-panel">
        <StepsPanel
          id={PANEL_ID}
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          steps={panelOpen ? <StepList steps={tuneSteps(view)} end={tuneStepsEnd(view)} /> : null}
          sources={panelOpen ? <SourceList sources={sources} /> : null}
        />
      </div>
    </div>
  );
}

/** Opens and closes the steps panel from the running step. */
function StepsToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="link-btn room-steps-link" aria-expanded={open} aria-controls={PANEL_ID} onClick={onClick}>
      {open ? "Hide steps" : "Show steps"}
      <Icon name="chevronRight" size={16} />
    </button>
  );
}

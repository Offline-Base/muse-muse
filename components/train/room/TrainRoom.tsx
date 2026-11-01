"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PlanViewCard } from "@/components/build/PlanCard";
import { ShowThinking, SourceList, StepList, StepsPanel, TitleChip, UserBubble, WorkingStep, type SourceItem } from "@/components/chat";
import { Icon } from "@/components/icons";
import { EvalResults } from "@/components/train/EvalResults";
import { HubCard } from "@/components/train/HubCard";
import { AdapterLiveDemo, type JobLiveDemo } from "@/components/train/LiveDemo";
import { MakeLocalFiles } from "@/components/train/LocalFiles";
import { SparkOpenNote } from "@/components/train/SparkOpenNote";
import { evalState, judgeName, tunedModelName, writerName } from "@/components/train/format";
import { GLIMMER_NAME, R30B_NAME } from "@/components/train/results";
import { planViewFromRun, roleTitle } from "@/components/train/room/plan";
import { tuneArt, tuneCurrentStep, tuneRunning, tuneSteps, tuneStepsEnd } from "@/components/train/room/steps";
import { WhereItRuns } from "@/components/train/room/WhereItRuns";
import { usd } from "@/lib/format";
import { isSparkOpenDerivative } from "@/lib/train/base";
import type { TuneRunView } from "@/lib/train/tune/types";

/** The steps panel, for the buttons that open it. */
const PANEL_ID = "tune-steps-panel";
/** How often the room asks for the run while something runs (as JobRoom does), and while it waits on a person. */
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

export interface TrainRoomProps {
  initial: TuneRunView;
  admin: boolean;
  /**
   * A trained run's live demo (app/fine-tuning/runs/live.ts): the Try it live box while a serve job for its adapter is
   * open, or Start a live demo when the adapter can be served. Read from the props, so a refresh updates it.
   */
  liveDemo?: JobLiveDemo | null;
  /** Admins only: the Hugging Face card's and Local files' setup, as on the job's page. */
  hub?: { offReason: string | null; maxActive: number; dailyUsd: number } | null;
  serverNow: number;
}

/**
 * A fine-tuning run's room at /fine-tuning/runs/{id} (docs/TRAINING.md "Fine-tune like a build"), on the build room's
 * chat kit: the title chip, the person's words as a bubble, the working step while something runs (Show thinking once
 * it ended), the plan card with the mascot for the stage, then what's next: Ready to train (the full form, until U3),
 * the verdict with the eval results, the live demo, the Hugging Face card and Where it runs, or why it stopped. The
 * steps panel lists the stages it reached. Polls GET /api/train/runs/{id} every 5 s while something runs.
 */
export function TrainRoom({ initial, admin, liveDemo = null, hub = null, serverNow }: TrainRoomProps) {
  const [view, setView] = useState(initial);
  // A refresh of the page (Start a live demo does one) brings a newer run: take it.
  const [given, setGiven] = useState(initial);
  if (given !== initial) {
    setGiven(initial);
    setView(initial);
  }
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

  // Poll while anything can still change. A hidden tab skips its turn and catches up as soon as it's shown again.
  useEffect(() => {
    if (!running && !waiting) return;
    const every = running ? POLL_MS : WAIT_POLL_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      timer = null;
      if (stopped) return;
      if (!document.hidden) await refresh();
      if (!stopped) timer = setTimeout(tick, every);
    };
    const onVisible = () => {
      if (document.hidden || !timer) return;
      clearTimeout(timer);
      void tick();
    };
    timer = setTimeout(tick, every);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [running, waiting, refresh]);

  const current = tuneCurrentStep(view);
  const ended = view.stage === "ready" || view.stage === "failed" || view.stage === "stopped";
  const art = tuneArt(view);
  const planView = useMemo(() => planViewFromRun(view, kept), [view, kept]);
  const title = roleTitle(view.title);
  const job = view.job;
  const jobHref = view.next?.kind === "job" ? view.next.href : null;
  const scored = job ? evalState(job, view.evals, now) : null;
  const trained = job?.status === "succeeded";
  // A run trained from r30b is a Derivative of Muse Spark Open (lib/train/base.ts). Before its job exists, it will be.
  const sparkOpen = job ? isSparkOpenDerivative({ params: job.params }) : true;
  const sources: SourceItem[] = [
    { id: "writer", title: writerName(view.dataset), detail: "Wrote the examples", kind: "model" },
    { id: "glimmer", title: sparkOpen ? R30B_NAME : GLIMMER_NAME, detail: "The model it tunes", kind: "model" },
  ];
  const togglePanel = () => setPanelOpen((o) => !o);

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
                <StepsToggle open={panelOpen} onClick={togglePanel} />
              </p>
            </li>
          ) : ended ? (
            <li>
              <ShowThinking onClick={() => setPanelOpen(true)} />
            </li>
          ) : null}

          <li className="room-plan">
            <PlanViewCard
              view={planView}
              art={art}
              running={running || waiting}
              more={current || ended ? null : <StepsToggle open={panelOpen} onClick={togglePanel} />}
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
              {/* The form's own defaults publish to Hugging Face and pick their own GPU and limits; the plan said Publish: Off. */}
              <p className="muted small" data-u3="publish-note">
                The form publishes to Hugging Face by default. To keep it on Muse Muse as the plan says, set Publish to Hugging Face to 0 there. Its GPU and limits are the form&apos;s own too, under the same caps.
              </p>
              <p className="room-meta">{usd(view.costSoFarUsd)} so far</p>
            </li>
          ) : null}

          {view.stage === "ready" ? (
            <li className="room-answer">
              <p className="tune-verdict">
                <Icon name={view.verdict?.passed ? "checkCircle" : "alertCircle"} size={18} />
                {/* The verdict's words say whether it passed (runVerdict), so only a pass gets "Ready." before them. */}
                <span>{view.verdict ? `${view.verdict.passed ? "Ready. " : ""}${view.verdict.words}` : "Not scored."}</span>
              </p>
              {job && sparkOpen ? <SparkOpenNote /> : null}
              {job && scored ? (
                <EvalResults
                  state={scored}
                  rows={view.evals}
                  model={tunedModelName(job.recipe)}
                  writer={writerName(view.dataset)}
                  judge={judgeName(job)}
                  sparkOpen={sparkOpen}
                />
              ) : null}
              {job && liveDemo ? <AdapterLiveDemo jobId={job.id} live={liveDemo} serverNow={serverNow} /> : null}
              {job && admin && hub ? <HubCard job={job} offReason={hub.offReason} maxActive={hub.maxActive} dailyUsd={hub.dailyUsd} /> : null}
              {job && admin && hub && trained ? <MakeLocalFiles jobId={job.id} maxActive={hub.maxActive} dailyUsd={hub.dailyUsd} /> : null}
              <WhereItRuns jobHref={jobHref} demoHere={Boolean(liveDemo)} localFilesHere={Boolean(admin && hub && trained)} admin={admin} />
              {jobHref ? <JobLink href={jobHref} /> : null}
              <p className="room-meta">{usd(view.costSoFarUsd)} in all</p>
            </li>
          ) : null}

          {(view.stage === "training" || view.stage === "scoring") && jobHref ? (
            <li className="room-answer">
              <JobLink href={jobHref} running />
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
              {jobHref ? <JobLink href={jobHref} /> : null}
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

/** Opens and closes the steps panel from the running step, or from the plan card while the run waits. */
function StepsToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="link-btn room-steps-link" aria-expanded={open} aria-controls={PANEL_ID} onClick={onClick}>
      {open ? "Hide steps" : "Show steps"}
      <Icon name="chevronRight" size={16} />
    </button>
  );
}

/** The training job's own page: its log and settings, and while it runs, the GPU's limits and Stop. */
function JobLink({ href, running = false }: { href: string; running?: boolean }) {
  return (
    <p className="muted small">
      {running ? "The GPU's log, its limits and Stop are on " : "The GPU's log and the job's settings are on "}
      <Link href={href}>the job&apos;s page</Link>.
    </p>
  );
}

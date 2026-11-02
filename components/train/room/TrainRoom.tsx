"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PlanViewCard } from "@/components/build/PlanCard";
import { PlanChecklist } from "@/components/build/PlanChecklist";
import { StepsFeed } from "@/components/build/StepsFeed";
import { tuneChecklist } from "@/lib/steps-feed/checklist";
import { ShowThinking, SourceList, StepList, StepsPanel, TitleChip, UserBubble, WorkingStep, type SourceItem } from "@/components/chat";
import { Icon } from "@/components/icons";
import { EvalResults } from "@/components/train/EvalResults";
import { HubCard } from "@/components/train/HubCard";
import { AdapterLiveDemo, type JobLiveDemo } from "@/components/train/LiveDemo";
import { MakeLocalFiles } from "@/components/train/LocalFiles";
import { SimTuneCard } from "@/components/train/SimTune";
import { SparkOpenNote } from "@/components/train/SparkOpenNote";
import { evalState, judgeName, tunedModelName, writerName } from "@/components/train/format";
import { GLIMMER_NAME, R30B_NAME } from "@/components/train/results";
import { planViewFromRun, roleTitle } from "@/components/train/room/plan";
import { tuneArt, tuneCurrentStep, tuneRunning, tuneSteps, tuneStepsEnd } from "@/components/train/room/steps";
import { WhereItRuns } from "@/components/train/room/WhereItRuns";
import { usd } from "@/lib/format";
import { isSparkOpenDerivative } from "@/lib/train/base";
import { tuneFeed } from "@/lib/steps-feed/tune";
import { endedText } from "@/lib/train/tune/marks";
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
  return task.split("\n\nWrite in the style of these examples")[0]!.split("\n\nRules for this model, always:")[0]!.trim();
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
  /** QUANT_TARGETS, for Where it runs. */
  quantTargets?: boolean;
  /** OPEN_TRAIN: a visitor's own run. Start training asks for the start code, and the room offers Stop. */
  needsCode?: boolean;
  /** MAKE_CHAT_ALL: the simple story on the left (lib/steps-feed/tune.ts), the plan, scores and results on the right. */
  story?: boolean;
}

/**
 * A fine-tuning run's room at /fine-tuning/runs/{id} (docs/TRAINING.md "Fine-tune like a build"), on the build room's
 * chat kit: the title chip, the person's words as a bubble, the working step while something runs (Show thinking once
 * it ended), the plan card with the mascot for the stage, then what's next: Start training (with why it waits),
 * the verdict with the eval results, the live demo, the Hugging Face card and Where it runs, or why it stopped. The
 * steps panel lists the stages it reached. Polls GET /api/train/runs/{id} every 5 s while something runs.
 */
export function TrainRoom({ initial, admin, liveDemo = null, hub = null, serverNow, quantTargets = false, needsCode = false, story = false }: TrainRoomProps) {
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
  const onFireworks = view.trainer === "fireworks";
  const trained = job?.status === "succeeded" && !onFireworks;
  // A run trained from r30b is a Derivative of Muse Spark Open (lib/train/base.ts). Before its job exists, it will be.
  const sparkOpen = job ? isSparkOpenDerivative({ params: job.params }) : true;
  const sources: SourceItem[] = [
    { id: "writer", title: writerName(view.dataset), detail: "Wrote the examples", kind: "model" },
    { id: "glimmer", title: sparkOpen ? R30B_NAME : GLIMMER_NAME, detail: "The model it tunes", kind: "model" },
  ];
  const togglePanel = () => setPanelOpen((o) => !o);
  const wrap = (story_: ReactNode, results: ReactNode) =>
    story ? (
      <div className="room-columns">
        <div className="room-feed-col">
          <ol className="convo" aria-label="Fine-tuning run">
            {story_}
          </ol>
        </div>
        <aside className="room-stuff" aria-label="Scores and results">
          <ol className="convo">{results}</ol>
        </aside>
      </div>
    ) : (
      <ol className="convo" aria-label="Fine-tuning run">
        {story_}
        {results}
      </ol>
    );

  return (
    <div className="room chat-split tune-room" data-settled="true">
      <div className={story ? "room-main room-main-feed" : "room-main"}>
        <div className="room-top">
          <TitleChip as="h1">{title}</TitleChip>
        </div>
        <p className="sr-only" aria-live="polite">
          {current ? (current.description ?? current.title) : ""}
        </p>

        {/* Off (the default): one column, the rows below in this order. MAKE_CHAT_ALL: the story left, the results right. */}
        {wrap(<>
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
          {story ? (
            <li>
              <PlanChecklist list={tuneChecklist(view)} />
              <StepsFeed feed={tuneFeed(view)} label="What is happening to your model" />
            </li>
          ) : null}
        </>, <>
          <li className="room-plan">
            <PlanViewCard
              view={planView}
              art={art}
              running={running || waiting}
              more={current || ended ? null : <StepsToggle open={panelOpen} onClick={togglePanel} />}
            />
          </li>

          {view.datasetOnly && view.stage === "waiting" && !view.job ? <DatasetResult runId={view.id} /> : null}

          {waiting && view.next?.kind === "start" ? (
            <li className="room-answer">
              <StartTraining
                startLabel={view.datasetOnly && view.hold?.reason === "not_started" ? "Tune a model on this" : undefined}
                key={view.hold?.reason ?? ""}
                start={view.next.start}
                fullForm={admin ? view.next.fullForm : null}
                autoUpload={view.next.autoUpload === true}
                hold={view.hold}
                onStarted={refresh}
                needsCode={needsCode}
              />
              <p className="room-meta">{usd(view.costSoFarUsd)} so far</p>
            </li>
          ) : null}

          {needsCode && (running || waiting) ? (
            <li className="room-answer">
              <StopRun id={id} onStopped={refresh} />
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
              {onFireworks ? <p className="muted">Trained on Fireworks. Its base is plain Muse Glimmer 30B, not the 2026 Glimmer (r30b), so both the tuned model and the base it&apos;s scored against lack r30b&apos;s 2026 knowledge. The adapter stays on Fireworks: Muse Muse&apos;s local files and live demo don&apos;t use it yet.</p> : null}
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
              {job && admin && hub && !onFireworks ? <HubCard job={job} offReason={hub.offReason} maxActive={hub.maxActive} dailyUsd={hub.dailyUsd} /> : null}
              {job && admin && hub && trained ? <MakeLocalFiles jobId={job.id} maxActive={hub.maxActive} dailyUsd={hub.dailyUsd} /> : null}
              {job && admin && hub && trained ? <SimTuneCard jobId={job.id} /> : null}
              {onFireworks ? null : <WhereItRuns jobHref={jobHref} demoHere={Boolean(liveDemo)} localFilesHere={Boolean(admin && hub && trained)} quantTargets={quantTargets} />}
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
        </>)}
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

/** MAKE_CHAT_ALL's Dataset: the first few examples and the download, from the owner-only examples route. Spends nothing. */
function DatasetResult({ runId }: { runId: string }) {
  const [got, setGot] = useState<{ total: number; rows: Array<{ messages?: Array<{ role: string; content: string }> }> } | null | "failed">(null);
  useEffect(() => {
    let live = true;
    void fetch(`/api/train/runs/${runId}/examples?sample=5`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (live) setGot(d);
      })
      .catch(() => {
        if (live) setGot("failed");
      });
    return () => {
      live = false;
    };
  }, [runId]);
  const said = (row: { messages?: Array<{ role: string; content: string }> }, role: string) => row.messages?.find((m) => m.role === role)?.content?.slice(0, 240) ?? "";
  return (
    <li className="room-answer">
      <p>
        <strong>Your dataset.</strong> {got && got !== "failed" ? `${got.total} training examples, plus the ones kept aside for a test. The first few:` : got === "failed" ? "The examples are ready, but they couldn't be shown here." : "Loading the examples."}
      </p>
      {got && got !== "failed" ? (
        <ul className="tune-folder-list">
          {got.rows.map((r, i) => (
            <li key={i}>
              <strong>{said(r, "user")}</strong> {said(r, "assistant")}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row-actions">
        <a className="btn btn-outline" href={`/api/train/runs/${runId}/examples`} download>
          Download the examples
        </a>
      </div>
    </li>
  );
}

/** What Start training says when POST /api/train/runs/{id}/start refuses, from its status and body. */
export function startTrainingErrorText(status: number, body: unknown): string {
  const b = body && typeof body === "object" ? (body as { error?: unknown; reason?: unknown }) : {};
  const code = typeof b.error === "string" ? b.error : "";
  if ((status === 422 || code === "gpu_limit") && typeof b.reason === "string" && b.reason.trim()) return b.reason.trim();
  const message = body && typeof body === "object" ? (body as { message?: unknown }).message : null;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (typeof b.reason === "string" && b.reason.trim() && /^(visitor|ip)_/.test(code)) return b.reason.trim();
  if (code === "stopped") return "This run was stopped, so it won't train.";
  if (code === "not_ready") return "The examples are still being written. Training starts on its own once they're ready.";
  if (code === "forbidden") return "Only the person who started this run can train it.";
  if (code === "lambda_not_configured" || code === "platform_not_public" || code === "sweep_not_configured" || code === "start_failed") {
    return endedText(code);
  }
  if (status === 401 || status === 403) return "Only admins can train models here.";
  if (status === 404) return "This run is gone, or fine-tuning from here isn't switched on.";
  if (status === 400 && code && /\s/.test(code)) return code;
  return "Something went wrong on our side. Try again in a moment.";
}

/**
 * Start training, where the run waits with its examples ready: why it waits (the run's hold), the button that tries the
 * launch now (POST /api/train/runs/{id}/start, under every cap a job has), and for admins a small link to the full New
 * job form with the dataset picked. A launch that has to wait says why, and the tuneRun workflow keeps trying.
 */
export function StartTraining({
  start,
  fullForm,
  autoUpload = false,
  hold,
  onStarted,
  needsCode = false,
  startLabel = "Start training",
}: {
  /** A finished dataset's button (MAKE_CHAT_ALL). */
  startLabel?: string;
  needsCode?: boolean;
  start: string;
  fullForm: string | null;
  autoUpload?: boolean;
  hold: TuneRunView["hold"];
  onStarted: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; problem: boolean } | null>(null);
  const [code, setCode] = useState("");

  async function press() {
    if (busy) return;
    setBusy(true);
    setSaid(null);
    try {
      const res = await fetch(start, { method: "POST", headers: { "content-type": "application/json" }, body: needsCode ? JSON.stringify({ startCode: code }) : "{}" });
      const data: unknown = await res.json().catch(() => null);
      if (res.status === 201 || (res.status === 409 && (data as { error?: unknown } | null)?.error === "already_training")) {
        await onStarted();
      } else if (res.status === 202) {
        const text = (data as { hold?: { text?: unknown } } | null)?.hold?.text;
        setSaid({ text: typeof text === "string" ? text : "It has to wait for now, and tries again on its own.", problem: false });
        await onStarted();
      } else {
        setSaid({ text: startTrainingErrorText(res.status, data), problem: true });
      }
    } catch {
      setSaid({ text: "Couldn't reach Muse Muse. Check your connection and try again.", problem: true });
    }
    setBusy(false);
  }

  const trying = Boolean(hold && hold.reason !== "not_started" && hold.reason !== "stopped");
  return (
    <>
      {/* While the workflow is trying, the working step above already says why it waits. */}
      <p>
        {said && !said.problem
          ? said.text
          : trying
            ? "Training starts on its own as soon as it can. Try now asks again at once."
            : (hold?.text ?? "The examples are ready. Training hasn't started yet.")}
      </p>
      {said?.problem ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{said.text}</span>
        </p>
      ) : null}
      {needsCode ? (
        <div className="field tune-start-code">
          <label htmlFor="tune-start-code">Start code</label>
          <input id="tune-start-code" type="text" autoComplete="off" autoCapitalize="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
        </div>
      ) : null}
      <div className="row-actions">
        <button type="button" className={trying ? "btn btn-outline" : "btn btn-primary"} onClick={() => void press()} disabled={busy || (needsCode && !code.trim())} aria-busy={busy}>
          {busy ? <span className="spinner" aria-hidden /> : null}
          {busy ? "Starting" : trying ? "Try now" : startLabel}
        </button>
      </div>
      <p className="muted small">
        {GLIMMER_NAME} LoRA with the plan&apos;s settings, on one GPU with its time and dollar limits, {autoUpload ? "uploaded to Hugging Face by itself once it is judged." : "kept on Muse Muse (publish is off)."}
        {fullForm ? (
          <>
            {" "}
            <Link href={fullForm}>Use the full form</Link> to change the settings.
          </>
        ) : null}
      </p>
    </>
  );
}

/** Stops a visitor's own run. Admins stop from the job's page. */
function StopRun({ id, onStopped }: { id: string; onStopped: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  async function press() {
    setBusy(true);
    setProblem(false);
    try {
      const res = await fetch(`/api/train/runs/${id}/stop`, { method: "POST" });
      if (res.ok || res.status === 409) await onStopped();
      else setProblem(true);
    } catch {
      setProblem(true);
    }
    setBusy(false);
  }
  return (
    <div className="row-actions">
      <button type="button" className="btn btn-outline" onClick={() => void press()} disabled={busy} aria-busy={busy}>
        {busy ? "Stopping" : "Stop this run"}
      </button>
      {problem ? <span role="alert">That didn&apos;t work. Try again.</span> : null}
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

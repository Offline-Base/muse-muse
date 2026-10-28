"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { EvalResults } from "@/components/train/EvalResults";
import { EventLog } from "@/components/train/EventLog";
import { JobPanel } from "@/components/train/JobPanel";
import {
  doneMetrics,
  errorHeadline,
  evalRows,
  evalState,
  gpuName,
  isSettled,
  jobElapsedMs,
  liveCostUsd,
  mergeEvents,
  stopControl,
  stopErrorText,
  trainStatusLabel,
  tunedModelName,
  workingText,
} from "@/components/train/format";
import { dateTimeUtc, duration, relativeTime, usd } from "@/lib/format";
import { isTrainTerminal, type RecipeView, type TrainEventView, type TrainJobView } from "@/lib/train/types";

export interface JobRoomProps {
  job: TrainJobView;
  /** The log the page loaded: every eval item and judgement, and the latest of the rest (keepEvents). */
  events: TrainEventView[];
  /** Older events the page left out of `events`. */
  droppedEvents?: number;
  recipe: RecipeView | null;
  /** The dataset the job trains on (its datasetId param), when it still exists. */
  dataset?: { id: string; title: string } | null;
  serverNow: number;
}

/** GET /api/train/jobs/{id}?after=<last id> this often until the job ends and its GPU is gone. */
const POLL_MS = 5_000;
/** After the job ends, keep polling this long for the GPU's shutdown, then stop. */
const AFTER_END_MS = 5 * 60_000;
/** The log keeps this many rows in the page. */
const MAX_SHOWN = 1500;

function isJobView(v: unknown, id: string): v is TrainJobView {
  if (!v || typeof v !== "object") return false;
  const j = v as Record<string, unknown>;
  return j.id === id && typeof j.status === "string" && typeof j.title === "string" && Array.isArray(j.artifacts);
}

function isEventView(v: unknown): v is TrainEventView {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "number" &&
    typeof e.at === "string" &&
    Boolean(e.payload) &&
    typeof (e.payload as { type?: unknown }).type === "string"
  );
}

function useNow(initial: number, ticking: boolean): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  return now;
}

function smooth(): ScrollBehavior {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

/**
 * The fine-tuning job page, in the build room's layout: the event log on the left, polled every 5 seconds while the
 * job runs, and the job panel on the right with status, limits, cost, progress, artifacts and Stop. A job that sent
 * eval items gets its results below the log; polling goes on after the GPU is gone while Muse Spark 1.3 judges them.
 */
export function JobRoom(props: JobRoomProps) {
  const jobId = props.job.id;
  const [job, setJob] = useState(props.job);
  const [events, setEvents] = useState(props.events);
  const [conn, setConn] = useState<"ok" | "error">("ok");
  const [gaveUp, setGaveUp] = useState(false);
  const [stop, setStop] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const lastId = useRef(props.events.reduce((m, e) => Math.max(m, e.id), 0));

  const terminal = isTrainTerminal(job.status);
  const jobSettled = isSettled(job);
  const settled = jobSettled || gaveUp;
  // The clock ticks while the page polls. Whether it polls depends on the clock (judging is given up on after a while).
  const [ticking, setTicking] = useState(!settled);
  const now = useNow(props.serverNow, ticking);
  const rows = useMemo(() => evalRows(events), [events]);
  const evals = evalState(job, events, rows, now);
  // Judging starts once the GPU is gone, so the page keeps polling for verdicts after the job settles.
  const judging = evals.state === "judging";
  const polling = !settled || judging;
  useEffect(() => setTicking(polling), [polling]);
  const elapsed = jobElapsedMs(job, now);
  const cost = liveCostUsd(job, now);
  const label = trainStatusLabel(job.status, job.stopRequested);
  const control = stopControl(job);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/train/jobs/${jobId}?after=${lastId.current}`, { cache: "no-store" });
      if (!res.ok) {
        setConn("error");
        return;
      }
      const data = (await res.json()) as { job?: unknown; events?: unknown };
      setConn("ok");
      if (isJobView(data.job, jobId)) setJob(data.job);
      const fresh = Array.isArray(data.events) ? data.events.filter(isEventView) : [];
      if (fresh.length) {
        lastId.current = fresh.reduce((m, e) => Math.max(m, e.id), lastId.current);
        setEvents((list) => mergeEvents(list, fresh));
      }
    } catch {
      setConn("error");
    }
  }, [jobId]);

  // Poll while anything can still change. A hidden tab skips its turn and catches up as soon as it's shown again.
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      timer = null;
      if (stopped) return;
      if (!document.hidden) await poll();
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
  }, [polling, poll]);

  // A job can end before its GPU is reported gone. Wait a few minutes for that, then stop polling.
  useEffect(() => {
    if (!terminal || jobSettled) return;
    const t = setTimeout(() => setGaveUp(true), AFTER_END_MS);
    return () => clearTimeout(t);
  }, [terminal, jobSettled]);

  // Keep the newest row in view while the viewer is at the bottom of the log.
  const end = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = end.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        atBottom.current = entry.isIntersecting;
      },
      { rootMargin: "0px 0px 120px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const seen = useRef(events.length);
  useEffect(() => {
    if (events.length > seen.current && atBottom.current && !settled) {
      end.current?.scrollIntoView({ block: "end", behavior: smooth() });
    }
    seen.current = events.length;
  }, [events.length, settled]);

  async function stopJob() {
    if (!control || !window.confirm(control.confirm)) return;
    setStop({ busy: true, message: null });
    try {
      const res = await fetch(`/api/train/jobs/${jobId}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStop({ busy: false, message: stopErrorText(res.status, data) });
        void poll();
        return;
      }
      const next = (data as { job?: unknown } | null)?.job;
      if (isJobView(next, jobId)) setJob(next);
      else setJob((j) => (isTrainTerminal(j.status) ? j : { ...j, stopRequested: true }));
      setStop({ busy: false, message: null });
      void poll();
    } catch {
      setStop({ busy: false, message: "Couldn't reach Muse Muse. Try again." });
    }
  }

  const shown = events.length > MAX_SHOWN ? events.slice(-MAX_SHOWN) : events;
  const totalEvents = events.length + (props.droppedEvents ?? 0);
  const recipeTitle = props.recipe?.title ?? job.recipe;
  const gpu = gpuName(props.recipe, job.instanceType);
  const shuttingDown = terminal && Boolean(job.instanceId) && !job.terminatedAt;

  return (
    <div className="room">
      <div className="room-main">
        <div className="toolbar" aria-label="Job actions">
          <Link className="btn" href="/fine-tuning">
            <Icon name="chevronLeft" />
            <span>All jobs</span>
          </Link>
          <Link className="btn" href="/fine-tuning#new-job">
            <Icon name="plus" />
            <span>New job</span>
          </Link>
          {control ? (
            <button type="button" className="btn train-toolbar-stop" onClick={stopJob} disabled={stop.busy}>
              <Icon name="power" />
              <span>{stop.busy ? "Stopping" : control.label}</span>
            </button>
          ) : null}
        </div>

        <div className="train-col">
          <header className="train-head">
            <h1>{job.title}</h1>
            <p className="muted">
              {recipeTitle} · {gpu} · queued{" "}
              <time dateTime={job.createdAt} title={dateTimeUtc(job.createdAt)}>
                {relativeTime(job.createdAt, now)}
              </time>
            </p>
          </header>

          <p className="mobile-status" aria-hidden>
            <span className={`pill-dot dot-${job.status}`} />
            {label} · {duration(elapsed)} · {usd(cost)}
            {job.terminatedAt ? "" : " est."}
          </p>
          <p className="sr-only" aria-live="polite">
            {`Status: ${label}.`}
          </p>
          {stop.message ? (
            <p className="form-error train-toolbar-stop" role="alert">
              <Icon name="alert" size={18} />
              <span>{stop.message}</span>
            </p>
          ) : null}

          <section className="train-log-section" aria-labelledby="train-log-title">
            <div className="train-log-head">
              <h2 id="train-log-title">Event log</h2>
              <span className="muted small">Times in UTC</span>
            </div>
            {totalEvents > shown.length ? (
              <p className="muted small">
                Showing the last {shown.length} of {totalEvents} events.
              </p>
            ) : null}
            <EventLog events={shown} jobId={jobId} />
            {!settled ? (
              <p className="turn turn-working train-working">
                <span className="working-dot" aria-hidden />
                <span>{shuttingDown ? "Shutting down the GPU" : workingText(job.status, job.stopRequested)}</span>
                <span className="muted">{duration(elapsed)}</span>
              </p>
            ) : null}
            {conn === "error" && polling ? (
              <p className="muted small" role="status">
                Can&apos;t reach Muse Muse right now. Trying again every 5 seconds.
              </p>
            ) : null}
            {gaveUp && !jobSettled ? (
              <p className="muted small" role="status">
                The GPU hasn&apos;t been reported shut down yet. Reload to check again, or look in Lambda&apos;s dashboard.
              </p>
            ) : null}
          </section>

          {terminal ? <JobResult job={job} events={events} elapsedMs={elapsed} costUsd={cost} /> : null}
          <EvalResults state={evals} rows={rows} model={tunedModelName(job.recipe)} />
          <div ref={end} className="convo-end" />
        </div>
      </div>

      <JobPanel
        job={job}
        recipe={props.recipe}
        dataset={props.dataset ?? null}
        now={now}
        elapsedMs={elapsed}
        costUsd={cost}
        stop={stop}
        onStop={stopJob}
      />
    </div>
  );
}

/** The closing turn: the summary and metrics when it succeeded, the error when it failed, a note when stopped. */
function JobResult({
  job,
  events,
  elapsedMs,
  costUsd,
}: {
  job: TrainJobView;
  events: TrainEventView[];
  elapsedMs: number;
  costUsd: number;
}) {
  const meta = [
    job.launchedAt ? `${duration(elapsedMs)} on the GPU` : "Never launched",
    `${usd(costUsd)}${job.terminatedAt ? "" : " est."}`,
  ].join(" · ");

  if (job.status === "succeeded") {
    const metrics = doneMetrics(events);
    return (
      <section className="turn turn-ok" aria-labelledby="train-result">
        <h2 className="turn-head" id="train-result">
          <span className="turn-icon" aria-hidden>
            <Icon name="check" size={18} />
          </span>
          Finished
        </h2>
        <div className="turn-body">
          <p>{job.summary ?? "The recipe finished."}</p>
          {metrics.length ? (
            <div className="table-wrap">
              <table className="data">
                <caption className="sr-only">Metrics the recipe reported</caption>
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td className="train-metric">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        <p className="turn-meta">{meta}</p>
      </section>
    );
  }

  const failed = job.status === "failed";
  return (
    <section className={`turn ${failed ? "turn-bad" : "turn-warn"}`} aria-labelledby="train-result">
      <h2 className="turn-head" id="train-result">
        <span className="turn-icon" aria-hidden>
          <Icon name={failed ? "alert" : "power"} size={18} />
        </span>
        {failed ? "Failed" : "Stopped"}
      </h2>
      <div className="turn-body">
        {failed ? (
          <>
            <div className="callout callout-bad" role="note">
              <Icon name="alert" size={18} />
              <p>{errorHeadline(job.error) || "The job failed without saying why. The log above has the details."}</p>
            </div>
            {job.error && job.error.includes("\n") ? <pre className="pre train-pre">{job.error}</pre> : null}
          </>
        ) : (
          <p>{job.error ?? "An admin stopped this job, and its GPU was shut down."}</p>
        )}
      </div>
      <p className="turn-meta">{meta}</p>
    </section>
  );
}

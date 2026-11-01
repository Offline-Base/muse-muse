"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusPill } from "@/components/ui";
import { SIMULATED_BODY, type LoopView, type StageStatus } from "@/lib/board-loop/logic";

const STAGE_TEXT: Record<StageStatus, string> = { waiting: "Waiting", running: "Running", done: "Done", failed: "Failed", skipped: "Skipped" };
const STAGE_TONE: Record<StageStatus, string> = { waiting: "disabled", running: "building", done: "live", failed: "failed", skipped: "partial" };
const POLL_MS = 3_000;

const money = (usd: number | null) => (usd === null ? "not recorded" : `$${usd.toFixed(2)}`);
const ended = (status: LoopView["status"]) => status === "failed" || status === "stopped";

/** The loop's own page: each stage with its status and cost, the test record, the clip and the way to the try page. */
export function BoardLoopRoom({ initial }: { initial: LoopView }) {
  const [view, setView] = useState(initial);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (ended(view.status)) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/board-loop/${view.id}`, { cache: "no-store" }).catch(() => null);
      if (res?.ok) setView((await res.json()) as LoopView);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [view.id, view.status]);

  const stop = async () => {
    setStopping(true);
    await fetch(`/api/board-loop/${view.id}/stop`, { method: "POST" }).catch(() => null);
  };

  return (
    <div className="board-loop">
      <p className={view.simulated ? "board-banner board-banner-sim" : "board-banner"}>
        <strong>{view.label}.</strong> {view.simulated ? SIMULATED_BODY : "These are this board's own numbers."}
      </p>

      <section className="card section-card" aria-labelledby="board-stages">
        <h2 id="board-stages">Stages</h2>
        <ol className="board-stages">
          {view.stages.map((s) => (
            <li key={s.id}>
              <span className="board-stage-name">{s.label}</span>
              <StatusPill status={STAGE_TONE[s.status]} label={STAGE_TEXT[s.status]} />
              <span className="board-stage-cost">{s.status === "waiting" ? "" : money(s.costUsd)}</span>
              {s.detail ? <p className="board-stage-detail">{s.detail}</p> : null}
            </li>
          ))}
        </ol>
        <p className="board-total">Recorded spend: {money(view.totalCostUsd)}</p>
        {!ended(view.status) ? (
          <button type="button" className="btn btn-outline btn-sm" onClick={stop} disabled={stopping || view.stopRequested}>
            {stopping || view.stopRequested ? "Stopping" : "Stop the loop"}
          </button>
        ) : null}
      </section>

      {view.test.runs.length ? (
        <section className="card section-card" aria-labelledby="board-test">
          <h2 id="board-test">Fixed test set</h2>
          <p>
            Mean {view.test.tokensPerSecond ?? "unknown"} tokens a second. Peak memory{" "}
            {view.test.peakMemMb === null ? "not reported" : `${view.test.peakMemMb} MB${view.simulated ? ", the small process's own and not a board's" : ` of ${view.test.memTotalMb ?? "unknown"} MB`}`}.
            {view.simulated ? null : ` Peak temperature ${view.test.peakTempC === null ? "not reported" : `${view.test.peakTempC} C`}.`}
          </p>
          <div className="board-table-wrap">
            <table className="board-table">
              <thead>
                <tr>
                  <th scope="col">Prompt</th>
                  <th scope="col">Answer</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Tokens/s</th>
                </tr>
              </thead>
              <tbody>
                {view.test.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.prompt}</td>
                    <td>{r.error ?? r.answer}</td>
                    <td>{r.tokens}</td>
                    <td>{r.tokensPerSecond}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {view.clip ? (
        <section className="card section-card" aria-labelledby="board-clip">
          <h2 id="board-clip">Demo clip</h2>
          <video controls preload="metadata" poster={view.clip.posterUrl ?? undefined} src={view.clip.videoUrl} className="board-video" />
          <p>{view.clip.captioned}</p>
        </section>
      ) : null}

      {view.tryOpen ? (
        <section className="card section-card" aria-labelledby="board-try">
          <h2 id="board-try">Let someone try it</h2>
          <p>{view.simulated ? "The page is labeled simulated, and answers with canned text." : "A real board answers, one person at a time."}</p>
          <Link className="btn btn-primary btn-sm" href={`/try-board/${view.id}`}>
            Open the try page
          </Link>
        </section>
      ) : null}
    </div>
  );
}

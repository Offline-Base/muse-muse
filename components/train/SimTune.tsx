"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Icon } from "@/components/icons";
import { simTuneActive, type SimTuneRunView } from "@/lib/train/sim-tune";

const POLL_MS = 15_000;

/** Said beside every number, so nobody reads them as a phone's. */
export const SIM_TUNE_LABEL = "Android emulator, not a real phone. It runs on a Mac in the device lab, so these numbers don't predict a phone's.";

const gbOf = (kb: number) => `${(kb / 1024 ** 2).toFixed(1)} GB`;

function statusLine(run: SimTuneRunView): string {
  if (run.status === "queued") return "Waiting for the device lab.";
  if (run.status === "claimed") return "Running on the emulator.";
  if (run.status === "expired") return "The device lab was busy, so this run didn't happen.";
  if (run.status === "canceled") return "This run was stopped.";
  if (run.labError) return run.summary ?? "The lab couldn't run this, so it says nothing about the model.";
  return run.summary ?? "Finished.";
}

/** One run's results. Exported so a test can render it without the fetches. */
export function SimTuneResults({ run }: { run: SimTuneRunView }) {
  const measured = run.loadMs !== null || run.answers.length > 0;
  return (
    <>
      <p aria-live="polite">{statusLine(run)}</p>
      {run.reasons.map((reason) => (
        <p key={reason} className="muted small">
          {reason}
        </p>
      ))}
      {measured ? (
        <>
          <p className="muted small">
            <strong>{SIM_TUNE_LABEL}</strong>
          </p>
          <dl className="kv">
            {run.device ? (
              <div>
                <dt>Emulator</dt>
                <dd>{run.device}</dd>
              </div>
            ) : null}
            {run.file ? (
              <div>
                <dt>File</dt>
                <dd>
                  <code>{run.file.name}</code>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Tokens per second</dt>
              <dd>{run.tokensPerSecond === null ? "None generated" : run.tokensPerSecond.toFixed(1)}</dd>
            </div>
            {run.loadMs !== null ? (
              <div>
                <dt>Load time</dt>
                <dd>{(run.loadMs / 1000).toFixed(1)} s</dd>
              </div>
            ) : null}
            {run.peakMemoryKb !== null ? (
              <div>
                <dt>Peak memory</dt>
                <dd>
                  {gbOf(run.peakMemoryKb)}
                  {run.totalMemoryKb !== null ? ` of ${gbOf(run.totalMemoryKb)}` : ""}
                </dd>
              </div>
            ) : null}
          </dl>
          {run.stoppedEarly ? <p className="muted small">The run hit its time limit before every prompt was sent.</p> : null}
          {run.answers.map((a) => (
            <details key={a.id}>
              <summary>{a.prompt}</summary>
              {a.error ? <p className="muted small">{a.error}</p> : null}
              <p>{a.answer || "No final answer."}</p>
              <p className="muted small">
                {a.tokens} tokens at {a.tokensPerSecond.toFixed(1)} per second
              </p>
            </details>
          ))}
        </>
      ) : null}
    </>
  );
}

/**
 * Run on an emulator, on an admin's page of a tuned model (docs/TRAINING.md "Emulator runs"). With SIM_TUNE off its route
 * is a 404, and the card draws nothing.
 */
export function SimTuneCard({ jobId }: { jobId: string }) {
  const id = useId();
  const [state, setState] = useState<{ problem: string | null; runs: SimTuneRunView[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/train/jobs/${jobId}/sim-tune`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) setState((await res.json()) as { problem: string | null; runs: SimTuneRunView[] });
  }, [jobId]);

  const latest = state?.runs[0] ?? null;
  const active = latest ? simTuneActive(latest.status) : false;

  useEffect(() => {
    let live = true;
    void (async () => {
      if (live) await load();
    })();
    return () => {
      live = false;
    };
  }, [load]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  if (!state) return null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/train/jobs/${jobId}/sim-tune`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) setError(data.message ?? "Couldn't start the run. Try again.");
      await load();
    } catch {
      setError("Couldn't reach Muse Muse. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card section-card lab-try" id="emulator-run" aria-labelledby={`${id}-title`}>
      <div className="lab-try-head">
        <h2 id={`${id}-title`}>Run on an emulator</h2>
      </div>
      <p className="lab-try-lead">Loads this model&apos;s smallest local file on the device lab&apos;s Android emulator and sends it a fixed set of prompts.</p>
      {state.problem ? <p className="muted small">{state.problem}</p> : null}
      {latest ? <SimTuneResults run={latest} /> : null}
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="row-actions">
        <button type="button" className="btn btn-outline" disabled={busy || active || Boolean(state.problem)} onClick={() => void start()}>
          {busy ? "Starting" : latest ? "Run again" : "Run on the emulator"}
        </button>
      </div>
    </section>
  );
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { WHY_MAX, errorCode, hubControl, hubHref, hubPill, hubStatusText, hubViewOf, publishErrorText } from "@/components/train/format";
import { ExternalLink } from "@/components/ui";
import { groupThousands } from "@/lib/format";
import type { HubView, TrainJobView } from "@/lib/train/types";

export interface HubCardProps {
  job: TrainJobView;
  /** Why publishing to the Hub is off on this deployment (env.hubOffReason), or null. */
  offReason: string | null;
  /** TRAIN_MAX_ACTIVE and TRAIN_DAILY_USD, for the sentences when the upload job can't start. */
  maxActive: number;
  dailyUsd: number;
}

/**
 * GET /api/train/jobs/{id}/publish this often while something moves, for at most POLL_FOR_MS, and for KICK_MS after a
 * press whatever the state says, since the workflow takes its claim a moment after the route answered.
 */
const POLL_MS = 5_000;
const POLL_FOR_MS = 30 * 60_000;
const KICK_MS = 60_000;

/** True while publishing moves on its own: the GPU uploads, an upload job runs, or the platform commits. */
function moving(hub: HubView | null): boolean {
  return Boolean(hub && (hub.status === "uploading" || (hub.status === "publishing" && !hub.stale) || (hub.status === "waiting" && hub.publishJobId)));
}

/**
 * The job page's Hugging Face card (docs/TRAINING.md "Hugging Face Hub"), for a Muse Glimmer LoRA job: where
 * publishing stands, the model and dataset repos once they exist, the why that leads the model card, and Publish,
 * Retry or Publish again. It polls the publish route while the GPU uploads or the platform publishes.
 */
export function HubCard({ job, offReason, maxActive, dailyUsd }: HubCardProps) {
  const id = useId();
  const [hub, setHub] = useState<HubView | null>(job.hub ?? null);
  // The why the card prints now: the hub view's (saved with Publish, else the job's param), or the param before any.
  const savedWhy = hub ? (hub.why ?? "") : typeof job.params?.why === "string" ? job.params.why : "";
  const [why, setWhy] = useState(savedWhy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(() => (moving(job.hub ?? null) ? Date.now() + POLL_FOR_MS : 0));
  const [kickUntil, setKickUntil] = useState(0);

  // The job page polls the job while it settles, and its hub view comes with it.
  useEffect(() => {
    if (job.hub) setHub(job.hub);
  }, [job.hub]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/train/jobs/${job.id}/publish`, { cache: "no-store" });
      if (!res.ok) return;
      const next = hubViewOf(await res.json());
      if (next) setHub(next);
    } catch {
      // The next poll tries again.
    }
  }, [job.id]);

  const polling = pollUntil > 0 && (moving(hub) || kickUntil > 0);
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      const now = Date.now();
      if (now > pollUntil) {
        setPollUntil(0);
        return;
      }
      if (kickUntil && now > kickUntil) setKickUntil(0);
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [polling, pollUntil, kickUntil, refresh]);

  const view = { ...job, hub };
  const control = hubControl(view, offReason);
  const status = hub?.status ?? null;
  const pill = hubPill(hub, offReason);
  const modelHref = hubHref(hub?.modelUrl);
  const datasetHref = hubHref(hub?.datasetUrl);

  async function publish(e: FormEvent) {
    e.preventDefault();
    if (!control || busy) return;
    if (why.length > WHY_MAX) {
      setError(`Keep the why to ${groupThousands(WHY_MAX)} characters.`);
      return;
    }
    if (!window.confirm(control.confirm)) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/train/jobs/${job.id}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ why: why.trim() }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(publishErrorText(res.status, data, { maxActive, dailyUsd }));
        if (errorCode(data) === "publishing" || errorCode(data) === "upload_running") void refresh();
        return;
      }
      const next = hubViewOf(data);
      const started = (data as { started?: unknown }).started;
      setHub(next ? (started === "publish" ? { ...next, status: "publishing", stale: false } : next) : hub);
      setNote(
        started === "upload"
          ? "A short GPU job is uploading the adapter's files from the model cache. It publishes once that job succeeds."
          : "Publishing: the cards are written and both repos committed, then checked. This card updates when it is done.",
      );
      setPollUntil(Date.now() + POLL_FOR_MS);
      setKickUntil(Date.now() + KICK_MS);
    } catch {
      setError("Couldn't reach Muse Muse. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card section-card lab-try" id="hugging-face" aria-labelledby={`${id}-title`}>
      <div className="lab-try-head">
        <h2 id={`${id}-title`}>Hugging Face</h2>
        <span className={`pill pill-${pill.tone}`}>
          <span className="pill-dot" aria-hidden />
          {pill.label}
        </span>
      </div>
      <p className="lab-try-lead" aria-live="polite">
        {hubStatusText(view, offReason)}
      </p>

      {hub?.modelRepo || hub?.datasetRepo ? (
        <dl className="kv">
          {hub.modelRepo ? (
            <div>
              <dt>Model</dt>
              <dd>{modelHref ? <ExternalLink href={modelHref}>{hub.modelRepo}</ExternalLink> : <code>{hub.modelRepo}</code>}</dd>
            </div>
          ) : null}
          {hub.datasetRepo ? (
            <div>
              <dt>Dataset</dt>
              <dd>{datasetHref ? <ExternalLink href={datasetHref}>{hub.datasetRepo}</ExternalLink> : <code>{hub.datasetRepo}</code>}</dd>
            </div>
          ) : null}
          {hub.storyBy ? (
            <div>
              <dt>Story</dt>
              <dd>{hub.storyBy === "spark" ? "Written by Muse Spark 1.3" : "From the template"}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {hub?.publishJobId && status === "waiting" ? (
        <p className="muted small">
          <Link href={`/fine-tuning/${hub.publishJobId}`}>Open the upload job</Link> for its GPU, log and Stop.
        </p>
      ) : null}

      {control ? (
        <form className="lab-try-form" onSubmit={publish} noValidate>
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-why`}>
              Why this model <span className="muted">(optional)</span>
            </label>
            <textarea
              id={`${id}-why`}
              className="train-input train-textarea"
              value={why}
              rows={3}
              maxLength={WHY_MAX}
              placeholder="In your own words: why it was made. It opens the model card's story, and Muse Spark 1.3 writes the rest from the records."
              onChange={(e) => setWhy(e.target.value)}
              disabled={busy}
              aria-describedby={`${id}-why-help`}
            />
            <p className="train-help train-help-row" id={`${id}-why-help`}>
              <span>Every number on the cards comes from this job&apos;s records.</span>
              <span className="train-count">
                {groupThousands(why.length)} / {groupThousands(WHY_MAX)}
              </span>
            </p>
          </div>
          <div className="lab-try-foot">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <span className="spinner" aria-hidden /> : <Icon name="arrowUp" size={16} />}
              <span>{busy ? "Starting" : control.label}</span>
            </button>
          </div>
        </form>
      ) : savedWhy ? (
        <div className="train-msg">
          <h3 className="train-role">Why this model</h3>
          <p className="train-text">{savedWhy}</p>
        </div>
      ) : null}

      {note ? (
        <p className="muted small" role="status">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
    </section>
  );
}

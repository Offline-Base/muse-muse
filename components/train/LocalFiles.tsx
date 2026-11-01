"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { Icon } from "@/components/icons";
import {
  buildSize,
  doneMetricsOf,
  errorCode,
  ggufControl,
  ggufStatusText,
  hubHref,
  hubPill,
  hubViewOf,
  makeFilesBlock,
  makeFilesCostText,
  makeFilesPill,
  makeFilesPublishing,
  makeFilesText,
  publishErrorText,
  quantAgreementText,
  quantChannelText,
  quantLowBitText,
  quantRows,
  quantRowText,
  quantStateOf,
  startErrorText,
  type QuantState,
} from "@/components/train/format";
import { ExternalLink } from "@/components/ui";
import { BUILT_WITH_SPARK_OPEN } from "@/lib/train/base";
import { DEVICE_TARGET_KINDS, deviceModelTarget, fileForDevice } from "@/lib/train/quant-targets";
import type { HubView, TrainEventView, TrainJobView } from "@/lib/train/types";

/** How often the cards look again while something moves, and for how long at most. */
const POLL_MS = 10_000;
const POLL_FOR_MS = 30 * 60_000;

export interface MakeLocalFilesProps {
  /** The glimmer-lora job whose adapter the files are made from. */
  jobId: string;
  /** TRAIN_MAX_ACTIVE and TRAIN_DAILY_USD, for the sentences when the job can't start. */
  maxActive: number;
  dailyUsd: number;
}

/**
 * Make local files, on an admin's page of a judged glimmer-lora job (docs/TRAINING.md "Local files"): whether this
 * adapter's GGUF files exist and where, the job making them, or why they can't be made here now, and the button that
 * starts a glimmer-quantize job for it (POST /api/train/jobs/{id}/quantize), which confirms first. It reads
 * GET /api/train/jobs/{id}/quantize when it opens, and again every 10 s while a job makes the files.
 */
export function MakeLocalFiles({ jobId, maxActive, dailyUsd }: MakeLocalFilesProps) {
  const id = useId();
  const [state, setState] = useState<QuantState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/train/jobs/${jobId}/quantize`, { cache: "no-store" });
      const next = res.ok ? quantStateOf(await res.json()) : null;
      if (!next) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      setState(next);
    } catch {
      setLoadError(true);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = Boolean(state?.latest && !["succeeded", "failed", "stopped"].includes(state.latest.status));
  useEffect(() => {
    if (!running && !pollUntil) return;
    const until = pollUntil || Date.now() + POLL_FOR_MS;
    const t = setInterval(() => {
      if (Date.now() > until) {
        setPollUntil(0);
        return;
      }
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [running, pollUntil, load]);

  const block = makeFilesBlock(state);
  const pill = makeFilesPill(state);
  const files = state?.files ?? null;
  const repoHref = files?.repo ? hubHref(`https://huggingface.co/${files.repo}`) : null;
  const again = Boolean(files || state?.latest);
  // Files already published or publishing make "again" a paid re-run, so it is the quiet button, and none while they publish.
  const publishingNow = makeFilesPublishing(state);

  async function make() {
    if (block || busy || publishingNow) return;
    const ask = `${again ? "Make this adapter's local files again?" : "Make this adapter's local files?"} A GPU on Lambda merges it into the 16-bit base, makes the GGUF builds, checks them and publishes the ones that pass to their own repo on Hugging Face, public when the adapter is: ${makeFilesCostText(state)}, under the usual limits.`;
    if (!window.confirm(ask)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/train/jobs/${jobId}/quantize`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(startErrorText(res.status, data, { maxActive, dailyUsd }));
        if (errorCode(data) === "quant_running") void load();
        return;
      }
      const quantJobId = (data as { quantJobId?: unknown }).quantJobId;
      setStarted(typeof quantJobId === "string" ? quantJobId : null);
      setPollUntil(Date.now() + POLL_FOR_MS);
      void load();
    } catch {
      setError("Couldn't reach Muse Muse. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card section-card lab-try" id="local-files" aria-labelledby={`${id}-title`}>
      <div className="lab-try-head">
        <h2 id={`${id}-title`}>Local files</h2>
        <span className={`pill pill-${pill.tone}`}>
          <span className="pill-dot" aria-hidden />
          {pill.label}
        </span>
      </div>
      <p className="lab-try-lead" aria-live="polite">
        {state ? makeFilesText(state) : loadError ? "Couldn't check this adapter's local files. Reload to try again." : "Checking this adapter's local files."}
      </p>

      {files ? (
        <dl className="kv">
          {files.repo ? (
            <div>
              <dt>Repo</dt>
              <dd>{repoHref ? <ExternalLink href={repoHref}>{files.repo}</ExternalLink> : <code>{files.repo}</code>}</dd>
            </div>
          ) : null}
          {files.files.map((f) => (
            <div key={f.level}>
              <dt>{f.level}</dt>
              <dd>
                <code>{f.name}</code> · {buildSize(f.bytes)}
              </dd>
            </div>
          ))}
          {files.needsTunedTemplate ? (
            <div>
              <dt>Template</dt>
              <dd>Stock apps need the repo&apos;s tuned.jinja: this adapter was trained before trainChannel.</dd>
            </div>
          ) : null}
          {files.sparkOpen ? (
            <div>
              <dt>License</dt>
              <dd>
                <strong>{BUILT_WITH_SPARK_OPEN}.</strong> Merged into the 2026 Glimmer, so the repo and every drive of these
                files ship MUSE_MODEL_LICENSE.md, USAGE_POLICY.md and NOTICE beside LICENSE.
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {state?.targets ? (
        <div>
          <h3>Which device gets which file</h3>
          <dl className="kv">
            {DEVICE_TARGET_KINDS.map(({ kind, label }) => {
              const target = deviceModelTarget(kind);
              const file = fileForDevice(kind, files);
              return (
                <div key={kind}>
                  <dt>{label}</dt>
                  <dd>
                    {target.label}, {target.level}: {file ? <code>{file.name}</code> : "this adapter hasn't made that file"}. {target.fit}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      ) : null}
      {state?.latest ? (
        <p className="muted small">
          <Link href={`/fine-tuning/${state.latest.id}`}>Open the {running ? "job making them" : "last local files job"}</Link> for its GPU, log
          and checks.
        </p>
      ) : null}
      {files?.repo ? (
        <p className="muted small">
          <Link href={`/fine-tuning/${jobId}/run`}>Try the run-locally page</Link>
          {files.public ? "" : ": admins see its guide while the repo is private, which is the way to test it"}.
        </p>
      ) : null}

      {/* Nothing to press while it is off here, the adapter can't have files, or they are publishing: the sentence above says why. */}
      {state && !running && !block && !publishingNow ? (
        <>
          <div className="lab-try-foot">
            <button type="button" className={`btn ${again ? "btn-outline" : "btn-primary"}`} onClick={make} disabled={busy} aria-describedby={`${id}-note`}>
              {busy ? <span className="spinner" aria-hidden /> : <Icon name="plus" size={16} />}
              <span>{busy ? "Starting" : again ? "Make local files again" : "Make local files"}</span>
            </button>
          </div>
          <p className="muted small" id={`${id}-note`}>
            {`${makeFilesCostText(state)[0]!.toUpperCase()}${makeFilesCostText(state).slice(1)}.`}
          </p>
        </>
      ) : null}

      {started ? (
        <p className="muted small" role="status">
          Started: <Link href={`/fine-tuning/${started}`}>the local files job</Link>. Its card publishes the builds that pass once it succeeds.
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

export interface QuantFilesCardProps {
  job: TrainJobView;
  /** The job's log as the page has it: the card reads the files' checks from its "done" event. */
  events: TrainEventView[];
}

/** True while the platform publishes the GGUF repo on its own. */
function publishing(hub: HubView | null): boolean {
  return Boolean(hub && hub.status === "publishing" && !hub.stale);
}

/**
 * A glimmer-quantize job's own card (docs/TRAINING.md "Local files"): each build with its size, how close it measured
 * to the merged model's Q8_0 against its limit, and whether it passed; the channel check and the agreement; where the
 * GGUF repo stands, with its link once published; and Publish, Retry or Publish again, which confirm first and POST
 * /api/train/jobs/{id}/publish. It looks again every 10 s while the platform publishes.
 */
export function QuantFilesCard({ job, events }: QuantFilesCardProps) {
  const id = useId();
  const [hub, setHub] = useState<HubView | null>(job.hub ?? null);
  const [offReason, setOffReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(() => (publishing(job.hub ?? null) ? Date.now() + POLL_FOR_MS : 0));

  // The job page polls the job while it settles, and its hub view comes with it.
  useEffect(() => {
    if (job.hub) setHub(job.hub);
  }, [job.hub]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/train/jobs/${job.id}/publish`, { cache: "no-store" });
      if (!res.ok) return;
      const data: unknown = await res.json();
      const next = hubViewOf(data);
      if (next) setHub(next);
      const off = (data as { offReason?: unknown }).offReason;
      setOffReason(typeof off === "string" && off ? off : null);
    } catch {
      // The next look tries again.
    }
  }, [job.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pollUntil) return;
    const t = setInterval(() => {
      if (Date.now() > pollUntil) {
        setPollUntil(0);
        return;
      }
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [pollUntil, refresh]);

  const metrics = doneMetricsOf(events);
  const rows = quantRows(job.params, metrics);
  const adapterJobId = typeof job.params?.adapterJobId === "string" && /^[0-9a-f-]{36}$/i.test(job.params.adapterJobId) ? job.params.adapterJobId : null;
  const view = { ...job, hub };
  const control = ggufControl(view, offReason);
  const pill = hubPill(hub, offReason);
  const repoHref = hubHref(hub?.modelUrl);
  const channel = quantChannelText(metrics);
  const agreement = quantAgreementText(metrics);
  const lowBit = quantLowBitText(metrics);

  async function publish() {
    if (!control || busy || !window.confirm(control.confirm)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/train/jobs/${job.id}/publish`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(publishErrorText(res.status, data, { maxActive: 1, dailyUsd: 0 }));
        if (errorCode(data) === "publishing") void refresh();
        return;
      }
      const next = hubViewOf(data);
      setHub(next ? { ...next, status: "publishing", stale: false } : hub);
      setPollUntil(Date.now() + POLL_FOR_MS);
    } catch {
      setError("Couldn't reach Muse Muse. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card section-card lab-try" id="local-files" aria-labelledby={`${id}-title`}>
      <div className="lab-try-head">
        <h2 id={`${id}-title`}>Local files</h2>
        <span className={`pill pill-${pill.tone}`}>
          <span className="pill-dot" aria-hidden />
          {pill.label}
        </span>
      </div>
      <p className="lab-try-lead" aria-live="polite">
        {ggufStatusText(view, offReason)}
      </p>
      {adapterJobId && ["failed", "stopped"].includes(job.status) ? (
        <p className="muted small">
          <Link href={`/fine-tuning/${adapterJobId}#local-files`}>Make local files again from the adapter&apos;s page</Link>.
        </p>
      ) : null}

      {rows.length || hub?.modelRepo ? (
        <dl className="kv">
          {hub?.modelRepo ? (
            <div>
              <dt>GGUF repo</dt>
              <dd>{repoHref ? <ExternalLink href={repoHref}>{hub.modelRepo}</ExternalLink> : <code>{hub.modelRepo}</code>}</dd>
            </div>
          ) : null}
          {rows.map((r) => (
            <div key={r.level}>
              <dt>{r.level}</dt>
              <dd>{quantRowText(r)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {channel ? <p className="muted small">{channel}</p> : null}
      {agreement ? <p className="muted small">{agreement}</p> : null}
      {lowBit ? <p className="muted small">{lowBit}</p> : null}

      {control ? (
        <div className="lab-try-foot">
          <button type="button" className="btn btn-primary" onClick={publish} disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="arrowUp" size={16} />}
            <span>{busy ? "Starting" : control.label}</span>
          </button>
        </div>
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

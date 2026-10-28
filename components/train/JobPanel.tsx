"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Icon } from "@/components/icons";
import { TrainStatusPill } from "@/components/train/TrainStatusPill";
import {
  artifactHref,
  gpuName,
  pricePerHour,
  progressText,
  servingText,
  stopControl,
  trainStatusLabel,
} from "@/components/train/format";
import { bytes, dateTimeUtc, duration, relativeTime, usd } from "@/lib/format";
import { isServeRecipe, unjudgedNote } from "@/lib/train/logic";
import { isTrainTerminal, type RecipeView, type TrainJobView } from "@/lib/train/types";

export interface JobPanelProps {
  job: TrainJobView;
  recipe: RecipeView | null;
  /** The dataset the job trains on, shown by name with a link in Settings. */
  dataset?: { id: string; title: string } | null;
  /** A glimmer-serve job's adapter: the trained job it serves, shown by name with a link in Settings and Live demo. */
  adapter?: { id: string; title: string } | null;
  now: number;
  elapsedMs: number;
  costUsd: number;
  stop: { busy: boolean; message: string | null };
  onStop: () => void;
}

/** A meter row like the build panel's fix rounds: label, a number box, and the bar underneath. */
function MeterField({ label, value, fraction }: { label: string; value: string; fraction: number }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    <div className="pfield">
      <div className="pfield-row">
        <span className="panel-label">{label}</span>
        <span className="numbox">{value}</span>
      </div>
      <span className="meter" aria-hidden>
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

/**
 * The job page's right panel: status, Stop, a glimmer-serve job's live demo, recipe and GPU, progress, limits, run facts
 * and artifacts.
 */
export function JobPanel({ job, recipe, dataset = null, adapter = null, now, elapsedMs, costUsd, stop, onStop }: JobPanelProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const label = trainStatusLabel(job.status, job.stopRequested);
  const final = Boolean(job.terminatedAt);
  const p = job.progress;
  const total = typeof p?.totalSteps === "number" && p.totalSteps > 0 ? p.totalSteps : null;
  const step = typeof p?.step === "number" ? p.step : null;
  const params = Object.entries(job.params ?? {});
  const control = stopControl(job);

  return (
    <aside className="panel" aria-label="Job details">
      <button
        type="button"
        className="panel-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="panel-toggle-text">
          <strong>Job details</strong>
          <span className="muted">
            {label} · {duration(elapsedMs)} · {usd(costUsd)}
            {final ? "" : " est."}
          </span>
        </span>
        <Icon name="chevronDown" className="panel-chevron" />
      </button>

      <div className="panel-body" id={bodyId} data-open={open}>
        <div className="panel-head">
          <h2>{job.title}</h2>
          <TrainStatusPill status={job.status} stopRequested={job.stopRequested} />
        </div>

        {control ? (
          <div className="pfield">
            <button
              type="button"
              className="btn btn-block train-stop"
              onClick={onStop}
              disabled={stop.busy}
              aria-describedby={`${bodyId}-stop-note`}
            >
              <Icon name="power" size={18} />
              <span>{stop.busy ? "Stopping" : control.label}</span>
            </button>
            <p className={`panel-note${stop.message ? " error-text" : ""}`} id={`${bodyId}-stop-note`} aria-live="polite">
              {stop.message ?? control.note}
            </p>
          </div>
        ) : null}

        {isServeRecipe(job.recipe) ? (
          <section className="panel-section" aria-labelledby={`${bodyId}-serving`}>
            <h3 className="panel-label" id={`${bodyId}-serving`}>
              Live demo
            </h3>
            <p className="panel-note">{servingText(job, now)}</p>
            {adapter && !isTrainTerminal(job.status) ? (
              <p className="panel-note">
                The Try it live box is on <Link href={`/fine-tuning/${adapter.id}`}>{adapter.title}</Link>&apos;s page.
              </p>
            ) : null}
          </section>
        ) : null}

        <div className="pfield">
          <span className="panel-label">Recipe</span>
          <div className="pbox pbox-off" aria-disabled="true">
            <span>{recipe?.title ?? job.recipe}</span>
            <Icon name="chevronDown" size={18} />
          </div>
        </div>

        <div className="pfield">
          <span className="panel-label">GPU</span>
          <div className="pbox pbox-off" aria-disabled="true">
            <span>{gpuName(recipe, job.instanceType)}</span>
            <Icon name="chevronDown" size={18} />
          </div>
        </div>

        {p && total !== null ? (
          <div className="pfield">
            <MeterField
              label="Progress"
              value={`${step ?? 0} of ${total}`}
              fraction={(step ?? 0) / total}
            />
            {typeof p.loss === "number" || p.message ? (
              <p className="panel-note">{progressText({ loss: p.loss, message: p.message })}</p>
            ) : null}
          </div>
        ) : p ? (
          <div className="pfield-row">
            <span className="panel-label">Progress</span>
            <span className="muted train-panel-text">{progressText(p)}</span>
          </div>
        ) : null}

        <MeterField
          label="Time limit"
          value={`${Math.floor(elapsedMs / 60_000)} of ${job.maxMinutes} min`}
          fraction={job.launchedAt ? elapsedMs / (job.maxMinutes * 60_000) : 0}
        />
        <MeterField
          label="Dollar limit"
          value={`${usd(costUsd)} of ${usd(job.maxUsd)}`}
          fraction={job.maxUsd > 0 ? costUsd / job.maxUsd : 0}
        />

        <dl className="kv">
          <div>
            <dt>Cost</dt>
            <dd>
              {usd(costUsd)}
              {final ? "" : " est."}
            </dd>
          </div>
          <div>
            <dt>GPU time</dt>
            <dd>{job.launchedAt ? duration(elapsedMs) : "Not launched"}</dd>
          </div>
          <div>
            <dt>Price</dt>
            <dd>{pricePerHour(job.priceCentsPerHour)}</dd>
          </div>
          <div>
            <dt>Region</dt>
            <dd>{job.region || "Not chosen"}</dd>
          </div>
          <div>
            <dt>IP</dt>
            <dd>{job.instanceIp ?? "Not yet"}</dd>
          </div>
          <div>
            <dt>Last heartbeat</dt>
            <dd>
              {job.lastHeartbeatAt ? (
                <time dateTime={job.lastHeartbeatAt} title={dateTimeUtc(job.lastHeartbeatAt)}>
                  {relativeTime(job.lastHeartbeatAt, now)}
                </time>
              ) : (
                "None yet"
              )}
            </dd>
          </div>
          <div>
            <dt>Launched</dt>
            <dd>{job.launchedAt ? dateTimeUtc(job.launchedAt) : "Not yet"}</dd>
          </div>
          {job.terminatedAt || job.finishedAt ? (
            <div>
              <dt>{job.terminatedAt ? "Shut down" : "Ended"}</dt>
              <dd>{dateTimeUtc((job.terminatedAt ?? job.finishedAt) as string)}</dd>
            </div>
          ) : null}
          {job.evalSummary ? (
            <div>
              <dt>Eval</dt>
              <dd>
                <a href="#eval-results">
                  {unjudgedNote(job.evalSummary) === null
                    ? `Tuned won ${job.evalSummary.tunedWins} of ${job.evalSummary.items}`
                    : "Not judged"}
                </a>
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="pfield-row">
          <span className="panel-label">
            Instance
            {job.instanceId ? (
              <code className="pfield-code" title={job.instanceId}>
                {job.instanceId.slice(0, 8)}
              </code>
            ) : null}
          </span>
          {job.instanceId ? (
            <CopyButton value={job.instanceId} label="Copy the Lambda instance id" className="round-btn" />
          ) : (
            <span className="muted">Not launched</span>
          )}
        </div>

        {params.length ? (
          <section className="panel-section" aria-labelledby={`${bodyId}-params`}>
            <h3 className="panel-label" id={`${bodyId}-params`}>
              Settings
            </h3>
            <dl className="kv">
              {params.map(([k, v]) => {
                const field = recipe?.params.find((f) => f.key === k);
                const isDataset = field?.kind === "dataset";
                const isAdapter = field?.kind === "adapter";
                return (
                  <div key={k}>
                    <dt>{field?.label ?? k}</dt>
                    <dd>
                      {isDataset && dataset && dataset.id === String(v) ? (
                        <Link href={`/fine-tuning/datasets/${dataset.id}`}>{dataset.title}</Link>
                      ) : isAdapter && adapter && adapter.id === String(v) ? (
                        <Link href={`/fine-tuning/${adapter.id}`}>{adapter.title}</Link>
                      ) : isDataset || isAdapter ? (
                        <code title={String(v)}>{String(v).slice(0, 8)}</code>
                      ) : (
                        String(v)
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>
        ) : null}

        <section className="panel-section" aria-labelledby={`${bodyId}-artifacts`}>
          <h3 className="panel-label" id={`${bodyId}-artifacts`}>
            Artifacts
          </h3>
          {job.artifacts.length ? (
            <ul className="train-artifacts">
              {job.artifacts.map((a, i) => {
                const href = artifactHref(a.url, job.id);
                return (
                  <li key={`${a.url}-${i}`}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="train-artifact-name">
                        {a.name}
                        <Icon name="external" size={14} className="ext-icon" />
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <span className="train-artifact-name">{a.name}</span>
                    )}
                    <span className="train-artifact-meta">
                      {a.kind} · {bytes(Math.max(0, Number(a.bytes) || 0))}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="panel-note">Files the job uploads, such as an adapter, show up here.</p>
          )}
        </section>
      </div>
    </aside>
  );
}

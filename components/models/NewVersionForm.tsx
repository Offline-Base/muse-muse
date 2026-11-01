"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { startErrorText } from "@/components/train/format";
import { usd } from "@/lib/format";
import type { NewVersionPlan } from "@/lib/train/versions";

export interface TunableField {
  key: string;
  label: string;
  min?: number;
  max?: number;
  value: number;
}

/**
 * The plan for a new version: the last version's settings, the few worth changing as fields, and what it costs. Only the
 * Start training button starts anything; the route checks every number and cap again.
 */
export function NewVersionForm({
  plan,
  tunable,
  limits,
  capUsd,
  capMinutes,
}: {
  plan: NewVersionPlan;
  tunable: TunableField[];
  limits: { maxActive: number; dailyUsd: number };
  capUsd: number;
  capMinutes: number;
}) {
  const id = useId();
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(tunable.map((f) => [f.key, String(f.value)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const params = { ...plan.params };
      for (const f of tunable) params[f.key] = Number(values[f.key]);
      const res = await fetch("/api/train/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipe: plan.recipe, title: plan.title, params, instanceType: plan.instanceType, maxMinutes: capMinutes, maxUsd: capUsd }),
      });
      const body: unknown = await res.json().catch(() => null);
      const jobId = (body as { job?: { id?: unknown } } | null)?.job?.id;
      if (res.ok && typeof jobId === "string") {
        router.push(`/fine-tuning/${jobId}`);
        return;
      }
      setError(startErrorText(res.status, body, limits));
    } catch {
      setError("That didn't reach the server. Nothing started. Try again.");
    }
    setBusy(false);
  }

  return (
    <section className="card train-new" aria-labelledby={`${id}-title`}>
      <div className="train-new-head">
        <h2 id={`${id}-title`}>Same examples, same settings</h2>
        <p>
          This trains a new adapter from the base model. It doesn&apos;t continue the last version. Training uses a fixed
          seed, so the same settings make a very similar model: change a number below to try something different. The
          examples are already written, so nothing pays to write them again.
        </p>
      </div>
      <form onSubmit={submit}>
        {tunable.map((f) => (
          <div className="train-field" key={f.key}>
            <label className="train-sublabel" htmlFor={`${id}-${f.key}`}>
              {f.label}
            </label>
            <input
              id={`${id}-${f.key}`}
              className="train-input"
              type="number"
              inputMode="decimal"
              min={f.min}
              max={f.max}
              step="any"
              required
              disabled={busy}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </div>
        ))}
        <div className="train-foot">
          <p className="train-cost" id={`${id}-cost`}>
            <strong>Up to {usd(capUsd)} of GPU</strong>, ending at {capMinutes} minutes at most, plus Meta&apos;s charge to
            judge it.
          </p>
          <Link href={`/models/${plan.fromJobId}`} className="btn">
            Back
          </Link>
          <button type="submit" className="btn btn-primary" disabled={busy} aria-describedby={`${id}-cost`}>
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="play" size={16} />}
            <span>{busy ? "Starting" : "Start training"}</span>
          </button>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </p>
        ) : null}
      </form>
    </section>
  );
}

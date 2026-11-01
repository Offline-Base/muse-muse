"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { DEFAULT_DATASET_COUNT } from "@/components/train/NewDatasetCard";
import { datasetCostRange, datasetCountOk } from "@/components/train/format";
import { ExternalLink } from "@/components/ui";
import { usd } from "@/lib/format";
import { DATASET_MAX_COUNT, DATASET_MIN_COUNT } from "@/lib/train/logic";
import type { ResearchSourceView, ResearchView } from "@/lib/train/research/view";

const WHY_HF = "Hugging Face's own license field is checked when you import.";

function errorText(data: { error?: unknown; message?: unknown; refusal?: unknown }): string {
  for (const v of [data.message, data.refusal, data.error]) if (typeof v === "string" && v) return v;
  return "That didn't work. Try again.";
}

function SourceCard({ source, picked, onPick, onImport, importing }: { source: ResearchSourceView; picked: boolean; onPick: (on: boolean) => void; onImport: () => void; importing: boolean }) {
  return (
    <li className="card research-source">
      <h3>
        <ExternalLink href={source.url}>{source.title}</ExternalLink>
      </h3>
      <p className="muted small">
        {source.kind} · {source.size} · license as stated: {source.license} · helps {source.helpfulness} of 5
      </p>
      <p>{source.holds}</p>
      <p>
        <strong>Why it helps:</strong> {source.whyItHelps}
      </p>
      <p>
        <strong>Risks:</strong> {source.risks}
      </p>
      {source.examples.length ? (
        <>
          <p>
            <strong>Questions it could teach:</strong>
          </p>
          <ul className="research-examples">
            {source.examples.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="research-source-foot">
        <label className="train-help">
          <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} /> Use as notes for the writer
        </label>
        {source.datasetId ? (
          <Link className="btn btn-outline" href={`/fine-tuning/datasets/${source.datasetId}`}>
            Open its dataset
          </Link>
        ) : source.importAs ? (
          <button type="button" className="btn btn-outline" onClick={onImport} disabled={importing}>
            {importing ? <span className="spinner" aria-hidden /> : <Icon name="plus" size={16} />}
            <span>{importing ? "Importing" : "Import its rows"}</span>
          </button>
        ) : (
          <span className="muted small">{source.readOnlyReason}</span>
        )}
      </div>
      {source.importAs === "hf" && !source.datasetId ? <p className="muted small">{WHY_HF}</p> : null}
    </li>
  );
}

/**
 * A research run's page. The admin reads the sources, picks some as notes for a new dataset's writer, or imports the
 * rows of one that may be imported. Each costs or saves only on its own click, and nothing here starts a training job.
 */
export function ResearchReport({ research }: { research: ResearchView }) {
  const router = useRouter();
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [count, setCount] = useState(String(DEFAULT_DATASET_COUNT));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function post(path: string, body: Record<string, unknown>): Promise<{ href: string; rows?: number; read?: number } | null> {
    setError(null);
    setDone(null);
    try {
      const res = await fetch(`/api/train/research/${research.id}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { href?: unknown; rows?: number; read?: number; error?: unknown; message?: unknown };
      if (typeof data.href === "string") return { href: data.href, rows: data.rows, read: data.read };
      setError(errorText(data));
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection and try again.");
    }
    return null;
  }

  async function importRows(s: ResearchSourceView) {
    const question =
      s.importAs === "file"
        ? `Import the rows of ${s.title}? The report says its license is ${s.license}, as a model read it. Press OK only if you read the license on its page and it allows this.`
        : `Import the rows of ${s.title}? They're scanned for personal data and saved as a dataset. Nothing trains.`;
    if (!window.confirm(question)) return;
    setBusy(s.id);
    const got = await post("import", { sourceId: s.id, licenseConfirmed: s.importAs === "file" });
    setBusy(null);
    if (got) {
      setDone(`Saved ${got.rows} of ${got.read} rows as a dataset. Nothing is training.`);
      router.refresh();
    }
  }

  async function writeDataset() {
    const n = Number(count);
    if (!datasetCountOk(n)) {
      setError(`Enter a whole number from ${DATASET_MIN_COUNT} to ${DATASET_MAX_COUNT}.`);
      return;
    }
    const { low, high } = datasetCostRange(n);
    if (!window.confirm(`Have Muse Wonder write ${n} examples with these notes? It costs about ${usd(low)} to ${usd(high)} on Meta's API. Nothing trains until you start a job.`)) return;
    setBusy("dataset");
    const got = await post("dataset", { picks: [...picks], count: n });
    if (got) router.push(got.href);
    else setBusy(null);
  }

  const pick = (id: string, on: boolean) =>
    setPicks((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="research-report">
      <section className="card">
        <h2>The task</h2>
        <p>{research.task}</p>
      </section>

      {research.status === "running" ? (
        <section className="card" role="status">
          <p>
            <span className="spinner" aria-hidden /> Searched {research.searched} of {research.questions.length || "a few"} questions. The report follows.
          </p>
          <ul className="research-examples">
            {research.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {research.status === "failed" ? (
        <div className="callout callout-bad" role="note">
          <Icon name="alert" size={18} />
          <p>{research.error ?? "It failed without saying why."}</p>
        </div>
      ) : null}
      {research.note ? (
        <div className="callout train-callout-warn" role="note">
          <Icon name="alert" size={18} />
          <p>{research.note}</p>
        </div>
      ) : null}
      {research.status === "ready" && !research.sources.length ? <p className="muted">No sources with a link from the search came back.</p> : null}

      {research.sources.length ? (
        <>
          <p className="muted small">Every source links to a page the search found. Its details come from a model reading web text, so check them on the page.</p>
          <ol className="research-sources">
            {research.sources.map((s) => (
              <SourceCard key={s.id} source={s} picked={picks.has(s.id)} onPick={(on) => pick(s.id, on)} onImport={() => importRows(s)} importing={busy === s.id} />
            ))}
          </ol>
          <section className="card train-foot research-foot">
            <label className="train-label">
              Examples
              <input className="train-input" type="number" min={DATASET_MIN_COUNT} max={DATASET_MAX_COUNT} value={count} onChange={(e) => setCount(e.target.value)} />
            </label>
            <button type="button" className="btn btn-primary" onClick={writeDataset} disabled={busy !== null || picks.size === 0}>
              <Icon name="play" size={16} />
              <span>{picks.size ? `Write a dataset with ${picks.size} ${picks.size === 1 ? "source" : "sources"}` : "Pick a source to write a dataset"}</span>
            </button>
          </section>
        </>
      ) : null}

      {done ? <p role="status">{done}</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

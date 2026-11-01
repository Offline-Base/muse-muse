"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { decisionUploadErrorText } from "@/components/train/format";
import { DESCRIPTION_MAX_CHARS, NONE_OPTION, OPTION_MAX_CHARS, QUESTION_MAX_CHARS, QUESTION_MIN_CHARS, labelId } from "@/lib/decide/format";
import type { DecisionLabel } from "@/lib/decide/types";
import { groupThousands, plural } from "@/lib/format";
import {
  DECISION_LABELS_MAX,
  DECISION_LABELS_MIN,
  DECISION_ROWS_MAX,
  DECISION_ROWS_PER_LABEL_MIN,
  DECISION_UPLOAD_MAX_BYTES,
  matchLabel,
  parseDecisionCsv,
  parseDecisionJsonl,
  type DecisionUploadReport,
} from "@/lib/train/decision-datasets";

const TITLE_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUESTION_PLACEHOLDER = "Which team should handle this support ticket?";
const ROWS_PLACEHOLDER = 'input,label\n"I was charged twice this month",Billing\n"The parcel is still not here",Shipping';

interface LabelDraft {
  key: number;
  name: string;
  description: string;
}

type Format = "csv" | "jsonl";

/** JSONL when the first line that isn't blank starts with "{", else CSV with the header input,label. */
export function rowsFormat(text: string): Format {
  const first = text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim());
  return first?.trim().startsWith("{") ? "jsonl" : "csv";
}

/** What the rows box holds, read the way the route reads it: rows, rows per label, rows with an unknown label, problems. */
export interface RowsPreview {
  format: Format;
  rows: number;
  perLabel: Array<{ name: string; rows: number }>;
  unknown: number;
  problems: number;
}

export function rowsPreview(text: string, labels: readonly DecisionLabel[]): RowsPreview | null {
  if (!text.trim()) return null;
  const format = rowsFormat(text);
  const parsed = format === "jsonl" ? parseDecisionJsonl(text) : parseDecisionCsv(text);
  const counts = new Map(labels.map((l) => [l.id, 0]));
  let unknown = 0;
  for (const r of parsed.rows) {
    const l = labels.length ? matchLabel(labels, r.label) : null;
    if (l) counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
    else unknown += 1;
  }
  return {
    format,
    rows: parsed.rows.length,
    perLabel: labels.map((l) => ({ name: l.name, rows: counts.get(l.id) ?? 0 })),
    unknown,
    problems: parsed.problems.length,
  };
}

/** The upload's labels as the route takes them, from the drafts with a name. */
function labelsOf(drafts: readonly LabelDraft[]): DecisionLabel[] {
  return drafts
    .filter((d) => d.name.trim())
    .map((d) => ({ id: labelId(d.name.trim()), name: d.name.trim(), description: d.description.trim() }));
}

interface Saved {
  id: string;
  title: string;
  /** The saved labels' ids and names, for the report's rows per label. */
  labels: Array<{ id: string; name: string }>;
  report: DecisionUploadReport;
}

/**
 * The New decision dataset card on /fine-tuning (docs/DECISION_MODELS.md "How a person's labels map onto it"): a name,
 * the question, 2 to 12 labels and the labeled rows, pasted or from a file, as CSV (input,label) or JSONL. Save posts to
 * /api/train/datasets with kind "decision", which checks and splits the rows and saves a ready dataset: nothing is
 * generated and nothing is spent. The card then shows the upload's report, with links to the dataset and to train on it.
 */
export function NewDecisionCard() {
  const router = useRouter();
  const id = useId();
  const next = useRef(3);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [drafts, setDrafts] = useState<LabelDraft[]>([
    { key: 1, name: "", description: "" },
    { key: 2, name: "", description: "" },
  ]);
  const [rowsText, setRowsText] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Saved | null>(null);

  const labels = useMemo(() => labelsOf(drafts), [drafts]);
  const deferredRows = useDeferredValue(rowsText);
  const preview = useMemo(() => rowsPreview(deferredRows, labels), [deferredRows, labels]);
  const questionLength = question.trim().length;

  function check(): Record<string, string> {
    const out: Record<string, string> = {};
    if (questionLength < QUESTION_MIN_CHARS || questionLength > QUESTION_MAX_CHARS) {
      out.question = `Ask the question in ${QUESTION_MIN_CHARS} to ${QUESTION_MAX_CHARS} characters.`;
    }
    const named = drafts.filter((d) => d.name.trim());
    if (named.length < DECISION_LABELS_MIN) out.labels = `Name at least ${DECISION_LABELS_MIN} labels.`;
    const seen = new Map<string, number>();
    drafts.forEach((d, i) => {
      const name = d.name.trim();
      if (!name) return;
      if (name.length > OPTION_MAX_CHARS) out[`name:${d.key}`] = `Keep a label's name to ${OPTION_MAX_CHARS} characters.`;
      else if (name.toLowerCase() === NONE_OPTION.toLowerCase()) out[`name:${d.key}`] = "That option is added to every prompt already.";
      else if (seen.has(labelId(name))) out[`name:${d.key}`] = `Label ${seen.get(labelId(name))! + 1} has the same name.`;
      seen.set(labelId(name), i);
      if (d.description.trim().length > DESCRIPTION_MAX_CHARS) {
        out[`desc:${d.key}`] = `Keep a description to ${DESCRIPTION_MAX_CHARS} characters.`;
      }
    });
    if (!rowsText.trim()) out.rows = "Paste the labeled rows, or choose a file.";
    return out;
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > DECISION_UPLOAD_MAX_BYTES) {
      setFileNote(`${file.name} is over 4 MB. Split it, or send fewer rows (${groupThousands(DECISION_ROWS_MAX)} at most).`);
      return;
    }
    try {
      setRowsText(await file.text());
      setFileNote(`Read ${file.name}.`);
    } catch {
      setFileNote(`Couldn't read ${file.name}. Try pasting its rows instead.`);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found = check();
    setInvalid(found);
    setProblems([]);
    if (Object.keys(found).length) {
      setError("Fix the fields marked above, then save the dataset.");
      return;
    }
    const format = rowsFormat(rowsText);
    const body = JSON.stringify({
      kind: "decision",
      ...(title.trim() ? { title: title.trim() } : {}),
      question: question.trim(),
      labels: labels.map((l) => ({ name: l.name, description: l.description })),
      [format]: rowsText,
    });
    if (new Blob([body]).size > DECISION_UPLOAD_MAX_BYTES) {
      setError(`The upload is over 4 MB. Split it, or send fewer rows (${groupThousands(DECISION_ROWS_MAX)} at most).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/train/datasets", { method: "POST", headers: { "content-type": "application/json" }, body });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const why = decisionUploadErrorText(res.status, data);
        setError(why.error);
        setProblems(why.problems.length > 1 || why.problems[0] !== why.error ? why.problems : []);
        setBusy(false);
        return;
      }
      const d =
        (data as { dataset?: { id?: unknown; title?: unknown; decision?: { labels?: unknown } }; report?: DecisionUploadReport } | null) ?? {};
      if (typeof d.dataset?.id !== "string" || !UUID.test(d.dataset.id) || !d.report) {
        setError("The dataset was saved, but its link didn't come back. It's in the datasets list above.");
        setBusy(false);
        router.refresh();
        return;
      }
      const savedLabels = Array.isArray(d.dataset.decision?.labels)
        ? (d.dataset.decision.labels as Array<{ id?: unknown; name?: unknown }>).flatMap((l) =>
            typeof l?.id === "string" && typeof l.name === "string" ? [{ id: l.id, name: l.name }] : [],
          )
        : labels.map((l) => ({ id: l.id, name: l.name }));
      setSaved({
        id: d.dataset.id,
        title: typeof d.dataset.title === "string" ? d.dataset.title : "Decision dataset",
        labels: savedLabels,
        report: d.report,
      });
      setBusy(false);
      router.refresh();
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection and try again.");
      setBusy(false);
    }
  }

  function reset() {
    setSaved(null);
    setTitle("");
    setQuestion("");
    setDrafts([
      { key: next.current++, name: "", description: "" },
      { key: next.current++, name: "", description: "" },
    ]);
    setRowsText("");
    setFileNote(null);
    setError(null);
    setProblems([]);
    setInvalid({});
  }

  const setDraft = (key: number, patch: Partial<LabelDraft>) =>
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  const fieldProps = (key: string, helpId?: string) => ({
    "aria-invalid": invalid[key] ? true : undefined,
    "aria-describedby": [helpId, invalid[key] ? `${id}-${key}-err` : null].filter(Boolean).join(" ") || undefined,
  });
  const fieldError = (key: string) =>
    invalid[key] ? (
      <p className="train-field-error" id={`${id}-${key}-err`}>
        {invalid[key]}
      </p>
    ) : null;

  return (
    <section className="card train-new" id="new-decision-dataset" aria-labelledby={`${id}-title`}>
      <div className="train-new-head">
        <h2 id={`${id}-title`}>New decision dataset</h2>
        <p className="muted small">
          Your own labeled examples. A decide job trains Glimmer to pick one label for each input, and scores it on
          examples held out from training. Saving generates nothing and costs nothing.
        </p>
      </div>

      {saved ? (
        <SavedReport saved={saved} onAgain={reset} />
      ) : (
        <form className="train-form" onSubmit={save} noValidate>
          <div className="train-grid">
            <div className="train-field train-field-wide">
              <label className="train-label" htmlFor={`${id}-question`}>
                Question
              </label>
              <input
                id={`${id}-question`}
                className="train-input"
                type="text"
                value={question}
                maxLength={QUESTION_MAX_CHARS}
                placeholder={QUESTION_PLACEHOLDER}
                autoComplete="off"
                onChange={(e) => setQuestion(e.target.value)}
                disabled={busy}
                {...fieldProps("question", `${id}-question-help`)}
              />
              <p className="train-help train-help-row" id={`${id}-question-help`}>
                <span>What to decide about each input. Every prompt asks it the same way.</span>
                <span className="train-count">
                  {questionLength} / {QUESTION_MAX_CHARS}
                </span>
              </p>
              {fieldError("question")}
            </div>

            <div className="train-field">
              <label className="train-label" htmlFor={`${id}-name`}>
                Name <span className="muted">(optional)</span>
              </label>
              <input
                id={`${id}-name`}
                className="train-input"
                type="text"
                value={title}
                maxLength={TITLE_MAX}
                placeholder="Ticket router"
                autoComplete="off"
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
                aria-describedby={`${id}-name-help`}
              />
              <p className="train-help" id={`${id}-name-help`}>
                Shown in the datasets list. Without one, it is named after the question.
              </p>
            </div>

            <fieldset className="train-field train-field-wide decide-labels" disabled={busy} aria-describedby={`${id}-labels-help`}>
              <legend className="train-label">Labels</legend>
              <p className="train-help" id={`${id}-labels-help`}>
                {DECISION_LABELS_MIN} to {DECISION_LABELS_MAX} choices. A short description helps the model tell them apart.
                &quot;{NONE_OPTION}&quot; is added to every prompt on its own.
              </p>
              <ol className="decide-label-list">
                {drafts.map((d, i) => (
                  <li className="decide-label-row" key={d.key}>
                    <div className="train-field">
                      <label className="train-sublabel" htmlFor={`${id}-label-${d.key}`}>
                        Label {i + 1}
                      </label>
                      <input
                        id={`${id}-label-${d.key}`}
                        className="train-input"
                        type="text"
                        value={d.name}
                        maxLength={OPTION_MAX_CHARS}
                        placeholder={["Billing", "Shipping", "Account", "Returns"][i] ?? "Another label"}
                        autoComplete="off"
                        onChange={(e) => setDraft(d.key, { name: e.target.value })}
                        {...fieldProps(`name:${d.key}`)}
                      />
                      {fieldError(`name:${d.key}`)}
                    </div>
                    <div className="train-field">
                      <label className="train-sublabel" htmlFor={`${id}-desc-${d.key}`}>
                        Description <span className="muted">(optional)</span>
                      </label>
                      <input
                        id={`${id}-desc-${d.key}`}
                        className="train-input"
                        type="text"
                        value={d.description}
                        maxLength={DESCRIPTION_MAX_CHARS}
                        placeholder={i === 0 ? "Charges, refunds and invoices" : undefined}
                        autoComplete="off"
                        onChange={(e) => setDraft(d.key, { description: e.target.value })}
                        {...fieldProps(`desc:${d.key}`)}
                      />
                      {fieldError(`desc:${d.key}`)}
                    </div>
                    <button
                      type="button"
                      className="round-btn decide-label-remove"
                      onClick={() => setDrafts((list) => list.filter((x) => x.key !== d.key))}
                      disabled={drafts.length <= DECISION_LABELS_MIN}
                      aria-label={`Remove label ${i + 1}${d.name.trim() ? `, ${d.name.trim()}` : ""}`}
                      title="Remove"
                    >
                      <Icon name="close" size={18} />
                    </button>
                  </li>
                ))}
              </ol>
              <div>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => setDrafts((list) => [...list, { key: next.current++, name: "", description: "" }])}
                  disabled={drafts.length >= DECISION_LABELS_MAX}
                >
                  <Icon name="plus" size={16} />
                  <span>Add a label</span>
                </button>
              </div>
              {fieldError("labels")}
            </fieldset>

            <div className="train-field train-field-wide">
              <div className="train-label-row">
                <label className="train-label" htmlFor={`${id}-rows`}>
                  Rows
                </label>
                <label className="btn btn-outline decide-file">
                  <Icon name="file" size={16} />
                  <span>Choose a file</span>
                  <input
                    type="file"
                    className="sr-only"
                    accept=".csv,.jsonl,.txt,text/csv,application/jsonl"
                    onChange={onFile}
                    disabled={busy}
                  />
                </label>
              </div>
              <textarea
                id={`${id}-rows`}
                className="train-input train-textarea decide-rows-input"
                value={rowsText}
                rows={8}
                placeholder={ROWS_PLACEHOLDER}
                spellCheck={false}
                onChange={(e) => setRowsText(e.target.value)}
                disabled={busy}
                {...fieldProps("rows", `${id}-rows-help`)}
              />
              <p className="train-help" id={`${id}-rows-help`} aria-live="polite">
                {fileNote ? `${fileNote} ` : ""}
                CSV with the header input,label, or JSONL with one {"{"}&quot;input&quot;, &quot;label&quot;{"}"} a line. At
                least {DECISION_ROWS_PER_LABEL_MIN} rows a label and {groupThousands(DECISION_ROWS_MAX)} at most, under 4
                MB. A fifth of each label is held out to test the model, and a tenth to calibrate it.
              </p>
              {preview ? <PreviewLine preview={preview} /> : null}
              {fieldError("rows")}
            </div>
          </div>

          <div className="train-foot">
            <p className="train-cost" id={`${id}-cost`}>
              Saved ready to train. Nothing runs and nothing is billed until you start a decide job on it.
            </p>
            <button type="submit" className="btn btn-primary" disabled={busy} aria-describedby={`${id}-cost`}>
              {busy ? <span className="spinner" aria-hidden /> : <Icon name="check" size={16} />}
              <span>{busy ? "Checking" : "Save dataset"}</span>
            </button>
          </div>

          {error ? (
            <div className="form-error" role="alert">
              <Icon name="alert" size={18} />
              <div>
                <p>{error}</p>
                {problems.length ? (
                  <ul className="decide-problems">
                    {problems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}

function PreviewLine({ preview: p }: { preview: RowsPreview }) {
  const short = p.perLabel.filter((l) => l.rows < DECISION_ROWS_PER_LABEL_MIN);
  return (
    <div className="decide-preview" aria-live="polite">
      <p>
        <strong>{plural(p.rows, "row")}</strong> read as {p.format === "jsonl" ? "JSONL" : "CSV"}
        {p.perLabel.length ? `: ${p.perLabel.map((l) => `${l.name} ${groupThousands(l.rows)}`).join(", ")}` : ""}
        {p.unknown ? `, ${plural(p.unknown, "row")} with a label not listed above` : ""}
        {p.problems ? `, ${plural(p.problems, "line")} that can't be read` : ""}.
      </p>
      {short.length && p.perLabel.length ? (
        <p className="muted">
          Each label needs at least {DECISION_ROWS_PER_LABEL_MIN}: {short.map((l) => l.name).join(", ")}{" "}
          {short.length === 1 ? "has" : "have"} fewer.
        </p>
      ) : null}
    </div>
  );
}

function SavedReport({ saved, onAgain }: { saved: Saved; onAgain: () => void }) {
  const r = saved.report;
  const ids = saved.labels.length ? saved.labels.map((l) => l.id) : Object.keys(r.perLabel);
  const nameOf = (labelKey: string) => saved.labels.find((l) => l.id === labelKey)?.name ?? labelKey;
  return (
    <div className="decide-saved" role="status">
      <p className="totals-big">
        <Icon name="checkCircle" size={20} />
        <span>
          Saved <strong>{saved.title}</strong>: {groupThousands(r.kept)} of {plural(r.read, "row")} kept.
        </span>
      </p>
      <div className="table-wrap">
        <table className="data decide-table">
          <caption className="sr-only">Rows per label in each split</caption>
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col" className="num">
                Train
              </th>
              <th scope="col" className="num">
                Dev
              </th>
              <th scope="col" className="num">
                Test
              </th>
            </tr>
          </thead>
          <tbody>
            {ids.map((labelKey) => {
              const c = r.perLabel[labelKey] ?? { train: 0, dev: 0, test: 0 };
              return (
                <tr key={labelKey}>
                  <th scope="row">{nameOf(labelKey)}</th>
                  <td className="num">{groupThousands(c.train)}</td>
                  <td className="num">{groupThousands(c.dev)}</td>
                  <td className="num">{groupThousands(c.test)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {r.merged.length ? (
        <p className="muted small">
          {plural(r.merged.length, "row")} repeated an earlier one and {r.merged.length === 1 ? "was" : "were"} merged
          {r.merged.length <= 5 ? ` (lines ${r.merged.map((m) => m.line).join(", ")})` : ""}.
        </p>
      ) : null}
      {r.warnings.length ? (
        <div className="callout train-callout-warn" role="note">
          <Icon name="alert" size={18} />
          <div>
            {r.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        </div>
      ) : null}
      <div className="decide-saved-actions">
        <Link className="btn btn-primary" href={`/fine-tuning?dataset=${saved.id}#new-job`}>
          <Icon name="play" size={16} />
          Train on it
        </Link>
        <Link className="btn btn-outline" href={`/fine-tuning/datasets/${saved.id}`}>
          Open the dataset
        </Link>
        <button type="button" className="btn" onClick={onAgain}>
          Make another
        </button>
      </div>
    </div>
  );
}

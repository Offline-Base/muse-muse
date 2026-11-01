"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import {
  WRITER_MODEL,
  WRITER_NAME,
  datasetBlockedText,
  datasetCostHint,
  datasetCostRange,
  datasetCountOk,
  datasetStartErrorText,
} from "@/components/train/format";
import { groupThousands, modelLabel, usd } from "@/lib/format";
import { SPARK_STANDIN } from "@/lib/meta/spark";
import { DATASET_MAX_COUNT, DATASET_MIN_COUNT, DATASET_TASK_MAX, DATASET_TASK_MIN } from "@/lib/train/logic";

export interface NewDatasetCardProps {
  /**
   * Why POST /api/train/datasets would refuse right now: "meta_not_configured" (no MODEL_API_KEY) or "paused" (the
   * platform's daily spend cap), or null. The card blocks Start with a sentence, as the New job card does.
   */
  blocked?: string | null;
  /** Offer Spark 1.3 Contributor as the writer (contributorWriterOn), for made-up tasks, and start with it selected. */
  contributorWriter?: boolean;
}

/** Examples the card starts with. */
export const DEFAULT_DATASET_COUNT = 300;

const TITLE_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TASK_PLACEHOLDER =
  "Answer customer questions for a small bakery: hours, allergens, custom cake orders, in a warm two-sentence style";

/**
 * The New dataset card on /fine-tuning: a task description, an optional name and how many examples to write, with a
 * cost estimate. Start posts to /api/train/datasets and opens the new dataset's page, where it fills in as it is written.
 */
export function NewDatasetCard({ blocked = null, contributorWriter = false }: NewDatasetCardProps) {
  const router = useRouter();
  const id = useId();
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [count, setCount] = useState(String(DEFAULT_DATASET_COUNT));
  const [useContributor, setUseContributor] = useState(contributorWriter);
  const [madeUp, setMadeUp] = useState(false);
  const writerModel = useContributor ? SPARK_STANDIN : WRITER_MODEL;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});

  const countNum = Number(count);
  const taskLength = task.trim().length;
  const blockedText = datasetBlockedText(blocked);

  function check(): Record<string, string> {
    const out: Record<string, string> = {};
    if (taskLength < DATASET_TASK_MIN) out.task = `Describe the task in at least ${DATASET_TASK_MIN} characters.`;
    else if (taskLength > DATASET_TASK_MAX) out.task = `Keep the task under ${groupThousands(DATASET_TASK_MAX)} characters.`;
    if (!datasetCountOk(countNum)) {
      out.count = `Enter a whole number from ${DATASET_MIN_COUNT} to ${groupThousands(DATASET_MAX_COUNT)}.`;
    }
    return out;
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    if (busy || blockedText) return;
    const problems = check();
    setInvalid(problems);
    if (Object.keys(problems).length) {
      setError("Fix the fields marked above, then start the dataset.");
      return;
    }
    if (useContributor && !madeUp) {
      setError("Confirm the task is made up, or switch back to Muse Wonder.");
      return;
    }
    const { low, high } = datasetCostRange(countNum, writerModel);
    if (!window.confirm(`Have ${modelLabel(writerModel)} write ${countNum} examples? It costs about ${usd(low)} to ${usd(high)} on Meta's API.`)) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/train/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(title.trim() ? { title: title.trim() } : {}), task: task.trim(), count: countNum, ...(useContributor ? { writer: "contributor", madeUp } : {}) }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(datasetStartErrorText(res.status, data));
        setBusy(false);
        return;
      }
      const datasetId = (data as { dataset?: { id?: unknown } } | null)?.dataset?.id;
      if (typeof datasetId !== "string" || !UUID.test(datasetId)) {
        setError("The dataset started, but its link didn't come back. It's in the datasets list above.");
        setBusy(false);
        router.refresh();
        return;
      }
      router.push(`/fine-tuning/datasets/${datasetId}`);
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection and try again.");
      setBusy(false);
    }
  }

  const fieldProps = (key: string, helpId: string) => ({
    "aria-invalid": invalid[key] ? true : undefined,
    "aria-describedby": [helpId, invalid[key] ? `${id}-${key}-err` : null].filter(Boolean).join(" "),
  });
  const fieldError = (key: string) =>
    invalid[key] ? (
      <p className="train-field-error" id={`${id}-${key}-err`}>
        {invalid[key]}
      </p>
    ) : null;

  return (
    <section className="card train-new" id="new-dataset" aria-labelledby={`${id}-title`}>
      <div className="train-new-head">
        <h2 id={`${id}-title`}>New dataset</h2>
        <p className="muted small">
          {WRITER_NAME} writes realistic prompts for the task and answers them. Jobs train on the answers.
        </p>
      </div>

      {blockedText ? (
        <div className="callout train-callout-warn" role="note">
          <Icon name="alert" size={18} />
          <p>{blockedText}</p>
        </div>
      ) : null}

      <form className="train-form" onSubmit={start} noValidate>
        <div className="train-grid">
          <div className="train-field train-field-wide">
            <label className="train-label" htmlFor={`${id}-task`}>
              Task
            </label>
            <textarea
              id={`${id}-task`}
              className="train-input train-textarea"
              value={task}
              rows={4}
              maxLength={DATASET_TASK_MAX}
              placeholder={TASK_PLACEHOLDER}
              required
              onChange={(e) => setTask(e.target.value)}
              disabled={busy}
              {...fieldProps("task", `${id}-task-help`)}
            />
            <p className="train-help train-help-row" id={`${id}-task-help`}>
              <span>What the model should learn to do, for whom, and in what voice.</span>
              <span className="train-count">
                {groupThousands(taskLength)} / {groupThousands(DATASET_TASK_MAX)}
              </span>
            </p>
            {fieldError("task")}
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
              placeholder="Bakery helper"
              autoComplete="off"
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              aria-describedby={`${id}-name-help`}
            />
            <p className="train-help" id={`${id}-name-help`}>
              Shown in the datasets list. Without one, it is named after the task.
            </p>
          </div>

          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-count`}>
              Examples
            </label>
            <input
              id={`${id}-count`}
              className="train-input"
              type="number"
              inputMode="numeric"
              min={DATASET_MIN_COUNT}
              max={DATASET_MAX_COUNT}
              step={1}
              value={count}
              onChange={(e) => setCount(e.target.value)}
              disabled={busy}
              {...fieldProps("count", `${id}-count-help`)}
            />
            <p className="train-help" id={`${id}-count-help`}>
              {DATASET_MIN_COUNT} to {groupThousands(DATASET_MAX_COUNT)}. More examples teach the task better and cost more.
            </p>
            {fieldError("count")}
          </div>
        </div>

        {contributorWriter ? (
          <div className="train-field">
            <label className="train-label" htmlFor={`${id}-writer`}>
              Written by
            </label>
            <select
              id={`${id}-writer`}
              className="train-input"
              value={useContributor ? "contributor" : "wonder"}
              onChange={(e) => setUseContributor(e.target.value === "contributor")}
              disabled={busy}
            >
              <option value="wonder">{WRITER_NAME}</option>
              <option value="contributor">{modelLabel(SPARK_STANDIN)}, made-up tasks only</option>
            </select>
            {useContributor ? (
              <label className="train-help">
                <input type="checkbox" checked={madeUp} onChange={(e) => setMadeUp(e.target.checked)} disabled={busy} /> This task is made up, with no real people&apos;s or private information. Meta may train on everything sent to this model.
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="train-foot">
          <p className="train-cost" id={`${id}-cost`} aria-live="polite">
            {blockedText ?? datasetCostHint(countNum, writerModel)}
          </p>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || Boolean(blockedText)}
            aria-describedby={`${id}-cost`}
          >
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="play" size={16} />}
            <span>{busy ? "Starting" : "Start dataset"}</span>
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

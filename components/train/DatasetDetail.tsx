import Link from "next/link";
import { Icon } from "@/components/icons";
import { DatasetStatusPill } from "@/components/train/DatasetStatusPill";
import { LongText } from "@/components/train/LongText";
import { WRITER_NAME, isDatasetStalled, itemNumber, writerName } from "@/components/train/format";
import { PageHeader } from "@/components/ui";
import { dateTimeUtc, duration, elapsedMs, plural, usd } from "@/lib/format";
import type { DatasetView, EvalExample, TrainExample } from "@/lib/train/types";

export interface DatasetDetailProps {
  dataset: DatasetView;
  /** The first training conversations. While it is written, the first answered ones, before eval is held out. */
  sampleTrain: TrainExample[];
  /** The held-out prompts with their reference answers. Empty until it is ready. */
  sampleEval: EvalExample[];
  /** Examples answered so far while it is written (datasetProgress), else null. */
  written: number | null;
  now: number;
  /** The Lab results' view for non-admins: no "Train on it" and no note. */
  readOnly?: boolean;
}

/**
 * The dataset page: its task, counts, cost and status, a sample of training conversations (the system message once,
 * since every example shares it) and the eval prompts with the reference answers. The writer is named from the
 * dataset's record (writerName: Muse Spark 1.3 for one made before the writer was recorded).
 */
export function DatasetDetail({ dataset: d, sampleTrain, sampleEval, written, now, readOnly = false }: DatasetDetailProps) {
  const writer = writerName(d);
  const ready = d.status === "ready";
  const generating = d.status === "generating";
  const stalled = isDatasetStalled(d, now);
  const system = sampleTrain.flatMap((ex) => ex.messages ?? []).find((m) => m.role === "system")?.content ?? null;
  const kept = d.trainCount + d.evalCount;

  return (
    <div className="page">
      <PageHeader
        title={d.title}
        subtitle={
          <>
            Written by {writer} · created{" "}
            <time dateTime={d.createdAt}>{dateTimeUtc(d.createdAt)}</time>
          </>
        }
        actions={
          <>
            <Link className="btn btn-outline" href="/fine-tuning#datasets">
              <Icon name="chevronLeft" size={18} />
              All datasets
            </Link>
            {ready && !readOnly ? (
              <Link className="btn btn-primary" href={`/fine-tuning?dataset=${d.id}#new-job`}>
                <Icon name="play" size={16} />
                Train on it
              </Link>
            ) : null}
          </>
        }
      />

      <section className="card totals" aria-label="Dataset status">
        <div className="train-ds-status">
          <DatasetStatusPill status={d.status} stalled={stalled} />
          <p className="totals-big">
            {ready ? (
              <>
                <strong>{d.trainCount}</strong> train · <strong>{d.evalCount}</strong> eval
              </>
            ) : generating ? (
              <>
                <strong>{written ?? 0}</strong> of {d.requested} answered
              </>
            ) : (
              <>{d.requested} asked for</>
            )}{" "}
            · <strong>{usd(d.costUsd)}</strong> est.
          </p>
        </div>
        <p className="muted small" role="status" aria-live="polite">
          {stalled
            ? "This started over 6 hours ago and never finished, so its workflow most likely stopped. Nothing bills for it and no job can use it, so make a new one."
            : generating
              ? `${writer} writes the prompts first, then answers them in chunks. This page updates every 10 seconds.`
              : ready && d.finishedAt
                ? `Finished ${dateTimeUtc(d.finishedAt)}, ${duration(elapsedMs(d.createdAt, d.finishedAt, now))} after it started.${
                    // A dataset that stopped early says why in its note below.
                    kept < d.requested && !d.error && !readOnly
                      ? ` ${d.requested - kept} of the ${d.requested} asked for were left out as repeats or unusable answers.`
                      : ""
                  }`
                : ready
                  ? "Ready to train on."
                  : "This dataset failed, so no job can train on it."}
        </p>
      </section>

      {d.status === "failed" ? (
        <div className="callout callout-bad" role="note">
          <Icon name="alert" size={18} />
          <p>{d.error ?? "It failed without saying why."}</p>
        </div>
      ) : ready && d.error && !readOnly ? (
        // A dataset that stopped early keeps what it had, with a note saying why.
        <div className="callout train-callout-warn" role="note">
          <Icon name="alert" size={18} />
          <p>{d.error}</p>
        </div>
      ) : null}

      <section className="card section-card" aria-labelledby="ds-task">
        <h2 id="ds-task">Task</h2>
        <p className="train-text">{d.task}</p>
      </section>

      <section className="section" aria-labelledby="ds-train">
        <div className="section-head">
          <h2 id="ds-train">Training examples</h2>
          {sampleTrain.length ? (
            <span className="muted small">
              {ready
                ? `The first ${sampleTrain.length} of ${d.trainCount}`
                : `The first ${plural(sampleTrain.length, "answered example")}`}
            </span>
          ) : null}
        </div>
        {system ? (
          <details className="card train-system">
            <summary>
              <strong>System message</strong> <span className="muted">the same in every example</span>
            </summary>
            <p className="train-text">{system}</p>
          </details>
        ) : null}
        {sampleTrain.length ? (
          <ol className="train-convos">
            {sampleTrain.map((ex, i) => (
              <li className="card train-convo" key={i}>
                <p className="train-convo-num">Example {i + 1}</p>
                {(ex.messages ?? [])
                  .filter((m) => m.role !== "system")
                  .map((m, j) => (
                    <div className={`train-msg${m.role === "user" ? " train-msg-user" : ""}`} key={j}>
                      <p className="train-role">{m.role === "user" ? "User" : `Answer (${writer})`}</p>
                      <LongText text={m.content} />
                    </div>
                  ))}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">
            {generating && !stalled ? "The first answers show up here as they are written." : "No training examples."}
          </p>
        )}
      </section>

      <section className="section" aria-labelledby="ds-eval">
        <div className="section-head">
          <h2 id="ds-eval">Eval prompts</h2>
          {ready ? <span className="muted small">{d.evalCount} held out</span> : null}
        </div>
        <p className="muted small">
          Held out from training. A job answers each one with the base and the tuned model, and the job&apos;s judge
          ({WRITER_NAME} for a job trained now) scores both against the reference.
        </p>
        {sampleEval.length ? (
          <div className="table-wrap">
            <table className="data train-ds-eval">
              <caption className="sr-only">Eval prompts with {writer}&apos;s reference answers</caption>
              <thead>
                <tr>
                  <th scope="col" className="num">
                    #
                  </th>
                  <th scope="col">Prompt</th>
                  <th scope="col">{writer} reference</th>
                </tr>
              </thead>
              <tbody>
                {sampleEval.map((e, i) => (
                  <tr key={i}>
                    <td className="num">{itemNumber(i)}</td>
                    <td>
                      <LongText text={e.prompt} />
                    </td>
                    <td>
                      <LongText text={e.reference} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{generating && !stalled ? "They are held out once every answer is written." : "No eval prompts."}</p>
        )}
        {ready && sampleEval.length < d.evalCount ? (
          <p className="muted small">
            Showing the first {sampleEval.length} of {d.evalCount}.
          </p>
        ) : null}
      </section>
    </div>
  );
}

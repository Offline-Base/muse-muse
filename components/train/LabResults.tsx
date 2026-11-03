import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { WRITER_NAME, datasetCountsText, percentText, scoreText, twoPlaces } from "@/components/train/format";
import { SparkOpenChip } from "@/components/train/SparkOpenNote";
import { GLIMMER_NAME, minutesText, type ResultView } from "@/components/train/results";
import { dateTimeUtc, modelLabel, relativeTime, truncate, usd } from "@/lib/format";
import { UNRECORDED_MODEL } from "@/lib/train/models";
import type { DatasetView } from "@/lib/train/types";

/*
 * The Lab results on /fine-tuning (docs/TRAINING.md "Lab results"): read-only, for everyone. Server components with no
 * client code, so only the text they render reaches the browser.
 */

const STEPS: Array<{ icon: IconName; title: string; text: string }> = [
  {
    icon: "brief",
    title: "Write",
    text: `${WRITER_NAME} writes a training set for a task and holds some prompts out.`,
  },
  {
    icon: "tune",
    title: "Train",
    text: `${GLIMMER_NAME} learns it with a LoRA adapter on a Lambda GPU.`,
  },
  {
    icon: "clipboard",
    title: "Judge",
    text: `${WRITER_NAME} scores base and tuned Glimmer on the held-out prompts, without knowing which is which.`,
  },
];

/**
 * What the lab does now, in three steps, with WRITER_NAME writing and judging. The runs before Oct 29, 2026 were
 * written and judged by Muse Spark 1.3, so the intro says so, and each result's page names its models from the record.
 */
export function LabIntro() {
  return (
    <section className="hero-card lab-intro" aria-labelledby="lab-intro-title">
      <div className="hero-card-head">
        <h2 id="lab-intro-title">Lab results</h2>
      </div>
      <div className="hero-card-body">
        <p className="hero-card-desc">
          Muse Muse fine-tunes Meta&apos;s open models on GPUs: {WRITER_NAME} writes a training set, {GLIMMER_NAME} learns
          it, and {WRITER_NAME} judges base against tuned on held-out prompts. {modelLabel(UNRECORDED_MODEL)} wrote and
          judged the runs before Oct 29, 2026, and each result&apos;s page names the models that did its work. Decision
          models are scored instead of judged: {GLIMMER_NAME} learns to pick one label from a person&apos;s labeled
          examples, and base and tuned are checked on rows held out before training, with no judge.
        </p>
        <ol className="how">
          {STEPS.map((s, i) => (
            <li key={s.title} className="how-step">
              <span className="how-icon" aria-hidden>
                <Icon name={s.icon} />
              </span>
              <h3 className="how-title">
                <span className="how-num">{i + 1}.</span> {s.title}
              </h3>
              <p className="muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/**
 * Judged jobs in the jobs table's style: what was tuned, how the tuned model did against the base, GPU, time, cost, and
 * an "On Hugging Face" chip once a job is published there.
 */
export function ResultsTable({ results, caption }: { results: ResultView[]; caption: string }) {
  return (
    <div className="table-wrap">
      <table className="data data-list">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">Model</th>
            <th scope="col">Tuned vs base</th>
            <th scope="col">Average score</th>
            <th scope="col">GPU</th>
            <th scope="col" className="num">
              GPU time
            </th>
            <th scope="col" className="num">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const s = r.summary;
            if (r.decision) return <DecisionRow key={r.id} r={r} />;
            return (
              <tr key={r.id}>
                <td>
                  <Link href={`/fine-tuning/${r.id}`} className="row-title">
                    {r.title}
                  </Link>
                  <span className="row-sub muted">
                    {r.recipeTitle}
                    {r.hub ? (
                      <>
                        {" "}
                        <span className="chip">On Hugging Face</span>
                      </>
                    ) : null}
                  </span>
                </td>
                <td className="train-nowrap">
                  {r.model}
                  {r.sparkOpen ? (
                    <span className="row-sub">
                      <SparkOpenChip />
                    </span>
                  ) : null}
                </td>
                <td className="train-nowrap">
                  Tuned won <strong>{s.tunedWins}</strong> of {s.items}
                  <span className="row-sub muted">
                    {r.sparkOpen ? "The 2026 Glimmer it started from won " : "Base won "}
                    {s.baseWins}, {s.ties === 1 ? "1 tie" : `${s.ties} ties`}
                  </span>
                </td>
                <td className="train-nowrap">
                  {r.sparkOpen ? "2026 Glimmer " : "Base "}
                  {scoreText(s.avgBaseScore)} · Tuned <strong>{scoreText(s.avgTunedScore)}</strong>
                  <span className="row-sub muted">out of 10</span>
                </td>
                <td className="train-nowrap">{r.gpu}</td>
                <td className="num">{minutesText(r.gpuMinutes)}</td>
                <td className="num">{usd(r.costUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A decide job's row in the results table: how often each model was right on the held-out test rows, and macro F1,
 * where a judged job has its wins and average scores.
 */
function DecisionRow({ r }: { r: ResultView }) {
  const d = r.decision!;
  const main = d.tuned ?? d.base;
  return (
    <tr>
      <td>
        <Link href={`/fine-tuning/${r.id}`} className="row-title">
          {r.title}
        </Link>
        <span className="row-sub muted">
          {r.recipeTitle} · decision model{" "}
          {r.hub ? <span className="chip">On Hugging Face</span> : null}
        </span>
      </td>
      <td className="train-nowrap">
        {r.model}
        {r.sparkOpen ? (
          <span className="row-sub">
            <SparkOpenChip />
          </span>
        ) : null}
      </td>
      <td>
        {d.tuned ? "Tuned" : r.sparkOpen ? "r30b" : "Base"} right on <strong>{main.accuracy.right}</strong> of {d.items} ({percentText(main.accuracy.rate)})
        <span className="row-sub muted">
          {d.tuned
            ? `${r.sparkOpen ? "The 2026 Glimmer it started from" : "Base"} right on ${d.base.accuracy.right} (${percentText(d.base.accuracy.rate)})`
            : "Score only, nothing trained"}
        </span>
      </td>
      <td>
        Macro F1 {d.tuned ? `${r.sparkOpen ? "r30b" : "base"} ${twoPlaces(d.base.macroF1)} · tuned ` : ""}
        <strong>{twoPlaces(main.macroF1)}</strong>
        <span className="row-sub muted">held-out rows, no judge</span>
      </td>
      <td className="train-nowrap">{r.gpu}</td>
      <td className="num">{minutesText(r.gpuMinutes)}</td>
      <td className="num">{usd(r.costUsd)}</td>
    </tr>
  );
}

/** Ready datasets: title, task, counts, cost and when each was made, each linking to its read-only page. */
export function ReadyDatasetsTable({ datasets, now, caption }: { datasets: DatasetView[]; now: number; caption: string }) {
  return (
    <div className="table-wrap">
      <table className="data data-list">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Dataset</th>
            <th scope="col">Examples</th>
            <th scope="col" className="num">
              Cost (est.)
            </th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((d) => (
            <tr key={d.id}>
              <td>
                <Link href={`/fine-tuning/datasets/${d.id}`} className="row-title">
                  {d.title}
                </Link>
                {/* A dataset with no title is named after the start of its task, so the task would only repeat it. */}
                {d.task.startsWith(d.title) ? null : <span className="row-sub muted">{truncate(d.task, 90)}</span>}
              </td>
              <td className="train-nowrap">{datasetCountsText(d)}</td>
              <td className="num">{usd(d.costUsd)}</td>
              <td className="train-nowrap">
                <time dateTime={d.createdAt} title={dateTimeUtc(d.createdAt)}>
                  {relativeTime(d.createdAt, now)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

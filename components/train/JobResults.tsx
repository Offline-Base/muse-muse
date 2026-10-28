import Link from "next/link";
import { Icon } from "@/components/icons";
import { EvalResults } from "@/components/train/EvalResults";
import { TryLiveCard } from "@/components/train/LiveDemo";
import { LongText } from "@/components/train/LongText";
import { WRITER_NAME, tunedModelName, type EvalRow } from "@/components/train/format";
import { minutesText, type PublicLiveDemo, type ResultView } from "@/components/train/results";
import { PageHeader } from "@/components/ui";
import { dateTimeUtc, usd } from "@/lib/format";

export interface JobResultsProps {
  result: ResultView;
  /** The job's eval items with their judgements (evalRows of its eval and judgement events only). */
  rows: EvalRow[];
  /** The dataset it trained on, when that dataset is ready. */
  dataset: { id: string; title: string } | null;
  /** A live demo of its adapter while one is starting or serving (the Try it live box), else nothing. */
  live?: PublicLiveDemo | null;
  /** The server's clock when the page rendered, for the live demo's countdown. */
  serverNow?: number;
}

/**
 * A judged job as anyone sees it: what ran (recipe, model, dataset, GPU, time, cost and the safe settings) and the eval
 * results, read-only. A server component, so nothing but this text reaches the browser: no instance, IP, region, log,
 * error or Stop. While a live demo of its adapter runs, the Try it live box comes first; it gets only PublicLiveDemo.
 */
export function JobResults({ result: r, rows, dataset, live = null, serverNow }: JobResultsProps) {
  const long = r.settings.filter((s) => s.key === "studentPrompt");
  const short = r.settings.filter((s) => s.key !== "studentPrompt");
  return (
    <div className="page">
      <PageHeader
        title={r.title}
        subtitle={
          <>
            {r.recipeTitle} · {r.model} · finished <time dateTime={r.finishedAt}>{dateTimeUtc(r.finishedAt)}</time>
          </>
        }
        actions={
          <Link className="btn btn-outline" href="/fine-tuning#results">
            <Icon name="chevronLeft" size={18} />
            All results
          </Link>
        }
      />

      {live ? <TryLiveCard adapterJobId={r.id} demo={live} serverNow={serverNow ?? Date.now()} /> : null}

      <section className="card section-card" aria-labelledby="run-title">
        <h2 id="run-title">The run</h2>
        <dl className="kv">
          <div>
            <dt>Recipe</dt>
            <dd>{r.recipeTitle}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{r.model}</dd>
          </div>
          {dataset ? (
            <div>
              <dt>Dataset</dt>
              <dd>
                <Link href={`/fine-tuning/datasets/${dataset.id}`}>{dataset.title}</Link>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>GPU</dt>
            <dd>{r.gpu}</dd>
          </div>
          <div>
            <dt>GPU time</dt>
            <dd>{minutesText(r.gpuMinutes)}</dd>
          </div>
          <div>
            <dt>GPU cost</dt>
            <dd>{usd(r.costUsd)}</dd>
          </div>
          {short.map((s) => (
            <div key={s.key}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
        {long.map((s) => (
          <div className="train-msg" key={s.key}>
            <h3 className="train-role">{s.label}</h3>
            <LongText text={s.value} />
          </div>
        ))}
        <p className="muted small">
          Both models answered each held-out prompt. {WRITER_NAME} saw the two answers in random order, without knowing
          which model wrote which.
        </p>
      </section>

      <EvalResults state={{ state: "judged", summary: r.summary }} rows={rows} model={tunedModelName(r.recipe)} />
    </div>
  );
}

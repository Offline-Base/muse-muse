import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/icons";
import { EvalResults } from "@/components/train/EvalResults";
import { TryLiveCard } from "@/components/train/LiveDemo";
import { LongText } from "@/components/train/LongText";
import { judgeName, tunedModelName, writerName, type EvalRow } from "@/components/train/format";
import { minutesText, type PublicLiveDemo, type ResultView } from "@/components/train/results";
import { ExternalLink, PageHeader } from "@/components/ui";
import { dateTimeUtc, usd } from "@/lib/format";

export interface JobResultsProps {
  result: ResultView;
  /** The job's eval items with their judgements (evalRows of its eval and judgement events only). */
  rows: EvalRow[];
  /**
   * The dataset it trained on, when that dataset is ready, with the model that wrote it (its writerModel: absent or null
   * means Muse Spark 1.3).
   */
  dataset: { id: string; title: string; writerModel?: string | null } | null;
  /** A live demo of its adapter while one is starting or serving (the Try it live box), else nothing. */
  live?: PublicLiveDemo | null;
  /** The server's clock when the page rendered, for the live demo's countdown. */
  serverNow?: number;
  /** What the page shows right under the model's title, such as "Run it on your computer" once it has local files. */
  aside?: ReactNode;
}

/**
 * A judged job as anyone sees it: what ran (recipe, model, dataset, GPU, time, cost and the safe settings) and the eval
 * results, read-only. A server component, so nothing but this text reaches the browser: no instance, IP, region, log,
 * error or Stop. While a live demo of its adapter runs, the Try it live box comes first; it gets only PublicLiveDemo.
 * Once the job is published to the Hugging Face Hub, an "On Hugging Face" chip and the two repos' links show; before
 * that, nothing about the Hub does.
 */
export function JobResults({ result: r, rows, dataset, live = null, serverNow, aside = null }: JobResultsProps) {
  const judge = judgeName(r);
  const long = r.settings.filter((s) => s.key === "studentPrompt");
  const short = r.settings.filter((s) => s.key !== "studentPrompt");
  return (
    <div className="page">
      <PageHeader
        title={r.title}
        subtitle={
          <>
            {r.recipeTitle} · {r.model} · finished <time dateTime={r.finishedAt}>{dateTimeUtc(r.finishedAt)}</time>
            {r.hub ? (
              <>
                {" "}
                <a className="chip" href={r.hub.modelUrl} target="_blank" rel="noopener noreferrer">
                  On Hugging Face
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </>
            ) : null}
          </>
        }
        actions={
          <Link className="btn btn-outline" href="/fine-tuning#results">
            <Icon name="chevronLeft" size={18} />
            All results
          </Link>
        }
      />

      {aside}
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
          {r.hub ? (
            <div>
              <dt>On Hugging Face</dt>
              <dd>
                <ExternalLink href={r.hub.modelUrl}>The adapter and its model card</ExternalLink>
                {r.hub.datasetUrl ? (
                  <>
                    {" · "}
                    <ExternalLink href={r.hub.datasetUrl}>The training data</ExternalLink>
                  </>
                ) : null}
              </dd>
            </div>
          ) : null}
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
          Both models answered each held-out prompt. {judge} saw the two answers in random order, without knowing which
          model wrote which.
        </p>
      </section>

      <EvalResults
        state={{ state: "judged", summary: r.summary }}
        rows={rows}
        model={tunedModelName(r.recipe)}
        writer={dataset ? writerName(dataset) : null}
        judge={judge}
      />
    </div>
  );
}

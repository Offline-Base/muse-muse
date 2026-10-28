import { LongText } from "@/components/train/LongText";
import {
  WRITER_NAME,
  itemNumber,
  scoreText,
  verdictLabel,
  verdictTone,
  type EvalRow,
  type EvalState,
} from "@/components/train/format";
import { usd } from "@/lib/format";

export interface EvalResultsProps {
  state: EvalState;
  rows: EvalRow[];
  /** What the recipe tunes, as the copy names it: "Glimmer", or "model". */
  model: string;
}

/**
 * The job page's eval results: a summary strip once Muse Spark 1.3 has judged the held-out prompts ("Judging..." until
 * then), and every item with the reference, the base and the tuned answer and the verdict. Long text folds.
 */
export function EvalResults({ state, rows, model }: EvalResultsProps) {
  if (state.state === "none") return null;
  return (
    <section className="train-eval" id="eval-results" aria-labelledby="train-eval-title">
      <div className="train-log-head">
        <h2 id="train-eval-title">Eval results</h2>
        {rows.length ? <span className="muted small">{rows.length} held-out prompts</span> : null}
      </div>
      <div aria-live="polite">
        <EvalStatus state={state} model={model} />
      </div>
      {rows.length ? <EvalTable rows={rows} model={model} judging={state.state === "judging"} /> : null}
    </section>
  );
}

function EvalStatus({ state, model }: { state: EvalState; model: string }) {
  switch (state.state) {
    case "judged": {
      const s = state.summary;
      return (
        <div className="card totals train-eval-strip">
          <p className="totals-big">
            Tuned {model} beat base on{" "}
            <strong>
              {s.tunedWins} of {s.items}
            </strong>
            , base won <strong>{s.baseWins}</strong>, ties <strong>{s.ties}</strong>
          </p>
          <p className="train-eval-sub">
            Average score base <strong>{scoreText(s.avgBaseScore)}</strong>, tuned{" "}
            <strong>{scoreText(s.avgTunedScore)}</strong>, judged by {WRITER_NAME}.
          </p>
          <p className="muted small">
            Scores run from 1 to 10 against {WRITER_NAME}&apos;s reference answer. Judging cost {usd(s.judgeCostUsd)}.
          </p>
        </div>
      );
    }
    case "judging":
      return (
        <p className="turn turn-working train-working">
          <span className="working-dot" aria-hidden />
          <span>Judging...</span>
          <span className="muted">
            {state.judged} of {state.total} judged by {WRITER_NAME}
          </span>
        </p>
      );
    case "answering":
      return (
        <p className="muted small">
          The job sends these as it answers them. {WRITER_NAME} judges them once the GPU shuts down.
        </p>
      );
    case "unjudged":
      return <p className="muted small">{state.reason}</p>;
    default:
      return null;
  }
}

function EvalTable({ rows, model, judging }: { rows: EvalRow[]; model: string; judging: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data train-eval-table">
        <caption className="sr-only">
          Each held-out prompt with {WRITER_NAME}&apos;s reference, the base and the tuned {model}&apos;s answers, and the
          verdict
        </caption>
        <colgroup>
          <col className="train-eval-col-text" />
          <col className="train-eval-col-text" />
          <col className="train-eval-col-text" />
          <col className="train-eval-col-verdict" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{WRITER_NAME} reference</th>
            <th scope="col">Base {model}</th>
            <th scope="col">Tuned {model}</th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        {rows.map((r) => {
          const j = r.judgement;
          return (
            <tbody key={r.index}>
              <tr className="train-eval-prompt">
                <th scope="rowgroup" colSpan={4}>
                  <span className="train-eval-num">Prompt {itemNumber(r.index)}</span>
                  <LongText text={r.prompt} foldAt={480} preview={300} />
                </th>
              </tr>
              <tr>
                <td>
                  <LongText text={r.reference} />
                </td>
                <td className={j?.better === "base" ? "train-eval-win" : undefined}>
                  <LongText text={r.base} />
                </td>
                <td className={j?.better === "tuned" ? "train-eval-win" : undefined}>
                  <LongText text={r.tuned} />
                </td>
                <td>
                  {j ? (
                    <div className="train-verdict">
                      <span className={`pill pill-${verdictTone(j.better)}`}>{verdictLabel(j.better)}</span>
                      <p className="train-scores">
                        Base {j.baseScore} · Tuned {j.tunedScore}
                      </p>
                      {j.note ? <p className="train-note">{j.note}</p> : null}
                    </div>
                  ) : (
                    <span className="muted small">{judging ? "Judging" : "Not judged"}</span>
                  )}
                </td>
              </tr>
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

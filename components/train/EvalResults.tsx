import { LongText } from "@/components/train/LongText";
import {
  itemNumber,
  judgeComparabilityNote,
  scoreText,
  verdictLabel,
  verdictTone,
  type EvalRow,
  type EvalState,
} from "@/components/train/format";
import { usd } from "@/lib/format";
import { checkNumber, checkSetOf } from "@/lib/train/general-checks";
import type { EvalCheckSummary } from "@/lib/train/types";

export interface EvalResultsProps {
  state: EvalState;
  rows: EvalRow[];
  /** What the recipe tunes, as the copy names it: "Glimmer", or "model". */
  model: string;
  /**
   * The models from the records, as the copy names them (writerName and judgeName in format.ts): the dataset's writer,
   * who wrote the references (null when the page doesn't have the dataset, so the copy says "the reference"), and the
   * job's judge.
   */
  writer: string | null;
  judge: string;
  /**
   * True for a job trained from r30b (isSparkOpenDerivative, lib/train/base.ts): the copy compares the tuned model with
   * the 2026 Glimmer it started from. Base Glimmer otherwise.
   */
  sparkOpen?: boolean;
}

/** How the copy names the model a job started from: in a sentence, as a column, and before a score. */
function baseWords(model: string, sparkOpen: boolean) {
  return sparkOpen
    ? { inLine: "the 2026 Glimmer it started from", column: "2026 Glimmer (r30b)", short: "r30b" }
    : { inLine: "base", column: `Base ${model}`, short: "Base" };
}

/** A row's label: "Prompt N" for a held-out prompt, or which general check it is (lib/train/general-checks.ts). */
function PromptLabel({ index }: { index: number }) {
  const set = checkSetOf(index);
  if (set === "general") return <>General check {checkNumber(index)}</>;
  if (set === "safety") return <>Safety check {checkNumber(index)}</>;
  return <>Prompt {itemNumber(index)}</>;
}

/**
 * The job page's eval results: a summary strip once the job's judge has judged the held-out prompts ("Judging..."
 * until then), and every item with the reference, the base and the tuned answer and the verdict. Long text folds. A
 * job that also answered the general checks (TUNE_GENERAL_CHECKS) gets their results as lines of their own, and their
 * rows after the held-out prompts; a job without them shows exactly what it did before.
 */
export function EvalResults({ state, rows, model, writer, judge, sparkOpen = false }: EvalResultsProps) {
  const base = baseWords(model, sparkOpen);
  if (state.state === "none") return null;
  const checks = rows.filter((r) => checkSetOf(r.index) !== null).length;
  return (
    <section className="train-eval" id="eval-results" aria-labelledby="train-eval-title">
      <div className="train-log-head">
        <h2 id="train-eval-title">Eval results</h2>
        {rows.length ? (
          <span className="muted small">
            {rows.length - checks} held-out prompts{checks ? `, ${checks} general checks` : null}
          </span>
        ) : null}
      </div>
      <div aria-live="polite">
        <EvalStatus state={state} model={model} writer={writer} judge={judge} base={base} />
      </div>
      {rows.length ? <EvalTable rows={rows} model={model} writer={writer} judging={state.state === "judging"} base={base} /> : null}
    </section>
  );
}

type BaseWords = ReturnType<typeof baseWords>;

function EvalStatus({ state, model, writer, judge, base }: { state: EvalState; model: string; writer: string | null; judge: string; base: BaseWords }) {
  switch (state.state) {
    case "judged": {
      const s = state.summary;
      return (
        <div className="card totals train-eval-strip">
          <p className="totals-big">
            Tuned {model} beat {base.inLine} on{" "}
            <strong>
              {s.tunedWins} of {s.items}
            </strong>
            , {base.short === "Base" ? "base" : base.short} won <strong>{s.baseWins}</strong>, ties <strong>{s.ties}</strong>
          </p>
          <p className="train-eval-sub">
            Average score {base.short === "Base" ? "base" : base.short} <strong>{scoreText(s.avgBaseScore)}</strong>, tuned{" "}
            <strong>{scoreText(s.avgTunedScore)}</strong>, judged by {judge}.
          </p>
          {s.general ? <CheckLine label="General ability check" c={s.general} base={base} model={model} /> : null}
          {s.safety ? <CheckLine label="Safety check" c={s.safety} base={base} model={model} /> : null}
          <p className="muted small">
            Scores run from 1 to 10 against {writer ? `${writer}'s reference answer` : "the reference answer"}. Judging cost{" "}
            {usd(s.judgeCostUsd)}.
          </p>
          {judgeComparabilityNote(judge) ? <p className="muted small">{judgeComparabilityNote(judge)}</p> : null}
        </div>
      );
    }
    case "judging":
      return (
        <p className="turn turn-working train-working">
          <span className="working-dot" aria-hidden />
          <span>Judging...</span>
          <span className="muted">
            {state.judged} of {state.total} judged by {judge}
          </span>
        </p>
      );
    case "answering":
      return (
        <p className="muted small">
          The job sends these as it answers them. {judge} judges them once the GPU shuts down.
        </p>
      );
    case "unjudged":
      return <p className="muted small">{state.reason}</p>;
    default:
      return null;
  }
}

/** One general check set's result, as its own line in the judged strip. */
function CheckLine({ label, c, base, model }: { label: string; c: EvalCheckSummary; base: BaseWords; model: string }) {
  const short = base.short === "Base" ? "base" : base.short;
  if (!c.items) {
    return (
      <p className="train-eval-sub">
        {label}: none of its {c.asked} prompts could be judged.
      </p>
    );
  }
  return (
    <p className="train-eval-sub">
      {label}, {c.items} fixed prompts outside the task: tuned {model} better on <strong>{c.tunedWins}</strong>, {short} on{" "}
      <strong>{c.baseWins}</strong>, ties <strong>{c.ties}</strong>. Average {short} <strong>{scoreText(c.avgBaseScore)}</strong>, tuned{" "}
      <strong>{scoreText(c.avgTunedScore)}</strong>.
    </p>
  );
}

function EvalTable({ rows, model, writer, judging, base }: { rows: EvalRow[]; model: string; writer: string | null; judging: boolean; base: BaseWords }) {
  return (
    <div className="table-wrap">
      <table className="data train-eval-table">
        <caption className="sr-only">
          Each held-out prompt with {writer ? `${writer}'s reference` : "the reference"}, {base.short === "Base" ? "the base" : base.inLine}{" "}
          and the tuned {model}&apos;s answers, and the verdict
        </caption>
        <colgroup>
          <col className="train-eval-col-text" />
          <col className="train-eval-col-text" />
          <col className="train-eval-col-text" />
          <col className="train-eval-col-verdict" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{writer ? `${writer} reference` : "Reference"}</th>
            <th scope="col">{base.column}</th>
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
                  <span className="train-eval-num">
                    <PromptLabel index={r.index} />
                  </span>
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
                        {base.short} {j.baseScore} · Tuned {j.tunedScore}
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

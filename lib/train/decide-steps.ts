/**
 * Scoring a decide job after its run (docs/DECISION_MODELS.md, "Scoring (logic.ts)"): the "use step" the training
 * workflow (lib/train/workflow.ts) runs in place of judging for a glimmer-lora job in decide mode, once its instance is
 * terminated. It reads the GPU's "decide" events and the dataset's dev and test rows, lays each part out the way the
 * dataset route served it (decisionScoringInput), and saves summarizeDecisions' result as the job's eval_summary, then
 * logs a line that says how the models did. Deterministic: no judge, no Meta call, nothing spent, and the same records
 * always give the same summary. Like judging, it never changes the job's status.
 *
 * A job that didn't succeed is scored too when its GPU sent scores (the base scores go out before anything else can
 * fail): its summary holds what was measured, and the result pages, which show only jobs that succeeded, never show
 * it. When nothing can be scored the summary is an unjudged one whose note says why (unjudgedSummary), so the job page
 * reads the outcome from the job's own record, never from the log.
 */
import { RetryableError } from "workflow";
import type { DecisionSummary, WilsonRate } from "@/lib/decide/types";
import { plural } from "@/lib/format";
import { decisionScoringInput, rowsInOrder } from "@/lib/train/decision-datasets";
import { ADAPTER_RECIPE, DECIDE_MODE, DECIDE_T_MIN_ROWS, jobMode, summarizeDecisions, unjudgedSummary } from "@/lib/train/logic";
import { decideScores, decisionSplitRows, getAdapterSource, getDataset, recordEvent, setEvalSummary } from "@/lib/train/store";

const DB_RETRY_AFTER = "30s";

/** What scoreDecisionStep saved: a decision summary, an unjudged note, or nothing. Small, since step results persist. */
export type DecisionScoreResult =
  | { saved: "summary"; items: number; testRows: number }
  | { saved: "note"; note: string }
  | { saved: "none" };

const NOTHING: DecisionScoreResult = { saved: "none" };

// ---------------------------------------------------------------------------------------------------------------
// Helpers (not steps)

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A database call whose failure is retried after 30 s rather than 1 s. */
async function fromDb<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new RetryableError(`The database did not answer: ${message(err)}`, { retryAfter: DB_RETRY_AFTER });
  }
}

/** "71 (89%)": the rows right, and the share. */
function rightOf(rate: WilsonRate): string {
  return `${rate.right} (${Math.round(rate.rate * 100)}%)`;
}

/**
 * The job log's line for a scored summary: how many held-out examples were scored, how often each model was right,
 * the rows left out and why, whether confidence is calibrated, and that it can be wrong. For a job that didn't succeed
 * it says these are only the scores its GPU sent before it stopped.
 */
export function decisionScoreText(s: DecisionSummary, job: { status: string; scoreOnly: boolean }): string {
  const out: string[] = [];
  if (job.status !== "succeeded") out.push("The job didn't succeed, so these are only the scores its GPU sent before it stopped.");
  const scored = s.items === s.testRows ? `all ${plural(s.testRows, "held-out example")}` : `${s.items} of the ${plural(s.testRows, "held-out example")}`;
  if (s.tuned) {
    out.push(`Scored ${scored}, with no judge and nothing spent: the tuned model was right on ${rightOf(s.tuned.accuracy)}, base Glimmer on ${rightOf(s.base.accuracy)}.`);
  } else {
    out.push(`Scored base Glimmer on ${scored}, with no judge and nothing spent: it was right on ${rightOf(s.base.accuracy)}.`);
    out.push(job.scoreOnly ? "Score only, so nothing trained." : "The tuned model sent no scores, so there is nothing to compare it with.");
  }
  if (s.unscoredRows) {
    out.push(`${plural(s.unscoredRows, "held-out example")} had no usable score, so ${s.unscoredRows === 1 ? "it is" : "they are"} left out of every number.`);
  }
  if (s.tooLong) out.push(`${plural(s.tooLong, "rendering")} ${s.tooLong === 1 ? "was" : "were"} too long to score.`);
  const side = s.tuned ?? s.base;
  out.push(
    side.calibrated
      ? `Confidence is calibrated on the dev rows (T = ${side.T}).`
      : `Fewer than ${DECIDE_T_MIN_ROWS} dev rows were scored, so confidence isn't calibrated.`,
  );
  out.push("It can be wrong: check anything that matters.");
  return out.join(" ");
}

/** The note of a summary with no scored test row: why there are no results. */
export function noRowsNote(s: DecisionSummary): string {
  const left = s.testRows === 1 ? "the 1 held-out example was left out" : `all ${s.testRows} held-out examples were left out`;
  const tooLong = s.tooLong ? ` ${plural(s.tooLong, "rendering")} ${s.tooLong === 1 ? "was" : "were"} too long to score.` : "";
  return `Scoring found no held-out example with a usable score for every rendering, so there are no results: ${left}.${tooLong}`;
}

/** Saves an unjudged summary whose note says why the job has no results, and logs the note. */
async function saveNote(jobId: string, note: string): Promise<DecisionScoreResult> {
  const summary = unjudgedSummary(note);
  await fromDb(() => setEvalSummary(jobId, summary));
  await fromDb(() => recordEvent(jobId, { type: "log", text: summary.note }));
  return { saved: "note", note: summary.note };
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

/**
 * Scores the decide job `jobId` and saves its eval summary (docs/DECISION_MODELS.md, "Scoring (logic.ts)"): its GPU's
 * scores ("decide" events, a repeated index counted once), its dataset's dev and test rows read whole, each part laid
 * out by decisionItems as the dataset route served it, its done metrics' too_long, and summarizeDecisions. Then a log
 * line (decisionScoreText). Nothing for a job that isn't a glimmer-lora job in decide mode, or that has a summary
 * already (an earlier attempt saved it). A job with no scores at all gets a note only when it succeeded; a dataset or
 * rows that are gone or don't match its spec, or scores summarizeDecisions refuses, get a note that says so; a summary
 * with no scored test row carries its own note (noRowsNote). Database errors are retried every 30 s, about 10 minutes
 * in all. Never touches the job's status.
 */
export async function scoreDecisionStep(jobId: string): Promise<DecisionScoreResult> {
  "use step";
  const source = await fromDb(() => getAdapterSource(jobId));
  const job = source?.job;
  if (!job || job.recipe !== ADAPTER_RECIPE || jobMode(job.params) !== DECIDE_MODE || job.evalSummary) return NOTHING;
  const scores = await fromDb(() => decideScores(jobId));
  if (!scores.dev.length && !scores.test.length) {
    return job.status === "succeeded" ? saveNote(jobId, "Scoring found no decision scores from the GPU, so this job has no results.") : NOTHING;
  }

  const datasetId = typeof job.params?.datasetId === "string" ? job.params.datasetId : "";
  const dataset = datasetId ? await fromDb(() => getDataset(datasetId)) : null;
  const spec = dataset?.kind === "decision" ? dataset.decision : null;
  const dev = spec ? await fromDb(() => decisionSplitRows(datasetId, "dev")) : null;
  const test = spec ? await fromDb(() => decisionSplitRows(datasetId, "test")) : null;
  if (!spec || !dev || !test) {
    return saveNote(jobId, "Scoring skipped: the job's decision dataset is gone, so the GPU's scores can't be matched to its examples.");
  }
  const devRows = rowsInOrder(dev);
  const testRows = rowsInOrder(test);
  if (!devRows || !testRows) {
    return saveNote(jobId, "Scoring failed: the dataset's dev and test rows don't match its spec, so the GPU's scores can't be matched to them.");
  }

  let summary: DecisionSummary;
  try {
    const tooLong = Number(source.metrics?.too_long ?? 0);
    summary = summarizeDecisions(decisionScoringInput(spec, { dev: devRows, test: testRows }, scores, tooLong));
  } catch (err) {
    const why = message(err);
    return saveNote(jobId, `Scoring failed: ${why.charAt(0).toLowerCase()}${why.slice(1)}`);
  }
  const text = summary.items ? decisionScoreText(summary, { status: job.status, scoreOnly: Number(job.params?.scoreOnly) >= 1 }) : noRowsNote(summary);
  if (!summary.items) summary = { ...summary, note: text };
  await fromDb(() => setEvalSummary(jobId, summary));
  await fromDb(() => recordEvent(jobId, { type: "log", text }));
  return { saved: "summary", items: summary.items, testRows: summary.testRows };
}
scoreDecisionStep.maxRetries = 20;

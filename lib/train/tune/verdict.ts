/**
 * Whether a tuned model passed (docs/TRAINING.md "Fine-tune like a build", "Verdict"): the one rule the run room, and
 * later unit 11's ownModelFor, use to decide that a product may answer with its own model. Pure.
 *
 * A chat run passes when at least 8 kept-aside prompts were judged, tuned won more of them than base and at least half
 * of them, and tuned's average score is at least a point above base's. A decision run passes when tuned's accuracy on
 * the test rows is above base's by more than the Wilson half-width of tuned's accuracy (95%).
 */
import { scoreText } from "@/components/train/format";
import type { DecisionSummary } from "@/lib/decide/types";
import type { TuneVerdict } from "@/lib/train/tune/types";
import type { EvalSummary } from "@/lib/train/types";

/** Judged items a verdict needs. Fewer can't tell training apart from luck. */
export const VERDICT_MIN_ITEMS = 8;
/** Points tuned's average score must beat base's by (scores are 1 to 10). */
export const VERDICT_SCORE_MARGIN = 1;

/** z for a two-sided 95% interval. */
const Z95 = 1.96;

/** Half the width of the Wilson score interval for `right` of `total` at 95%, 0 to 0.5. */
export function wilsonHalfWidth(right: number, total: number): number {
  if (!(total > 0)) return 0.5;
  const p = Math.min(1, Math.max(0, right / total));
  const z2 = Z95 * Z95;
  return (Z95 * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / (1 + z2 / total);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A decide job's summary (tg-decide's DecisionSummary, which extends EvalSummary with kind "decision"). */
function isDecision(s: EvalSummary | DecisionSummary): s is DecisionSummary {
  return (s as Partial<DecisionSummary>).kind === "decision";
}

/**
 * Passed or not, with one sentence that says why. A decision summary is read by its test rows' accuracy (base.accuracy
 * and tuned.accuracy, right of total), never by its EvalSummary fields: tunedWins and baseWins there count the rows one
 * got right and the other wrong, and its scores are 0. `sparkOpen` (a job trained on r30b, isSparkOpenDerivative) names
 * the model it is compared with r30b, the 2026 Glimmer it started from; otherwise it is base Glimmer, as "base".
 */
export function evalVerdict(s: EvalSummary | DecisionSummary, sparkOpen = false): TuneVerdict {
  if (isDecision(s)) {
    const base = s.base?.accuracy;
    const tuned = s.tuned?.accuracy;
    if (!base) return { passed: false, words: "Not scored yet, so it hasn't passed." };
    if (!tuned || !(tuned.total > 0) || !(base.total > 0)) return { passed: false, words: "Not scored yet, so it hasn't passed." };
    const tunedRate = tuned.right / tuned.total;
    const baseRate = base.right / base.total;
    const margin = wilsonHalfWidth(tuned.right, tuned.total);
    const passed = tuned.total >= VERDICT_MIN_ITEMS && tunedRate - baseRate > margin;
    const words = `Tuned got ${tuned.right} of ${tuned.total} test rows right (${pct(tunedRate)}), ${sparkOpen ? "r30b" : "base"} ${base.right} of ${base.total} (${pct(baseRate)}).`;
    const than = sparkOpen ? " than the 2026 Glimmer it started from" : "";
    return { passed, words: passed ? words : `${words} That isn't clearly better${than}, so it didn't pass.` };
  }
  const items = Math.max(0, Math.floor(s.items));
  if (items === 0) return { passed: false, words: "Nothing was judged, so it hasn't passed." };
  const scores = `(${scoreText(s.avgTunedScore)} vs ${scoreText(s.avgBaseScore)})`;
  const words = `Tuned won ${s.tunedWins} of ${items} kept-aside prompts ${scores}.`;
  if (items < VERDICT_MIN_ITEMS) return { passed: false, words: `${words} That's too few to tell, so it didn't pass.` };
  const passed =
    s.tunedWins > s.baseWins && s.tunedWins >= items / 2 && s.avgTunedScore >= s.avgBaseScore + VERDICT_SCORE_MARGIN;
  const than = sparkOpen ? "the 2026 Glimmer it started from" : "base";
  return { passed, words: passed ? words : `${words} That isn't clearly better than ${than}, so it didn't pass.` };
}

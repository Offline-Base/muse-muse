/**
 * Whether a tuned model passed (docs/TRAINING.md "Fine-tune like a build", "Verdict"): the one rule the run room, and
 * later unit 11's ownModelFor, use to decide that a product may answer with its own model. Pure.
 *
 * A chat run passes when at least 8 kept-aside prompts were judged, tuned won more of them than base and at least half
 * of them, and tuned's average score is at least a point above base's. A decision run passes when tuned's accuracy on
 * the test rows is above base's by more than the Wilson half-width of tuned's accuracy (95%).
 */
import { scoreText } from "@/components/train/format";
import type { TuneVerdict } from "@/lib/train/tune/types";
import type { EvalSummary } from "@/lib/train/types";

/** Judged items a verdict needs. Fewer can't tell training apart from luck. */
export const VERDICT_MIN_ITEMS = 8;
/** Points tuned's average score must beat base's by (scores are 1 to 10). */
export const VERDICT_SCORE_MARGIN = 1;

/**
 * The part of tg-decide's DecisionSummary (lib/decide/types.ts on that branch) the verdict reads, so this file needn't
 * wait for it: accuracy as right of total on the test rows, for base and, once scored, tuned.
 */
export interface DecisionScores {
  kind: "decision";
  items: number;
  base: { accuracy: { right: number; total: number } };
  tuned: { accuracy: { right: number; total: number } } | null;
}

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

function isDecision(s: EvalSummary | DecisionScores): s is DecisionScores {
  return (s as DecisionScores).kind === "decision";
}

/** Passed or not, with one sentence that says why. */
export function evalVerdict(s: EvalSummary | DecisionScores): TuneVerdict {
  if (isDecision(s)) {
    const base = s.base.accuracy;
    const tuned = s.tuned?.accuracy;
    if (!tuned || !(tuned.total > 0) || !(base.total > 0)) return { passed: false, words: "Not scored yet, so it hasn't passed." };
    const tunedRate = tuned.right / tuned.total;
    const baseRate = base.right / base.total;
    const margin = wilsonHalfWidth(tuned.right, tuned.total);
    const passed = tuned.total >= VERDICT_MIN_ITEMS && tunedRate - baseRate > margin;
    const words = `Tuned got ${tuned.right} of ${tuned.total} test rows right (${pct(tunedRate)}), base ${base.right} of ${base.total} (${pct(baseRate)}).`;
    return { passed, words: passed ? words : `${words} That isn't clearly better, so it didn't pass.` };
  }
  const items = Math.max(0, Math.floor(s.items));
  if (items === 0) return { passed: false, words: "Nothing was judged, so it hasn't passed." };
  const scores = `(${scoreText(s.avgTunedScore)} vs ${scoreText(s.avgBaseScore)})`;
  const words = `Tuned won ${s.tunedWins} of ${items} kept-aside prompts ${scores}.`;
  if (items < VERDICT_MIN_ITEMS) return { passed: false, words: `${words} That's too few to tell, so it didn't pass.` };
  const passed =
    s.tunedWins > s.baseWins && s.tunedWins >= items / 2 && s.avgTunedScore >= s.avgBaseScore + VERDICT_SCORE_MARGIN;
  return { passed, words: passed ? words : `${words} That isn't clearly better than base, so it didn't pass.` };
}

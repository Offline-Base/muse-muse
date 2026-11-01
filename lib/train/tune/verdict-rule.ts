/**
 * The chat rule a verdict reads (./verdict.ts), on its own with no import from components/, so the tuning loop's steps
 * (./loop-steps.ts) use the very same rule. Pure.
 */
import type { EvalSummary } from "@/lib/train/types";

/** Judged items a verdict needs. Fewer can't tell training apart from luck. */
export const VERDICT_MIN_ITEMS = 8;
/** Points tuned's average score must beat base's by (scores are 1 to 10). */
export const VERDICT_SCORE_MARGIN = 1;

/** Enough items judged, tuned won more than base and at least half, and tuned's average is a point above base's. */
export function chatPasses(s: Pick<EvalSummary, "items" | "tunedWins" | "baseWins" | "avgTunedScore" | "avgBaseScore">): boolean {
  const items = Math.max(0, Math.floor(s.items));
  return items >= VERDICT_MIN_ITEMS && s.tunedWins > s.baseWins && s.tunedWins >= items / 2 && s.avgTunedScore >= s.avgBaseScore + VERDICT_SCORE_MARGIN;
}

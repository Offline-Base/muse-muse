/**
 * Unit 11's seam to General's lib/train/base.ts and evalVerdict. The r30b rule and its words live there alone.
 */
import { BUILT_WITH_SPARK_OPEN, USAGE_POINTS, isSparkOpenDerivative } from "@/lib/train/base";
import { evalVerdict } from "@/lib/train/tune/verdict";
import type { DecisionSummary } from "@/lib/decide/types";
import type { TuneVerdict } from "@/lib/train/tune/types";
import type { EvalSummary } from "@/lib/train/types";

export { BUILT_WITH_SPARK_OPEN, USAGE_POINTS, isSparkOpenDerivative };

/** evalVerdict, which names r30b as the base when the run is a Derivative. */
export function verdictFor(summary: EvalSummary | DecisionSummary, sparkOpen: boolean): TuneVerdict {
  return evalVerdict(summary, sparkOpen);
}

/** The line a served Derivative's reply carries, or null for a model that isn't one. */
export function derivativeNote(sparkOpen: boolean): string | null {
  return sparkOpen ? `${BUILT_WITH_SPARK_OPEN}. ${USAGE_POINTS.join(" ")}` : null;
}

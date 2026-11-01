/**
 * The one seam to General's lib/train/base.ts (docs/CAPABILITIES.md, section 17; ~/mm-wt/_plan/wave3.md, "r30b base"), which
 * isn't on tg-cap-int yet. Once it lands, this file becomes re-exports of isSparkOpenDerivative, BUILT_WITH_SPARK_OPEN and
 * USAGE_POINTS, and verdictFor passes `sparkOpen` as evalVerdict's second argument. Nothing else in unit 11 changes.
 */
import { evalVerdict } from "@/lib/train/tune/verdict";
import type { DecisionSummary } from "@/lib/decide/types";
import type { TuneVerdict } from "@/lib/train/tune/types";
import type { EvalSummary } from "@/lib/train/types";

/** The repo every build of r30b is named from (R30B_REPO there). */
const R30B_REPO = "OfflineBase/Glimmer-30B-2026-Knowledge";

export const BUILT_WITH_SPARK_OPEN = "Built with Muse Spark Open";

/** What a person must be told about a Derivative (USAGE_POINTS there, from the Muse Model License's Exhibit A). */
export const USAGE_POINTS: readonly string[] = [
  "For people 18 and over only.",
  "Its answers are written by a model. Never present them as written by a person.",
  "It can make up answers, and it can go along with a false premise in a question. Check what it says before you rely on it.",
];

const isR30b = (id: unknown) => typeof id === "string" && (id === R30B_REPO || id.startsWith(`${R30B_REPO}-`));

/** General's single rule: a lab model is a Derivative when anything recorded about its base names r30b. */
export function isSparkOpenDerivative(job: { params?: Readonly<Record<string, unknown>> | null; metrics?: Readonly<Record<string, unknown>> | null } | null | undefined): boolean {
  if (!job) return false;
  return isR30b(job.params?.baseModel) || isR30b(job.metrics?.base_model) || isR30b(job.metrics?.merge_base);
}

/** evalVerdict. `_sparkOpen` goes through as its second argument once that argument is on tg-cap-int. */
export function verdictFor(summary: EvalSummary | DecisionSummary, _sparkOpen: boolean): TuneVerdict {
  return evalVerdict(summary);
}

/** The line a served Derivative's reply carries, or null for a model that isn't one. */
export function derivativeNote(sparkOpen: boolean): string | null {
  return sparkOpen ? `${BUILT_WITH_SPARK_OPEN}. ${USAGE_POINTS.join(" ")}` : null;
}

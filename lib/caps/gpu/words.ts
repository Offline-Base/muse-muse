/**
 * The words a tuned Derivative must show (lib/train/base.ts there, once it lands; see general.ts). No imports: the /models
 * slot uses these on a page with its flags off.
 */
export const BUILT_WITH_SPARK_OPEN = "Built with Muse Spark Open";

/** What a person must be told about a Derivative (USAGE_POINTS there, from the Muse Model License's Exhibit A). */
export const USAGE_POINTS: readonly string[] = [
  "For people 18 and over only.",
  "Its answers are written by a model. Never present them as written by a person.",
  "It can make up answers, and it can go along with a false premise in a question. Check what it says before you rely on it.",
];

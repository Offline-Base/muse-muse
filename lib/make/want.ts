/**
 * What the Make box's menu can ask for (docs/TRAINING.md "One box for everything"). Auto leaves it to the sentence. Pure
 * and browser-safe.
 */
export const MAKE_WANTS = ["auto", "app", "model", "both", "dataset"] as const;
export type MakeWant = (typeof MAKE_WANTS)[number];

export const WANT_WORDS: Record<MakeWant, { title: string; note: string }> = {
  auto: { title: "Auto", note: "Muse decides from what you write" },
  app: { title: "App", note: "A product with its own link" },
  model: { title: "Model", note: "A model tuned for one job, and scored" },
  both: { title: "App and model", note: "Builds both from one Start" },
  dataset: { title: "Dataset", note: "Writes examples and stops, with no training" },
};

/** Only these run anywhere, so "where it runs" is only asked for them. */
export const wantHasApp = (want: MakeWant): boolean => want === "auto" || want === "app" || want === "both";

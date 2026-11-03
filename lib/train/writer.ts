import { testModel } from "@/lib/env";
import { defaultModel } from "@/lib/meta/spark";

/**
 * The model that writes a described (task) run's examples: TEST_MODEL off production, else the dataset writer
 * (defaultModel(), Contributor while BUILDS_ON_CONTRIBUTOR is on, the same value as DATASET_MODEL). Kept in its own
 * light module so POST /api/train/plan can say who will write before a run starts.
 */
export function taskWriterModel(): string {
  return testModel() ?? defaultModel();
}

/** A run's room on the site, relative to its origin. */
export function runHref(runId: string): string {
  return `/fine-tuning/runs/${runId}`;
}

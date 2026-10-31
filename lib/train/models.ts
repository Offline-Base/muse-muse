/**
 * Which Muse model did the fine-tuning lab's own work, read from the record (docs/TRAINING.md "Which model did the
 * work"). Muse Wonder writes new datasets, judges new runs and tells new Hub stories (DATASET_MODEL, JUDGE_MODEL and
 * STORY_MODEL). The lab started recording the model on Oct 29, 2026, when Muse Wonder took over from Muse Spark 1.3:
 * everything made before then was made by Muse Spark 1.3, so a record with no model reads as Muse Spark 1.3. History is
 * never relabeled. Pure functions only, so the pages, the cards and the steps share them.
 */
import type { DecisionSummary } from "@/lib/decide/types";
import { modelLabel } from "@/lib/format";
import { RETIRED_SPARK } from "@/lib/meta/spark";
import type { EvalSummary } from "@/lib/train/types";

/** The model a lab record with no model names: Muse Spark 1.3, which did all of the lab's work before Oct 29, 2026. */
export const UNRECORDED_MODEL = RETIRED_SPARK;

/**
 * writer_model of a decision dataset a person uploaded (docs/DECISION_MODELS.md): no model wrote its rows, the person
 * labeled them. Saved on every such dataset, never left null, since null reads as Muse Spark 1.3.
 */
export const PERSON_WRITER = "person";
/** writer_model of Muse Decide's mix: public datasets under their own licenses, not a Muse model's output. */
export const PUBLIC_WRITER = "public";

/** How the pages and the cards name a dataset's writer that isn't a model. */
const NOT_A_MODEL: Record<string, string> = {
  [PERSON_WRITER]: "The person who uploaded it",
  [PUBLIC_WRITER]: "Public datasets",
};

/** True when a dataset's writer_model says a person or public data wrote it, not a Muse model. */
export function isModelWriter(writer: string): boolean {
  return !Object.hasOwn(NOT_A_MODEL, writer);
}

/** The model a record names: its own, trimmed, or Muse Spark 1.3 when it has none (UNRECORDED_MODEL). */
export function recordedModel(model: string | null | undefined): string {
  const m = typeof model === "string" ? model.trim() : "";
  return m || UNRECORDED_MODEL;
}

/**
 * A model id as the pages and the cards name it: "Muse Wonder", "Muse Spark 1.3" (modelLabel in lib/format.ts). A
 * decision dataset's writer, which isn't a model, by what it is: "The person who uploaded it", "Public datasets".
 */
export function modelName(model: string): string {
  return Object.hasOwn(NOT_A_MODEL, model) ? NOT_A_MODEL[model]! : modelLabel(model);
}

/**
 * The model that wrote a dataset's prompts and answers: its writer_model, else Muse Spark 1.3. For a decision dataset,
 * PERSON_WRITER or PUBLIC_WRITER (isModelWriter is false for both).
 */
export function writerModelOf(dataset: { writerModel?: string | null } | null | undefined): string {
  return recordedModel(dataset?.writerModel);
}

/** True when an eval summary holds verdicts, not the note of judging that was skipped or judged nothing. */
export function isJudged(summary: EvalSummary | null | undefined): boolean {
  return Boolean(summary) && Number(summary!.items) > 0;
}

/**
 * True for a decide job's eval summary (docs/DECISION_MODELS.md, "Scoring"): scored from the GPU's own log-probabilities
 * by scoreDecisionStep, with no judge. Its `kind` is "decision".
 */
export function isDecisionSummary(summary: EvalSummary | null | undefined): summary is DecisionSummary {
  return Boolean(summary) && (summary as { kind?: unknown }).kind === "decision";
}

/**
 * The model that judged a job's eval items, or is judging them: its judge_model; else Muse Spark 1.3 for a job with
 * verdicts, judged before the judge was recorded; else null, for a job no judge has started on. A decision summary
 * was scored, not judged, so it names no judge.
 */
export function judgeModelOf(job: { judgeModel?: string | null; evalSummary?: EvalSummary | null }): string | null {
  const m = typeof job.judgeModel === "string" ? job.judgeModel.trim() : "";
  if (m) return m;
  if (isDecisionSummary(job.evalSummary)) return null;
  return isJudged(job.evalSummary) ? UNRECORDED_MODEL : null;
}

/**
 * The model that wrote a Hub card's story: its storyModel when a model wrote it (storyBy "spark", the value's name
 * from before the model was recorded), else Muse Spark 1.3; null for the template's story or none.
 */
export function storyModelOf(hub: { storyBy?: string | null; storyModel?: string | null } | null | undefined): string | null {
  return hub?.storyBy === "spark" ? recordedModel(hub.storyModel) : null;
}

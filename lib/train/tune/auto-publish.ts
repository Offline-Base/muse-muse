/**
 * Whether a run's model uploads to Hugging Face by itself (TUNE_AUTO_PUBLISH, docs/TRAINING.md "Auto upload"), and what
 * the plan card says about it. Pure and browser-safe. The signed plan keeps `publish: 0`, so plan hashes don't change:
 * Start keeps the choice with the run (saveRunAutoPublish) and launchForRun turns it into the job's publish param.
 */
import { PUBLIC_WRITER } from "@/lib/train/models";
import { FOLD_HEAD } from "@/lib/train/tune/examples";

/** True when a dataset's task quotes a person's own rows (foldExamples), old datasets included: the card quotes the task. */
export function taskHoldsPersonRows(task: string | null | undefined): boolean {
  return Boolean(task?.includes(FOLD_HEAD));
}

export interface AutoPublishInput {
  /** TUNE_AUTO_PUBLISH. */
  flag: boolean;
  /** env.hubOffReason: publishing is off here. */
  hubOff: string | null;
  /** An admin started the run and Advanced left it on. Visitors never get here. */
  asked: boolean;
  dataset: { kind?: string | null; productId?: string | null; task?: string | null; writerModel?: string | null };
  /** The product the run is for (saveRunProduct), or null. */
  runProductId: string | null;
}

/** Fails closed: anything but an admin's run on a chat dataset with no product and no person's rows stays at publish 0. */
export function autoPublishOk(i: AutoPublishInput): boolean {
  if (!i.flag || i.hubOff || !i.asked || i.runProductId) return false;
  if (i.dataset.kind === "decision" || i.dataset.productId || i.dataset.writerModel === PUBLIC_WRITER) return false;
  return !taskHoldsPersonRows(i.dataset.task);
}

export type UploadVisibility = "private" | "public";

/** A plan's own words on uploading, or null when this plan can't upload by itself. */
export function uploadPlanText(visibility: UploadVisibility): string {
  return `Once it succeeds and is judged, the adapter, its card and its results upload to Hugging Face by themselves as a ${visibility} repo, and the examples as a ${visibility} dataset repo. A dataset Spark 1.3 Contributor wrote stays private. The card quotes the task above and has one short story from Muse Wonder. A failed upload says why, and Publish tries again. Advanced turns this off.`;
}

/** Why a plan that can't upload stays here. */
export const UPLOAD_STAYS_TEXT = "It stays on Muse Muse, because it follows your own rows or is for a product. Your rows never go to Hugging Face.";

import { env } from "@/lib/env";
import type { SessionUser } from "@/lib/auth";
import { limitCeilings } from "@/lib/train/gate";
import { visitorJobCeilings, visitorLimits } from "@/lib/train/public/limits";
import type { UploadVisibility } from "@/lib/train/tune/auto-publish";

/** What the Make box may offer this person for a model, as /fine-tuning/new decides it. The routes check it all again. */
export interface MakeTrain {
  defaultExamples: number;
  ceilings: { maxMinutes: number; maxUsd: number };
  /** A non-admin with OPEN_TRAIN on: their limits, and Start asks for the start code. */
  visitor: { maxExamples: number; maxSteps: number } | null;
  folder: boolean;
  fireworks: boolean;
  anyBase: boolean;
  autoUpload: UploadVisibility | null;
  codeUnset: boolean;
}

/** Null when this person can't plan a run. */
export function makeTrainProps(user: Pick<SessionUser, "isAdmin"> | null): MakeTrain | null {
  const shared = { folder: env.tuneFolder, fireworks: env.fireworksTune };
  if (user?.isAdmin) {
    return { ...shared, defaultExamples: env.tuneDefaultExamples, ceilings: limitCeilings(), visitor: null, anyBase: env.tuneAnyBase, autoUpload: env.tuneAutoPublish && !env.hubOffReason ? (env.hfPublicSet && env.hfPublic ? "public" : "private") : null, codeUnset: false };
  }
  if (!env.openTrain) return null;
  const limits = visitorLimits();
  return {
    ...shared,
    defaultExamples: Math.min(env.tuneDefaultExamples, limits.datasetMaxRows),
    ceilings: visitorJobCeilings(limits),
    visitor: { maxExamples: limits.datasetMaxRows, maxSteps: limits.job.maxSteps },
    anyBase: false,
    autoUpload: null,
    codeUnset: !env.tuneStartCode,
  };
}

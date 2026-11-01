/**
 * A run's live demo, for its room (app/fine-tuning/runs/[id]/page.tsx). Not a page: Next only serves page.tsx files.
 * The same reads the admin job page makes for a trained glimmer-lora job (app/fine-tuning/[jobId]/page.tsx, whose
 * helpers a page file can't export): the Try it live box while a serve job for it is open, Start a live demo when its
 * adapter can be served, else null. A problem reading it is logged and leaves the box out, so the room still shows.
 */
import { sweepOffReason, sweepRunning } from "@/app/api/train/shared";
import type { JobLiveDemo } from "@/components/train/LiveDemo";
import { NOT_PUBLIC_TEXT, sweepOffText } from "@/components/train/format";
import { hasResults } from "@/components/train/results";
import { env } from "@/lib/env";
import { ADAPTER_RECIPE, adapterProblem } from "@/lib/train/logic";
import { getAdapterSource, getLiveDemo, lastSweepOkAt } from "@/lib/train/store";
import type { TrainJobView } from "@/lib/train/types";
import { callbackOrigin } from "@/lib/train/userdata";

/** Why POST /api/train/jobs would refuse a live demo right now, as the Start a live demo card says it, or null. */
async function startBlock(now: Date): Promise<string | null> {
  if (!callbackOrigin(env.platformUrl)) return NOT_PUBLIC_TEXT;
  const off = sweepOffReason();
  if (off) return sweepOffText(off);
  // When the database can't say, the route still checks on Start, as on the job page.
  const last = await lastSweepOkAt().catch(() => undefined);
  return last === undefined || sweepRunning(last, now) ? null : sweepOffText("sweep_not_running");
}

export async function runLiveDemo(job: Pick<TrainJobView, "id" | "recipe" | "status" | "title"> | null, now: Date): Promise<JobLiveDemo | null> {
  if (!job || job.recipe !== ADAPTER_RECIPE || job.status !== "succeeded") return null;
  try {
    const demo = await getLiveDemo(job.id, now);
    if (demo) return { kind: "demo", demo };
    const source = await getAdapterSource(job.id);
    if (!source || adapterProblem(source.job, source.metrics)) return null;
    return {
      kind: "start",
      adapterTitle: job.title,
      ceilings: { maxMinutes: env.trainJobMaxMinutes, maxUsd: env.trainJobMaxUsd },
      maxActive: env.trainMaxActive,
      dailyUsd: env.trainDailyUsd,
      blocked: await startBlock(now),
      publicPage: hasResults(source.job),
    };
  } catch (err) {
    console.error("[fine-tuning] run live demo:", err instanceof Error ? err.message : err);
    return null;
  }
}

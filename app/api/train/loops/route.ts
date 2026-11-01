import { start } from "workflow/api";
import { limitCeilings } from "@/app/api/train/shared";
import { datasetCostRange } from "@/components/train/format";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { spendPaused } from "@/lib/quota";
import { ADAPTER_RECIPE, runEstimate } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import { getDataset } from "@/lib/train/store";
import { tuneCaller } from "@/lib/train/tune/caller";
import { scoreHighUsd } from "@/lib/train/tune/cost";
import { LOOP_MIN_EVAL, loopSettings, roundBudget, type LoopSpec } from "@/lib/train/tune/loop";
import { tuneLoop } from "@/lib/train/tune/loop-run";
import { createLoop, loopsOfRun, recordLoopEnded } from "@/lib/train/tune/loop-store";
import { latestTuneJob, readRunMarks, readRunProduct } from "@/lib/train/tune/run-store";
import { newVersionPlan } from "@/lib/train/versions";

/**
 * POST {datasetId, targetScore, maxUsd, maxRounds?, examples?} -> 201 {loopId, href}: starts a tuning loop on a judged
 * run (docs/TRAINING.md "Tuning loop"). Admins or automation (tuneCaller). Off with TUNE_LOOP: 404. 400 with a sentence
 * for bad settings or a run that can't loop, or a cap too small for one round. 404 not_found, 409 loop_running, 503
 * meta_not_configured or paused, 500 start_failed.
 */
export const POST = route(async (req: Request) => {
  if (!env.tuneLoop) return errorJson(404, "not_found");
  const caller = await tuneCaller(req);
  const body = await readJson(req, 8 * 1024);
  const settings = loopSettings(body);
  if (!settings.ok) return errorJson(400, settings.error);
  const dataset = typeof body.datasetId === "string" ? await getDataset(body.datasetId) : null;
  if (!dataset) return errorJson(404, "not_found");
  if (!caller.isAdmin && dataset.createdBy !== caller.id) return errorJson(403, "forbidden");

  if (dataset.kind === "decision") return errorJson(400, "A loop works on chat models, not decision models.");
  if (dataset.productId || (await readRunProduct(dataset.id))) return errorJson(400, "A loop can't run on a product's model yet.");
  if (dataset.evalCount < LOOP_MIN_EVAL) return errorJson(400, `A loop needs at least ${LOOP_MIN_EVAL} kept-aside prompts, half of them sealed. This run has ${dataset.evalCount}, so it needs more examples.`);
  const job = await latestTuneJob(dataset.id);
  if (!job || job.status !== "succeeded" || !((job.evalSummary?.items ?? 0) > 0)) return errorJson(400, "A loop starts from a run that trained and was judged.");
  if (!newVersionPlan(job, recipeById(ADAPTER_RECIPE)?.params ?? [])) return errorJson(400, "This run's job can't have a new version.");
  const marks = await readRunMarks(dataset.id);
  // launchForRun takes the base from the run's marks. A job from the full form on another base has none, and a round would train on r30b.
  if (Number(job.params?.baseScale) > 0 && !marks.base) return errorJson(400, "This job's base wasn't kept with the run, so its rounds would train on another model.");

  if (!process.env.MODEL_API_KEY) return errorJson(503, "meta_not_configured");
  if (await spendPaused()) return errorJson(503, "paused");

  const metaHighUsd = datasetCostRange(settings.examples).high;
  const judged = scoreHighUsd(dataset.evalCount);
  const ceilings = limitCeilings();
  const estimate = runEstimate(ADAPTER_RECIPE, { maxSteps: job.params?.maxSteps, baseScale: job.params?.baseScale, baseBytes: job.params?.baseBytes }, job.instanceType, true)?.minutes ?? job.maxMinutes;
  const first = roundBudget({ capUsd: settings.capUsd, spentUsd: 0, writerUsd: metaHighUsd, scoreHighUsd: judged, ceilingUsd: ceilings.maxUsd, maxMinutes: Math.min(job.maxMinutes, ceilings.maxMinutes), priceCentsPerHour: job.priceCentsPerHour, estimateMinutes: estimate });
  if (!first.fits) return errorJson(400, "That spend cap doesn't cover one round: writing, training and judging. Raise it and try again.");

  const spec: LoopSpec = {
    v: 1,
    sourceDatasetId: dataset.id,
    sourceJobId: job.id,
    target: settings.target,
    capUsd: settings.capUsd,
    maxRounds: settings.maxRounds,
    examples: settings.examples,
    metaHighUsd,
    scoreHighUsd: judged,
    callerId: caller.id,
    startedAt: new Date().toISOString(),
  };
  const loopId = await createLoop(spec);
  if (!loopId) {
    const open = (await loopsOfRun(dataset.id)).find((l) => !l.ended);
    return errorJson(409, "loop_running", open ? { loopId: open.id, href: `/fine-tuning/loops/${open.id}` } : {});
  }
  try {
    await start(tuneLoop, [{ loopId }]);
  } catch (err) {
    console.error("[train/tune] start loop", err);
    await recordLoopEnded({ id: loopId, spec }, "start_failed");
    return errorJson(500, "start_failed");
  }
  return Response.json({ loopId, href: `/fine-tuning/loops/${loopId}` }, { status: 201 });
});

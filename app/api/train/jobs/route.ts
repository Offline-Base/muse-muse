import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { LambdaApiError, listInstanceTypes, pickGpu, type LambdaInstanceType } from "@/lib/train/lambda";
import { clampLimits, toJobView, validateParams } from "@/lib/train/logic";
import { RECIPES, recipeById } from "@/lib/train/recipes";
import {
  activeJobCount,
  attachRun,
  createJob,
  lastSweepOkAt,
  listJobs,
  setStatus,
  trainingCommittedToday,
  trainingSpendToday,
} from "@/lib/train/store";
import { callbackOrigin } from "@/lib/train/userdata";
import { trainJob } from "@/lib/train/workflow";
import { gpuOptions, lambdaConfigured, limitCeilings, recipeView, sweepOffReason, sweepRunning } from "../shared";

// The launch checks call Lambda (20 s timeout, one retry).
export const maxDuration = 60;

const TITLE_MAX = 200;

/** A limit from the body: a positive number, a numeric string (from a form), or nothing. */
function limit(value: unknown, label: string): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `${label} must be a positive number.` };
  return { ok: true, value: n };
}

/**
 * The daily_cap reply: what training has spent today, what it could reach with every unfinished job at its full
 * dollar limit, the cap, and the new job's limit.
 */
async function dailyCap(jobMaxUsd: number): Promise<Response> {
  const [spentUsd, committedUsd] = await Promise.all([trainingSpendToday(), trainingCommittedToday()]);
  return errorJson(503, "daily_cap", { spentUsd, committedUsd, dailyUsd: env.trainDailyUsd, jobMaxUsd });
}

/** GET -> {jobs: TrainJobView[], recipes: RecipeView[]}, newest jobs first. Admins only. */
export const GET = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  const now = new Date();
  const rows = await listJobs(50);
  return Response.json({ jobs: rows.map((row) => toJobView(row, now)), recipes: RECIPES.map(recipeView) });
});

/**
 * POST {recipe, title?, params?, instanceType?, maxMinutes?, maxUsd?} -> 201 {job}. Admins or automation only.
 * Queues the job and starts the trainJob workflow, which launches the instance. Limits are the lowest of the ask, the
 * recipe's defaults and the platform ceilings. 400 bad input, 409 too_many_active (TRAIN_MAX_ACTIVE), 502
 * lambda_unavailable, 503 lambda_not_configured, platform_not_public (the instance couldn't report back over https),
 * sweep_not_configured with {reason} (the 5-minute sweep that terminates a lost GPU can't run here: see
 * sweepOffReason), sweep_not_running with {lastSweepAt} (it can, but hasn't run with Lambda answering in the last 15
 * minutes: see sweepRunning), daily_cap (TRAIN_DAILY_USD could be passed, counting every unfinished job at its full
 * dollar limit) or no_capacity with {options}.
 */
export const POST = route(async (req: Request) => {
  const user = await requireAdminOrAutomation(req);
  const body = await readJson(req, 16 * 1024);

  const recipe = recipeById(typeof body.recipe === "string" ? body.recipe : null);
  if (!recipe) return errorJson(400, "Pick a recipe.");
  if (body.title !== undefined && body.title !== null && typeof body.title !== "string") {
    return errorJson(400, "title must be text.");
  }
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, TITLE_MAX) : recipe.title;
  const params = validateParams(recipe, body.params);
  if (!params.ok) return errorJson(400, params.error);
  let instanceType: string | undefined;
  if (body.instanceType !== undefined && body.instanceType !== null && body.instanceType !== "") {
    if (typeof body.instanceType !== "string" || !recipe.gpus.some((g) => g.instanceType === body.instanceType)) {
      return errorJson(400, "That GPU isn't one this recipe can use.");
    }
    instanceType = body.instanceType;
  }
  const maxMinutes = limit(body.maxMinutes, "maxMinutes");
  if (!maxMinutes.ok) return errorJson(400, maxMinutes.error);
  const maxUsd = limit(body.maxUsd, "maxUsd");
  if (!maxUsd.ok) return errorJson(400, maxUsd.error);
  const limits = clampLimits(recipe, { maxMinutes: maxMinutes.value, maxUsd: maxUsd.value }, limitCeilings());

  if (!lambdaConfigured()) return errorJson(503, "lambda_not_configured");
  if (!callbackOrigin(env.platformUrl)) return errorJson(503, "platform_not_public");
  // Without the sweep, a job whose workflow died would keep its GPU, and Lambda would bill it past every limit.
  const sweepOff = sweepOffReason();
  if (sweepOff) return errorJson(503, "sweep_not_configured", { reason: sweepOff });
  const lastSweepAt = await lastSweepOkAt();
  if (!sweepRunning(lastSweepAt, new Date())) {
    return errorJson(503, "sweep_not_running", { lastSweepAt: lastSweepAt?.toISOString() ?? null });
  }
  if ((await activeJobCount()) >= env.trainMaxActive) return errorJson(409, "too_many_active", { max: env.trainMaxActive });
  // The new job's whole dollar limit counts, and so does every unfinished job's, so the day's spend can't pass the cap.
  if ((await trainingCommittedToday()) + limits.maxUsd > env.trainDailyUsd) return dailyCap(limits.maxUsd);

  let types: LambdaInstanceType[];
  try {
    types = await listInstanceTypes();
  } catch (err) {
    console.error("[train/jobs] instance types", err instanceof Error ? err.message : err);
    // Lambda refusing the key is a configuration problem; anything else is Lambda being unreachable.
    const status = err instanceof LambdaApiError ? err.status : 0;
    if (status === 401 || status === 403) return errorJson(503, "lambda_not_configured");
    return errorJson(502, "lambda_unavailable");
  }
  const gpu = pickGpu(recipe.gpus, types, instanceType);
  if (!gpu) return errorJson(503, "no_capacity", { options: gpuOptions(types, [recipe]) });

  const job = await createJob({
    recipe: recipe.id,
    title,
    params: params.value,
    instanceType: gpu.instanceType,
    region: gpu.region,
    priceCentsPerHour: gpu.priceCentsPerHour,
    maxMinutes: limits.maxMinutes,
    maxUsd: limits.maxUsd,
    createdBy: user.id,
  });
  // Two requests at once could both pass the checks above. The new row now counts in both, so each backs out when it
  // sees the other, and the limits hold.
  const tooMany = (await activeJobCount()) > env.trainMaxActive;
  if (tooMany || (await trainingCommittedToday()) > env.trainDailyUsd) {
    await setStatus(job.id, "failed", {
      message: "Another job started at the same moment.",
      set: { error: "Another job started at the same moment, so this one was not launched." },
    });
    return tooMany ? errorJson(409, "too_many_active", { max: env.trainMaxActive }) : dailyCap(limits.maxUsd);
  }

  let runId: string;
  try {
    runId = (await start(trainJob, [{ jobId: job.id }])).runId;
  } catch (err) {
    console.error("[train/jobs] start", err);
    await setStatus(job.id, "failed", {
      message: "The job's workflow could not start.",
      set: { error: "The job's workflow could not start, so nothing was launched." },
    }).catch((e) => console.error("[train/jobs] markStartFailed", e));
    return errorJson(500, "start_failed");
  }
  await attachRun(job.id, runId).catch((err) => console.error("[train/jobs] attachRun", err));
  return Response.json({ job: toJobView(job, new Date()) }, { status: 201 });
});

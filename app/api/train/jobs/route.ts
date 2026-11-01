import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { BASE_MODEL_PARAM, LAB_BASE_MODEL } from "@/lib/train/base";
import { decideRunSize, isDecideMode } from "@/lib/train/decision-datasets";
import { quantParams } from "@/lib/train/hub-cards";
import { cacheRegions, LambdaApiError, listInstanceTypes, pickGpu, type LambdaInstanceType } from "@/lib/train/lambda";
import {
  ADAPTER_RECIPE,
  adapterProblem,
  clampLimits,
  DECIDE_MODE,
  datasetModeProblem,
  type DecideRunSize,
  isQuantRecipe,
  isServeRecipe,
  quantProblem,
  recipeDefaults,
  runEstimate,
  runFitProblem,
  SERVE_ADAPTER_PARAM,
  SERVE_BOOT_MINUTES,
  SERVE_MINUTES_PARAM,
  serveFitProblem,
  serveMinutes,
  toJobView,
  usableMinutes,
  validateParams,
} from "@/lib/train/logic";
import { RECIPES, recipeById } from "@/lib/train/recipes";
import {
  activeJobCount,
  attachRun,
  createJob,
  earlierOpenQuantJob,
  earlierOpenServeJob,
  getAdapterSource,
  getDataset,
  getLiveDemo,
  lastSweepOkAt,
  listJobs,
  openQuantJob,
  setStatus,
  trainingCommittedToday,
  trainingSpendToday,
} from "@/lib/train/store";
import { callbackOrigin } from "@/lib/train/userdata";
import type { Recipe } from "@/lib/train/types";
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
 * Null when every dataset param names a dataset that is ready and fits the job's mode (datasetModeProblem: decide mode
 * trains on a decision dataset, chat mode on a chat one), otherwise what to tell the admin.
 */
async function datasetProblem(recipe: Recipe, params: Record<string, string | number>): Promise<string | null> {
  for (const field of recipe.params) {
    if (field.kind !== "dataset" || params[field.key] === undefined) continue;
    const dataset = await getDataset(String(params[field.key]));
    if (!dataset) return `${field.label}: that dataset doesn't exist.`;
    if (dataset.status !== "ready") {
      return dataset.status === "generating"
        ? `${field.label}: that dataset is still being written.`
        : `${field.label}: that dataset failed, so it can't be trained on.`;
    }
    const mismatch = datasetModeProblem(params, dataset.kind);
    if (mismatch) return `${field.label}: ${mismatch}`;
  }
  return null;
}

/**
 * For a job in decide mode: what it runs on its decision dataset (decideRunSize), which its run estimate is made from.
 * Null for any other job, or when the dataset has no spec.
 */
async function decideSize(recipe: Recipe, params: Record<string, string | number>): Promise<DecideRunSize | null> {
  if (!isDecideMode(params)) return null;
  const field = recipe.params.find((f) => f.kind === "dataset" && params[f.key] !== undefined);
  const dataset = field ? await getDataset(String(params[field.key])) : null;
  return dataset?.decision ? decideRunSize(dataset.decision, params) : null;
}

/**
 * For a recipe with an "adapter" param (glimmer-serve): the region its adapter is in, since the serve job must launch
 * there and mount the same cache filesystem. Null for any other recipe. A problem (no such job, not a glimmer-lora job
 * that succeeded, a dry run, an adapter not on the cache) is the 400 to answer, after the param's label. A decision
 * model's adapter is taken only by glimmer-serve, which serves it at POST /decide (docs/DECISION_MODELS.md, D7).
 */
async function adapterRegion(
  recipe: Recipe,
  params: Record<string, string | number>,
): Promise<{ ok: true; region: string | null; adapterJobId: string | null } | { ok: false; error: string }> {
  for (const field of recipe.params) {
    if (field.kind !== "adapter" || params[field.key] === undefined) continue;
    const source = await getAdapterSource(String(params[field.key]));
    const problem = adapterProblem(source?.job ?? null, source?.metrics ?? null, { decide: isServeRecipe(recipe.id) });
    if (problem || !source) return { ok: false, error: `${field.label}: ${problem ?? "that job doesn't exist."}` };
    return { ok: true, region: source.job.region, adapterJobId: source.job.id };
  }
  return { ok: true, region: null, adapterJobId: null };
}

/**
 * For a glimmer-quantize job (docs/TRAINING.md "Local files"): the params the platform writes itself (quantParams), or
 * the reply that refuses it. Its switch must be on (503 quant_off); its adapter judged and trained under the short
 * student prompt (quantProblem, 400 after the param's label); unless its publish param is 0, publishing on (503
 * hub_off) and the adapter published, since its GGUF repo links to it (409 adapter_not_published); and no other local
 * files job of the adapter open (409 quant_running with {quantJobId}).
 */
async function quantSetup(
  recipe: Recipe,
  params: Record<string, string | number>,
): Promise<{ ok: true; params: Record<string, string | number> } | { ok: false; reply: Response }> {
  const label = recipe.params.find((f) => f.key === SERVE_ADAPTER_PARAM)?.label ?? "Adapter";
  if (!env.quantEnabled) return { ok: false, reply: errorJson(503, "quant_off", { reason: "QUANT_ENABLED isn't on" }) };
  const adapterJobId = String(params[SERVE_ADAPTER_PARAM] ?? "");
  const source = await getAdapterSource(adapterJobId);
  if (!source) return { ok: false, reply: errorJson(400, `${label}: that job doesn't exist.`) };
  const problem = quantProblem(source.job, source.metrics);
  if (problem) return { ok: false, reply: errorJson(400, `${label}: ${problem}`) };
  if (Number(params.publish) !== 0) {
    const off = env.hubOffReason;
    if (off) return { ok: false, reply: errorJson(503, "hub_off", { reason: off }) };
    if (source.job.hub?.status !== "published") {
      const reason = "Publish the adapter to Hugging Face first: its local files go to a repo whose card links to it.";
      return { ok: false, reply: errorJson(409, "adapter_not_published", { reason }) };
    }
  }
  const datasetId = typeof source.job.params?.datasetId === "string" ? source.job.params.datasetId : "";
  const dataset = datasetId ? await getDataset(datasetId) : null;
  if (!dataset) return { ok: false, reply: errorJson(400, `${label}: its dataset is gone, so its files' system message can't be made.`) };
  const running = await openQuantJob(adapterJobId);
  if (running) return { ok: false, reply: errorJson(409, "quant_running", { quantJobId: running.id }) };
  return { ok: true, params: quantParams(source.job, dataset.title) };
}

/**
 * Regions that already hold the model cache, for a recipe that keeps one. Only a preference, so a Lambda error picks
 * from every region instead of refusing the job.
 */
async function preferredRegions(recipe: Recipe): Promise<string[]> {
  if (!recipe.usesCache) return [];
  try {
    return await cacheRegions();
  } catch (err) {
    console.error("[train/jobs] cache regions", err instanceof Error ? err.message : err);
    return [];
  }
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
 * Queues the job and starts the trainJob workflow, which launches the instance (with mode "decide" for a glimmer-lora
 * job in decide mode, which the workflow scores after its run instead of judging). Limits are what the admin asked for,
 * capped by the platform ceilings, with the recipe's defaults (also capped) for a limit not asked for. A dataset param
 * must name a dataset that is ready and fits the job's mode: a decision dataset in decide mode, a chat one otherwise
 * (datasetModeProblem); a decide job's run estimate comes from what that dataset makes it train and score
 * (decideRunSize). An adapter param (glimmer-serve) must name a glimmer-lora job whose adapter can
 * be served (adapterProblem), and the job then launches only in that adapter's region (409 demo_running with
 * {serveJobId} while one for it is already open, or when two start at once and this is the later, 503 no_capacity
 * with {options, region} when that region has no free GPU); its minutes are stored whole (serveMinutes), its default
 * limits follow them (recipeDefaults), and it is refused with a 400 when its limits on the
 * GPU it gets can't cover them plus 15 minutes to boot (serveFitProblem, with {estimateMinutes, usableMinutes}). A
 * recipe that keeps the model cache prefers a region that already has it. A glimmer-quantize job also needs its switch,
 * a judged adapter and, to publish, a published one, one at a time per adapter (quantSetup, 503 quant_off or hub_off,
 * 400, 409 adapter_not_published or quant_running with {quantJobId}), and the platform writes its levels, slug and
 * trainChannel params itself. A glimmer-lora or glimmer-quantize job also gets the baseModel param, the base its GPU
 * loads (LAB_BASE_MODEL, lib/train/base.ts). A run
 * that can't fit its limits on the GPU it gets (runEstimate: seconds a step for that GPU plus a fixed overhead, larger
 * in a region without the cache) is refused with a 400 that says so, with {estimateMinutes, usableMinutes}, before
 * anything is created. 400 bad input, 409 too_many_active (TRAIN_MAX_ACTIVE), 502
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
  // A job that makes a model records the base its GPU loads (lib/train/base.ts), so its pages know a Muse Spark Open
  // Derivative before any metrics arrive. Not a recipe field, so validateParams refuses it from a caller.
  if (recipe.id === ADAPTER_RECIPE || isQuantRecipe(recipe.id)) params.value[BASE_MODEL_PARAM] = LAB_BASE_MODEL;
  // A serve job's minutes are stored whole (serveMinutes rounds down), so the limits, the page's end time, the proxy's
  // cutoff and the GPU, which reads the same param from job.json, all count the same minutes.
  if (isServeRecipe(recipe.id)) params.value[SERVE_MINUTES_PARAM] = serveMinutes(params.value);
  const datasetError = await datasetProblem(recipe, params.value);
  if (datasetError) return errorJson(400, datasetError);
  const adapter = await adapterRegion(recipe, params.value);
  if (!adapter.ok) return errorJson(400, adapter.error);
  if (isServeRecipe(recipe.id) && !adapter.adapterJobId) return errorJson(400, "Pick the trained adapter to serve.");
  if (isQuantRecipe(recipe.id)) {
    const quant = await quantSetup(recipe, params.value);
    if (!quant.ok) return quant.reply;
    Object.assign(params.value, quant.params);
  }
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
  const limits = clampLimits(recipeDefaults(recipe, params.value), { maxMinutes: maxMinutes.value, maxUsd: maxUsd.value }, limitCeilings());

  if (!lambdaConfigured()) return errorJson(503, "lambda_not_configured");
  if (!callbackOrigin(env.platformUrl)) return errorJson(503, "platform_not_public");
  // Without the sweep, a job whose workflow died would keep its GPU, and Lambda would bill it past every limit.
  const sweepOff = sweepOffReason();
  if (sweepOff) return errorJson(503, "sweep_not_configured", { reason: sweepOff });
  const lastSweepAt = await lastSweepOkAt();
  if (!sweepRunning(lastSweepAt, new Date())) {
    return errorJson(503, "sweep_not_running", { lastSweepAt: lastSweepAt?.toISOString() ?? null });
  }
  if (adapter.adapterJobId && isServeRecipe(recipe.id)) {
    // One live demo per adapter: the page and the proxy only ever use the newest. A glimmer-publish job of the same
    // adapter doesn't count, and doesn't stop for a demo.
    const running = await getLiveDemo(adapter.adapterJobId);
    if (running) return errorJson(409, "demo_running", { serveJobId: running.serveJobId });
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
  const pinned = adapter.region;
  const cacheAt = pinned ? [pinned] : await preferredRegions(recipe);
  const gpu = pinned ? pickGpu(recipe.gpus, types, instanceType, cacheAt, pinned) : pickGpu(recipe.gpus, types, instanceType, cacheAt);
  if (!gpu) {
    return errorJson(503, "no_capacity", { options: gpuOptions(types, [recipe]), ...(pinned ? { region: pinned } : {}) });
  }
  if (isServeRecipe(recipe.id)) {
    const usable = usableMinutes(limits, gpu.priceCentsPerHour);
    const label = recipe.gpus.find((g) => g.instanceType === gpu.instanceType)?.label ?? gpu.instanceType;
    const minutes = serveMinutes(params.value);
    const problem = serveFitProblem(minutes, usable, label);
    if (problem) return errorJson(400, problem, { estimateMinutes: minutes + SERVE_BOOT_MINUTES, usableMinutes: usable });
  }
  // A run its limits would cut off before the end pays for the GPU and saves nothing. A decide job's estimate comes from
  // what its decision dataset makes it train and score.
  const decide = await decideSize(recipe, params.value);
  const estimate = runEstimate(recipe.id, params.value, gpu.instanceType, cacheAt.includes(gpu.region), decide);
  if (estimate) {
    const usable = usableMinutes(limits, gpu.priceCentsPerHour);
    const label = recipe.gpus.find((g) => g.instanceType === gpu.instanceType)?.label ?? gpu.instanceType;
    const problem = runFitProblem(estimate, usable, label);
    if (problem) return errorJson(400, problem, { estimateMinutes: estimate.minutes, usableMinutes: usable });
  }

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
  // Two demos of one adapter asked for at once could both pass the demo_running check above. Only the later one backs
  // out, so one demo always survives and no GPU serves a demo nobody can reach.
  if (adapter.adapterJobId && isServeRecipe(recipe.id)) {
    const earlier = await earlierOpenServeJob(adapter.adapterJobId, job.id);
    if (earlier) {
      await setStatus(job.id, "failed", {
        message: "Another live demo of this adapter started at the same moment.",
        set: { error: "Another live demo of this adapter started at the same moment, so this one was not launched." },
      });
      return errorJson(409, "demo_running", { serveJobId: earlier.id });
    }
  }
  // Two local files jobs of one adapter at once would upload to the same repo. Only the later backs out.
  if (adapter.adapterJobId && isQuantRecipe(recipe.id)) {
    const earlier = await earlierOpenQuantJob(adapter.adapterJobId, job.id);
    if (earlier) {
      await setStatus(job.id, "failed", {
        message: "Another local files job of this adapter started at the same moment.",
        set: { error: "Another local files job of this adapter started at the same moment, so this one was not launched." },
      });
      return errorJson(409, "quant_running", { quantJobId: earlier.id });
    }
  }
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
    // A decide job is scored after its run instead of judged (docs/DECISION_MODELS.md, "Scoring"); every other job's
    // input is as it was.
    const decideJob = recipe.id === ADAPTER_RECIPE && isDecideMode(params.value);
    runId = (await start(trainJob, [{ jobId: job.id, ...(decideJob ? { mode: DECIDE_MODE } : {}) }])).runId;
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

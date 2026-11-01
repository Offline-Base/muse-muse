/**
 * Starting a training job (docs/TRAINING.md "Routes"): every check POST /api/train/jobs makes, in the same order, then
 * the job row and its trainJob workflow. The route is a thin caller of it, and so are the tuneRun workflow's launch
 * step (lib/train/tune/run-steps.ts), POST /api/train/runs/{id}/start, and wave 3's unit 11 ("Train on my data"), so a
 * job started from anywhere passes the same sweep gate, caps, capacity, fit and start race.
 *
 * Nothing here reads the request or answers it: a refusal comes back as {ok: false, status, code, body?}, which the
 * route sends as errorJson(status, code, body), so every reply is the one the route gave before the move.
 */
import { start } from "workflow/api";
import { env } from "@/lib/env";
import { BASE_MODEL_PARAM, LAB_BASE_MODEL } from "@/lib/train/base";
import { resolveBase } from "@/lib/train/base-check";
import { askedBase, baseParams } from "@/lib/train/bases";
import { decideRunSize, isDecideMode } from "@/lib/train/decision-datasets";
import { gpuOptions, lambdaConfigured, limitCeilings, sweepOffReason, sweepRunning } from "@/lib/train/gate";
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
  TRAIN_CHANNEL_PARAM,
  trainChannelOf,
  serveMinutes,
  type TrainJobRow,
  usableMinutes,
  validateParams,
} from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import {
  activeJobCount,
  attachRun,
  createJob,
  earlierOpenQuantJob,
  earlierOpenServeJob,
  getAdapterSource,
  getDataset,
  ownerRowsProblem,
  getLiveDemo,
  lastSweepOkAt,
  openQuantJob,
  setStatus,
  trainingCommittedToday,
  trainingSpendToday,
} from "@/lib/train/store";
import { callbackOrigin } from "@/lib/train/userdata";
import { PUBLISH_RECIPE, RL_RECIPE, type Recipe, type RecipeId } from "@/lib/train/types";
import { trainJob } from "@/lib/train/workflow";

const TITLE_MAX = 200;

/** What a job is started with: the contract wave 3's unit 11 imports (docs/TRAINING.md "Fine-tune like a build"). */
export interface LaunchInput {
  recipe: RecipeId;
  title?: string;
  params: Record<string, unknown>;
  instanceType?: string;
  maxMinutes?: number;
  maxUsd?: number;
  /** Another Meta base (TUNE_ANY_BASE), checked again here. Not set: the job trains on r30b. */
  base?: { repo: string; revision?: string | null };
  /** A tune run's instanceType is only its first choice, so a base it doesn't fit moves to a GPU it does. */
  baseGpuAuto?: boolean;
}

/** Who starts it: the job's created_by. */
export interface LaunchCaller {
  userId: string;
}

/** The refusal: the status, the error code (or the 400's sentence) and anything the reply adds to it. */
export interface LaunchRefusal {
  ok: false;
  status: number;
  code: string;
  body?: Record<string, unknown>;
}

export type LaunchResult = { ok: true; job: TrainJobRow } | LaunchRefusal;

/**
 * A request body as POST /api/train/jobs takes it, before it is checked: every field may be anything. Limits may be
 * numeric strings, from a form.
 */
export type LaunchRequest = { [K in keyof LaunchInput]?: unknown };

function refuse(status: number, code: string, body?: Record<string, unknown>): LaunchRefusal {
  return body ? { ok: false, status, code, body } : { ok: false, status, code };
}

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
): Promise<{ ok: true; region: string | null; adapterJobId: string | null; trainChannel: 0 | 1 } | { ok: false; error: string }> {
  for (const field of recipe.params) {
    if (field.kind !== "adapter" || params[field.key] === undefined) continue;
    const source = await getAdapterSource(String(params[field.key]));
    const problem = adapterProblem(source?.job ?? null, source?.metrics ?? null, {
      decide: isServeRecipe(recipe.id),
      uploadOnly: recipe.id === PUBLISH_RECIPE,
    });
    if (problem || !source) return { ok: false, error: `${field.label}: ${problem ?? "that job doesn't exist."}` };
    const ownerRows = recipe.id === PUBLISH_RECIPE ? await ownerRowsProblem(source.job) : null;
    if (ownerRows) return { ok: false, error: `${field.label}: ${ownerRows}` };
    return { ok: true, region: source.job.region, adapterJobId: source.job.id, trainChannel: trainChannelOf(source.job.params) };
  }
  return { ok: true, region: null, adapterJobId: null, trainChannel: 0 };
}

/**
 * For a glimmer-quantize job (docs/TRAINING.md "Local files"): the params the platform writes itself (quantParams), or
 * the refusal. Its switch must be on (503 quant_off); its adapter judged and trained under the short student prompt
 * (quantProblem, 400 after the param's label); unless its publish param is 0, publishing on (503 hub_off) and the
 * adapter published, since its GGUF repo links to it (409 adapter_not_published); and no other local files job of the
 * adapter open (409 quant_running with {quantJobId}).
 */
async function quantSetup(
  recipe: Recipe,
  params: Record<string, string | number>,
): Promise<{ ok: true; params: Record<string, string | number> } | LaunchRefusal> {
  const label = recipe.params.find((f) => f.key === SERVE_ADAPTER_PARAM)?.label ?? "Adapter";
  if (!env.quantEnabled) return refuse(503, "quant_off", { reason: "QUANT_ENABLED isn't on" });
  const adapterJobId = String(params[SERVE_ADAPTER_PARAM] ?? "");
  const source = await getAdapterSource(adapterJobId);
  if (!source) return refuse(400, `${label}: that job doesn't exist.`);
  const problem = quantProblem(source.job, source.metrics);
  if (problem) return refuse(400, `${label}: ${problem}`);
  if (Number(params.publish) !== 0) {
    const off = env.hubOffReason;
    if (off) return refuse(503, "hub_off", { reason: off });
    if (source.job.hub?.status !== "published") {
      const reason = "Publish the adapter to Hugging Face first: its local files go to a repo whose card links to it.";
      return refuse(409, "adapter_not_published", { reason });
    }
  }
  const datasetId = typeof source.job.params?.datasetId === "string" ? source.job.params.datasetId : "";
  const dataset = datasetId ? await getDataset(datasetId) : null;
  if (!dataset) return refuse(400, `${label}: its dataset is gone, so its files' system message can't be made.`);
  const running = await openQuantJob(adapterJobId);
  if (running) return refuse(409, "quant_running", { quantJobId: running.id });
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
 * The daily_cap refusal: what training has spent today, what it could reach with every unfinished job at its full
 * dollar limit, the cap, and the new job's limit.
 */
async function dailyCap(jobMaxUsd: number): Promise<LaunchRefusal> {
  const [spentUsd, committedUsd] = await Promise.all([trainingSpendToday(), trainingCommittedToday()]);
  return refuse(503, "daily_cap", { spentUsd, committedUsd, dailyUsd: env.trainDailyUsd, jobMaxUsd });
}

/**
 * Checks and starts one job, for POST /api/train/jobs and every caller in lib (see the file's comment). Queues the job
 * and starts the trainJob workflow, which launches the instance (with mode "decide" for a glimmer-lora job in decide
 * mode, which the workflow scores after its run instead of judging). Limits are what was asked for, capped by the
 * platform ceilings, with the recipe's defaults (also capped) for a limit not asked for. A dataset param must name a
 * dataset that is ready and fits the job's mode (datasetModeProblem); a decide job's run estimate comes from what that
 * dataset makes it train and score (decideRunSize). An adapter param (glimmer-serve) must name a glimmer-lora job whose
 * adapter can be served (adapterProblem), and the job then launches only in that adapter's region (409 demo_running
 * with {serveJobId} while one for it is already open, or when two start at once and this is the later, 503 no_capacity
 * with {options, region} when that region has no free GPU); its minutes are stored whole (serveMinutes), its default
 * limits follow them (recipeDefaults), and it is refused with a 400 when its limits on the GPU it gets can't cover them
 * plus 15 minutes to boot (serveFitProblem, with {estimateMinutes, usableMinutes}). A recipe that keeps the model cache
 * prefers a region that already has it. A glimmer-serve job gets its adapter's trainChannel in its params, written by
 * the platform. A glimmer-quantize job also needs its switch, a judged adapter and, to publish,
 * a published one, one at a time per adapter (quantSetup), and the platform writes its levels, slug and trainChannel
 * params itself. A run that can't fit its limits on the GPU it gets (runEstimate) is refused with a 400 that says so,
 * with {estimateMinutes, usableMinutes}, before anything is created.
 *
 * Refusals: 400 bad input, 409 too_many_active (TRAIN_MAX_ACTIVE), 502 lambda_unavailable, 503 lambda_not_configured,
 * platform_not_public, sweep_not_configured with {reason}, sweep_not_running with {lastSweepAt}, daily_cap
 * (TRAIN_DAILY_USD could be passed, counting every unfinished job at its full dollar limit) or no_capacity with
 * {options}, 500 start_failed. Two starts at once that both pass the checks: the later one backs out.
 */
export async function launchJobRequest(input: LaunchRequest, caller: LaunchCaller): Promise<LaunchResult> {
  const recipe = recipeById(typeof input.recipe === "string" ? input.recipe : null);
  if (!recipe) return refuse(400, "Pick a recipe.");
  if (recipe.id === RL_RECIPE && !env.tuneRl) return refuse(400, "Pick a recipe.");
  if (input.title !== undefined && input.title !== null && typeof input.title !== "string") {
    return refuse(400, "title must be text.");
  }
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, TITLE_MAX) : recipe.title;
  const params = validateParams(recipe, input.params);
  if (!params.ok) return refuse(400, params.error);
  // A job that makes a model records the base its GPU loads (lib/train/base.ts), so its pages know a Muse Spark Open
  // Derivative before any metrics arrive. Not a recipe field, so validateParams refuses it from a caller.
  if (recipe.id === ADAPTER_RECIPE || recipe.id === RL_RECIPE || isQuantRecipe(recipe.id)) params.value[BASE_MODEL_PARAM] = LAB_BASE_MODEL;
  // Another Meta base (docs/TRAINING.md "Any Meta base"): checked against the Hub here, every time, and pinned, and only
  // what that check returned goes in the job's params. Off with TUNE_ANY_BASE, a base is refused.
  let baseGpus: string[] | null = null;
  let jobTitle = title;
  if (input.base !== undefined && input.base !== null) {
    if (!env.tuneAnyBase) return refuse(400, "Picking a base isn't switched on.");
    if (recipe.id !== ADAPTER_RECIPE) return refuse(400, "Only a LoRA job takes a base.");
    const asked = askedBase(input.base);
    if (!asked.ok) return refuse(400, asked.error);
    const checked = await resolveBase(asked.value!);
    if (!checked.ok) return refuse(400, checked.error);
    if (isDecideMode(params.value) && !checked.base.decide) return refuse(400, "Decide mode only trains on a 4-bit Muse Glimmer build: its letters and scores are measured on that model.");
    Object.assign(params.value, baseParams(checked.base));
    baseGpus = checked.base.gpus;
    const prefix = checked.base.duties.namePrefix;
    if (prefix && !title.startsWith(prefix)) jobTitle = `${prefix}${title}`.slice(0, TITLE_MAX);
  }
  // A serve job's minutes are stored whole (serveMinutes rounds down), so the limits, the page's end time, the proxy's
  // cutoff and the GPU, which reads the same param from job.json, all count the same minutes.
  if (isServeRecipe(recipe.id)) params.value[SERVE_MINUTES_PARAM] = serveMinutes(params.value);
  const datasetError = await datasetProblem(recipe, params.value);
  if (datasetError) return refuse(400, datasetError);
  const adapter = await adapterRegion(recipe, params.value);
  if (!adapter.ok) return refuse(400, adapter.error);
  if (isServeRecipe(recipe.id) && !adapter.adapterJobId) return refuse(400, "Pick the trained adapter to serve.");
  // The serve job's GPU answers products' chat the way its adapter was trained (lib/train/glimmer-serving.ts), so the
  // platform writes the adapter's trainChannel into its params, as it does for a glimmer-quantize job. No caller can send
  // it: validateParams refuses a param the recipe doesn't list.
  if (isServeRecipe(recipe.id)) params.value[TRAIN_CHANNEL_PARAM] = adapter.trainChannel;
  if (isQuantRecipe(recipe.id)) {
    const quant = await quantSetup(recipe, params.value);
    if (!quant.ok) return quant;
    Object.assign(params.value, quant.params);
  }
  let instanceType: string | undefined;
  if (input.instanceType !== undefined && input.instanceType !== null && input.instanceType !== "") {
    if (typeof input.instanceType !== "string" || !recipe.gpus.some((g) => g.instanceType === input.instanceType)) {
      return refuse(400, "That GPU isn't one this recipe can use.");
    }
    instanceType = input.instanceType;
  }
  // A base only runs on a GPU it fits: a tune run's first choice falls through to one, and a form's choice is refused.
  const fits = baseGpus;
  const gpuChoices = fits ? recipe.gpus.filter((g) => fits.includes(g.instanceType)) : recipe.gpus;
  if (fits && instanceType && !fits.includes(instanceType)) {
    if (input.baseGpuAuto) instanceType = fits[0];
    else return refuse(400, "That base doesn't fit in that GPU's memory. Pick a larger one.");
  }
  const maxMinutes = limit(input.maxMinutes, "maxMinutes");
  if (!maxMinutes.ok) return refuse(400, maxMinutes.error);
  const maxUsd = limit(input.maxUsd, "maxUsd");
  if (!maxUsd.ok) return refuse(400, maxUsd.error);
  const limits = clampLimits(recipeDefaults(recipe, params.value), { maxMinutes: maxMinutes.value, maxUsd: maxUsd.value }, limitCeilings());

  if (!lambdaConfigured()) return refuse(503, "lambda_not_configured");
  if (!callbackOrigin(env.platformUrl)) return refuse(503, "platform_not_public");
  // Without the sweep, a job whose workflow died would keep its GPU, and Lambda would bill it past every limit.
  const sweepOff = sweepOffReason();
  if (sweepOff) return refuse(503, "sweep_not_configured", { reason: sweepOff });
  const lastSweepAt = await lastSweepOkAt();
  if (!sweepRunning(lastSweepAt, new Date())) {
    return refuse(503, "sweep_not_running", { lastSweepAt: lastSweepAt?.toISOString() ?? null });
  }
  if (adapter.adapterJobId && isServeRecipe(recipe.id)) {
    // One live demo per adapter: the page and the proxy only ever use the newest. A glimmer-publish job of the same
    // adapter doesn't count, and doesn't stop for a demo.
    const running = await getLiveDemo(adapter.adapterJobId);
    if (running) return refuse(409, "demo_running", { serveJobId: running.serveJobId });
  }
  if ((await activeJobCount()) >= env.trainMaxActive) return refuse(409, "too_many_active", { max: env.trainMaxActive });
  // The new job's whole dollar limit counts, and so does every unfinished job's, so the day's spend can't pass the cap.
  if ((await trainingCommittedToday()) + limits.maxUsd > env.trainDailyUsd) return dailyCap(limits.maxUsd);

  let types: LambdaInstanceType[];
  try {
    types = await listInstanceTypes();
  } catch (err) {
    console.error("[train/jobs] instance types", err instanceof Error ? err.message : err);
    // Lambda refusing the key is a configuration problem; anything else is Lambda being unreachable.
    const status = err instanceof LambdaApiError ? err.status : 0;
    if (status === 401 || status === 403) return refuse(503, "lambda_not_configured");
    return refuse(502, "lambda_unavailable");
  }
  const pinned = adapter.region;
  const cacheAt = pinned ? [pinned] : await preferredRegions(recipe);
  const gpu = pinned ? pickGpu(gpuChoices, types, instanceType, cacheAt, pinned) : pickGpu(gpuChoices, types, instanceType, cacheAt);
  if (!gpu) {
    return refuse(503, "no_capacity", { options: gpuOptions(types, [recipe]), ...(pinned ? { region: pinned } : {}) });
  }
  if (isServeRecipe(recipe.id)) {
    const usable = usableMinutes(limits, gpu.priceCentsPerHour);
    const label = recipe.gpus.find((g) => g.instanceType === gpu.instanceType)?.label ?? gpu.instanceType;
    const minutes = serveMinutes(params.value);
    const problem = serveFitProblem(minutes, usable, label);
    if (problem) return refuse(400, problem, { estimateMinutes: minutes + SERVE_BOOT_MINUTES, usableMinutes: usable });
  }
  // A run its limits would cut off before the end pays for the GPU and saves nothing. A decide job's estimate comes from
  // what its decision dataset makes it train and score.
  const decide = await decideSize(recipe, params.value);
  const estimate = runEstimate(recipe.id, params.value, gpu.instanceType, cacheAt.includes(gpu.region), decide);
  if (estimate) {
    const usable = usableMinutes(limits, gpu.priceCentsPerHour);
    const label = recipe.gpus.find((g) => g.instanceType === gpu.instanceType)?.label ?? gpu.instanceType;
    const problem = runFitProblem(estimate, usable, label);
    if (problem) return refuse(400, problem, { estimateMinutes: estimate.minutes, usableMinutes: usable });
  }

  const job = await createJob({
    recipe: recipe.id,
    title: jobTitle,
    params: params.value,
    instanceType: gpu.instanceType,
    region: gpu.region,
    priceCentsPerHour: gpu.priceCentsPerHour,
    maxMinutes: limits.maxMinutes,
    maxUsd: limits.maxUsd,
    createdBy: caller.userId,
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
      return refuse(409, "demo_running", { serveJobId: earlier.id });
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
      return refuse(409, "quant_running", { quantJobId: earlier.id });
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
    return tooMany ? refuse(409, "too_many_active", { max: env.trainMaxActive }) : dailyCap(limits.maxUsd);
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
    return refuse(500, "start_failed");
  }
  await attachRun(job.id, runId).catch((err) => console.error("[train/jobs] attachRun", err));
  return { ok: true, job };
}

/**
 * The contract (docs/TRAINING.md "Fine-tune like a build", the ownership split): launchJobRequest with typed input, for
 * callers in lib and wave 3's unit 11. The same checks and the same refusals.
 */
export function launchJob(input: LaunchInput, caller: LaunchCaller): Promise<LaunchResult> {
  return launchJobRequest(input, caller);
}

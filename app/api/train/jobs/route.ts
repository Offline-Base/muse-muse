import { requireAdminOrAutomation } from "@/lib/auth";
import { errorJson, readJson, route } from "@/lib/http";
import { launchJobRequest } from "@/lib/train/launch";
import { toJobView } from "@/lib/train/logic";
import { RECIPES } from "@/lib/train/recipes";
import { listJobs } from "@/lib/train/store";
import { recipeView } from "../shared";

// The launch checks call Lambda (20 s timeout, one retry).
export const maxDuration = 60;

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
  // Every check, and the start itself, is launchJob's (lib/train/launch.ts); this only reads the body and answers.
  const launched = await launchJobRequest(
    { recipe: body.recipe, title: body.title, params: body.params, instanceType: body.instanceType, maxMinutes: body.maxMinutes, maxUsd: body.maxUsd },
    { userId: user.id },
  );
  if (!launched.ok) return errorJson(launched.status, launched.code, launched.body);
  return Response.json({ job: toJobView(launched.job, new Date()) }, { status: 201 });
});

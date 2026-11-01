import { limitCeilings } from "@/app/api/train/shared";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { spendPaused } from "@/lib/quota";
import { tuneCaller, tuneExamplesMax } from "@/lib/train/tune/caller";
import { askedExamples, askedSteps, maxStepsFor, planCost, planSettings, verifyPlan } from "@/lib/train/tune/plan";
import { startTuneRun, TuneStartError } from "@/lib/train/tune/start";
import type { TrainPlanBody } from "@/lib/train/tune/types";

/**
 * POST {plan, settings?: {examples?, steps?}} -> 201 {runId, href}. Admins or automation (tuneCaller). Off with
 * TUNE_COMPOSER: 404. `plan` is what POST /api/train/plan answered, unchanged: its token must be this caller's, for
 * exactly this plan, and not expired, and each plan starts once. Advanced may change the number of examples (40 to the
 * caller's most, tuneExamplesMax) and the training steps (10 to as many as fit in the run's time limit, maxStepsFor);
 * every other setting and the costs are made again here from the platform's defaults and ceilings, never taken from
 * the browser. A task plan saves the dataset and starts makeDataset, as POST /api/train/datasets does, keeps the steps
 * with the run and starts the tuneRun workflow, which trains it once the examples are ready (startTuneRun); the run's
 * id is the dataset's.
 *
 * 400 bad input or plan_expired, 403 plan_invalid (tampered, or another caller's), 409 already_started, 503
 * meta_not_configured or paused, 500 start_failed.
 */
export const POST = route(async (req: Request) => {
  if (!env.tuneComposer) return errorJson(404, "not_found");
  const caller = await tuneCaller(req);
  const body = await readJson(req, 32 * 1024);
  const now = new Date();

  const check = verifyPlan(body.plan, caller.id, now);
  if (!check.ok) {
    if (check.reason === "expired") return errorJson(400, "plan_expired");
    if (check.reason === "bad_token") return errorJson(403, "plan_invalid");
    return errorJson(400, "Send the plan POST /api/train/plan answered, unchanged.");
  }
  // The token signs the task, not the size: Advanced may change it, up to the caller's own most (tuneExamplesMax).
  const size = askedExamples(body.settings, tuneExamplesMax(caller));
  if (!size.ok) return errorJson(400, size.error);
  if (size.value === undefined && check.plan.settings.examples > tuneExamplesMax(caller)) {
    return errorJson(400, `Runs here ask for at most ${tuneExamplesMax(caller)} examples. Change it and send it again.`);
  }
  const sized = planSettings(size.value ?? check.plan.settings.examples, limitCeilings());
  const steps = askedSteps(body.settings, maxStepsFor(sized));
  if (!steps.ok) return errorJson(400, steps.error);
  const settings = planSettings(sized.examples, limitCeilings(), steps.value);
  const plan: TrainPlanBody = { ...check.plan, settings, cost: planCost(settings) };

  if (plan.source.kind === "task") {
    if (!process.env.MODEL_API_KEY) return errorJson(503, "meta_not_configured");
    if (await spendPaused()) return errorJson(503, "paused");
  }

  // One start per plan. The row outlives the plan by the hourly cleanup's hour, so a replay finds it.
  const token = (body.plan as { token: string }).token;
  const until = new Date((body.plan as { exp: string }).exp);
  const key = `tune-run:${token}`;
  if ((await reserveCounter(key, until, 1, 1)) === null) return errorJson(409, "already_started");

  try {
    const run = await startTuneRun({ plan, callerId: caller.id });
    return Response.json(run, { status: 201 });
  } catch (err) {
    if (!(err instanceof TuneStartError)) throw err;
    // Nothing started, so the plan may be started again.
    if (err.status >= 500) await adjustCounter(key, until, -1).catch((e) => console.error("[train/runs] release", e));
    return errorJson(err.status, err.code);
  }
});

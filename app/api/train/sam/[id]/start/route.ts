import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { errorJson, isUuid, route } from "@/lib/http";
import { planFor } from "@/lib/train/sam/logic";
import { SAM_TUNE_DAY_KEY, samMicros, samTuneDayWindow, startProblem } from "@/lib/train/sam/route-helpers";
import { getRunView, queueRun } from "@/lib/train/sam/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST -> {run}: a draft run goes in the office board's queue. Admins or automation. Checks, in order: the run is a
 * draft (409 not_draft), its photos and look-alikes are ready (400 not_ready with a sentence), its planned cost fits
 * its own cap and SAM_TUNE_MAX_USD (402 over_run_cap), and what it has left to spend fits today's SAM_TUNE_DAILY_USD
 * (402 over_daily_cap), reserved under SAM_TUNE_DAY_KEY and given back if the run couldn't be queued. 404 unknown,
 * or SAM_TUNE off.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const view = await getRunView(id);
  if (!view) return errorJson(404, "not_found");
  if (view.status !== "draft") return errorJson(409, "not_draft");
  const notReady = startProblem(view);
  if (notReady) return errorJson(400, "not_ready", { message: notReady });

  const plan = planFor(view);
  const cap = Math.min(view.maxUsd, env.samTuneMaxUsd);
  if (plan.costUsd > cap) {
    return errorJson(402, "over_run_cap", { message: `This run would cost about $${plan.costUsd.toFixed(2)}, over its $${cap.toFixed(2)} cap.` });
  }
  const left = samMicros(Math.max(0, plan.costUsd - view.costUsd));
  const day = samTuneDayWindow(new Date());
  if ((await reserveCounter(SAM_TUNE_DAY_KEY, day, left, samMicros(env.samTuneDailyUsd))) === null) {
    return errorJson(402, "over_daily_cap", { message: "Today's spend cap for SAM tune runs is used up. Try again tomorrow." });
  }
  const run = await queueRun(id).catch(async (err: unknown) => {
    await adjustCounter(SAM_TUNE_DAY_KEY, day, -left).catch(() => undefined);
    throw err;
  });
  if (!run) {
    await adjustCounter(SAM_TUNE_DAY_KEY, day, -left).catch(() => undefined);
    return errorJson(409, "not_draft");
  }
  return Response.json({ run, plan });
});

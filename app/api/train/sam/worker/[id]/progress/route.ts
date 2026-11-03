import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { wholeNumber } from "@/lib/train/sam/route-helpers";
import { progress } from "@/lib/train/sam/store";
import type { SamStage } from "@/lib/train/sam/types";
import { requireRunToken, requireWorker } from "@/lib/train/sam/worker-auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const STAGES: SamStage[] = [
  "claimed", "building_sets", "loading_meta", "scoring_meta", "training",
  "loading_tune", "scoring_tune", "drawing", "uploading", "done",
];
const LINE_MAX = 300;

/**
 * POST {jobToken, stage, step?, steps?, line?} -> {stop}: the board's progress, which also extends the run's lease.
 * stop is true once an admin pressed Stop; the board then ends the run through /fail. Worker secret and the run's
 * jobToken. 401 wrong either, 400 bad field, 409 not_running (the run ended or was never claimed), 404 SAM_TUNE off.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  requireWorker(req);
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const body = await readJson(req, 4096);
  const jobToken = typeof body.jobToken === "string" ? body.jobToken : "";
  await requireRunToken(req, id, jobToken);
  const stage = body.stage as SamStage;
  const step = body.step === undefined ? undefined : wholeNumber(body.step, 1_000_000);
  const steps = body.steps === undefined ? undefined : wholeNumber(body.steps, 1_000_000);
  const line = body.line === undefined ? undefined : typeof body.line === "string" ? body.line.slice(0, LINE_MAX) : null;
  if (!STAGES.includes(stage) || step === null || steps === null || line === null) {
    return errorJson(400, "bad_request", { message: "Send a known stage, and whole-number step and steps." });
  }
  const answer = await progress(id, jobToken, {
    stage,
    ...(step === undefined ? {} : { step }),
    ...(steps === undefined ? {} : { steps }),
    ...(line === undefined ? {} : { line }),
  });
  if (!answer) return errorJson(409, "not_running");
  return Response.json({ stop: answer.stop });
});

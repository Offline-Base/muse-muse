import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { localFilesFor } from "@/lib/train/local-files-server";
import { ADAPTER_RECIPE } from "@/lib/train/logic";
import { pickSimTuneFile } from "@/lib/train/sim-tune";
import { simTuneRuns, startSimTune } from "@/lib/train/sim-tune-server";
import { getJob } from "@/lib/train/store";

type Ctx = { params: Promise<{ id: string }> };

const NO_STORE = { "cache-control": "no-store" };

/**
 * GET -> {problem, runs}: why this model can't run on the lab's emulator now, and its newest runs there. Admins or
 * automation only. A 404 with SIM_TUNE off, before anything is read, or for a job that isn't a tuned model.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  if (!env.simTune) return errorJson(404, "not_found");
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const job = await getJob(id);
  if (!job || job.recipe !== ADAPTER_RECIPE) return errorJson(404, "not_found");
  const [files, runs] = await Promise.all([localFilesFor(id), simTuneRuns(id)]);
  const pick = pickSimTuneFile(files, env.simTuneMaxBytes);
  const problem = !env.nativeLab ? "The device lab is off (NATIVE_LAB)." : pick.ok ? null : pick.problem;
  return Response.json({ problem, runs }, { headers: NO_STORE });
});

/** POST -> 202 {jobId, ahead, etaSeconds}: queues a run. It waits for the lab and needs no GPU or paid call of its own. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.simTune) return errorJson(404, "not_found");
  const user = await requireAdminOrAutomation(req);
  const { id } = await params;
  const job = await getJob(id);
  if (!job || job.recipe !== ADAPTER_RECIPE) return errorJson(404, "not_found");
  const started = await startSimTune(id, user.id);
  if (!started.ok) return Response.json({ error: started.reason, message: started.message }, { status: started.reason === "lab_off" ? 503 : 409, headers: NO_STORE });
  return Response.json({ jobId: started.jobId, ahead: started.ahead, etaSeconds: started.etaSeconds }, { status: 202, headers: NO_STORE });
});

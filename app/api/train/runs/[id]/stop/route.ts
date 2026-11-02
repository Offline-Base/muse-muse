import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { getDataset, requestStop } from "@/lib/train/store";
import { mayTouchRun, runCaller } from "@/lib/train/tune/caller";
import { latestTuneJob, markRunStopped } from "@/lib/train/tune/run-store";
import { isTrainTerminal } from "@/lib/train/types";

type Ctx = { params: Promise<{ id: string }> };

const adminJobHref = (jobId: string) => `/fine-tuning/${jobId}`;

/**
 * POST -> stops a run (docs/TRAINING.md "Fine-tune like a build", "Starting training"). Admins or automation
 * (tuneCaller), and once visitors are let in, only the run's own starter. Off with TUNE_COMPOSER: 404.
 *
 * The run is marked stopped (markRunStopped), so the tuneRun workflow, Start training and launchForRun never launch for
 * it again; examples already being written still finish, as failing a dataset partway does today. Then the run's job,
 * when it has one that hasn't ended, is asked to stop (requestStop: its workflow terminates the GPU at its next check,
 * and the 5-minute sweep does in any case). A launch at the same moment sees the mark once its job exists and stops
 * that job itself (launchForRun), so the two never leave a GPU training. Pressing it again answers the same.
 *
 * 200 {stopped: "before_training"} or {stopped: "training", jobId, href}. 404 not_found, 403 forbidden (another person's
 * run), 409 already_ended with {jobId, href} when its job has already ended.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.tuneComposer) return errorJson(404, "not_found");
  const caller = await runCaller(req);
  const { id } = await params;
  const dataset = await getDataset(id);
  if (!dataset) return errorJson(404, "not_found");
  if (!(await mayTouchRun(caller, dataset.createdBy))) return errorJson(403, "forbidden");
  const jobHref = caller.visitor ? () => `/fine-tuning/runs/${id}` : adminJobHref;

  const before = await latestTuneJob(id);
  if (before && isTrainTerminal(before.status)) return errorJson(409, "already_ended", { jobId: before.id, href: jobHref(before.id) });
  await markRunStopped(id);
  // Read after the mark: a job a launcher made just before it is found here, and one made after it the launcher stops.
  const job = await latestTuneJob(id);
  if (!job) return Response.json({ stopped: "before_training" });
  if (!isTrainTerminal(job.status)) await requestStop(job.id);
  return Response.json({ stopped: "training", jobId: job.id, href: jobHref(job.id) });
});

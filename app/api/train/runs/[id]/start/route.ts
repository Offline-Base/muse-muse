import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { getDataset } from "@/lib/train/store";
import { tuneCaller } from "@/lib/train/tune/caller";
import { TUNE_STEPS } from "@/lib/train/tune/settings";
import { checkText, freshHeartbeat, isCheckCode, isWaitReason, waitText } from "@/lib/train/tune/marks";
import { checkExamples, launchForRun, recordCheckEnded } from "@/lib/train/tune/run-launch";
import { startTraining } from "@/lib/train/tune/start";
import { clearRunEnded, latestTuneJob, readRunMarks } from "@/lib/train/tune/run-store";

// The launch checks call Lambda (20 s timeout, one retry), as POST /api/train/jobs does.
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const jobHref = (jobId: string) => `/fine-tuning/${jobId}`;

/**
 * POST -> Start training for a run whose examples are ready and that no job trains on yet (docs/TRAINING.md "Fine-tune
 * like a build", "Starting training"). Admins or automation (tuneCaller), and once visitors are let in, only the run's
 * own starter. Off with TUNE_COMPOSER: 404. The examples are checked as the tuneRun workflow checks them, then the
 * launch is tried once now through launchJob with the run's settings and publish 0 (launchForRun), under the same
 * caps as every job.
 *
 * 201 {jobId, href}: training started. 202 {hold: {reason, text}}: it has to wait (the GPU is busy, a cap is hit, the
 * sweep hasn't run, Meta's spend cap), and the tuneRun workflow tries again every 5 minutes for up to 2 hours (started
 * here unless one is already trying). 404 not_found, 403 forbidden (another person's run), 409 already_training with
 * {jobId, href}, stopped, or not_ready (the examples are still being written), 422 {code, reason} when the examples
 * can't be trained on, and otherwise launchJob's own refusal (400 with its sentence, 503 lambda_not_configured,
 * platform_not_public, sweep_not_configured, 500 start_failed).
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.tuneComposer) return errorJson(404, "not_found");
  const caller = await tuneCaller(req);
  const { id } = await params;
  const dataset = await getDataset(id);
  if (!dataset) return errorJson(404, "not_found");
  if (!caller.isAdmin && dataset.createdBy !== caller.id) return errorJson(403, "forbidden");

  const job = await latestTuneJob(id);
  if (job) return errorJson(409, "already_training", { jobId: job.id, href: jobHref(job.id) });
  const now = new Date();
  const marks = await readRunMarks(id, now);
  if (marks.stopped) return errorJson(409, "stopped");
  const check = await checkExamples(id);
  if (!check.ok) {
    if (check.code === "not_ready") return errorJson(409, "not_ready");
    if (check.code === "missing") return errorJson(404, "not_found");
    await recordCheckEnded(id, check);
    return errorJson(422, check.code, { reason: isCheckCode(check.code) ? checkText(check.code) : null });
  }

  // A workflow still trying (a fresh waiting heartbeat) goes on trying; otherwise one starts if this try must wait.
  const beat = freshHeartbeat(marks, now.getTime());
  const trying = Boolean(beat && (beat.state === "checking" || isWaitReason(beat.state)));
  const steps = marks.steps ?? TUNE_STEPS;
  await clearRunEnded(id);
  const r = await launchForRun({ datasetId: id, callerId: caller.id, steps, now });
  if (r.kind === "stopped") return errorJson(409, "stopped");
  if (r.kind === "launched") {
    if (r.already) return errorJson(409, "already_training", { jobId: r.jobId, href: jobHref(r.jobId) });
    return Response.json({ jobId: r.jobId, href: jobHref(r.jobId) }, { status: 201 });
  }
  if (r.kind === "wait") {
    if (!trying) await startTraining(id, caller.id, steps);
    return Response.json({ hold: { reason: r.reason, text: waitText(r.reason) } }, { status: 202 });
  }
  return errorJson(r.refusal.status, r.refusal.code, r.refusal.body);
});

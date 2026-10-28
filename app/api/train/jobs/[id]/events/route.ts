import { after } from "next/server";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { terminateInstances } from "@/lib/train/lambda";
import { applyCallback, finishJob, getJob, recordEvent } from "@/lib/train/store";
import { isTrainTerminal, type TrainArtifact, type TrainCallback } from "@/lib/train/types";
import { jobBlobUrl, requireJobToken } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/** Callback bodies are small; the runner keeps them under this, and cuts log text to 4 KB. */
const MAX_BODY_BYTES = 16 * 1024;
const TEXT_MAX = 16 * 1024;
const ARTIFACT_KINDS: readonly TrainArtifact["kind"][] = ["adapter", "checkpoint", "metrics", "log", "other"];
/**
 * Heartbeat, progress, log and artifact callbacks one job may send per minute. The runner sends a heartbeat a minute
 * and a few progress and log lines; this stops a leaked job token filling the log. done and failed are never limited,
 * so the instance is always terminated at once.
 */
const CALLBACKS_PER_MINUTE = 120;

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, TEXT_MAX) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Only set keys, so an absent field stays absent in the stored event. */
function defined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The callback with only the fields its type allows, or null when it isn't one the runner sends. An artifact's URL
 * must be this job's own upload on this deployment's Blob store (jobBlobUrl).
 */
function parseCallback(body: Record<string, unknown>, jobId: string): TrainCallback | null {
  switch (body.type) {
    case "heartbeat":
      return defined({ type: "heartbeat" as const, message: text(body.message) });
    case "progress":
      return defined({
        type: "progress" as const,
        step: finite(body.step),
        totalSteps: finite(body.totalSteps),
        loss: finite(body.loss),
        message: text(body.message),
      });
    case "log": {
      const t = text(body.text);
      return t === undefined ? null : { type: "log", text: t };
    }
    case "artifact": {
      const a = body.artifact as Record<string, unknown> | null;
      if (!a || typeof a !== "object") return null;
      const name = text(a.name);
      const raw = text(a.url);
      const bytes = finite(a.bytes);
      if (!name || !raw || bytes === undefined || bytes < 0) return null;
      const url = jobBlobUrl(raw, jobId);
      if (!url) return null;
      const kind = ARTIFACT_KINDS.includes(a.kind as TrainArtifact["kind"]) ? (a.kind as TrainArtifact["kind"]) : "other";
      return { type: "artifact", artifact: { name, kind, url, bytes } };
    }
    case "done": {
      let metrics: Record<string, number | string> | undefined;
      if (body.metrics && typeof body.metrics === "object" && !Array.isArray(body.metrics)) {
        metrics = {};
        for (const [key, value] of Object.entries(body.metrics as Record<string, unknown>)) {
          if (typeof value === "string") metrics[key] = value.slice(0, 500);
          else if (finite(value) !== undefined) metrics[key] = value as number;
        }
      }
      return defined({ type: "done" as const, summary: text(body.summary), metrics });
    }
    case "failed":
      return { type: "failed", error: text(body.error) || "The job failed." };
    default:
      return null;
  }
}

/**
 * Terminates the job's instance now rather than at the workflow's next check: after done or failed, and when an ended
 * job's instance still reports in (its workflow may be gone). Skips a job with no instance or one already terminated.
 * finishJob keeps the job's own final status. Never throws.
 */
async function terminateNow(jobId: string, reason: string): Promise<void> {
  try {
    const job = await getJob(jobId);
    if (!job?.instanceId || job.terminatedAt) return;
    await terminateInstances([job.instanceId]);
    const status = job.status === "succeeded" || job.status === "stopped" ? job.status : "failed";
    await finishJob(jobId, { status, reason, terminatedAt: new Date() });
  } catch (err) {
    // The workflow's next check terminates it, and the sweep after that.
    console.error("[train/events] terminate", err instanceof Error ? err.message : err);
  }
}

/**
 * POST TrainCallback -> 204, from the job's runner with "Authorization: Bearer <job token>". 401 bad token, 400 not a
 * callback (or an artifact that isn't this job's own Blob upload), 413 over 16 KB, 409 job_ended once the job has
 * ended (a late log is still kept), 409 artifact_limit once the job has ARTIFACTS_MAX artifacts, 429 rate_limited
 * past 120 heartbeat, progress, log and artifact callbacks a minute. Any callback counts as a sign of life. done and
 * failed set the final status here and terminate the instance right after the reply, and so does any other callback
 * from an instance whose job already ended but isn't terminated.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  await requireJobToken(req, id);
  const body = await readJson(req, MAX_BODY_BYTES);
  const callback = parseCallback(body, id);
  if (!callback && body.type === "artifact") {
    return errorJson(400, "Send the artifact's name, size and the URL Vercel Blob gave this job's upload.");
  }
  if (!callback) return errorJson(400, "Send a heartbeat, progress, log, artifact, done or failed event.");

  if (callback.type !== "done" && callback.type !== "failed") {
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const key = `train-events:${id}`;
    const counts = await hitRateLimits([key], minute);
    if ((counts[key] ?? 0) > CALLBACKS_PER_MINUTE) return errorJson(429, "rate_limited");
  }

  const applied = await applyCallback(id, callback, new Date());
  if (!applied) return errorJson(404, "not_found");
  if (!applied.applied) {
    // A cap that won't lift, so not 429: the runner retries those.
    if (applied.artifactLimit) return errorJson(409, "artifact_limit");
    if (callback.type === "log") {
      await recordEvent(id, callback);
      return new Response(null, { status: 204 });
    }
    // The job ended but its instance still runs, so its workflow may be gone. Terminate it from here, which works
    // even while the sweep is down: the token keeps working for 15 minutes after the end and the runner reports
    // every minute.
    if (isTrainTerminal(applied.status)) after(() => terminateNow(id, "The instance kept reporting after its job ended."));
    return errorJson(409, "job_ended");
  }
  // A bare heartbeat every minute would bury the log; lastHeartbeatAt already shows it.
  if (callback.type !== "heartbeat" || callback.message) await recordEvent(id, callback);
  if (callback.type === "done" || callback.type === "failed") {
    const reason = callback.type === "done" ? "The job finished." : "The job reported a failure.";
    after(() => terminateNow(id, reason));
  }
  return new Response(null, { status: 204 });
});

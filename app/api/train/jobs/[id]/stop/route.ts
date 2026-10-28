import { requireAdminOrAutomation } from "@/lib/auth";
import { errorJson, route } from "@/lib/http";
import { terminateInstances } from "@/lib/train/lambda";
import { toJobView } from "@/lib/train/logic";
import { finishJob, getJob, recordEvent, requestStop } from "@/lib/train/store";
import { isTrainTerminal, type TrainStatus } from "@/lib/train/types";

type Ctx = { params: Promise<{ id: string }> };
type Ending = Extract<TrainStatus, "succeeded" | "failed" | "stopped">;

/**
 * POST -> {job}. Admins or automation only. On a job that hasn't ended: sets stopRequested (logged), then terminates
 * the instance right away when it has one, and records the job as stopped. On a job that ended but whose instance
 * isn't confirmed terminated yet: terminates it again, and the job keeps its status. So Stop can be pressed again until
 * terminatedAt is set. Best effort: when Lambda doesn't answer, the job's workflow terminates it at its next check
 * while it still runs, and the 5-minute sweep does in any case. 404 unknown job, 409 already_ended (terminated, or
 * ended without ever launching).
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  await requireAdminOrAutomation(req);
  const { id } = await params;
  const requested = await requestStop(id);
  const row = requested ?? (await getJob(id));
  if (!row) return errorJson(404, "not_found");
  if (!requested && (row.terminatedAt || !row.instanceId)) return errorJson(409, "already_ended");

  if (row.instanceId && !row.terminatedAt) {
    // Without a stop request the job has ended (requestStop only takes open jobs), so it keeps its status.
    const status = requested || !isTrainTerminal(row.status) ? "stopped" : (row.status as Ending);
    try {
      await terminateInstances([row.instanceId]);
      // finishJob decides the final status from the row: a stop request makes it stopped, an ended job keeps its own.
      await finishJob(id, {
        status,
        reason: requested ? "Stopped by an admin." : "An admin shut down the GPU after the job ended.",
        terminatedAt: new Date(),
      });
    } catch (err) {
      console.error("[train/stop] terminate", err instanceof Error ? err.message : err);
      await recordEvent(id, {
        type: "log",
        text: "Lambda did not confirm the terminate yet. The 5-minute sweep will terminate the instance, or press Stop again.",
      }).catch(() => undefined);
    }
  }
  const job = (await getJob(id)) ?? row;
  return Response.json({ job: toJobView(job, new Date()) });
});

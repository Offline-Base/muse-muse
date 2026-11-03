import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { fail } from "@/lib/train/sam/store";
import { requireRunToken, requireWorker } from "@/lib/train/sam/worker-auth";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const REASON_MAX = 500;

/**
 * POST {jobToken, reason} -> {status}: the board ends the run, as failed, or as stopped when an admin pressed Stop. The
 * reason is kept to 500 characters. 401 wrong secret or token, 400 no reason, 409 not_running, 404 SAM_TUNE off.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.samTune) return errorJson(404, "not_found");
  await requireWorker(req);
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const body = await readJson(req, 8192);
  await requireRunToken(req, id, typeof body.jobToken === "string" ? body.jobToken : "");
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, REASON_MAX) : "";
  if (!reason) return errorJson(400, "bad_request", { message: "Send a reason." });
  const run = await fail(id, reason);
  if (!run) return errorJson(409, "not_running");
  return Response.json({ status: run.status });
});

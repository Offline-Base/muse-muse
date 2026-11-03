import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { WORKER_ID_RE, wholeNumber } from "@/lib/train/sam/route-helpers";
import { claimNext } from "@/lib/train/sam/store";
import { requireWorker } from "@/lib/train/sam/worker-auth";

export const runtime = "nodejs";

/**
 * The office board's poll (scripts/edge/sam3/tune/worker.py). POST {workerId, freeMemMb, freeDiskMb} with
 * "Authorization: Bearer <worker secret>" (SAM_WORKER_TOKEN_SHA256). Records the poll, fails runs whose lease ran out,
 * then answers 204 with nothing queued, or 200 {run: {id, word, generic, data, photos, distractors, seed, epochs,
 * jobToken}} for the run it just claimed. The jobToken is sent this once. 401 wrong secret, 404 SAM_TUNE off.
 */
export const POST = route(async (req: Request) => {
  if (!env.samTune) return errorJson(404, "not_found");
  await requireWorker(req);
  const body = await readJson(req, 2048);
  const workerId = typeof body.workerId === "string" ? body.workerId : "";
  const freeMemMb = wholeNumber(body.freeMemMb, 1 << 30);
  const freeDiskMb = wholeNumber(body.freeDiskMb, 1 << 30);
  if (!WORKER_ID_RE.test(workerId) || freeMemMb === null || freeDiskMb === null) {
    return errorJson(400, "bad_request", { message: "Send workerId, freeMemMb and freeDiskMb." });
  }
  const run = await claimNext({ workerId, freeMemMb, freeDiskMb });
  if (!run) return new Response(null, { status: 204 });
  return Response.json({ run }, { headers: { "cache-control": "no-store" } });
});

import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { tuneCaller } from "@/lib/train/tune/caller";
import { readLoop, stopLoop } from "@/lib/train/tune/loop-store";

type Ctx = { params: Promise<{ id: string }> };

/** POST -> {stopped: true}: stops a tuning loop for good (stopLoop). Admins or automation. Off with TUNE_LOOP: 404. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.tuneLoop) return errorJson(404, "not_found");
  const caller = await tuneCaller(req);
  const loop = await readLoop((await params).id);
  if (!loop) return errorJson(404, "not_found");
  if (!caller.isAdmin && loop.spec.callerId !== caller.id) return errorJson(403, "forbidden");
  await stopLoop(loop);
  return Response.json({ stopped: true });
});

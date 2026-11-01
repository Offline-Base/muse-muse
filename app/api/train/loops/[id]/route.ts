import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { tuneCaller } from "@/lib/train/tune/caller";
import { loadLoopView } from "@/lib/train/tune/loop-store";

type Ctx = { params: Promise<{ id: string }> };

/** GET -> {loop: LoopView}: a tuning loop and every round. Admins or automation. Off with TUNE_LOOP: 404. */
export const GET = route(async (req: Request, { params }: Ctx) => {
  if (!env.tuneLoop) return errorJson(404, "not_found");
  await tuneCaller(req);
  const loop = await loadLoopView((await params).id);
  return loop ? Response.json({ loop }) : errorJson(404, "not_found");
});

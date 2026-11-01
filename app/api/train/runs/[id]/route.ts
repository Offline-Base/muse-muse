import { limitCeilings } from "@/app/api/train/shared";
import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { tuneCaller } from "@/lib/train/tune/caller";
import { loadTuneRun } from "@/lib/train/tune/store";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET -> {run: TuneRunView}: a run as its room shows it (lib/train/tune/view.ts), polled every 5 s while something
 * runs. Admins or automation (tuneCaller). Off with TUNE_COMPOSER: 404. 404 not_found for an id that names no dataset.
 *
 * There is no stop route yet: a dataset has no "stopped" state, and failing one mid-way doesn't stop its prompt batches
 * from being written (and billed). Training jobs stop from their own page, as they always have.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  if (!env.tuneComposer) return errorJson(404, "not_found");
  await tuneCaller(req);
  const { id } = await params;
  const run = await loadTuneRun(id, new Date(), limitCeilings());
  if (!run) return errorJson(404, "not_found");
  return Response.json({ run });
});

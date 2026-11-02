import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { getDataset } from "@/lib/train/store";
import { mayTouchRun, runCaller, runCeilings } from "@/lib/train/tune/caller";
import { loadTuneRun } from "@/lib/train/tune/store";
import { visitorRunView } from "@/lib/train/tune/view";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET -> {run: TuneRunView}: a run as its room shows it (lib/train/tune/view.ts), polled every 5 s while something
 * runs. Admins or automation (runCaller), and with OPEN_TRAIN on the visitor who started it, as visitorRunView shows it.
 * Off with TUNE_COMPOSER: 404. 404 not_found for an id that names no dataset, or anyone else's run for a visitor.
 *
 * There is no stop route yet: a dataset has no "stopped" state, and failing one mid-way doesn't stop its prompt batches
 * from being written (and billed). Training jobs stop from their own page, as they always have.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  if (!env.tuneComposer) return errorJson(404, "not_found");
  const caller = await runCaller(req);
  const { id } = await params;
  if (caller.visitor) {
    const dataset = await getDataset(id);
    if (!dataset || !(await mayTouchRun(caller, dataset.createdBy))) return errorJson(404, "not_found");
  }
  const run = await loadTuneRun(id, new Date(), runCeilings(caller));
  if (!run) return errorJson(404, "not_found");
  return Response.json({ run: caller.visitor ? visitorRunView(run) : run });
});

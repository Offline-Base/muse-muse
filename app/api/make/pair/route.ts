import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { buildForPair, isPairId, linkDeps, linkRun, saveRunAutoPublish, savePair } from "@/lib/make/pair";
import { makeChatAllOn } from "@/lib/make/switch";
import { getDataset } from "@/lib/train/store";
import { mayTouchRun, runCaller } from "@/lib/train/tune/caller";

/**
 * POST {buildId, runId} -> 200 {paired: true, link}. MAKE_CHAT_ALL (docs/TRAINING.md "One box for everything"). Off: 404.
 * Keeps a build and a run that were started together, for a caller who may touch both: the run is theirs (or they're an
 * admin) and the build is theirs (or they're an admin). A paired run is for a product, so it never uploads by itself,
 * whatever Start said. Starts nothing and spends nothing. Sent again later, it links the run to the build's product once
 * there is one (linkRun, admins only): `link` says how that stands.
 *
 * 400 bad ids, 401 or 403 as the run routes, 403 forbidden for someone else's build or run, 404 not_found, 409 run_paired
 * when the run is already paired with another build.
 */
export const POST = route(async (req: Request) => {
  if (!makeChatAllOn()) return errorJson(404, "not_found");
  const caller = await runCaller(req);
  const body = await readJson(req, 4 * 1024);
  if (!isPairId(body.buildId) || !isPairId(body.runId)) return errorJson(400, "Send a build and a run.");
  const { buildId, runId } = body;
  const dataset = await getDataset(runId);
  if (!dataset) return errorJson(404, "not_found");
  if (!(await mayTouchRun(caller, dataset.createdBy))) return errorJson(403, "forbidden");
  const build = await buildForPair(buildId);
  if (!build) return errorJson(404, "not_found");
  if (!caller.isAdmin) {
    const user = await getSessionUser();
    if (!user || user.id !== build.userId) return errorJson(403, "forbidden");
  }
  // Fails the pair, not quietly: a run for a product must not upload.
  await saveRunAutoPublish(runId, false);
  if (!(await savePair(buildId, runId))) return errorJson(409, "run_paired");
  const link = await linkRun({ caller, runId, buildId, build, now: new Date() }, linkDeps(env.tuneFromBuilds));
  return Response.json({ paired: true, link });
});

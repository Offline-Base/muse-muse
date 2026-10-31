import { start } from "workflow/api";
import { requireAdminOrAutomation } from "@/lib/auth";
import { env } from "@/lib/env";
import { badRequest, errorJson, readJson, route } from "@/lib/http";
import { requestedTargetsFrom } from "@/lib/native/targets";
import { catalogItem, catalogItems, itemId, rebuildNote, type CatalogItem } from "@/lib/pipeline/catalog";
import { attachRun, insertBuild, markStartFailed, rebuildIdsTaken } from "@/lib/pipeline/records";
import { buildProduct } from "@/lib/pipeline/workflow";
import { spendPaused } from "@/lib/quota";

/**
 * Admin. POST {ids?: string[], targets?: string[]} -> 200 {started: [{id, buildId}]}. Starts one build per catalog item
 * (Meta's videos and the missing demos). With no ids, it picks every item that has no live or partial product and no
 * build running. With ids, it rebuilds exactly those. `targets` is where each one runs, for showcase batches, and with
 * every target flag off it is ignored.
 */
export const POST = route(async (req: Request) => {
  const admin = await requireAdminOrAutomation(req);
  // An empty or missing body means "everything not rebuilt yet".
  const body: Record<string, unknown> = await readJson(req).catch(() => ({}));
  const ids = body.ids;
  const targets = requestedTargetsFrom(body.targets, env.enabledTargets);
  if (!targets.ok) throw badRequest(targets.error);

  let items: CatalogItem[];
  if (ids !== undefined && ids !== null) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw badRequest("ids must be a list of catalog ids.");
    items = [...new Set(ids as string[])].map((id) => {
      const item = catalogItem(id);
      if (!item) throw badRequest(`${id} isn't in the catalog.`);
      return item;
    });
  } else {
    const all = catalogItems();
    const taken = await rebuildIdsTaken(all.map(itemId));
    items = all.filter((item) => !taken.has(itemId(item)));
  }

  if (items.length && (await spendPaused())) return errorJson(503, "paused");

  const started: Array<{ id: string; buildId: string }> = [];
  for (const item of items) {
    const id = itemId(item);
    const { buildId } = await insertBuild({ userId: admin.id, note: rebuildNote(item), references: [], rebuildOf: id, requestedTargets: targets.value });
    try {
      const run = await start(buildProduct, [{ buildId }]);
      await attachRun(buildId, run.runId).catch((err) => console.error("[rebuilds] attachRun", err));
      started.push({ id, buildId });
    } catch (err) {
      await markStartFailed(buildId, err);
    }
  }
  return Response.json({ started });
});

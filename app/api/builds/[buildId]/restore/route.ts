import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { canActAsOwner, requireUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { errorJson, isUuid, route } from "@/lib/http";
import { attachRun, insertRefineBuild, markStartFailed } from "@/lib/pipeline/records";
import { restoreProduct } from "@/lib/pipeline/workflow";
import { checkBuildAllowed } from "@/lib/quota";
import { commitsFrom } from "@/lib/versions/policy";
import { keptBuildIds, productCommitBuilds } from "@/lib/versions/store";

type Ctx = { params: Promise<{ buildId: string }> };

/**
 * POST -> 201 {buildId} of a new build that brings this build's saved source back, on top of the history. Owner or admin
 * only (requireUser also refuses other sites). 404 unknown build or no saved source, 409 busy, not shipped, or a version
 * that never shipped. The quota applies, as for a change, though a restore makes no model calls.
 */
export const POST = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { buildId } = await params;
  if (!isUuid(buildId)) return errorJson(404, "not_found");
  const [from] = await db().select({ productId: schema.builds.productId, status: schema.builds.status }).from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  if (!from?.productId) return errorJson(404, "not_found");
  const [product] = await db().select().from(schema.products).where(eq(schema.products.id, from.productId)).limit(1);
  if (!product || product.takenDownAt) return errorJson(404, "not_found");
  if (!canActAsOwner(user, product.ownerId)) return errorJson(403, "Only the product's owner can restore a version.");
  if (product.status !== "live" && product.status !== "partial") return errorJson(409, "not_shipped");
  if (!product.sandboxName || !product.museSessionId) return errorJson(409, "not_shipped");
  if (from.status !== "live" && from.status !== "partial") return errorJson(409, "That version never shipped, so it can't be restored.");
  if (product.latestBuildId === buildId) return errorJson(409, "That's already the live version.");

  const commits = commitsFrom(await productCommitBuilds(product.id), await keptBuildIds(product.id));
  const commit = commits.find((c) => c.id === buildId);
  if (!commit?.kept) return errorJson(404, "That version's source wasn't kept.");

  const allowed = await checkBuildAllowed(user);
  if (!allowed.ok) return errorJson(allowed.status, allowed.error);

  const inserted = await insertRefineBuild({
    userId: user.id,
    productId: product.id,
    rebuildOf: product.rebuildOf,
    message: `Restore version ${commit.number}`,
    references: [],
    buildId: randomUUID(),
  });
  if (!inserted) return errorJson(409, "busy");
  let runId: string;
  try {
    runId = (await start(restoreProduct, [{ buildId: inserted.buildId, fromBuildId: buildId }])).runId;
  } catch (err) {
    await markStartFailed(inserted.buildId, err);
    return errorJson(500, "start_failed");
  }
  await attachRun(inserted.buildId, runId).catch((err) => console.error("[restore] attachRun", err));
  return Response.json({ buildId: inserted.buildId }, { status: 201 });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { attachRun, insertRefineBuild, markStartFailed } from "@/lib/pipeline/records";
import { MAX_NOTE_CHARS, validateReferences } from "@/lib/pipeline/references";
import { refineProduct } from "@/lib/pipeline/workflow";
import { checkBuildAllowed } from "@/lib/quota";

type Ctx = { params: Promise<{ buildId: string }> };

/**
 * POST {message, references?} -> 201 {buildId} of the new refine build for the product this build made.
 * 401 signed out, 403 not the owner or an admin, 404 unknown build, 409 {error: "busy"} while another build of the
 * product runs (or {error: "not_shipped"} before it has shipped). Also 429 daily_limit and 503 paused, as for new
 * builds, because a refinement spends credits too.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { buildId } = await params;
  if (!isUuid(buildId)) return errorJson(404, "not_found");
  const body = await readJson(req);

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return errorJson(400, "Say what to change.");
  if (message.length > MAX_NOTE_CHARS) return errorJson(400, `Keep the message under ${MAX_NOTE_CHARS} characters.`);

  const [build] = await db()
    .select({ productId: schema.builds.productId })
    .from(schema.builds)
    .where(eq(schema.builds.id, buildId))
    .limit(1);
  if (!build) return errorJson(404, "not_found");
  if (!build.productId) return errorJson(409, "not_shipped");
  const [product] = await db().select().from(schema.products).where(eq(schema.products.id, build.productId)).limit(1);
  if (!product) return errorJson(404, "not_found");
  if (product.ownerId !== user.id && !user.isAdmin) return errorJson(403, "Only the product's owner can change it.");
  if (product.status !== "live" && product.status !== "partial") return errorJson(409, "not_shipped");
  if (!product.sandboxName || !product.museSessionId) return errorJson(409, "not_shipped");

  // New files are prefixed with the refine build's id so they never replace the files earlier builds put in inspo/.
  const newBuildId = randomUUID();
  const references = validateReferences(body.references, { prefix: `${newBuildId.slice(0, 8)}-` });
  if (!references.ok) return errorJson(400, references.error);

  const allowed = await checkBuildAllowed(user);
  if (!allowed.ok) return errorJson(allowed.status, allowed.error);

  const inserted = await insertRefineBuild({
    userId: user.id,
    productId: product.id,
    rebuildOf: product.rebuildOf,
    message,
    references: references.value,
    buildId: newBuildId,
  });
  if (!inserted) return errorJson(409, "busy");

  let runId: string;
  try {
    runId = (await start(refineProduct, [{ buildId: inserted.buildId }])).runId;
  } catch (err) {
    await markStartFailed(inserted.buildId, err);
    return errorJson(500, "start_failed");
  }
  await attachRun(inserted.buildId, runId).catch((err) => console.error("[messages] attachRun", err));
  return Response.json({ buildId: inserted.buildId }, { status: 201 });
});

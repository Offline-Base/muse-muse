import { and, eq } from "drizzle-orm";
import { isCrossSite, requireUser } from "@/lib/auth";
import { checkChange } from "@/lib/brief/policy";
import { StructuredOutputError } from "@/lib/brief/structured";
import { db, schema } from "@/lib/db/client";
import { canEditProduct } from "@/lib/edit-pass";
import { LOOK_NOTE_MAX_CHARS } from "@/lib/engine/look";
import { env } from "@/lib/env";
import { addBuildCost, emit } from "@/lib/events";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import type { ModelUsage } from "@/lib/types";
import { recordUsage } from "@/lib/usage";

type Ctx = { params: Promise<{ buildId: string }> };

// A change's policy check is one low-effort model call, with one repair retry at most.
export const maxDuration = 60;

const REPLIES_PER_MINUTE = 6;

/**
 * POST {action: "approve"} or {action: "change", text} -> 200 {ok: true}: LOOK_FIRST (docs/LOOK_FIRST.md). The product's
 * owner answers the screens a build made first: wire them in now, or change the look first. A change passes the same
 * policy check as a refinement before Muse Code sees it. The build reads the answer from its events (lookReplyStep).
 * 404 with the flag off or an unknown build, 403 not the owner, 409 when the build isn't waiting on its screens.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.lookFirst) return errorJson(404, "not_found");
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const user = await requireUser();
  const { buildId } = await params;
  if (!isUuid(buildId)) return errorJson(404, "not_found");
  const body = await readJson(req);
  const action = body.action === "approve" || body.action === "change" ? body.action : null;
  if (!action) return errorJson(400, "Say approve or change.");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (action === "change" && !text) return errorJson(400, "Say what to change.");
  if (text.length > LOOK_NOTE_MAX_CHARS) return errorJson(400, `Keep the change under ${LOOK_NOTE_MAX_CHARS} characters.`);

  const [build] = await db()
    .select({ productId: schema.builds.productId, status: schema.builds.status })
    .from(schema.builds)
    .where(eq(schema.builds.id, buildId))
    .limit(1);
  if (!build?.productId) return errorJson(404, "not_found");
  const [product] = await db().select().from(schema.products).where(eq(schema.products.id, build.productId)).limit(1);
  if (!product) return errorJson(404, "not_found");
  if (!(await canEditProduct(user, product))) return errorJson(403, "Only the person who started this build can shape its look.");
  if (build.status !== "building") return errorJson(409, "not_waiting");

  // Only while the screens wait: the newest look event says "ready".
  const [last] = await db()
    .select({ payload: schema.buildEvents.payload })
    .from(schema.buildEvents)
    .where(and(eq(schema.buildEvents.buildId, buildId), eq(schema.buildEvents.type, "look")))
    .orderBy(schema.buildEvents.id)
    .then((rows) => rows.slice(-1));
  if (!last || last.payload.type !== "look" || last.payload.state !== "ready") return errorJson(409, "not_waiting");

  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const counts = await hitRateLimits([`look:${buildId}`], windowStart);
  if ((counts[`look:${buildId}`] ?? 0) > REPLIES_PER_MINUTE) return errorJson(429, "Too many answers. Wait a minute.");

  if (action === "change") {
    const charge = async (usage: ModelUsage[]) => {
      if (!usage.length) return;
      await recordUsage({ source: "platform", endpoint: "responses", buildId, productId: build.productId }, usage);
      await addBuildCost(buildId, usage.reduce((sum, u) => sum + (u.costUsd || 0), 0), "Look change check");
    };
    let refusal: string | null;
    try {
      const result = await checkChange({ message: text, references: [] });
      await charge(result.usage);
      refusal = result.refusal;
    } catch (err) {
      if (err instanceof StructuredOutputError) await charge(err.usage);
      return errorJson(503, "Muse Muse couldn't check this change, so it wasn't sent.");
    }
    if (refusal) return errorJson(422, refusal);
  }
  await emit(buildId, { type: "look_reply", action, ...(action === "change" ? { text } : {}) });
  return Response.json({ ok: true });
});

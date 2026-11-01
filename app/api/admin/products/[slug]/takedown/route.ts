import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, readJson, route } from "@/lib/http";
import { platformAlias } from "@/lib/trust/alias";
import { cleanReason, dbTakedownDeps, takedownProduct, undoTakedown } from "@/lib/trust/takedown";

export const runtime = "nodejs";

/**
 * POST {reason} -> 200 {ok, result}: an admin takes a product down (TRUST_REPORTS, docs/CAPABILITIES.md, section 7).
 * It's turned off, its live tokens are revoked, its page and gallery card are hidden and its public link is removed.
 * `result` is null when it was down already. DELETE undoes it. 404 with the flag off or for an unknown slug.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  if (!env.trustReports) return errorJson(404, "not_found");
  await requireAdmin();
  const { slug } = await params;
  const reason = cleanReason((await readJson(req, 4096)).reason);
  if (!reason) return errorJson(400, "Say why, in up to 500 characters.");
  const done = await takedownProduct(slug, reason, dbTakedownDeps(platformAlias()));
  if (!done.ok) return errorJson(404, "not_found");
  return Response.json({ ok: true, result: done.result });
});

export const DELETE = route(async (_req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  if (!env.trustReports) return errorJson(404, "not_found");
  await requireAdmin();
  const { slug } = await params;
  const done = await undoTakedown(slug, dbTakedownDeps(platformAlias()));
  if (!done.ok) return errorJson(404, "not_found");
  return Response.json({ ok: true, result: done.result });
});

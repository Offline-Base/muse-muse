import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { platformAlias } from "@/lib/trust/alias";
import { banUser, cleanReason, dbTakedownDeps, liftBan } from "@/lib/trust/takedown";

export const runtime = "nodejs";

/**
 * POST {reason} -> 200 {ok, bannedAt, products}: an admin bans a builder (TRUST_REPORTS, docs/CAPABILITIES.md,
 * section 7). They can't sign in or build, and every product of theirs is taken down at the same moment. DELETE lifts
 * the ban and undoes exactly those takedowns. 409 for an admin or the shared guest account, 404 with the flag off.
 */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!env.trustReports) return errorJson(404, "not_found");
  await requireAdmin();
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const reason = cleanReason((await readJson(req, 4096)).reason);
  if (!reason) return errorJson(400, "Say why, in up to 500 characters.");
  const done = await banUser(id, reason, dbTakedownDeps(platformAlias()));
  if (!done.ok) return errorJson(done.status, done.error);
  return Response.json(done);
});

export const DELETE = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!env.trustReports) return errorJson(404, "not_found");
  await requireAdmin();
  const { id } = await params;
  if (!isUuid(id)) return errorJson(404, "not_found");
  const done = await liftBan(id, dbTakedownDeps(platformAlias()));
  if (!done.ok) return errorJson(done.status, done.error);
  return Response.json(done);
});

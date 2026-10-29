import { isCrossSite } from "@/lib/auth";
import { toOrderView } from "@/lib/drive/logic";
import { adminMove, buyerCancel, getOrder, orderForSecret } from "@/lib/drive/store";
import { errorJson, route } from "@/lib/http";
import { cookieSecret, noStore, viewerIsAdmin } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST -> {order}: cancels an order (docs/VIBE_TUNING.md, Feature 6). Its buyer (the link's secret in this browser's
 * cookie) may until the bench starts writing the stick; an admin may until it ships. Not from another site (403
 * cross_site). 404 not_found for anyone else; 409 not_cancellable with {status} once it is too late.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const { id } = await params;
  const secret = cookieSecret(req, id);
  const mine = secret ? await orderForSecret(id, secret) : null;
  const admin = !mine && (await viewerIsAdmin());
  const row = mine ?? (admin ? await getOrder(id) : null);
  if (!row) return errorJson(404, "not_found");

  const moved = mine ? await buyerCancel(row.id) : await adminMove(row.id, { to: "cancelled" });
  if (!moved) {
    const now = await getOrder(row.id);
    return errorJson(409, "not_cancellable", { status: now?.status ?? row.status });
  }
  return Response.json({ order: toOrderView(moved) }, { headers: noStore });
});

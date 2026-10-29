import { isOrderSecret, toOrderView } from "@/lib/drive/logic";
import { getOrder, orderForSecret } from "@/lib/drive/store";
import { errorJson, route } from "@/lib/http";
import { cookieSecret, noStore, orderCookie, viewerIsAdmin } from "../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET -> {order}: one order as its buyer sees it, with their name, email and address (docs/VIBE_TUNING.md, Feature 6).
 * Only for the holder of the order's link (its secret in this browser's cookie, or ?k= once, which sets the cookie and
 * redirects to the clean URL) and for admins. Anyone else gets 404 not_found, whether or not the order exists.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const k = new URL(req.url).searchParams.get("k");
  if (isOrderSecret(k)) {
    const linked = await orderForSecret(id, k);
    if (linked) {
      const headers = new Headers({ ...noStore, location: `/api/drive/orders/${linked.id}` });
      headers.append("set-cookie", orderCookie(linked.id, k));
      return new Response(null, { status: 303, headers });
    }
  }
  const secret = cookieSecret(req, id);
  const mine = secret ? await orderForSecret(id, secret) : null;
  const row = mine ?? ((await viewerIsAdmin()) ? await getOrder(id) : null);
  if (!row) return errorJson(404, "not_found");
  return Response.json({ order: toOrderView(row) }, { headers: noStore });
});

import { isOrderSecret } from "@/lib/drive/logic";
import { orderForSecret } from "@/lib/drive/store";
import { route } from "@/lib/http";
import { noStore, orderCookie } from "@/app/api/drive/shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET ?k=<secret>: the order link a buyer was shown once (docs/VIBE_TUNING.md, Feature 6). With the order's own secret
 * it saves the secret in this browser as an HttpOnly cookie and lands on the clean /orders/{id}, so the secret leaves
 * the address bar at once. Without it, it lands there all the same, and the page says there is no order to show.
 */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const { id } = await params;
  const k = new URL(req.url).searchParams.get("k");
  const row = isOrderSecret(k) ? await orderForSecret(id, k) : null;
  const target = row ? row.id : encodeURIComponent(id);
  const headers = new Headers({ ...noStore, location: `/orders/${target}`, "referrer-policy": "no-referrer" });
  if (row && k) headers.append("set-cookie", orderCookie(row.id, k));
  return new Response(null, { status: 303, headers });
});

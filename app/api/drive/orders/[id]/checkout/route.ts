import { isCrossSite } from "@/lib/auth";
import { checkoutFor } from "@/lib/drive/checkout";
import { orderForSecret } from "@/lib/drive/store";
import { StripeError } from "@/lib/drive/stripe";
import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { cookieSecret, noStore } from "../../../shared";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST -> {url}: the Stripe Checkout page that pays for a card order (docs/VIBE_TUNING.md, Feature 6, "Paying by
 * card"), for the order's buyer only (the link's secret in this browser's cookie). It reuses the order's open session,
 * so a second click pays the same one. Not from another site (403 cross_site). 503 checkout_off unless card payments
 * are set up (env.driveCheckout); 404 not_found for anyone else; 409 not_payable with {status} for an order that isn't
 * a card order waiting for its payment; 502 stripe with Stripe's sentence when Stripe refuses or can't be reached.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  if (!env.driveCheckout) return errorJson(503, "checkout_off");
  const { id } = await params;
  const secret = cookieSecret(req, id);
  const row = secret ? await orderForSecret(id, secret) : null;
  if (!row) return errorJson(404, "not_found");
  if (row.payment !== "card" || row.status !== "requested") return errorJson(409, "not_payable", { status: row.status });
  try {
    const url = await checkoutFor(row, env.platformUrl);
    return Response.json({ url }, { headers: noStore });
  } catch (err) {
    if (err instanceof StripeError) {
      console.error("[drive] checkout:", err.status, err.message);
      return errorJson(err.status === 503 ? 503 : 502, err.status === 503 ? "checkout_off" : "stripe", { message: err.message });
    }
    throw err;
  }
});

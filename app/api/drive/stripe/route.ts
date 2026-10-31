import { after } from "next/server";
import { settleCheckout } from "@/lib/drive/checkout";
import { paidSummary } from "@/lib/drive/logic";
import { notifyOwner } from "@/lib/drive/notify";
import { countToFlash } from "@/lib/drive/store";
import { verifyWebhook, type CheckoutSession } from "@/lib/drive/stripe";
import { env } from "@/lib/env";
import { errorJson } from "@/lib/http";
import { noStore } from "../shared";

/** A Stripe event is a few KB; anything near this isn't one. */
const BODY_MAX = 256 * 1024;

/** The events this endpoint acts on. Subscribe the webhook in Stripe to these. */
const SETTLES = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

/**
 * POST: Stripe's webhook for card-paid drive orders (docs/VIBE_TUNING.md, Feature 6, "Paying by card"). Only a body
 * signed with STRIPE_WEBHOOK_SECRET within five minutes counts (400 bad_signature otherwise); 503 checkout_off when
 * Stripe isn't set up. A completed, paid Checkout Session moves its order to paid, and the owner's webhook gets one
 * line; a payment for an order that was cancelled or already paid is refunded (settleCheckout). Every other event is
 * acknowledged and ignored. A failure answers 500, so Stripe sends the event again.
 */
export async function POST(req: Request): Promise<Response> {
  const secret = env.stripeWebhookSecret;
  if (!secret || !env.stripeSecretKey) return errorJson(503, "checkout_off");
  const raw = await req.text();
  if (raw.length > BODY_MAX) return errorJson(413, "too_large");
  const event = verifyWebhook(raw, req.headers.get("stripe-signature"), secret);
  if (!event) return errorJson(400, "bad_signature");
  if (!SETTLES.has(event.type)) return Response.json({ received: true }, { headers: noStore });
  try {
    const settled = await settleCheckout(event.data.object as unknown as CheckoutSession);
    if (settled.outcome === "paid") {
      const order = settled.order;
      after(async () => {
        try {
          const toFlash = await countToFlash();
          const adminUrl = `${env.platformUrl}/fine-tuning/orders`;
          await notifyOwner(paidSummary({ title: order.model.title, build: order.build, count: order.files.length, orderId: order.id, toFlash, adminUrl }));
        } catch (err) {
          console.error("[drive] couldn't tell the owner:", err instanceof Error ? err.message : err);
        }
      });
    }
    return Response.json({ received: true, outcome: settled.outcome }, { headers: noStore });
  } catch (err) {
    console.error("[drive] webhook:", err instanceof Error ? err.message : err);
    return errorJson(500, "not_settled");
  }
}

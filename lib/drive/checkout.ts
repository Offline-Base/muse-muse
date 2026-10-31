/**
 * Paying for a flash drive by card (docs/VIBE_TUNING.md, Feature 6, "Paying by card"): the Checkout Session for an
 * order, settling a session Stripe says was paid (from the signed webhook, or the session the buyer comes back with),
 * and the refund when a paid card order is cancelled. The webhook is the source of truth; reading the session on the
 * way back only makes the order page right before the webhook lands. Settling twice is harmless: the store's guarded
 * update moves an order to paid once, and a second payment for the same order is refunded.
 */
import { buildLabel, usd, type DriveOrderRow } from "@/lib/drive/logic";
import { appendNote, getOrder, markCardPaid, setCheckoutSession, setRefund } from "@/lib/drive/store";
import { createCheckout, getCheckout, isPaymentIntentId, refundPayment, StripeError, type CheckoutSession, type FetchLike } from "@/lib/drive/stripe";
import { env } from "@/lib/env";

/** The note an order gets when its refund couldn't be sent, so the admin queue shows it. */
export const REFUND_FAILED_NOTE = "The card refund didn't go through: refund it in Stripe.";

export interface CheckoutDeps {
  fetchImpl?: FetchLike;
  now?: Date;
}

function stripeKey(): string {
  const key = env.stripeSecretKey;
  if (!key) throw new StripeError(503, "Card payments aren't set up.");
  return key;
}

/** Where Stripe sends the buyer back: the order page, with the session's id so it can be read at once. */
export function checkoutUrls(origin: string, orderId: string): { successUrl: string; cancelUrl: string } {
  return {
    // Stripe fills {CHECKOUT_SESSION_ID} in itself.
    successUrl: `${origin}/orders/${orderId}?session={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/orders/${orderId}?checkout=cancelled`,
  };
}

/**
 * The Checkout Session to send a card order's buyer to: the order's open one when it has one (so a second click or a
 * second tab pays the same session), else a new one at today's price. Returns its URL. Throws StripeError when Stripe
 * refuses or can't be reached.
 */
export async function checkoutFor(row: DriveOrderRow, origin: string, deps: CheckoutDeps = {}): Promise<string> {
  const key = stripeKey();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const price = env.drivePriceCents;
  if (price === null) throw new StripeError(503, "Card payments aren't set up.");
  if (row.checkoutSessionId) {
    const open = await getCheckout(key, row.checkoutSessionId, fetchImpl).catch(() => null);
    if (open?.status === "open" && open.url) return open.url;
  }
  if (!row.email) throw new StripeError(409, "This order has no email to send the receipt to.");
  const { successUrl, cancelUrl } = checkoutUrls(origin, row.id);
  const session = await createCheckout(
    key,
    {
      orderId: row.id,
      email: row.email,
      name: `${row.model.title} on a flash drive`,
      description: `${buildLabel(row.build, row.files.length)} of the model, with a llama.cpp runtime and launchers for Mac and Windows. US shipping included.`,
      amountCents: price,
      successUrl,
      cancelUrl,
      // Two clicks at once both see the same previous session, so they make one new one.
      idempotencyKey: `drive-checkout-${row.id}-${row.checkoutSessionId ?? "first"}`,
    },
    fetchImpl,
  );
  if (!session.url) throw new StripeError(502, "Stripe didn't send a checkout page.");
  await setCheckoutSession(row.id, session.id, deps.now);
  return session.url;
}

/** "$59.00 by card": what a card order keeps as its amount, from what Stripe charged. */
export function chargedText(session: Pick<CheckoutSession, "amount_total" | "currency">): string {
  const cents = session.amount_total ?? 0;
  const currency = (session.currency ?? "usd").toLowerCase();
  const amount = currency === "usd" ? usd(cents) : `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  return `${amount} by card`;
}

export type SettleResult =
  | { outcome: "paid"; order: DriveOrderRow }
  | { outcome: "already"; order: DriveOrderRow }
  | { outcome: "refunded"; order: DriveOrderRow }
  | { outcome: "ignored" };

/**
 * A Checkout Session Stripe says is complete. A paid session for a card order waiting on it makes the order paid. One
 * for an order already paid by that same payment changes nothing. One for an order that was cancelled, or already
 * paid by another session (two tabs, both paid), is refunded at once, so nobody pays twice or pays for nothing.
 * Anything else (unpaid, not ours, an invoice order) is ignored.
 */
export async function settleCheckout(session: CheckoutSession, deps: CheckoutDeps = {}): Promise<SettleResult> {
  if (session.payment_status !== "paid" || !isPaymentIntentId(session.payment_intent)) return { outcome: "ignored" };
  const orderId = session.metadata?.orderId ?? session.client_reference_id;
  const row = orderId ? await getOrder(orderId) : null;
  if (!row || row.payment !== "card") return { outcome: "ignored" };
  const moved = await markCardPaid(row.id, { paymentIntent: session.payment_intent, amountText: chargedText(session), sessionId: session.id }, deps.now);
  if (moved) return { outcome: "paid", order: moved };
  const now = (await getOrder(row.id)) ?? row;
  if (now.invoiceRef === session.payment_intent) return { outcome: "already", order: now };
  const key = stripeKey();
  await refundPayment(key, session.payment_intent, row.id, deps.fetchImpl ?? fetch);
  return { outcome: "refunded", order: now };
}

/**
 * The session the buyer came back from Stripe with, read from Stripe and settled, but only when it belongs to this
 * order (its metadata names it). Never throws: the webhook settles it anyway.
 */
export async function settleReturn(row: DriveOrderRow, sessionId: string, deps: CheckoutDeps = {}): Promise<DriveOrderRow> {
  if (row.payment !== "card" || row.status !== "requested" || !env.stripeSecretKey) return row;
  try {
    const session = await getCheckout(env.stripeSecretKey, sessionId, deps.fetchImpl ?? fetch);
    if ((session.metadata?.orderId ?? session.client_reference_id) !== row.id) return row;
    const settled = await settleCheckout(session, deps);
    return settled.outcome === "ignored" ? row : settled.order;
  } catch (err) {
    console.error("[drive] couldn't read the checkout:", err instanceof Error ? err.message : err);
    return row;
  }
}

/**
 * Refunds a card order that was cancelled after it was paid, once (Stripe's idempotency key is the payment), and keeps
 * the refund's id. A refund that fails leaves a note for the admin queue and never undoes the cancel. Returns the order
 * as it now is. Invoice orders are refunded by the owner from their own tool, as before.
 */
export async function refundIfCardPaid(row: DriveOrderRow, deps: CheckoutDeps = {}): Promise<DriveOrderRow> {
  if (row.status !== "cancelled" || row.payment !== "card" || !row.paidAt || row.refundRef || !isPaymentIntentId(row.invoiceRef)) return row;
  try {
    const refund = await refundPayment(stripeKey(), row.invoiceRef, row.id, deps.fetchImpl ?? fetch);
    return (await setRefund(row.id, refund.id, deps.now)) ?? row;
  } catch (err) {
    console.error("[drive] refund failed:", err instanceof Error ? err.message : err);
    await appendNote(row.id, REFUND_FAILED_NOTE, deps.now).catch(() => {});
    return (await getOrder(row.id)) ?? row;
  }
}

/**
 * Stripe for card-paid flash drive orders (docs/VIBE_TUNING.md, Feature 6, "Paying by card"): a Checkout Session for
 * an order, reading one back, refunding a payment, and checking a webhook's signature. Plain fetch against Stripe's REST
 * API with the secret key (STRIPE_SECRET_KEY), so there's no SDK to keep current, and every call takes a fetch the
 * tests fake. The key is sent only to api.stripe.com and never logged or returned.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.stripe.com/v1";

/** How old a webhook's signed timestamp may be, as Stripe's own libraries allow. */
export const WEBHOOK_TOLERANCE_S = 300;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A call Stripe refused or couldn't answer. `message` is Stripe's own sentence, which never holds the key. */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

/** The fields of a Checkout Session the drive orders read. */
export interface CheckoutSession {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired" | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  payment_intent: string | null;
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string> | null;
}

/** A webhook event, as far as the drive orders read it. */
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

type FormValue = string | number | boolean | undefined | null | FormFields | FormValue[];
interface FormFields {
  [key: string]: FormValue;
}

/** Stripe's form encoding: nested objects and arrays as a[b][0]=c. Undefined and null are left out. */
export function stripeForm(fields: FormFields): URLSearchParams {
  const out = new URLSearchParams();
  const add = (key: string, value: FormValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${key}[${i}]`, v));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else out.append(key, String(value));
  };
  for (const [k, v] of Object.entries(fields)) add(k, v);
  return out;
}

async function call<T>(
  fetchImpl: FetchLike,
  secretKey: string,
  method: "GET" | "POST",
  path: string,
  fields?: FormFields,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
  if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let res: Response;
  try {
    res = await fetchImpl(`${API}${path}`, { method, headers, body: fields ? stripeForm(fields).toString() : undefined });
  } catch {
    throw new StripeError(502, "Couldn't reach Stripe.");
  }
  const data = (await res.json().catch(() => null)) as { error?: { message?: unknown; code?: unknown } } | null;
  if (!res.ok) {
    const message = typeof data?.error?.message === "string" ? data.error.message : `Stripe answered HTTP ${res.status}.`;
    throw new StripeError(res.status, message, typeof data?.error?.code === "string" ? data.error.code : undefined);
  }
  return data as T;
}

export interface NewCheckout {
  orderId: string;
  email: string;
  /** What the buyer reads on Stripe's page: the product's name and one line about it. */
  name: string;
  description: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
  /** Two calls with the same key make one session, so a double click never makes two. */
  idempotencyKey: string;
}

/**
 * A Checkout Session for one order: one line item at the drive's price in US dollars, card only (so a paid session is
 * paid at once, with no bank transfer to wait for), the buyer's email for Stripe's receipt, and the order's id in
 * client_reference_id and in the session's and the payment's metadata, which is how the webhook finds the order.
 */
export async function createCheckout(secretKey: string, input: NewCheckout, fetchImpl: FetchLike = fetch): Promise<CheckoutSession> {
  return call<CheckoutSession>(
    fetchImpl,
    secretKey,
    "POST",
    "/checkout/sessions",
    {
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: input.amountCents,
            product_data: { name: input.name.slice(0, 250), description: input.description.slice(0, 500) },
          },
        },
      ],
      customer_email: input.email,
      client_reference_id: input.orderId,
      metadata: { orderId: input.orderId },
      payment_intent_data: { metadata: { orderId: input.orderId } },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
    input.idempotencyKey,
  );
}

/** One Checkout Session, read back from Stripe. */
export async function getCheckout(secretKey: string, sessionId: string, fetchImpl: FetchLike = fetch): Promise<CheckoutSession> {
  if (!isCheckoutSessionId(sessionId)) throw new StripeError(400, "That isn't a Checkout Session id.");
  return call<CheckoutSession>(fetchImpl, secretKey, "GET", `/checkout/sessions/${sessionId}`);
}

/**
 * Refunds a payment in full. Keyed on the payment, so asking twice refunds once. Returns the refund's id and Stripe's
 * status for it ("succeeded", or "pending" while the card network confirms).
 */
export async function refundPayment(
  secretKey: string,
  paymentIntent: string,
  orderId: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ id: string; status: string }> {
  if (!isPaymentIntentId(paymentIntent)) throw new StripeError(400, "That isn't a payment id.");
  const refund = await call<{ id: string; status: string }>(
    fetchImpl,
    secretKey,
    "POST",
    "/refunds",
    { payment_intent: paymentIntent, metadata: { orderId } },
    `refund-${paymentIntent}`,
  );
  return { id: refund.id, status: refund.status };
}

export function isCheckoutSessionId(value: unknown): value is string {
  return typeof value === "string" && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(value);
}

export function isPaymentIntentId(value: unknown): value is string {
  return typeof value === "string" && /^pi_[A-Za-z0-9]{10,200}$/.test(value);
}

/**
 * The event in a webhook's body when its Stripe-Signature header is signed with `secret` (an HMAC-SHA256 of
 * "<t>.<body>", any of the v1 signatures, compared in constant time) and its timestamp is within the tolerance. Null
 * for anything else, so a forged or replayed call changes nothing.
 */
export function verifyWebhook(rawBody: string, header: string | null, secret: string, nowMs = Date.now()): StripeEvent | null {
  if (!header) return null;
  let t: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((x) => x?.trim() ?? "");
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (t === null || !signatures.length) return null;
  if (Math.abs(nowMs / 1000 - t) > WEBHOOK_TOLERANCE_S) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  const match = signatures.some((s) => {
    const got = Buffer.from(s);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!match) return null;
  try {
    const event = JSON.parse(rawBody) as StripeEvent;
    return typeof event?.type === "string" && event.data && typeof event.data.object === "object" ? event : null;
  } catch {
    return null;
  }
}

/** A Stripe-Signature header for `rawBody`, as Stripe signs it. For the tests and the local checkout script. */
export function signWebhook(rawBody: string, secret: string, nowMs = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

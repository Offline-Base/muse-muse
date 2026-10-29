/**
 * Words and small helpers for the flash drive pages (docs/VIBE_TUNING.md, Feature 6): the request form, the order page,
 * the offer on a model's page and the admin queue. No hooks and no server imports, so server and client components
 * share them.
 */
import type { Tone } from "@/lib/format";
import type { DriveOrderView } from "@/lib/drive/logic";
import type { DriveAddress, DriveStatus } from "@/lib/drive/types";

export const DRIVE_STATUS_LABEL: Record<DriveStatus, string> = {
  requested: "Requested",
  invoiced: "Invoiced",
  paid: "Paid",
  flashing: "Writing the drive",
  checked: "Checked",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/** Pill color: green once delivered, grey when cancelled, blue while it moves. */
export function driveTone(status: DriveStatus): Tone {
  if (status === "delivered") return "live";
  if (status === "cancelled") return "neutral";
  return "building";
}

/** The steps the order page draws, in order. A cancelled order shows where it stopped. */
export const DRIVE_STEPS: ReadonlyArray<{ status: DriveStatus; label: string; sub: string }> = [
  { status: "requested", label: "Requested", sub: "Nothing is charged" },
  { status: "invoiced", label: "Invoiced", sub: "An invoice by email" },
  { status: "paid", label: "Paid", sub: "In line to be written" },
  { status: "flashing", label: "Writing the drive", sub: "The files go on the drive" },
  { status: "checked", label: "Checked", sub: "Every file read back and matched" },
  { status: "shipped", label: "Shipped", sub: "On its way" },
  { status: "delivered", label: "Delivered", sub: "Plug it in" },
];

/** True once the order was paid: a cancel then owes the buyer a refund, which the owner sends from their own tool. */
export function wasPaid(order: Pick<DriveOrderView, "at">): boolean {
  return Boolean(order.at.paid);
}

/** USPS's tracking page for a number, or null for another carrier or a number that isn't one. */
export function trackingHref(carrier: string | null, tracking: string | null): string | null {
  const number = (tracking ?? "").replace(/\s+/g, "");
  if (!/^usps$/i.test((carrier ?? "").trim()) || !/^[A-Z0-9]{10,40}$/i.test(number)) return null;
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`;
}

/** What happens next, as the order page says it. */
export function nextStepText(order: Pick<DriveOrderView, "status" | "at" | "buyer" | "invoiceRef" | "amountText" | "carrier" | "tracking" | "serial" | "cancelledBy">): string {
  const email = order.buyer?.email ?? "your email";
  switch (order.status) {
    case "requested":
      return `We'll email an invoice to ${email} within 2 business days. Nothing is charged until you pay it.`;
    case "invoiced": {
      const what = [order.invoiceRef ? `invoice ${order.invoiceRef}` : "an invoice", order.amountText ? `for ${order.amountText}` : null]
        .filter(Boolean)
        .join(" ");
      return `We emailed ${what} to ${email}. Pay it from the email, and we'll write your drive. You can still cancel until then.`;
    }
    case "paid":
      return "Thanks, you've paid. We write your drive, check every file on it, and ship it within 2 business days.";
    case "flashing":
      return "We're writing your drive now. Then we unplug it, plug it back in and check every file before it ships.";
    case "checked":
      return `Your drive${order.serial ? ` (serial ${order.serial})` : ""} passed its check: every file matched. It ships next.`;
    case "shipped":
      return `${order.carrier && order.tracking ? `It's on its way with ${order.carrier}. The tracking number is ${order.tracking}.` : "It's on its way."} When it arrives, plug it in and open Start Here.html.`;
    case "delivered":
      return "Delivered. Plug the drive in and open Start Here.html.";
    case "cancelled": {
      const who = order.cancelledBy === "buyer" ? "You cancelled this order." : "This order was cancelled.";
      return `${who} ${wasPaid(order) ? "We'll refund what you paid." : "Nothing was charged."}`;
    }
  }
}

/** The address as label lines. */
export function addressLines(a: DriveAddress): string[] {
  return [a.line1, a.line2, `${a.city}, ${a.state} ${a.postalCode}`].filter((l): l is string => Boolean(l));
}

/** A request the route refused, as one sentence for the form. */
export function requestErrorText(status: number, data: unknown): string {
  const d = (data && typeof data === "object" ? data : {}) as { error?: unknown; scope?: unknown; reason?: unknown };
  const error = typeof d.error === "string" ? d.error : "";
  if (status === 400 && error) return error;
  if (status === 429) {
    return d.scope === "everyone"
      ? "We've had all the drive requests we can take today. Try again tomorrow."
      : "You've sent as many drive requests as we take in a day. Try again tomorrow, or cancel one you don't need.";
  }
  if (status === 409 && error === "terms_changed") return "The terms changed while this page was open. Reload the page to read them, then send it again.";
  if (status === 404) return typeof d.reason === "string" && d.reason ? d.reason : "This model can't go on a drive right now.";
  if (status === 503) return "Flash drive orders are off right now.";
  if (status === 401) return "Sign in to request a drive.";
  if (status === 403) return "Your browser blocked the request. Reload the page and try again.";
  return "Something went wrong on our side. Try again in a minute.";
}

/** One of the admin queue's actions the route refused, as one sentence. */
export function adminErrorText(status: number, data: unknown): string {
  const d = (data && typeof data === "object" ? data : {}) as { error?: unknown; status?: unknown };
  if (status === 400 && typeof d.error === "string") return d.error;
  if (status === 409) {
    const now = typeof d.status === "string" && d.status in DRIVE_STATUS_LABEL ? DRIVE_STATUS_LABEL[d.status as DriveStatus] : "moved on";
    return `The order is ${now.toLowerCase()} now, so that can't happen. Reload the queue.`;
  }
  if (status === 403 || status === 401) return "Only admins can change orders.";
  if (status === 404) return "That order is gone.";
  return "Something went wrong on our side. Try again in a minute.";
}

/** Where the buyer's saved details live in their browser (Remember my details on this device). */
export const REMEMBER_KEY = "mm_drive_buyer_v1";

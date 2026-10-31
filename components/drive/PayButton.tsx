"use client";

import { useState } from "react";
import { requestErrorText } from "@/components/drive/format";
import { Icon } from "@/components/icons";

/**
 * Sends a card order's buyer to Stripe Checkout (docs/VIBE_TUNING.md, Feature 6, "Paying by card"): POSTs
 * /api/drive/orders/{id}/checkout with this browser's order cookie and goes to the page it answers with. Stripe brings
 * the buyer back to the order page, paid or not.
 */
export async function goToCheckout(orderId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/drive/orders/${orderId}/checkout`, { method: "POST" });
    const data: unknown = await res.json().catch(() => ({}));
    const url = (data as { url?: unknown } | null)?.url;
    if (res.ok && typeof url === "string" && url.startsWith("https://")) {
      window.location.assign(url);
      return null;
    }
    if (res.status === 409) return "This order isn't waiting for a payment any more. Reload the page.";
    return requestErrorText(res.status, data);
  } catch {
    return "Couldn't reach Muse Muse. Check your connection and try again.";
  }
}

export function PayButton({ orderId, label }: { orderId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="drive-row">
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const problem = await goToCheckout(orderId);
          if (problem) {
            setError(problem);
            setBusy(false);
          }
        }}
      >
        {busy ? "Opening checkout..." : label}
      </button>
      <span className="muted small">Card payments go through Stripe. We never see your card number.</span>
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

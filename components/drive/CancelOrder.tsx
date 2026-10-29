"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";

/**
 * Cancel on the order page: confirms, saying what happens to any payment (a paid order is refunded), then POSTs
 * /api/drive/orders/{id}/cancel with this browser's order cookie and reloads the page's data. The route says no once
 * the bench has started writing the drive.
 */
export function CancelOrder({ orderId, paid }: { orderId: string; paid: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    const ask = paid
      ? "Cancel this order? We won't write the drive, and we'll refund what you paid."
      : "Cancel this order? Nothing was charged, and we won't write the drive.";
    if (busy || !window.confirm(ask)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/drive/orders/${orderId}/cancel`, { method: "POST" });
      if (res.ok) {
        router.refresh();
      } else if (res.status === 409) {
        setError("It's too late to cancel: we've started writing your drive. Reply to the invoice email if something is wrong.");
      } else {
        setError("Couldn't cancel it just now. Try again in a minute.");
      }
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <div className="drive-row">
      <button type="button" className="btn btn-outline" onClick={() => void cancel()} disabled={busy}>
        {busy ? "Cancelling..." : "Cancel the order"}
      </button>
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

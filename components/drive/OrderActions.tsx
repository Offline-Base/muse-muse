"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { adminErrorText } from "@/components/drive/format";
import type { AdminMove } from "@/lib/drive/logic";

/** Each button says what it does, not the status it leads to. */
const LABEL: Record<AdminMove, string> = {
  invoiced: "Mark invoiced",
  paid: "Mark paid",
  shipped: "Mark shipped",
  delivered: "Mark delivered",
  cancelled: "Cancel order",
};

/** Moves that need details first open a small form; the others only confirm. */
const CONFIRM: Partial<Record<AdminMove, string>> = {
  paid: "Mark this order paid? It joins the bench queue.",
  delivered: "Mark this order delivered? Its buyer's details are deleted 60 days from now.",
  cancelled: "Cancel this order? The buyer sees it on their order page, and if they paid, it tells them you'll refund them: do that from your invoicing tool.",
};

/**
 * The admin queue's buttons for one order (docs/VIBE_TUNING.md, Feature 6): Invoiced (with the invoice reference and the
 * amount as the invoice states it), Paid, Shipped (carrier and tracking number), Delivered and Cancel, only those the
 * order's status allows. Each POSTs /api/drive/orders/{id}/status, which checks the move again, then reloads the queue.
 * Flashing and Checked come only from the bench script.
 */
export function OrderActions({ orderId, actions }: { orderId: string; actions: AdminMove[] }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState<"invoiced" | "shipped" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invoiceRef, setInvoiceRef] = useState("");
  const [amountText, setAmountText] = useState("");
  const [carrier, setCarrier] = useState("USPS");
  const [tracking, setTracking] = useState("");

  async function move(to: AdminMove, extra: Record<string, string> = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/drive/orders/${orderId}/status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: to, ...extra }),
      });
      if (res.ok) {
        setOpen(null);
        router.refresh();
      } else {
        setError(adminErrorText(res.status, await res.json().catch(() => ({}))));
      }
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection and try again.");
    }
    setBusy(false);
  }

  function press(to: AdminMove) {
    if (to === "invoiced" || to === "shipped") {
      setOpen(open === to ? null : to);
      setError(null);
      return;
    }
    if (window.confirm(CONFIRM[to] ?? "Are you sure?")) void move(to);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (open === "invoiced") void move("invoiced", { invoiceRef: invoiceRef.trim(), amountText: amountText.trim() });
    if (open === "shipped") void move("shipped", { carrier: carrier.trim(), tracking: tracking.trim() });
  }

  if (!actions.length) return <span className="muted small">Nothing to do</span>;
  return (
    <div>
      <div className="drive-actions">
        {actions.map((to) => (
          <button
            key={to}
            type="button"
            className={to === "cancelled" ? "btn btn-sm btn-outline" : "btn btn-sm btn-primary"}
            onClick={() => press(to)}
            disabled={busy}
            aria-expanded={to === "invoiced" || to === "shipped" ? open === to : undefined}
          >
            {LABEL[to]}
          </button>
        ))}
      </div>
      {open ? (
        <form className="drive-action-form" onSubmit={submit}>
          {open === "invoiced" ? (
            <>
              <label className="train-sublabel" htmlFor={`${id}-ref`}>
                Invoice reference
              </label>
              <input id={`${id}-ref`} className="train-input" value={invoiceRef} maxLength={100} onChange={(e) => setInvoiceRef(e.target.value)} placeholder="INV-0012" required />
              <label className="train-sublabel" htmlFor={`${id}-amount`}>
                Amount, as the invoice says it
              </label>
              <input id={`${id}-amount`} className="train-input" value={amountText} maxLength={100} onChange={(e) => setAmountText(e.target.value)} placeholder="$59 with US shipping" required />
            </>
          ) : (
            <>
              <label className="train-sublabel" htmlFor={`${id}-carrier`}>
                Carrier
              </label>
              <input id={`${id}-carrier`} className="train-input" value={carrier} maxLength={40} onChange={(e) => setCarrier(e.target.value)} required />
              <label className="train-sublabel" htmlFor={`${id}-tracking`}>
                Tracking number
              </label>
              <input id={`${id}-tracking`} className="train-input" value={tracking} maxLength={60} onChange={(e) => setTracking(e.target.value)} required />
            </>
          )}
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
            {busy ? "Saving..." : open === "invoiced" ? "Save as invoiced" : "Save as shipped"}
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="train-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

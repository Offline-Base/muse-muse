"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/icons";
import "@/components/trust/trust.css";

/** The report form (TRUST_REPORTS). POST /api/reports. The labels come from REASON_LABELS on the server. */
export function ReportForm({ slug, reasons }: { slug: string; reasons: Array<{ id: string; label: string }> }) {
  const detailId = useId();
  const [reason, setReason] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    if (!reason) {
      setError("Pick what's wrong with it.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, reason, detail }),
      });
      if (res.ok) {
        setSent(true);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error && /\s/.test(data.error) ? data.error : "The report didn't go through. Try again in a moment.");
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection.");
    }
    setBusy(false);
  }

  if (sent) {
    return (
      <p className="trust-done" role="status">
        Thanks. The Muse Muse team will look at your report.
      </p>
    );
  }

  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <fieldset className="trust-radios">
        <legend>What&apos;s wrong with it?</legend>
        {reasons.map((r) => (
          <label key={r.id}>
            <input type="radio" name="reason" value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} />
            <span>{r.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={detailId}>Details (optional)</label>
        <textarea id={detailId} className="trust-textarea" maxLength={1000} value={detail} onChange={(e) => setDetail(e.target.value)} />
        <p className="field-hint">What you saw, and where. Up to 1,000 characters. Don&apos;t include passwords or payment details.</p>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          <Icon name="alert" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? "Sending" : "Send report"}
      </button>
    </form>
  );
}

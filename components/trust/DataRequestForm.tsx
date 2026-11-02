"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/icons";
import "@/components/trust/trust.css";

/** The slug a request from this form is filed under, since it may not name one product. */
const DATA_REQUEST_SLUG = "data-request";

/** Anyone's way to ask for their data to be deleted: a privacy report to POST /api/reports, read at /admin/reports. */
export function DataRequestForm() {
  const whatId = useId();
  const replyId = useId();
  const [what, setWhat] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    if (!what.trim()) {
      setError("Say what you'd like deleted.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const detail = [what.trim(), reply.trim() ? `Reply to: ${reply.trim()}` : ""].filter(Boolean).join("\n");
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: DATA_REQUEST_SLUG, reason: "privacy", detail }),
      });
      if (res.ok) {
        setSent(true);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error && /\s/.test(data.error) ? data.error : "The request didn't go through. Try again in a moment.");
    } catch {
      setError("Couldn't reach Muse Muse. Check your connection.");
    }
    setBusy(false);
  }

  if (sent) {
    return (
      <p className="trust-done" role="status">
        Thanks. The Muse Muse team has your request.
      </p>
    );
  }

  return (
    <section aria-labelledby="data-request-title">
      <h2 id="data-request-title">Ask for your data to be deleted</h2>
      <form
        className="form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="field">
          <label htmlFor={whatId}>What should be deleted</label>
          <textarea id={whatId} className="trust-textarea" maxLength={800} value={what} onChange={(e) => setWhat(e.target.value)} />
          <p className="field-hint">Name the build or product, or paste its link or the words of your note. Don&apos;t include passwords or payment details.</p>
        </div>
        <div className="field">
          <label htmlFor={replyId}>How to reach you (optional)</label>
          <input id={replyId} type="text" maxLength={150} autoComplete="email" value={reply} onChange={(e) => setReply(e.target.value)} />
          <p className="field-hint">An email address, if you want to hear back.</p>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Sending" : "Send request"}
        </button>
      </form>
    </section>
  );
}

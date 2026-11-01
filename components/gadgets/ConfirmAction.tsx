"use client";

import { useState } from "react";

/** The owner's yes or no to one action. Nothing happens unless they press it. */
export function ConfirmAction({ request, title, lines, simulated }: { request: string; title: string; lines: string[]; simulated: boolean }) {
  const [state, setState] = useState<"ready" | "busy" | "done" | "no">("ready");
  const [message, setMessage] = useState<string | null>(null);

  async function confirm() {
    setState("busy");
    const res = await fetch("/api/boards/actions/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request }) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
    if (res?.ok && body?.ok) {
      setState("done");
      setMessage("Done. You can close this tab.");
    } else {
      setState("ready");
      setMessage(body?.message ?? (body?.error === "stopped" ? "The hard stop is on. Clear it on the Gadgets page first." : body?.error === "already_used" ? "This was already confirmed." : "That didn't work. Ask from the product again."));
    }
  }

  return (
    <section className="card section-card">
      <h1>{title}</h1>
      {simulated ? <p className="pill pill-neutral">Simulated board. Nothing real moves.</p> : null}
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {message ? (
        <p className="note" role="status">
          {message}
        </p>
      ) : null}
      {state === "done" || state === "no" ? (
        state === "no" ? <p className="muted">Nothing was done.</p> : null
      ) : (
        <div className="row-actions">
          <button type="button" className="btn btn-primary" disabled={state === "busy"} onClick={() => void confirm()}>
            Yes, do it
          </button>
          <button type="button" className="btn btn-outline" onClick={() => setState("no")}>
            No
          </button>
        </div>
      )}
    </section>
  );
}

"use client";
// Platform file (Muse Muse platform services). Don't edit: render it with the confirmation send() gave.
//
// The owner reads the exact message and presses Confirm, which sends it once with their own account. Changing a word
// needs a new confirmation. In a build the message goes nowhere and the card says "Sent (sample)".
//   const result = await send(request, { channel: "email", to, subject, body });
//   if (result.status === "needs_confirmation") return <ConfirmSend confirmation={result.confirmation} />;
import { useState } from "react";
import type { Confirmation } from "@/lib/platform/send";

type State = { kind: "ask"; confirmation: Confirmation; note?: string } | { kind: "busy"; confirmation: Confirmation } | { kind: "sent"; sample: boolean } | { kind: "cancelled" } | { kind: "error"; confirmation: Confirmation; message: string };

export function ConfirmSend({ confirmation, onDone }: { confirmation: Confirmation; onDone?: (sent: boolean) => void }) {
  const [state, setState] = useState<State>({ kind: "ask", confirmation });

  async function confirm(c: Confirmation) {
    setState({ kind: "busy", confirmation: c });
    try {
      const res = await fetch("/api/musemuse/connect-send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: c.args, approval: c.id }) });
      const reply = (await res.json().catch(() => ({}))) as { status?: string; simulated?: boolean; confirmation?: Confirmation; error?: string };
      if (reply.status === "sent") {
        setState({ kind: "sent", sample: Boolean(reply.simulated) });
        onDone?.(true);
      } else if (reply.status === "needs_confirmation" && reply.confirmation) {
        setState({ kind: "ask", confirmation: reply.confirmation, note: "This needs a fresh confirmation. Check it again." });
      } else {
        setState({ kind: "error", confirmation: c, message: reply.error ?? "That didn't send. Nothing went out." });
      }
    } catch {
      setState({ kind: "error", confirmation: c, message: "That didn't send. Check your connection and try again." });
    }
  }

  if (state.kind === "sent") {
    return (
      <div className="card" role="status" data-testid="send-result">
        <p className="note">{state.sample ? "Sent (sample)" : "Sent"}</p>
      </div>
    );
  }
  if (state.kind === "cancelled") {
    return (
      <div className="card" role="status" data-testid="send-result">
        <p className="hint">Not sent.</p>
      </div>
    );
  }
  const c = state.confirmation;
  const busy = state.kind === "busy";
  return (
    <div className="card stack" role="group" aria-label={c.title} data-testid="confirm-send-card">
      <h3>{c.title}</h3>
      {state.kind === "ask" && state.note ? <p className="hint">{state.note}</p> : null}
      <div className="stack">
        {c.lines.map((line, i) => (
          <p key={i} className="prose">
            {line}
          </p>
        ))}
      </div>
      {state.kind === "error" ? (
        <p className="error" role="alert">
          {state.message}
        </p>
      ) : null}
      <div className="row actions">
        <button type="button" className="primary" onClick={() => confirm(c)} disabled={busy} aria-busy={busy} data-testid="confirm-send">
          {busy ? "Sending" : "Confirm and send"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setState({ kind: "cancelled" });
            onDone?.(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

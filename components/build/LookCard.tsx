"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/icons";
import { LOOK_NOTE_MAX_CHARS } from "@/lib/engine/look";
import { sendLook, type LookState } from "@/components/build/look";

/**
 * LOOK_FIRST (docs/LOOK_FIRST.md): the build made its screens first. Everyone sees where that stage is; the person who
 * started the build gets the controls while the screens wait: change the look, or wire it up now. Doing nothing wires
 * them in when the wait ends.
 */
export function LookCard({ buildId, look, canAnswer, now }: { buildId: string; look: LookState; canAnswer: boolean; now: number }) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<"approve" | "change" | null>(null);

  if (look.state !== "ready") {
    const line =
      look.state === "building"
        ? "Making your screens first, with sample data. You'll see them in the preview in a few minutes."
        : look.state === "changing"
          ? "Changing the look. The preview updates when it's done."
          : null;
    return line ? (
      <section className="look-card look-card-quiet" aria-live="polite">
        <Icon name="sparkle" size={16} aria-hidden />
        <p>{line}</p>
      </section>
    ) : null;
  }

  const secondsLeft = look.waitUntil ? Math.max(0, Math.round((look.waitUntil - now) / 1000)) : null;
  const waiting = look.answered || sent !== null;
  const submit = async (body: { action: "approve" } | { action: "change"; text: string }) => {
    setBusy(true);
    setError(null);
    const problem = await sendLook(buildId, body);
    setBusy(false);
    if (problem) setError(problem);
    else setSent(body.action);
  };

  return (
    <section className="look-card" aria-labelledby={`${id}-title`}>
      <div className="look-card-head">
        <h3 id={`${id}-title`}>Your screens are ready</h3>
        {secondsLeft !== null && !waiting ? <span className="muted small">Wiring in by itself in {secondsLeft} s</span> : null}
      </div>
      <p className="muted">The preview shows every screen with sample data. Nothing is wired in yet, so changes to the look are quick now.</p>
      {!canAnswer ? null : waiting ? (
        <p className="muted" aria-live="polite">
          {sent === "change" || (look.answered && sent === null) ? "Got it. Changing the look next." : "Wiring everything into these screens now."}
        </p>
      ) : (
        <form
          className="look-card-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && look.changesLeft > 0) void submit({ action: "change", text: text.trim() });
          }}
        >
          {look.changesLeft > 0 ? (
            <>
              <label htmlFor={`${id}-note`} className="sr-only">
                Change the look
              </label>
              <textarea
                id={`${id}-note`}
                className="look-card-note"
                rows={2}
                maxLength={LOOK_NOTE_MAX_CHARS}
                placeholder="Change the look, like: bigger cards, search at the top"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
              />
            </>
          ) : (
            <p className="muted small">That was the last change before wiring. You can still change it once it's live.</p>
          )}
          <div className="look-card-actions">
            {look.changesLeft > 0 ? (
              <button type="submit" className="btn btn-outline" disabled={busy || !text.trim()}>
                Change the look
              </button>
            ) : null}
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit({ action: "approve" })}>
              Looks good, wire it up
            </button>
          </div>
          {error ? (
            <p className="look-card-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}

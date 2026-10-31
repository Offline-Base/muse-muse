"use client";

import { useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";

/** What this box sends to the control route, which takes more commands for the build room's other controls. */
export type SteerBody = { action: "steer" | "queue"; text: string } | { action: "stop" };

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The longest note the control route takes. */
const MAX_NOTE = 4000;

const SENT: Record<SteerBody["action"], string> = {
  steer: "Sent. Muse Code reads it at its next step.",
  queue: "Saved. Muse Code gets it when this step ends.",
  stop: "Stopping. The build ends within a minute.",
};

/** POST /api/builds/{id}/control. Null when it went through, else a sentence for the owner. */
export async function sendSteer(buildId: string, body: SteerBody, fetcher: Fetch = (url, init) => fetch(url, init)): Promise<string | null> {
  let res: Response;
  try {
    res = await fetcher(`/api/builds/${buildId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return "Couldn't reach Muse Muse. Check your connection and try again.";
  }
  if (res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { error?: unknown };
  return steerErrorText(res.status, typeof data.error === "string" ? data.error : undefined);
}

/**
 * The control route sends a readable sentence for 400, the policy's refusal included, and stable codes for the rest
 * (see its contract).
 */
export function steerErrorText(status: number, code: string | undefined): string {
  if (status === 400) return code && /\s/.test(code) ? code : "That note couldn't be sent. Check it and try again.";
  if (code === "not_checked") return "Muse Muse couldn't check that note, so it wasn't sent. Try again in a moment.";
  if (code === "paused") return "Muse Muse reached today's spending cap, so it can't take notes right now. Stop still works.";
  if (status === 401) return "Sign in again to steer this build.";
  if (status === 404) return "Only the person who made this build can steer it.";
  if (status === 409 || code === "no_round") return "Muse Code isn't taking notes right now. Try again once it's working.";
  if (status === 413) return "That note is too long to send.";
  if (status === 429 || code === "rate_limited") return "That's a lot at once. Wait a minute, then send again.";
  if (status === 502 || code === "not_delivered") return "Muse Code couldn't be reached, so that didn't arrive. Try again in a moment.";
  if (status === 503 || code === "steering_off") return "Steering is off in this deployment.";
  if (status === 403) return "That request was refused. Reload the page and try again.";
  return "Something went wrong on our side. Try again in a moment.";
}

/**
 * The build owner's controls while a Muse Code round runs (docs/MUSE_CODE_FULL.md, "The owner steers"), in the Muse app's
 * composer (docs/UI_MUSE_APP.md, "The composer"): a note sent into the running step (Send now), one held until the step
 * ends ("After this step"), and Stop, which ends the build after a confirm. Each answers with a short sent or error note.
 *
 * Send turns into stop while the box is empty, as in the app. With a note written, Stop moves beside Send, so it's
 * always one press away.
 */
export function SteerBox({ buildId }: { buildId: string }) {
  const inputId = useId();
  const hintId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<SteerBody["action"] | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [stopped, setStopped] = useState(false);

  async function send(action: SteerBody["action"]) {
    if (inFlight.current || stopped) return;
    const text = note.trim();
    if (action !== "stop" && !text) {
      setResult({ ok: false, text: "Write a note first." });
      textarea.current?.focus();
      return;
    }
    if (action === "stop" && !window.confirm("Stop this build? Muse Code stops now, and nothing from this build ships.")) return;
    inFlight.current = true;
    setBusy(action);
    setResult(null);
    const error = await sendSteer(buildId, action === "stop" ? { action } : { action, text });
    inFlight.current = false;
    setBusy(null);
    // Send can be gone or was disabled, so the note takes focus back, unless the owner has moved on.
    if (action !== "stop" && (document.activeElement === document.body || textarea.current?.form?.contains(document.activeElement))) textarea.current?.focus();
    if (error) {
      setResult({ ok: false, text: error });
      return;
    }
    if (action === "stop") setStopped(true);
    else setNote("");
    setResult({ ok: true, text: SENT[action] });
  }

  const disabled = busy !== null || stopped;
  return (
    <div className="composer-wrap composer-floating">
      <form
        className="composer"
        aria-label="Steer Muse Code"
        onSubmit={(e) => {
          e.preventDefault();
          void send("steer");
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          A note for Muse Code
        </label>
        <textarea
          id={inputId}
          ref={textarea}
          className="composer-input"
          rows={1}
          maxLength={MAX_NOTE}
          value={note}
          placeholder="Tell Muse Code something while it works"
          aria-describedby={hintId}
          disabled={stopped}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            if (window.matchMedia?.("(pointer: coarse)").matches) return;
            e.preventDefault();
            void send("steer");
          }}
        />
        <p id={hintId} className="sr-only">
          Send now reaches Muse Code at its next step. After this step waits until the step it is on ends. Stop ends the
          build.
        </p>
        <div className="composer-row">
          <SteerActions hasNote={note.trim().length > 0} busy={busy} disabled={disabled} onQueue={() => void send("queue")} onStop={() => void send("stop")} />
        </div>
        {result?.ok ? (
          <p className="note" aria-hidden>
            <Icon name="check" size={16} />
            <span>{result.text}</span>
          </p>
        ) : result ? (
          <p className="note note-error" role="alert">
            <Icon name="alert" size={16} />
            <span>{result.text}</span>
          </p>
        ) : null}
      </form>
      <p className="sr-only" aria-live="polite">
        {result?.ok ? result.text : ""}
      </p>
    </div>
  );
}

/** The composer's right end: the pill, then Stop and Send when there's a note, and only Stop, in Send's place, when not. */
export function SteerActions({
  hasNote,
  busy,
  disabled,
  onQueue,
  onStop,
}: {
  hasNote: boolean;
  busy: SteerBody["action"] | null;
  disabled: boolean;
  onQueue: () => void;
  onStop: () => void;
}) {
  const stopIcon = busy === "stop" ? <span className="spinner" aria-hidden /> : <span className="composer-stop" aria-hidden />;
  return (
    <div className="composer-actions">
      <button type="button" className="composer-pill" disabled={disabled} onClick={onQueue}>
        {busy === "queue" ? "Saving" : "After this step"}
      </button>
      {hasNote ? (
        <>
          <button type="button" className="composer-tool" aria-label="Stop" title="Stop" disabled={disabled} onClick={onStop}>
            {stopIcon}
          </button>
          <button type="submit" className="send-btn" aria-label="Send now" title="Send now" disabled={disabled}>
            {busy === "steer" ? <span className="spinner" aria-hidden /> : <Icon name="arrowUp" size={24} />}
          </button>
        </>
      ) : (
        <button type="button" className="send-btn" aria-label="Stop" title="Stop" disabled={disabled} onClick={onStop}>
          {stopIcon}
        </button>
      )}
    </div>
  );
}

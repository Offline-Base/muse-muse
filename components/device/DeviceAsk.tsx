"use client";

import { useId, useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import type { DeviceAgentResult, DeviceAgentStep } from "@/lib/device/agent";

const ERRORS: Record<string, string> = {
  device_not_configured: "No board is set up. DEVICE_MCP_URL and DEVICE_MCP_TOKEN are missing.",
  device_unavailable: "Couldn't reach the board. Its server or tunnel may be down.",
  model_unavailable: "Couldn't reach Muse Wonder.",
  paused: "Today's spend cap is reached, so model calls are paused.",
  rate_limited: "That's a lot of questions for one minute. Try again in a moment.",
};

type Part = { type?: string; text?: string; data?: string; mimeType?: string };

/** What one tool returned: photos and recordings as themselves, and text as text. */
function StepOutput({ step }: { step: DeviceAgentStep }) {
  return (
    <>
      {(step.content as Part[]).map((part, i) => {
        const src = `data:${part.mimeType};base64,${part.data}`;
        if (part.type === "image") {
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={src} alt={`Photo from ${step.tool}`} style={{ maxWidth: "100%", height: "auto" }} />
          );
        }
        if (part.type === "audio") return <audio key={i} controls src={src} />;
        return (
          <pre key={i} className="small" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {part.text}
          </pre>
        );
      })}
    </>
  );
}

/** Admin only: asks Muse Wonder something, and shows its answer with every tool it used on the board. */
export function DeviceAsk() {
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<DeviceAgentResult | null>(null);

  async function ask(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setResult(null);
    try {
      const res = await fetch("/api/device/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = (await res.json().catch(() => ({}))) as DeviceAgentResult & { error?: string };
      if (res.ok) setResult(data);
      else setMessage(ERRORS[data.error ?? ""] ?? data.error ?? "That didn't work.");
    } catch {
      setMessage("Couldn't reach Muse Muse.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card section-card">
        <form onSubmit={ask}>
          <label className="field-label" htmlFor={`${id}-prompt`}>
            Ask the board
          </label>
          <textarea
            id={`${id}-prompt`}
            className="train-input train-textarea"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            maxLength={2000}
            placeholder="What can you see right now?"
            required
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !prompt.trim()}>
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="arrowUp" size={16} />}
            <span>{busy ? "Working" : "Ask"}</span>
          </button>
        </form>
        {message ? (
          <p className="small" role="alert">
            {message}
          </p>
        ) : null}
      </section>

      {result ? (
        <section className="card section-card" aria-live="polite">
          <h2>Answer</h2>
          <p>{result.answer || "Muse Wonder stopped without an answer. Its tool calls are below."}</p>
          {result.steps.map((step, i) => (
            <div key={i}>
              <h3 className="small">
                {step.tool}
                {step.isError ? " (failed)" : ""}
              </h3>
              <StepOutput step={step} />
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}

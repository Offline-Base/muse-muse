"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { usd } from "@/lib/format";
import type { HostProvider } from "@/lib/train/host/types";
import type { HostView } from "@/lib/train/host/view";

/**
 * The Run it section: pick a provider, one click to deploy on the platform's account, then a chat box. It talks only to
 * Muse Muse's own routes, so a provider's address and key never reach this page.
 */
const POLL_MS = 15_000;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : "That didn't work. Try again.";
}

export function RunIt({ modelId, initial }: { modelId: string; initial: HostView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<HostProvider | "stop" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ownerToken, setOwnerToken] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const inputId = useId();
  const route = `/api/models/${modelId}/host`;
  const endpoint = view.endpoint;
  const moving = endpoint?.status === "starting" || endpoint?.status === "stopping";

  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(async () => {
      const res = await fetch(route).catch(() => null);
      const body = res?.ok ? ((await res.json()) as { view: HostView }) : null;
      if (body) setView(body.view);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [moving, route]);

  async function act(init: RequestInit, label: HostProvider | "stop") {
    setBusy(label);
    setProblem(null);
    try {
      const res = await fetch(route, init);
      if (!res.ok) {
        setProblem(await errorOf(res));
        return;
      }
      const body = (await res.json()) as { view: HostView | null; ownerToken?: string };
      if (body.view) setView(body.view);
      if (body.ownerToken) setOwnerToken(body.ownerToken);
    } catch {
      setProblem("Couldn't reach Muse Muse. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || asking) return;
    const messages: Turn[] = [...turns, { role: "user", content: text }];
    setTurns(messages);
    setDraft("");
    setAsking(true);
    setProblem(null);
    try {
      const res = await fetch(`${route}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }) });
      if (!res.ok) {
        setProblem(await errorOf(res));
        setTurns(turns);
        setDraft(text);
        return;
      }
      const body = (await res.json()) as { text: string };
      setTurns([...messages, { role: "assistant", content: body.text }]);
    } catch {
      setProblem("Couldn't reach Muse Muse. Check your connection and try again.");
      setTurns(turns);
      setDraft(text);
    } finally {
      setAsking(false);
    }
  }

  const { limits, duties } = view;
  return (
    <section className="section" aria-labelledby="run-it-title">
      <div className="section-head">
        <h2 id="run-it-title">Run it</h2>
      </div>
      <p className="muted">
        Muse Muse deploys it on a provider and pays for the GPU. It stops after {limits.idleMinutes} idle minutes, and within {limits.maxMinutes / 60} hours regardless. {limits.maxLive} can run at once, up to {usd(limits.dailyUsd)} a day
        across all providers. None of these routes has been tested with a real GPU yet, so a first deploy may fail.
      </p>
      {view.problem ? <p className="muted">{view.problem}</p> : null}

      {endpoint ? (
        <div>
          <p>
            <strong>{endpoint.label}</strong>: {endpoint.status === "live" ? "running" : endpoint.status === "starting" ? "starting. A first start can take many minutes." : "stopping."} About {usd(endpoint.costSoFarUsd)} so far. Stops by{" "}
            {new Date(endpoint.stopsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.
          </p>
          {endpoint.note ? <p className="muted">{endpoint.note}</p> : null}
          {endpoint.status !== "stopping" ? (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => act({ method: "DELETE" }, "stop")}>
              {busy === "stop" ? "Stopping" : "Stop it"}
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="link-list">
          {view.choices.map((c) => (
            <li key={c.id}>
              <button type="button" className="btn" disabled={!c.available || busy !== null} onClick={() => act({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: c.id }) }, c.id)}>
                {busy === c.id ? `Deploying on ${c.label}` : `Deploy on ${c.label}`}
              </button>{" "}
              <span className="muted">{c.available ? `About ${usd(c.hourlyUsd)} an hour on ${c.gpu}. An estimate.` : `Unavailable: ${c.reason}`}</span>
            </li>
          ))}
        </ul>
      )}

      {problem ? (
        <p role="alert" className="muted">
          {problem}
        </p>
      ) : null}

      {ownerToken ? (
        <div>
          <p>
            Your token for this endpoint, shown only now. Use it as the API key with any OpenAI client, at <code>{view.gatewayPath}</code> on this site, with <code>model</code> set to <code>{modelId}</code>.
          </p>
          <p>
            <code>{ownerToken}</code>
          </p>
        </div>
      ) : null}

      {endpoint?.status === "live" ? (
        <form onSubmit={ask}>
          {turns.map((t, i) => (
            <p key={i}>
              <strong>{t.role === "user" ? "You" : "Model"}:</strong> {t.content}
            </p>
          ))}
          <label htmlFor={inputId}>Ask it something</label>
          <textarea id={inputId} className="input" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={asking || !draft.trim()}>
            {asking ? "Waiting for the model" : "Send"}
          </button>
          <p className="muted">It may need a few minutes to wake after being idle. If it's waking, try again soon.</p>
        </form>
      ) : null}

      <div>
        {duties.line ? <p><strong>{duties.line}</strong></p> : null}
        <p className="muted">{duties.license}</p>
        {duties.points.length ? (
          <ul className="muted">
            {duties.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

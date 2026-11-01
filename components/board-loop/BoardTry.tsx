"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnView } from "@/lib/board-loop/try";

interface PageState {
  state: "open" | "closed" | "offline";
}

const WATCH_MS = 8_000;
const TURN_MS = 1_500;

/** The public try page: a labeled board, a queue with a place in line, and plain words when it's offline or over a limit. */
export function BoardTry(props: { loopId: string; label: string; simulated: boolean; initialState: PageState["state"]; promptChars: number; perHour: number }) {
  const { loopId, promptChars, perHour } = props;
  const [state, setState] = useState(props.initialState);
  const [prompt, setPrompt] = useState("");
  const [turn, setTurn] = useState<TurnView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const watch = setInterval(async () => {
      const res = await fetch(`/api/board-loop/${loopId}/try`, { cache: "no-store" }).catch(() => null);
      if (res?.ok) setState(((await res.json()) as PageState).state);
    }, WATCH_MS);
    return () => clearInterval(watch);
  }, [loopId]);

  const poll = useCallback(async (id: string) => {
    const res = await fetch(`/api/board-loop/turns/${id}`, { method: "POST" }).catch(() => null);
    if (res?.ok) {
      const view = (await res.json()) as TurnView;
      setTurn(view);
      if (view.status !== "queued" && view.status !== "running") return;
    }
    timer.current = setTimeout(() => void poll(id), TURN_MS);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setNotice(null);
    const res = await fetch(`/api/board-loop/${loopId}/try`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) }).catch(() => null);
    setSending(false);
    const body = (await res?.json().catch(() => null)) as { turn?: TurnView; message?: string; error?: string } | null;
    if (res?.status === 202 && body?.turn) {
      setTurn(body.turn);
      void poll(body.turn.id);
      return;
    }
    if (body?.error === "offline") setState("offline");
    setNotice(body?.message ?? "That didn't go through. Try again.");
  };

  const busy = turn?.status === "queued" || turn?.status === "running";

  return (
    <div className="board-loop">
      <p className={props.simulated ? "board-banner board-banner-sim" : "board-banner"} data-testid="board-label">
        <strong>{props.label}.</strong>{" "}
        {props.simulated ? "Every answer here is canned text from a small process. No model runs, so it shows the queue and the limits, not a model." : "A real board answers, one person at a time."}
      </p>

      {state === "offline" ? (
        <section className="card section-card" data-testid="board-offline">
          <h2>The board is offline</h2>
          <p>Nothing can run right now, and no turn was used. This page checks again by itself.</p>
        </section>
      ) : state === "closed" ? (
        <section className="card section-card" data-testid="board-closed">
          <h2>This page isn&apos;t open</h2>
          <p>The board isn&apos;t serving this model now.</p>
        </section>
      ) : (
        <section className="card section-card">
          <form onSubmit={ask}>
            <label htmlFor="board-prompt">Ask it something</label>
            <textarea id="board-prompt" className="input" rows={3} maxLength={promptChars} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy || sending} />
            <p className="board-limits">
              One turn at a time, {perHour} an hour, so everyone gets a go. Short answers only.
            </p>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || sending || !prompt.trim()}>
              Ask
            </button>
          </form>
        </section>
      )}

      {notice ? (
        <p className="board-notice" role="status">
          {notice}
        </p>
      ) : null}

      {turn ? (
        <section className="card section-card" aria-live="polite" data-testid="board-turn">
          {turn.status === "queued" ? <p>You&apos;re number {turn.position} in line. Keep this page open.</p> : null}
          {turn.status === "running" ? <p>The board is answering you now.</p> : null}
          {turn.status === "done" ? (
            <>
              <p data-testid="board-answer">{turn.answer}</p>
              <p className="board-limits">
                {turn.tokens} tokens at {turn.tokensPerSecond} tokens a second{turn.simulated ? ", from the simulated board's canned text" : ""}.
              </p>
            </>
          ) : null}
          {turn.status === "failed" || turn.status === "expired" ? <p>{turn.message}</p> : null}
        </section>
      ) : null}
    </div>
  );
}

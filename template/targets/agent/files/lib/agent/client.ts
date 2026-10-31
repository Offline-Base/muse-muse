"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_VIEW, reduceAgent, stopMessage, type AgentEvent, type AgentView } from "./events";

/**
 * The browser's side of a run: posts to your agent route, reads its events and keeps an AgentView for AgentRun to draw.
 * It also keeps the run's place, so Stop, Keep going and a trip through an account's sign-in page all pick up from it.
 */

const CONNECTING_KEY = "musemuse:agent-connecting";

export interface UseAgent<T> {
  view: AgentView<T>;
  busy: boolean;
  /** Starts a run. `body` is what your route reads, such as `{ question }`. */
  start(body?: Record<string, unknown>): void;
  /** Stops listening and stops the run. Keep going picks up from the last finished step. */
  stop(): void;
  keepGoing(): void;
  /** The person's answer to the confirm card. */
  decide(approve: boolean): void;
  /** Sends the person to connect an account, and carries on when they come back. */
  connect(toolkit: string): Promise<void>;
  reset(): void;
}

/** Reads a route's lines as they arrive, and hands over each event. A line it can't read is skipped. */
export async function readAgentEvents(res: Response, onEvent: (event: AgentEvent) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const line = (text: string) => {
    if (!text.trim()) return;
    try {
      onEvent(JSON.parse(text) as AgentEvent);
    } catch {
      // A partial or garbled line. The next checkpoint or done still arrives.
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    lines.forEach(line);
  }
  line(buffer);
}

function refusalMessage(body: unknown, status: number): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  return status === 429 ? stopMessage("busy") : stopMessage("error");
}

export function useAgent<T = unknown>(url: string): UseAgent<T> {
  const [view, setView] = useState<AgentView<T>>(IDLE_VIEW);
  const [busy, setBusy] = useState(false);
  const running = useRef<AbortController | null>(null);
  const latest = useRef<AgentView<T>>(IDLE_VIEW);
  const lastBody = useRef<Record<string, unknown>>({});

  const update = useCallback((next: AgentView<T>) => {
    latest.current = next;
    setView(next);
  }, []);

  const post = useCallback(
    async (body: Record<string, unknown>, from: AgentView<T>) => {
      running.current?.abort();
      const abort = new AbortController();
      running.current = abort;
      setBusy(true);
      update({ ...from, status: "running", reason: null, message: null, confirm: null, connect: null });
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/x-ndjson" },
          body: JSON.stringify(body),
          signal: abort.signal,
        });
        if (!res.ok) {
          const message = refusalMessage(await res.json().catch(() => null), res.status);
          update({ ...latest.current, status: "failed", reason: "error", message });
          return;
        }
        await readAgentEvents(res, (event) => update(reduceAgent(latest.current, event)));
        if (latest.current.status === "running") {
          // The connection dropped before the run ended.
          update({ ...latest.current, status: "stopped", reason: "error", message: "The connection dropped. You can keep going." });
        }
      } catch {
        if (abort.signal.aborted) return;
        update({ ...latest.current, status: "stopped", reason: "error", message: "The connection dropped. You can keep going." });
      } finally {
        if (running.current === abort) {
          running.current = null;
          setBusy(false);
        }
      }
    },
    [update, url],
  );

  const start = useCallback(
    (body: Record<string, unknown> = {}) => {
      lastBody.current = body;
      void post(body, IDLE_VIEW);
    },
    [post],
  );

  const stop = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setBusy(false);
    update({
      ...latest.current,
      status: "stopped",
      reason: "stopped",
      // Stopped before its first checkpoint, or too big to have one: there's nothing to keep going from.
      message: latest.current.resume ? null : "Stopped. Start it again when you're ready.",
      steps: latest.current.steps.map((s) => (s.state === "running" ? { ...s, state: "waiting" as const } : s)),
    });
  }, [update]);

  const keepGoing = useCallback(() => {
    const resume = latest.current.resume;
    if (resume) void post({ ...lastBody.current, resume }, latest.current);
  }, [post]);

  const decide = useCallback(
    (approve: boolean) => {
      const { resume, confirm } = latest.current;
      if (resume && confirm) void post({ ...lastBody.current, resume, decision: { approvalId: confirm.approvalId, approve } }, latest.current);
    },
    [post],
  );

  const connect = useCallback(
    async (toolkit: string) => {
      const res = await fetch("/api/musemuse/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolkit, returnTo: `${location.pathname}${location.search}` }),
      });
      const body = (await res.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
      if (!res.ok) {
        update({ ...latest.current, message: refusalMessage(body, res.status) });
        return;
      }
      if (typeof body?.url !== "string") {
        // A build's accounts are samples, so there's no page to visit.
        keepGoing();
        return;
      }
      try {
        sessionStorage.setItem(CONNECTING_KEY, JSON.stringify({ url, view: latest.current, body: lastBody.current }));
      } catch {
        // The person would start over when they come back, which still works.
      }
      location.assign(body.url);
    },
    [keepGoing, update, url],
  );

  const reset = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setBusy(false);
    update(IDLE_VIEW);
  }, [update]);

  // Back from connecting an account: the run goes on from where it was waiting, or it's still waiting if that didn't
  // work. The timer is so React's second run of this effect in development doesn't start it twice.
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const failed = query.has("connect_failed");
    if (!failed && !query.has("connected")) return;
    const timer = setTimeout(() => {
      let saved: { url?: unknown; view?: AgentView<T>; body?: Record<string, unknown> } | null = null;
      try {
        saved = JSON.parse(sessionStorage.getItem(CONNECTING_KEY) ?? "null");
        sessionStorage.removeItem(CONNECTING_KEY);
      } catch {
        return;
      }
      if (saved?.url !== url || !saved.view?.resume) return;
      lastBody.current = saved.body ?? {};
      if (failed) update({ ...saved.view, message: "That account didn't connect. Try again." });
      else void post({ ...lastBody.current, resume: saved.view.resume }, saved.view);
    }, 0);
    return () => clearTimeout(timer);
  }, [post, update, url]);

  useEffect(() => () => running.current?.abort(), []);

  return { view, busy, start, stop, keepGoing, decide, connect, reset };
}

/** Forgets a connected account, for a settings row with ConnectCard's Disconnect. True when it worked. */
export async function disconnectAccount(toolkit: string): Promise<boolean> {
  const res = await fetch("/api/musemuse/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolkit }),
  });
  return res.ok;
}

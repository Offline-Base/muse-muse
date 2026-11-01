"use client";
// Platform file (Muse Muse platform services). Don't edit: call useLive from a client component.
//
//   const { items, status, error } = useLive<Score>("scores", "shared");
//
// Keeps a saved collection current in this browser with no reload. A change anyone saves through data() shows here within
// a few seconds. This reads only: save through your own action routes. A browser reads only what its holder could read
// with data(). A hidden tab lets go of its stream, so someone else can watch, and catches up when it's shown again.
import { useEffect, useRef, useState } from "react";
import { applyLiveChange, LIVE_RESYNC_AFTER_MS, liveBackoffMs, readLiveChange, type LiveItem } from "@/lib/platform/live-state";

export type { LiveItem } from "@/lib/platform/live-state";
export type LiveScope = "shared" | "visitor" | "owner" | "user";
export type LiveStatus = "connecting" | "live" | "reconnecting" | "error";

export interface UseLive<T> {
  /** The collection's items, oldest change first. */
  items: LiveItem<T>[];
  status: LiveStatus;
  /** Plain words to show as they are, or null. */
  error: string | null;
}

interface Ticket {
  ticket: string;
  streamUrl: string;
  expiresAt: number;
}

const ROUTE = "/api/musemuse/live-ticket";
/** A ticket with less left than this isn't worth opening a stream with. */
const TICKET_MARGIN_MS = 30_000;

export function useLive<T = unknown>(collection: string, scope: LiveScope): UseLive<T> {
  const [items, setItems] = useState<LiveItem<T>[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const after = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ticket: Ticket | null = null;
    let failures = 0;
    let lastContact = Date.now();
    let closed = false;
    // Each connect() takes the next number. One that finds a newer number after waiting has been replaced, and stops.
    let attempt = 0;
    after.current = 0;
    setItems([]);
    setStatus("connecting");
    setError(null);

    const drop = () => {
      source?.close();
      source = null;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const retry = (ms: number) => {
      drop();
      if (closed || document.hidden) return;
      timer = setTimeout(connect, ms);
    };

    const failed = () => {
      failures += 1;
      setStatus("reconnecting");
      // The stream can't say why it was refused. A new ticket covers one that expired or went bad.
      ticket = null;
      retry(liveBackoffMs(failures));
    };

    async function connect() {
      drop();
      if (closed || document.hidden) return;
      const mine = ++attempt;
      // Away long enough that a delete may have left the stream: read the collection again from the start.
      if (after.current > 0 && Date.now() - lastContact > LIVE_RESYNC_AFTER_MS) {
        after.current = 0;
        setItems([]);
      }
      if (!ticket || ticket.expiresAt - Date.now() < TICKET_MARGIN_MS) {
        const res = await fetch(ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collection, scope }) }).catch(() => null);
        const reply = ((await res?.json().catch(() => null)) ?? {}) as { ticket?: string; streamUrl?: string; expiresAt?: string; error?: string };
        // Closed or replaced while it waited, or the tab went away: showing it again starts a new connect().
        if (closed || mine !== attempt || document.hidden) return;
        if (res?.status === 403 || res?.status === 404) {
          // Asking again wouldn't change this answer.
          setStatus("error");
          setError(typeof reply.error === "string" ? reply.error : "Live updates aren't available here.");
          return;
        }
        if (!res?.ok || !reply.ticket || !reply.streamUrl || !reply.expiresAt) return failed();
        ticket = { ticket: reply.ticket, streamUrl: reply.streamUrl, expiresAt: new Date(reply.expiresAt).getTime() };
      }
      const url = new URL(ticket.streamUrl);
      url.searchParams.set("ticket", ticket.ticket);
      url.searchParams.set("after", String(after.current));
      const es = new EventSource(url.href);
      source = es;
      es.addEventListener("open", () => {
        failures = 0;
        lastContact = Date.now();
        setError(null);
        setStatus("live");
      });
      es.onmessage = (event) => {
        lastContact = Date.now();
        const change = readLiveChange<T>(event.data as string);
        if (!change) return;
        after.current = Math.max(after.current, change.seq);
        setItems((list) => applyLiveChange(list, change));
      };
      // The stream's plain end: it lasts under a minute, and the next one carries on from here.
      es.addEventListener("end", () => {
        lastContact = Date.now();
        retry(50);
      });
      es.onerror = () => {
        if (source === es) failed();
      };
    }

    const onVisible = () => {
      if (document.hidden) {
        attempt += 1;
        drop();
      } else if (!source && !timer) void connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    void connect();
    return () => {
      closed = true;
      attempt += 1;
      document.removeEventListener("visibilitychange", onVisible);
      drop();
    };
  }, [collection, scope]);

  return { items, status, error };
}

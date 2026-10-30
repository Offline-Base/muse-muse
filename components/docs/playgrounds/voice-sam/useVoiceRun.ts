"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDocsPage, type RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import { ABORTED_ERROR, type RunState } from "@/components/docs/kit/useDocsRun";
import { DOCS_API, sseReader, type DocsError, type DocsResult, type SseEvent } from "@/lib/docs/client/api";

/**
 * useDocsRun for the voice demos, plus one thing the kit's client doesn't send: an Accept header. POST
 * /v1/asr/transcribe picks its reply by Accept (application/json, text/event-stream or text/plain;
 * api-reference/voice/transcribe), and the docs proxy passes Accept through, so this hook sends it and reads the reply
 * the way its content type says. Same states, Stop, live elapsed time and copy-prompt record as useDocsRun; the call
 * still goes to Muse Muse's proxy (or its realtime relay), never to Meta, and never with a key.
 */

export interface VoiceRunInit {
  form?: FormData;
  /** A raw body, for the realtime relay (audio/wav). */
  raw?: { data: Blob; contentType: string };
  /** Overrides /api/docs/v1, for /api/docs/asr-realtime. */
  base?: string;
  /** The Accept header. */
  accept?: string;
  /** Called for each server-sent event when the reply is a stream. */
  onEvent?: (e: SseEvent) => void;
  /** What to record for the copy prompt, given the result; null records nothing. */
  record?: (result: DocsResult) => RecordedRequest | null;
}

/** The most raw stream text kept for the reference view. */
const RAW_MAX = 200_000;

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function errorFrom(status: number, json: unknown, text: string, headers: Headers): DocsError {
  const err = (json as { error?: { type?: string; code?: string | null; message?: string } } | null)?.error;
  const retry = Number(headers.get("retry-after"));
  return {
    type: err?.type,
    code: err?.code ?? undefined,
    message: err?.message || text.slice(0, 500) || `HTTP ${status}`,
    retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : undefined,
  };
}

function failed(error: DocsError, elapsedMs: number): DocsResult {
  return { ok: false, status: 0, json: null, text: "", blob: null, headers: {}, error, model: null, note: null, elapsedMs };
}

/** One call, read to the end. Never throws: a stop resolves with the aborted error, a network failure with status 0. */
export async function voiceCall(path: string, init: VoiceRunInit, signal: AbortSignal): Promise<DocsResult> {
  const started = performance.now();
  const headers: Record<string, string> = {};
  if (init.accept) headers.accept = init.accept;
  if (init.raw) headers["content-type"] = init.raw.contentType;
  let res: Response;
  try {
    res = await fetch(`${init.base ?? DOCS_API}/${path.replace(/^\/+/, "")}`, {
      method: "POST",
      headers,
      body: init.form ?? init.raw?.data,
      signal,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    if (signal.aborted) return failed(ABORTED_ERROR, performance.now() - started);
    return failed({ message: "Couldn't reach Muse Muse. Check your connection and try again." }, performance.now() - started);
  }
  const base = {
    status: res.status,
    headers: headerRecord(res.headers),
    model: res.headers.get("x-docs-model"),
    note: res.headers.get("x-docs-note"),
    blob: null,
  };
  const type = res.headers.get("content-type") ?? "";
  try {
    if (res.ok && res.body && type.startsWith("text/event-stream")) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const sse = sseReader((e) => init.onEvent?.(e));
      let raw = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (raw.length < RAW_MAX) raw += chunk;
        sse.push(chunk);
      }
      const tail = decoder.decode();
      sse.push(tail);
      sse.end();
      return { ...base, ok: true, json: null, text: raw + tail, error: null, elapsedMs: performance.now() - started };
    }
    const text = await res.text();
    let json: unknown = null;
    if (type.includes("json")) {
      try {
        json = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        json = null;
      }
    }
    return {
      ...base,
      ok: res.ok,
      json,
      text,
      error: res.ok ? null : errorFrom(res.status, json, text, res.headers),
      elapsedMs: performance.now() - started,
    };
  } catch (err) {
    if (signal.aborted) return { ...base, ok: false, json: null, text: "", error: ABORTED_ERROR, elapsedMs: performance.now() - started };
    return { ...base, ok: false, json: null, text: "", error: { message: err instanceof Error ? err.message : "The reply was cut off." }, elapsedMs: performance.now() - started };
  }
}

const TICK_MS = 100;

export function useVoiceRun(): {
  state: RunState;
  result: DocsResult | null;
  error: DocsError | null;
  elapsedMs: number;
  run(path: string, init?: VoiceRunInit): Promise<DocsResult>;
  abort(): void;
  reset(): void;
} {
  const { recordRequest } = useDocsPage();
  const record = useRef(recordRequest);
  record.current = recordRequest;
  const [state, setState] = useState<RunState>("idle");
  const [result, setResult] = useState<DocsResult | null>(null);
  const [error, setError] = useState<DocsError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const latest = useRef(0);

  const stopTicker = () => {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
  };

  useEffect(
    () => () => {
      controller.current?.abort();
      stopTicker();
    },
    [],
  );

  const run = useCallback(async (path: string, init: VoiceRunInit = {}): Promise<DocsResult> => {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    const id = ++latest.current;
    const started = performance.now();
    setState("running");
    setResult(null);
    setError(null);
    setElapsedMs(0);
    stopTicker();
    ticker.current = setInterval(() => {
      if (latest.current === id) setElapsedMs(performance.now() - started);
    }, TICK_MS);

    const res = await voiceCall(path, init, ctrl.signal);
    const aborted = res.error?.code === "aborted";
    const recorded = !aborted && init.record ? init.record(res) : null;
    if (recorded) record.current(recorded);
    if (latest.current === id) {
      stopTicker();
      setResult(res);
      setElapsedMs(res.elapsedMs);
      setError(aborted ? null : res.error);
      setState(aborted ? "idle" : res.ok ? "done" : "error");
      controller.current = null;
    }
    return res;
  }, []);

  const abort = useCallback(() => controller.current?.abort(), []);
  const reset = useCallback(() => {
    latest.current++;
    controller.current?.abort();
    controller.current = null;
    stopTicker();
    setState("idle");
    setResult(null);
    setError(null);
    setElapsedMs(0);
  }, []);

  return { state, result, error, elapsedMs, run, abort, reset };
}

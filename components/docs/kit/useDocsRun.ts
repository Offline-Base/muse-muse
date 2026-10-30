"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { docsCall, docsStream, type CallInit, type DocsError, type DocsResult, type SseEvent } from "@/lib/docs/client/api";
import { useDocsPage, type RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import { eventType } from "@/lib/docs/client/events";
import { rememberReply } from "@/lib/docs/client/recent";
import { describeForm, outcomeOfCollected, outcomeOfReply, trimForRecord } from "@/lib/docs/client/record";
import { collectorFor, protocolOfPath, type Collected } from "@/lib/docs/client/stream";

/**
 * Runs one demo request through the docs proxy (lib/docs/client/api) and tracks it: idle, running, done or error,
 * a live elapsed time, Stop, and a record of what ran for "Copy prompt for your coding agent". Every playground
 * goes through this hook so they all behave the same (docs/DOCS_MIRROR.md, "Kit contract").
 */

export type RunState = "idle" | "running" | "done" | "error";

export interface RunOptions extends CallInit {
  /** Read the reply as server-sent events, calling onEvent for each. */
  stream?: boolean;
  onEvent?: (e: SseEvent) => void;
  /** What to record for the copy-prompt ("Include what I just ran"); false records nothing. */
  record?: Partial<RecordedRequest> | false;
}

/** The error a stopped run reports. ErrorBox shows nothing for it. */
export const ABORTED_ERROR: DocsError = { type: "aborted", code: "aborted", message: "Stopped before the reply finished." };

export function isAborted(result: DocsResult | null | undefined): boolean {
  return result?.error?.code === "aborted";
}

function emptyResult(error: DocsError, elapsedMs: number): DocsResult {
  return { ok: false, status: 0, json: null, text: "", blob: null, headers: {}, error, model: null, note: null, elapsedMs };
}

function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException && err.name === "AbortError") || (err instanceof Error && err.name === "AbortError");
}

export interface RunOutcome {
  result: DocsResult;
  /** What a stream carried, read with its protocol's collector (null for plain calls and non-text streams). */
  reply: Collected | null;
  /** The error to show: the HTTP error, or one the stream reported mid-way. Null for a stopped run. */
  error: DocsError | null;
  state: Exclude<RunState, "running">;
  /** The record for the copy prompt, or null when this run isn't recorded. */
  record: RecordedRequest | null;
}

/**
 * One run without React: send through the proxy, read the stream when asked, and work out what to show and what to
 * record. The hook wraps this with state; tests drive it with a fake fetch.
 */
export async function performRun(path: string, init: RunOptions, signal: AbortSignal): Promise<RunOutcome> {
  const started = performance.now();
  // Streams are read here too, so the record can say what came back without each playground working it out.
  const protocol = init.stream ? protocolOfPath(path) : null;
  const collector = protocol ? collectorFor(protocol) : null;
  let events = 0;
  let lastType = "";
  const onEvent = (e: SseEvent) => {
    events++;
    lastType = eventType(e);
    collector?.push(e);
    init.onEvent?.(e);
  };

  let result: DocsResult;
  try {
    result = init.stream
      ? await docsStream(path, init.body, onEvent, { form: init.form, raw: init.raw, signal, base: init.base })
      : await docsCall(path, { method: init.method, body: init.body, form: init.form, raw: init.raw, signal, base: init.base });
  } catch (err) {
    result = isAbortError(err)
      ? emptyResult(ABORTED_ERROR, performance.now() - started)
      : emptyResult({ message: err instanceof Error ? err.message : "The request failed." }, performance.now() - started);
  }

  const aborted = isAborted(result);
  const reply = collector?.snapshot() ?? null;
  if (result.ok) rememberReply(reply?.final ?? result.json);

  let record: RecordedRequest | null = null;
  if (init.record !== false && (init.base === undefined || init.record)) {
    const method = init.method ?? (init.body !== undefined || init.form || init.raw ? "POST" : "GET");
    const outcome = aborted
      ? "stopped before the reply finished"
      : !result.ok
        ? outcomeOfReply(null, result.status, result.error?.message)
        : reply
          ? outcomeOfCollected(reply)
          : init.stream
            ? `${events} events, the last ${lastType || "none"}`
            : outcomeOfReply(result.json, result.status);
    const bodyModel = init.body && typeof init.body === "object" ? (init.body as { model?: unknown }).model : undefined;
    record = {
      method,
      path: path.replace(/^\/+/, "").replace(/^v1\//, ""),
      ...(init.form ? { body: describeForm(init.form) } : init.body !== undefined ? { body: trimForRecord(init.body) } : {}),
      ...(result.model && result.model !== bodyModel ? { model: result.model } : {}),
      status: result.status,
      outcome,
      ...(init.record || {}),
    };
  }

  const streamError: DocsError | null = result.ok && reply?.error ? { code: reply.error.code ?? undefined, message: reply.error.message } : null;
  return {
    result,
    reply,
    error: aborted ? null : (result.error ?? streamError),
    state: aborted ? "idle" : result.ok && !streamError ? "done" : "error",
    record,
  };
}

const TICK_MS = 100;

export function useDocsRun(): {
  state: RunState;
  result: DocsResult | null;
  error: DocsError | null;
  elapsedMs: number;
  run(path: string, init?: RunOptions): Promise<DocsResult>;
  abort(): void;
  reset(): void;
} {
  const { recordRequest } = useDocsPage();
  // Outside a docs page the context hands out a new no-op each render; a ref keeps `run` stable either way.
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

  const run = useCallback(async (path: string, init: RunOptions = {}): Promise<DocsResult> => {
    controller.current?.abort();
    const ctrl = new AbortController();
    controller.current = ctrl;
    if (init.signal) {
      if (init.signal.aborted) ctrl.abort();
      else init.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
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

    const outcome = await performRun(path, init, ctrl.signal);
    if (outcome.record) record.current(outcome.record);
    // A newer run (or a reset) owns the state now; this one only hands back its result.
    if (latest.current === id) {
      stopTicker();
      setResult(outcome.result);
      setElapsedMs(outcome.result.elapsedMs);
      setError(outcome.error);
      setState(outcome.state);
      controller.current = null;
    }
    return outcome.result;
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

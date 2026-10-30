/**
 * Browser client for the docs playground proxy (app/api/docs/v1/[...path], lib/docs/proxy). The proxy mirrors
 * https://api.meta.ai/v1 for the endpoints the docs cover and adds the platform's key on the server, so these calls
 * never carry a key. Paths are Meta's: docsCall("responses", ...) is POST https://api.meta.ai/v1/responses.
 */

export const DOCS_API = "/api/docs/v1";

export interface DocsError {
  type?: string;
  code?: string;
  message: string;
  /** From a 429's retry-after header. */
  retryAfterSec?: number;
}

export interface DocsResult<T = unknown> {
  ok: boolean;
  status: number;
  /** The parsed body when it was JSON. */
  json: T | null;
  /** The raw body text (empty for streams and binary bodies). */
  text: string;
  /** The binary body for non-JSON, non-text replies such as GET files/{id}/content. */
  blob: Blob | null;
  headers: Record<string, string>;
  error: DocsError | null;
  /** x-docs-model: the model the proxy actually called (muse-spark-1.3 runs as muse-spark-1.3-contributor). */
  model: string | null;
  /** x-docs-note: what the proxy changed, such as a lowered max_output_tokens. */
  note: string | null;
  elapsedMs: number;
}

export interface SseEvent {
  event: string | null;
  data: string;
  /** data parsed as JSON, or null when it isn't JSON (such as "[DONE]"). */
  json: Record<string, unknown> | null;
}

export interface CallInit {
  method?: "GET" | "POST" | "DELETE";
  /** A JSON body. */
  body?: unknown;
  /** A multipart body (files, images/edits, asr/transcribe). */
  form?: FormData;
  /** A raw body with its content type (asr-realtime takes audio/wav). */
  raw?: { data: Blob | ArrayBuffer; contentType: string };
  signal?: AbortSignal;
  /** Overrides DOCS_API for the docs routes outside the mirror (/api/docs/ask, /api/docs/asr-realtime). */
  base?: string;
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function errorFrom(status: number, json: unknown, text: string, headers: Headers): DocsError {
  const err = (json as { error?: { type?: string; code?: string; message?: string } } | null)?.error;
  const retry = Number(headers.get("retry-after"));
  return {
    type: err?.type,
    code: err?.code,
    message: err?.message || text.slice(0, 500) || `HTTP ${status}`,
    retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : undefined,
  };
}

function urlFor(path: string, base?: string): string {
  const clean = path.replace(/^\/+/, "").replace(/^v1\//, "");
  return `${base ?? DOCS_API}${clean ? `/${clean}` : ""}`;
}

function requestInit(init: CallInit): RequestInit {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.raw) {
    body = init.raw.data;
    headers["content-type"] = init.raw.contentType;
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  return {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
    signal: init.signal,
    credentials: "same-origin",
    cache: "no-store",
  };
}

/** One call through the proxy, read to the end. Never throws for HTTP errors; `error` says what went wrong. */
export async function docsCall<T = unknown>(path: string, init: CallInit = {}): Promise<DocsResult<T>> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(urlFor(path, init.base), requestInit(init));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return {
      ok: false,
      status: 0,
      json: null,
      text: "",
      blob: null,
      headers: {},
      error: { message: "Couldn't reach Muse Muse. Check your connection and try again." },
      model: null,
      note: null,
      elapsedMs: performance.now() - started,
    };
  }
  const type = res.headers.get("content-type") ?? "";
  let json: T | null = null;
  let text = "";
  let blob: Blob | null = null;
  if (type.includes("json") || type.startsWith("text/")) {
    text = await res.text();
    try {
      json = text ? (JSON.parse(text) as T) : null;
    } catch {
      json = null;
    }
  } else {
    blob = await res.blob();
  }
  return {
    ok: res.ok,
    status: res.status,
    json,
    text,
    blob,
    headers: headerRecord(res.headers),
    error: res.ok ? null : errorFrom(res.status, json, text, res.headers),
    model: res.headers.get("x-docs-model"),
    note: res.headers.get("x-docs-note"),
    elapsedMs: performance.now() - started,
  };
}

/** Splits server-sent events out of decoded text chunks. */
export function sseReader(onEvent: (e: SseEvent) => void) {
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  const flush = () => {
    if (data.length) {
      const joined = data.join("\n");
      let json: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(joined) as unknown;
        json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      onEvent({ event, data: joined, json });
    }
    event = null;
    data = [];
  };
  const line = (raw: string) => {
    if (raw === "") return flush();
    if (raw.startsWith(":")) return;
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  return {
    push(text: string) {
      buffer += text;
      let idx: number;
      while ((idx = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const breakLen = buffer.startsWith("\r\n", idx) ? 2 : 1;
        if (buffer[idx] === "\r" && idx === buffer.length - 1) break; // maybe half of \r\n
        line(buffer.slice(0, idx));
        buffer = buffer.slice(idx + breakLen);
      }
    },
    end() {
      if (buffer) line(buffer);
      buffer = "";
      flush();
    },
  };
}

/**
 * A streamed call: POSTs `body` (or `init.form` / `init.raw`) and calls onEvent for each server-sent event as it
 * arrives. Resolves when the stream ends with the status and headers; a non-2xx reply is read whole into `error`.
 * Add `stream: true` to the body yourself where Meta's API wants it (responses, chat/completions, messages).
 */
export async function docsStream(
  path: string,
  body: unknown,
  onEvent: (e: SseEvent) => void,
  init: Omit<CallInit, "body" | "method"> = {},
): Promise<DocsResult<null>> {
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(urlFor(path, init.base), requestInit({ ...init, method: "POST", body }));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    return {
      ok: false,
      status: 0,
      json: null,
      text: "",
      blob: null,
      headers: {},
      error: { message: "Couldn't reach Muse Muse. Check your connection and try again." },
      model: null,
      note: null,
      elapsedMs: performance.now() - started,
    };
  }
  const base = {
    status: res.status,
    headers: headerRecord(res.headers),
    model: res.headers.get("x-docs-model"),
    note: res.headers.get("x-docs-note"),
  };
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || !type.startsWith("text/event-stream")) {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    // A JSON reply to a stream request (the model ignored stream, or the proxy answered itself): hand it over as one
    // event so callers see the same shape either way.
    if (res.ok && json && typeof json === "object") onEvent({ event: null, data: text, json: json as Record<string, unknown> });
    return {
      ...base,
      ok: res.ok,
      json: null,
      text,
      blob: null,
      error: res.ok ? null : errorFrom(res.status, json, text, res.headers),
      elapsedMs: performance.now() - started,
    };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = sseReader(onEvent);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    sse.push(decoder.decode(value, { stream: true }));
  }
  sse.push(decoder.decode());
  sse.end();
  return { ...base, ok: true, json: null, text: "", blob: null, error: null, elapsedMs: performance.now() - started };
}

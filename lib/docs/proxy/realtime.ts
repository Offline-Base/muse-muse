import { randomUUID } from "node:crypto";
import { isCrossSite } from "@/lib/auth";
import { docsError, docsErrors, KEY_REFUSED_MESSAGE } from "@/lib/docs/proxy/errors";
import { checkModelLimit, checkRequestLimits, docsClientIp, holdSpend, withInFlightSlot } from "@/lib/docs/proxy/limits";
import {
  DOCS_MAX_BODY_BYTES,
  DOCS_MODEL_HEADER,
  DOCS_MODELS,
  REALTIME_MAX_AUDIO_MS,
  UPSTREAM_REALTIME_URL,
} from "@/lib/docs/proxy/policy";
import type { DocsDeps } from "@/lib/docs/proxy/types";
import { isHttps, visitorCookie, visitorOf } from "@/lib/docs/proxy/visitor";
import { frameDueAt, parseWav, pcmFrames, WavError, audioMs as pcmMs } from "@/lib/docs/proxy/wav";
import { asrUsage } from "@/lib/gateway/meter";
import { usageCost } from "@/lib/meta/pricing";
import type { ModelUsage } from "@/lib/types";

/**
 * POST /api/docs/asr-realtime?model=&mode=&diarization= with an audio/wav body: realtime transcription for the docs
 * (api-reference/voice/realtime). The browser can't hold Muse Muse's key, and the realtime endpoint takes the key in its
 * first WebSocket frame, so the server opens the socket, sends the handshake, streams the WAV's samples in 80 ms
 * frames at real-time pace, ends with {"type":"endStream"}, and relays every server frame as server-sent events:
 * `event: handshake` first, then each frame under its own type, `event: error` on a failure, and `event: done` last.
 * Billed by audio duration, like file transcription.
 */

/** What the relay needs of a WebSocket. Node's global WebSocket has it. */
export interface RealtimeSocket {
  binaryType: string;
  send(data: string | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
}

export type SocketFactory = (url: string) => RealtimeSocket;

export interface RealtimeRun {
  url: string;
  connect: SocketFactory;
  /** The first frame. It holds the credential, so it is sent and never logged or relayed. */
  handshake: Record<string, unknown>;
  /** The WAV's samples, 16-bit little-endian mono. */
  pcm: Uint8Array;
  sampleRate: number;
  emit(event: string, data: string): void;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Milliseconds on a steady clock. */
  now(): number;
  /** Aborts when the reader goes away. */
  signal: AbortSignal;
  /** Meta wants the handshake acknowledged within 10 s of connecting. */
  handshakeTimeoutMs?: number;
  /** How long to wait for Meta to flush and close after endStream. */
  drainTimeoutMs?: number;
}

export interface RealtimeSummary {
  sessionId: string | null;
  /** Audio sent, in ms. */
  sentMs: number;
  /** The most audio Meta said it processed, in ms. */
  processedMs: number;
  transcribed: boolean;
  failed: boolean;
  closeCode: number | null;
}

class RealtimeFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Words in an error frame that say the credential was the problem. The handshake carries Muse Muse's key, so such a
 * frame is replaced with the docs' own message, as the HTTP proxy replaces a 401: Meta doesn't document what an auth
 * failure frame holds, and nothing about the key should reach the browser.
 */
const AUTH_WORDS = /auth|credential|unauthori[sz]ed|forbidden|permission|access[\s_-]?token|api[\s_-]?key|bearer|\b40[13]\b/i;

/** True when an error frame's code, type or message names auth or the credential. */
export function isAuthFailure(frame: Record<string, unknown>): boolean {
  const nested = frame.error && typeof frame.error === "object" ? (frame.error as Record<string, unknown>) : {};
  const fields = [frame.code, frame.errorType, frame.status, frame.message, nested.type, nested.code, nested.message];
  return fields.some((f) => (typeof f === "string" || typeof f === "number") && AUTH_WORDS.test(String(f)));
}

/** The frame a reader gets in place of an auth failure. */
const AUTH_FRAME = JSON.stringify({ type: "error", code: "upstream_auth", message: KEY_REFUSED_MESSAGE });

/**
 * A close before the handshake was acknowledged, as a reader should hear it. Its reason is dropped: Meta hadn't
 * accepted the credential yet, so the reason may be about it. A 1008 there is a refused handshake, which the docs
 * explain as a refused key, since the proxy checks the model and mode before connecting.
 */
export function closeBeforeAckMessage(code: number): { code: string; message: string } {
  if (code === 1008) return { code: "upstream_auth", message: KEY_REFUSED_MESSAGE };
  return { code: "realtime_closed", message: closeMessage(code, "") };
}

/** Close codes as a docs reader should hear them (api-reference/voice/realtime, "Close codes"). */
export function closeMessage(code: number, reason: string): string {
  const why = reason ? `: ${reason.slice(0, 200)}` : "";
  switch (code) {
    case 1008:
      return `Muse Voice Transcribe refused the stream${why || ". Check the model, the mode and the audio."}`;
    case 1011:
      return `Muse Voice Transcribe hit an internal error${why}. Try again.`;
    case 1013:
      return "Muse Voice Transcribe is rate limited right now. Try again in a minute.";
    default:
      return `The transcription stream closed early (code ${code})${why}.`;
  }
}

/** One frame as a single SSE data line: JSON is re-serialized compactly, anything else has its line breaks flattened. */
function dataLine(text: string): { json: Record<string, unknown> | null; line: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { json: value as Record<string, unknown>, line: JSON.stringify(value) };
    }
  } catch {
    // Not JSON: relayed as text.
  }
  return { json: null, line: text.replace(/[\r\n]+/g, " ") };
}

/** SSE event names are the frame's type, letters only, so a frame can't inject other SSE fields. */
function eventName(type: unknown): string {
  return typeof type === "string" && /^[A-Za-z]{1,40}$/.test(type) ? type : "message";
}

/**
 * Runs one realtime session to its end and returns what happened. Never throws: failures are emitted as `event:
 * error`, and `event: done` is always the last event.
 */
export async function relayRealtime(run: RealtimeRun): Promise<RealtimeSummary> {
  const summary: RealtimeSummary = {
    sessionId: null,
    sentMs: 0,
    processedMs: 0,
    transcribed: false,
    failed: false,
    closeCode: null,
  };
  let socket: RealtimeSocket | null = null;
  let acked = false;
  /** Meta sent its own error frame, which already told the reader why the session ended. */
  let serverError = false;
  let closed = false;
  let closeReason = "";
  let onAck: (() => void) | null = null;
  let onFail: ((err: RealtimeFailure) => void) | null = null;
  let onClosed: (() => void) | null = null;
  const ack = new Promise<void>((resolve, reject) => {
    onAck = resolve;
    onFail = reject;
  });
  ack.catch(() => {});
  const closedPromise = new Promise<void>((resolve) => (onClosed = resolve));
  const fail = (err: RealtimeFailure) => onFail?.(err);

  const emitError = (code: string, message: string) => {
    summary.failed = true;
    run.emit("error", JSON.stringify({ type: "error", code, message }));
  };

  try {
    try {
      socket = run.connect(run.url);
    } catch {
      throw new RealtimeFailure("realtime_unreachable", "Couldn't reach Muse Voice Transcribe. Try again.");
    }
    const ws = socket;
    ws.binaryType = "arraybuffer";
    // Listeners never throw: an exception in a socket listener would be an uncaught error in Node.
    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify(run.handshake));
      } catch {
        fail(new RealtimeFailure("realtime_unreachable", "Couldn't reach Muse Voice Transcribe. Try again."));
      }
    });
    ws.addEventListener("message", (event) => {
      try {
        relayFrame(event);
      } catch (err) {
        console.error("[docs] relaying a realtime frame failed:", err instanceof Error ? err.message : err);
      }
    });
    const relayFrame = (event: unknown) => {
      const data = (event as { data?: unknown }).data;
      // Binary frames carry nothing a reader needs.
      if (typeof data !== "string") return;
      const { json, line } = dataLine(data);
      if (!acked) {
        // The acknowledgement is the only frame with no type (api-reference/voice/realtime).
        if (json && json.type === undefined && typeof json.sessionId === "string") {
          acked = true;
          summary.sessionId = json.sessionId;
          run.emit("handshake", line);
          onAck?.();
          return;
        }
      }
      const processed = json?.audioProcessedMs;
      if (typeof processed === "number" && Number.isFinite(processed)) {
        summary.processedMs = Math.max(summary.processedMs, processed);
      }
      if (json?.type === "transcript" || json?.type === "speechComplete") summary.transcribed = true;
      if (json?.type === "error") {
        summary.failed = true;
        serverError = true;
        run.emit("error", isAuthFailure(json) ? AUTH_FRAME : line);
        return;
      }
      run.emit(eventName(json?.type), line);
    };
    ws.addEventListener("close", (event) => {
      closed = true;
      summary.closeCode = (event as { code?: number }).code ?? null;
      closeReason = String((event as { reason?: unknown }).reason ?? "");
      if (!acked) {
        const early = closeBeforeAckMessage(summary.closeCode ?? 1006);
        fail(new RealtimeFailure(early.code, early.message));
      }
      onClosed?.();
    });
    ws.addEventListener("error", () => {
      if (!acked) fail(new RealtimeFailure("realtime_unreachable", "Couldn't reach Muse Voice Transcribe. Try again."));
    });

    // Wait for the acknowledgement before sending audio.
    const handshakeTimeout = new AbortController();
    const stopWaiting = () => handshakeTimeout.abort();
    run.signal.addEventListener("abort", stopWaiting, { once: true });
    const timer = run.sleep(run.handshakeTimeoutMs ?? 10_000, handshakeTimeout.signal).then(() => {
      if (!acked && !run.signal.aborted) {
        const message = "Muse Voice Transcribe didn't answer the handshake in time. Try again.";
        fail(new RealtimeFailure("realtime_handshake", message));
      }
      if (run.signal.aborted) fail(new RealtimeFailure("aborted", "The reader stopped the run."));
    });
    try {
      await ack;
    } finally {
      handshakeTimeout.abort();
      run.signal.removeEventListener("abort", stopWaiting);
      await timer;
    }

    // Each frame is due 80 ms after the one before, counted from the first, so the stream stays at real-time pace.
    const frames = pcmFrames(run.pcm, run.sampleRate);
    const start = run.now();
    for (let i = 0; i < frames.length && !closed && !run.signal.aborted; i++) {
      const wait = frameDueAt(start, i) - run.now();
      if (wait > 0) await run.sleep(wait, run.signal);
      if (closed || run.signal.aborted) break;
      ws.send(frames[i]);
      summary.sentMs += pcmMs(frames[i].byteLength, run.sampleRate);
    }
    if (!closed && !run.signal.aborted) {
      ws.send(JSON.stringify({ type: "endStream" }));
      // Meta flushes what's pending and closes with 1000. Don't wait forever if it stalls.
      const drain = new AbortController();
      const stopDraining = () => drain.abort();
      run.signal.addEventListener("abort", stopDraining, { once: true });
      await Promise.race([closedPromise, run.sleep(run.drainTimeoutMs ?? 20_000, drain.signal)]);
      drain.abort();
      run.signal.removeEventListener("abort", stopDraining);
      if (!closed && !run.signal.aborted) {
        const message = "Muse Voice Transcribe stopped answering before it finished. The transcript so far is above.";
        emitError("realtime_stalled", message);
      }
    } else if (closed && summary.closeCode !== 1000 && !serverError) {
      emitError("realtime_closed", closeMessage(summary.closeCode ?? 1006, closeReason));
    }
  } catch (err) {
    const failure =
      err instanceof RealtimeFailure
        ? err
        : new RealtimeFailure("realtime_error", "The transcription stream failed. Try again.");
    if (failure.code === "aborted") summary.failed = true;
    else if (serverError) summary.failed = true;
    else emitError(failure.code, failure.message);
  } finally {
    if (socket && !closed) {
      try {
        socket.close(1000, run.signal.aborted ? "reader left" : "done");
      } catch {
        // Already closing.
      }
    }
    run.emit(
      "done",
      JSON.stringify({
        ok: !summary.failed && !run.signal.aborted,
        sessionId: summary.sessionId,
        code: summary.closeCode,
        audioMs: Math.round(summary.sentMs),
        processedMs: summary.processedMs,
      }),
    );
  }
  return summary;
}

/** What a session is billed: the audio Meta processed, or what was sent when it reported less. Nothing if nothing was sent. */
export function realtimeUsage(model: string, summary: RealtimeSummary): ModelUsage[] {
  const ms = Math.max(summary.processedMs, summary.sentMs);
  return ms > 0 ? [asrUsage(model, ms)] : [];
}

const MODES = ["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"] as const;
const PARTIAL_MODES = ["CUMULATIVE", "DELTA"] as const;
const WAV_TYPES = ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "application/octet-stream"];

/** A comma-separated query list (keywords, languageBias): at most 20 entries of 60 characters. */
function listParam(value: string | null): string[] | undefined {
  const items = (value ?? "")
    .split(",")
    .map((s) => s.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 20);
  return items.length ? items : undefined;
}

/** Reads the query into the handshake's settings, or an error message for the reader. */
export function realtimeSettings(
  query: URLSearchParams,
): { model: string; settings: Record<string, unknown> } | { error: string; status: 400 | 404 } {
  const model = query.get("model") || DOCS_MODELS.voice[0];
  if (!(DOCS_MODELS.voice as readonly string[]).includes(model)) {
    return { error: `Realtime transcription runs on ${DOCS_MODELS.voice.join(", ")}.`, status: 404 };
  }
  const diarization = ["1", "true", "yes", "on"].includes((query.get("diarization") ?? "").toLowerCase());
  const mode = (query.get("mode") || (diarization ? "DIARIZATION" : "PUSH_TO_TALK")).toUpperCase();
  if (!(MODES as readonly string[]).includes(mode)) {
    return { error: `mode must be one of ${MODES.join(", ")}.`, status: 400 };
  }
  const partialMode = query.get("partialMode")?.toUpperCase();
  if (partialMode && !(PARTIAL_MODES as readonly string[]).includes(partialMode)) {
    return { error: `partialMode must be ${PARTIAL_MODES.join(" or ")}.`, status: 400 };
  }
  const settings: Record<string, unknown> = { model, mode, emitAudioProgress: true };
  if (partialMode) settings.partialMode = partialMode;
  const keywords = listParam(query.get("keywords"));
  if (keywords) settings.keywords = keywords;
  const languageBias = listParam(query.get("languageBias"));
  if (languageBias) settings.languageBias = languageBias;
  return { model, settings };
}

export interface RealtimeOptions {
  connect?: SocketFactory;
  sleep?: RealtimeRun["sleep"];
  now?: () => number;
  url?: string;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The realtime route. Never throws: unexpected failures are a 500 in the gateway's shape. */
export async function handleDocsRealtime(req: Request, deps: DocsDeps, opts: RealtimeOptions = {}): Promise<Response> {
  try {
    return await realtime(req, deps, opts);
  } catch (err) {
    console.error("[docs] realtime failed:", err instanceof Error ? err.message : err);
    return docsErrors.unexpected();
  }
}

async function realtime(req: Request, deps: DocsDeps, opts: RealtimeOptions): Promise<Response> {
  const visitor = visitorOf(req, deps.newVisitorId);
  const reply = (res: Response) => {
    if (visitor.isNew) res.headers.append("set-cookie", visitorCookie(visitor.id, isHttps(req)));
    return res;
  };
  if (isCrossSite(req.headers)) return reply(docsErrors.crossSite());
  if (!deps.config.live) return reply(docsErrors.paused());

  const read = realtimeSettings(new URL(req.url).searchParams);
  if ("error" in read) {
    const code = read.status === 404 ? "model_not_found" : "invalid_body";
    return reply(docsError(read.status, "invalid_request_error", code, read.error, { retry: false }));
  }
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type && !WAV_TYPES.includes(type)) {
    return reply(docsErrors.invalidBody("Send the recording as the body, with Content-Type: audio/wav."));
  }
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > DOCS_MAX_BODY_BYTES) {
    return reply(docsErrors.tooLarge(DOCS_MAX_BODY_BYTES));
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > DOCS_MAX_BODY_BYTES) return reply(docsErrors.tooLarge(DOCS_MAX_BODY_BYTES));
  let wav;
  try {
    wav = parseWav(bytes, { maxDurationMs: REALTIME_MAX_AUDIO_MS });
  } catch (err) {
    if (err instanceof WavError) return reply(docsErrors.invalidAudio(err.message));
    throw err;
  }

  const ip = docsClientIp(req.headers);
  const now = deps.now?.() ?? new Date();
  const limited = (await checkRequestLimits(ip, deps, now)) ?? (await checkModelLimit(read.model, deps, now));
  if (limited) return reply(limited);

  const { model, settings } = read;
  const sampleRate = wav.sampleRate;
  const pcm = bytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataBytes);
  return reply(
    await withInFlightSlot(ip, deps, now, async () => {
      // The handshake holds the key, read before any spend is held, so a deploy without one charges nothing.
      const handshake = {
        authorization: { accessToken: `Bearer ${deps.upstreamKey()}` },
        audioEncoding: sampleRate === 24_000 ? "PCM_24KHZ" : "PCM_16KHZ",
        ...settings,
      };
      const audioSeconds = wav.durationMs / 1000;
      const estimate = usageCost({ model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds });
      const hold = await holdSpend(deps, { source: "docs", endpoint: "asr/realtime" }, model, estimate, ip, now);
      if (hold instanceof Response) return { response: hold, metering: null };

      const encoder = new TextEncoder();
      const left = new AbortController();
      let open = true;
      let finished: Promise<RealtimeSummary> = Promise.resolve({
        sessionId: null,
        sentMs: 0,
        processedMs: 0,
        transcribed: false,
        failed: true,
        closeCode: null,
      });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: string, data: string) => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
            } catch {
              open = false;
            }
          };
          finished = relayRealtime({
            url: `${opts.url ?? UPSTREAM_REALTIME_URL}?sessionId=docs-${randomUUID()}`,
            connect: opts.connect ?? ((url) => new WebSocket(url) as unknown as RealtimeSocket),
            handshake,
            pcm,
            sampleRate,
            emit,
            sleep: opts.sleep ?? abortableSleep,
            now: opts.now ?? (() => performance.now()),
            signal: left.signal,
          }).finally(() => {
            if (open) {
              open = false;
              try {
                controller.close();
              } catch {
                // The reader already left.
              }
            }
          });
        },
        cancel() {
          open = false;
          left.abort();
        },
      });
      const metering = finished
        .then((summary) => hold.settle(realtimeUsage(model, summary)))
        .catch((err) => console.error("[docs] metering realtime failed:", err instanceof Error ? err.message : err));
      return {
        response: new Response(body, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
            [DOCS_MODEL_HEADER]: model,
          },
        }),
        metering,
      };
    }),
  );
}

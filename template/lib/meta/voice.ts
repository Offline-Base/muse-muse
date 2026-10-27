import { clientIpHeaders, gatewayEnv, type RequestLike } from "./client";

export interface TranscriptTurn {
  speaker: string;
  startSec: number;
  endSec: number;
  text: string;
}

export interface Transcript {
  text: string;
  /** Always empty in practice: Meta returns no turns, even for two voices. Don't promise speaker labels. */
  turns: TranscriptTurn[];
  durationSec?: number;
}

export interface TranscribeOptions {
  /** Public https URL of a 16 kHz (or 24 kHz) mono 16-bit WAV, such as the url uploadMedia returns. */
  url?: string;
  /** Or the WAV bytes themselves, when the file came in the request body. */
  bytes?: ArrayBuffer | Uint8Array;
  /** Byte size when known, to skip downloading files that are too big for the multipart path. */
  size?: number;
  fileName?: string;
  /** The incoming request, or `await headers()` in a server action, so the gateway can rate limit each visitor. */
  request?: RequestLike | null;
}

export const VOICE_MODEL = "muse-voice-transcribe-1.0";

/** Multipart bodies above this go through the gateway's JSON audioUrl path instead (functions accept 4.5 MB). */
const MULTIPART_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Transcribes a recorded WAV with muse-voice-transcribe-1.0 (POST {GATEWAY_URL}/v1/asr/transcribe). Server only.
 *
 * Meta accepts only mono 16-bit PCM WAV at 16 or 24 kHz. Convert in the browser with toWav16k from
 * lib/client/wav.ts before uploading. MP3, M4A, WebM and the rest are rejected with HTTP 400.
 *
 * Two paths:
 * - WAV under 4 MB: multipart { request: {"model","audioEncoding":"WAV"}, audio: file }, the same as Meta's own API.
 * - Larger, with a public url: JSON { model, audioUrl }, a Muse Muse gateway extension (the gateway downloads it).
 *
 * The transcript is trimmed and U+200B is stripped. `turns` are mapped if Meta ever returns them, but it returns an
 * empty list today, so treat the result as one block of text.
 */
export async function transcribeFile(opts: TranscribeOptions): Promise<Transcript> {
  const endpoint = `${gatewayEnv().baseURL}/asr/transcribe`;
  let bytes = opts.bytes ? toUint8(opts.bytes) : null;

  if (!bytes) {
    if (!opts.url) throw new Error("transcribeFile needs a url or bytes.");
    if (!(opts.size !== undefined && opts.size > MULTIPART_MAX_BYTES)) {
      const res = await fetch(opts.url);
      if (!res.ok) throw new Error(`Could not download the audio (HTTP ${res.status}).`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MULTIPART_MAX_BYTES) {
        await res.body?.cancel();
      } else {
        bytes = new Uint8Array(await res.arrayBuffer());
      }
    }
  }

  let res: Response;
  if (bytes && bytes.byteLength <= MULTIPART_MAX_BYTES) {
    if (!isWav(bytes)) throw new Error("Audio must be a 16 kHz mono WAV. Convert it with toWav16k before upload.");
    const form = new FormData();
    form.append("request", JSON.stringify({ model: VOICE_MODEL, audioEncoding: "WAV" }));
    form.append("audio", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "audio/wav" }), opts.fileName ?? "audio.wav");
    res = await fetch(endpoint, { method: "POST", headers: authHeaders(opts.request), body: form });
  } else {
    if (!opts.url) throw new Error("Audio over 4 MB needs a public url (upload it with uploadMedia).");
    res = await fetch(endpoint, {
      method: "POST",
      headers: { ...authHeaders(opts.request), "Content-Type": "application/json" },
      body: JSON.stringify({ model: VOICE_MODEL, audioUrl: opts.url }),
    });
  }

  const body = (await res.json().catch(() => ({}))) as AsrReply;
  if (!res.ok || body.error) {
    const message = body.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Transcription failed: ${message}`);
  }
  return {
    text: cleanText(body.transcript),
    turns: Array.isArray(body.turns) ? body.turns.map(toTurn) : [],
    durationSec: typeof body.audioDurationMs === "number" ? body.audioDurationMs / 1000 : undefined,
  };
}

interface AsrReply {
  sessionId?: string;
  transcript?: string;
  audioDurationMs?: number;
  turns?: Array<Record<string, unknown>>;
  error?: { type?: string; param?: string; message?: string };
}

function toTurn(t: Record<string, unknown>): TranscriptTurn {
  const num = (...keys: string[]) => {
    for (const k of keys) if (typeof t[k] === "number") return t[k] as number;
    return 0;
  };
  const ms = typeof t.startMs === "number" || typeof t.start_ms === "number";
  const scale = ms ? 1 / 1000 : 1;
  return {
    speaker: String(t.speaker ?? t.speakerId ?? t.speaker_id ?? ""),
    startSec: num("startMs", "start_ms", "start", "startSec") * scale,
    endSec: num("endMs", "end_ms", "end", "endSec") * scale,
    text: cleanText(typeof t.text === "string" ? t.text : typeof t.transcript === "string" ? t.transcript : ""),
  };
}

function cleanText(text: unknown): string {
  return typeof text === "string" ? text.replace(/​/g, "").trim() : "";
}

function isWav(bytes: Uint8Array): boolean {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  return bytes.byteLength > 44 && tag(0) === "RIFF" && tag(8) === "WAVE";
}

function toUint8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function authHeaders(request?: RequestLike | null): Record<string, string> {
  return { Authorization: `Bearer ${gatewayEnv().apiKey}`, ...clientIpHeaders(request) };
}

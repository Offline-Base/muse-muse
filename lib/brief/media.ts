import { toFile } from "openai";
import { env } from "@/lib/env";
import { UPSTREAM_BASE_URL } from "@/lib/gateway/policy";
import { metaPlatform } from "@/lib/meta/platform";
import { usageCost } from "@/lib/meta/pricing";
import { fetchBytes } from "@/lib/storage";
import type { ModelUsage, Reference } from "@/lib/types";

/**
 * Content parts for the platform's own Responses calls (brief writer and judge), plus the fallbacks docs/SPIKES.md
 * calls for: Meta fetches public https media itself, and when an origin refuses its fetcher (HTTP 400
 * media_url_origin_error) the part is resent inline.
 */

/** Meta's input_video part isn't in the OpenAI SDK types. */
export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" | "low" | "high" }
  | { type: "input_video"; video_url?: string; file_id?: string }
  | { type: "input_file"; filename?: string; file_data?: string; file_id?: string };

/** Where a remote media part came from, so it can be inlined if Meta can't fetch it. */
export interface MediaSource {
  url: string;
  kind: "image" | "video";
  contentType: string;
  fileName: string;
}

export const PDF_MAX_BYTES = 20 * 1024 * 1024;
/** Above this, a fallback uploads with POST /v1/files instead of sending a data URL. */
const INLINE_MAX_BYTES = 15 * 1024 * 1024;
const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";

export function dataUrl(bytes: Buffer, contentType: string): string {
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

export function textPart(text: string): ContentPart {
  return { type: "input_text", text };
}

export function imagePart(url: string): ContentPart {
  return { type: "input_image", image_url: url, detail: "auto" };
}

export function videoPart(url: string): ContentPart {
  return { type: "input_video", video_url: url };
}

/** The content index Meta names in a media_url_origin_error, or -1 when the error is that kind but unparseable. */
export function mediaOriginErrorIndex(err: unknown): number | null {
  const e = err as { status?: number; code?: unknown; error?: { code?: unknown; message?: unknown }; message?: unknown };
  const code = e?.code ?? e?.error?.code;
  const message = String(e?.error?.message ?? e?.message ?? "");
  if (code !== "media_url_origin_error" && !/failed to download media/i.test(message)) return null;
  const m = /content\[(\d+)\]/.exec(message);
  return m ? Number(m[1]) : -1;
}

/** Replaces a remote media part with inline bytes: a data URL, or a Meta file id for large video. */
export async function inlineMedia(source: MediaSource): Promise<ContentPart> {
  const bytes = await fetchBytes(source.url);
  if (source.kind === "image") return imagePart(dataUrl(bytes, source.contentType));
  if (bytes.length <= INLINE_MAX_BYTES) return videoPart(dataUrl(bytes, source.contentType));
  const file = await metaPlatform().files.create({
    file: await toFile(bytes, source.fileName, { type: source.contentType }),
    purpose: "user_data",
  });
  return { type: "input_video", file_id: file.id };
}

/**
 * Runs a call over a list of content parts. When Meta can't fetch one of the remote parts, that part (or every remote
 * part, if the error doesn't say which) is inlined and the call is retried.
 */
export async function withMediaFallback<T>(
  parts: ContentPart[],
  sources: Map<number, MediaSource>,
  call: (parts: ContentPart[]) => Promise<T>,
): Promise<T> {
  const current = [...parts];
  const pending = new Map(sources);
  for (;;) {
    try {
      return await call(current);
    } catch (err) {
      const index = mediaOriginErrorIndex(err);
      if (index === null || pending.size === 0) throw err;
      const targets = index >= 0 && pending.has(index) ? [index] : [...pending.keys()];
      console.warn(`Meta could not fetch media at content[${index}]. Sending ${targets.length} part(s) inline.`);
      for (const i of targets) {
        current[i] = await inlineMedia(pending.get(i) as MediaSource);
        pending.delete(i);
      }
    }
  }
}

export interface Transcription {
  text: string;
  audioDurationMs: number;
  usage: ModelUsage;
}

/** Duration of a PCM WAV from its header, for billing when Meta's reply has no audioDurationMs. */
function wavDurationMs(bytes: Buffer): number {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") return 0;
  const byteRate = bytes.readUInt32LE(28);
  return byteRate > 0 ? Math.round(((bytes.length - 44) / byteRate) * 1000) : 0;
}

/**
 * Transcribes a 16 kHz mono WAV with Muse Voice Transcribe using the master key: multipart with a JSON `request` part
 * and an `audio` part (docs/SPIKES.md). Throws with Meta's message on a 4xx.
 */
export async function transcribeWav(bytes: Buffer, fileName: string): Promise<Transcription> {
  const form = new FormData();
  form.append("request", JSON.stringify({ model: TRANSCRIBE_MODEL, audioEncoding: "WAV" }));
  form.append("audio", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), fileName || "memo.wav");
  const res = await fetch(`${UPSTREAM_BASE_URL}/asr/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.modelApiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    transcript?: string;
    audioDurationMs?: number;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${body.error?.message ?? "no message"}`);
  const audioDurationMs = Number(body.audioDurationMs) || wavDurationMs(bytes);
  const u = { model: TRANSCRIBE_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds: audioDurationMs / 1000 };
  return {
    text: (body.transcript ?? "").replace(/[​\s]+$/u, "").trim(),
    audioDurationMs,
    usage: { ...u, costUsd: usageCost(u) },
  };
}

export interface ReferenceParts {
  parts: ContentPart[];
  /** Remote media parts by content index, for withMediaFallback. */
  sources: Map<number, MediaSource>;
  transcripts: Array<{ index: number; text: string }>;
  usage: ModelUsage[];
}

function remote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * One labeled block per reference, in order: an input_text label "Reference N (<kind>, <fileName>)" and then the
 * media. Images and videos go by URL, PDFs inline as file_data, voice memos as their transcript.
 */
export async function referenceParts(references: Reference[]): Promise<ReferenceParts> {
  const out: ReferenceParts = { parts: [], sources: new Map(), transcripts: [], usage: [] };
  for (const [i, ref] of references.entries()) {
    out.parts.push(textPart(`Reference ${i + 1} (${ref.kind}, ${ref.fileName})`));
    if (ref.kind === "image" || ref.kind === "video") {
      if (remote(ref.url)) {
        out.sources.set(out.parts.length, { url: ref.url, kind: ref.kind, contentType: ref.contentType, fileName: ref.fileName });
      }
      out.parts.push(ref.kind === "image" ? imagePart(ref.url) : videoPart(ref.url));
    } else if (ref.kind === "pdf") {
      const bytes = await fetchBytes(ref.url);
      if (bytes.length > PDF_MAX_BYTES) {
        out.parts.push(textPart(`(This PDF is ${(bytes.length / 1048576).toFixed(1)} MB, over the 20 MB the brief writer reads. Use its file name and the note.)`));
      } else {
        out.parts.push({ type: "input_file", filename: ref.fileName, file_data: dataUrl(bytes, "application/pdf") });
      }
    } else {
      try {
        const t = await transcribeWav(await fetchBytes(ref.url), ref.fileName);
        out.usage.push(t.usage);
        out.transcripts.push({ index: i, text: t.text });
        const seconds = Math.round(t.audioDurationMs / 1000);
        out.parts.push(textPart(t.text ? `Voice memo transcript (${seconds} s, one voice assumed):\n${t.text}` : "(The voice memo has no speech that could be transcribed.)"));
      } catch (err) {
        out.parts.push(textPart(`(This voice memo could not be transcribed: ${(err as Error).message}. Rely on the note and other references.)`));
      }
    }
  }
  return out;
}

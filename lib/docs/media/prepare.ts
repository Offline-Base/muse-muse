import { formatBytes, sniffMime } from "@/lib/docs/media/base64";
import { downscaleImage, imageSize } from "@/lib/docs/media/downscale";
import { MAX_TRANSCRIBE_SECONDS, formatDuration, toTranscribeWav } from "@/lib/docs/media/audio";
import { kindOf } from "@/lib/docs/media/accept";
import { codecLabel } from "@/lib/docs/media/mp4";
import { MAX_INLINE_VIDEO_BYTES, probeVideo, videoProblems } from "@/lib/docs/media/video";
import type { DocsSample, SampleKind } from "@/lib/docs/media/samples";

/**
 * Turns a picked file, a sample or a recording into what a demo sends: images downscaled so their data URL fits,
 * audio converted to 16 kHz mono WAV, video checked for size, length and codec. Every file picker and recorder in the
 * media kit hands playgrounds this one shape.
 */

/** The most a demo sends in one file (the proxy takes 4.5 MB bodies; base64 adds a third). */
export const MAX_DEMO_FILE_BYTES = 3 * 1024 * 1024;

export type PrepareMode = "image" | "audio" | "video" | "none";

export interface PickedMedia {
  /** What gets sent: the prepared bytes (a downscaled image, a converted WAV) or the original. */
  blob: Blob;
  name: string;
  mime: string;
  bytes: number;
  kind: SampleKind;
  source: "upload" | "sample" | "recording";
  sampleId?: string;
  /** The sample's description (alt text, a transcript), when it's a sample. */
  description?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  fps?: number;
  frames?: number;
  codec?: string | null;
  /** What changed on the way in, such as "Resized from 4032 x 3024 to 1600 x 1200". */
  note?: string;
  /** Why it can't be sent as is. A playground disables Run while there are any. */
  problems: string[];
}

export interface PrepareOptions {
  prepare?: PrepareMode;
  source?: PickedMedia["source"];
  sample?: DocsSample | null;
  maxBytes?: number;
  /** Video for SAM 3.1: check the codec too. */
  forSam?: boolean;
  /** Longest audio accepted, in seconds. */
  maxAudioSeconds?: number;
}

function renamed(name: string, ext: string): string {
  return `${name.replace(/\.[^.]+$/, "") || "file"}.${ext}`;
}

/** Prepares one file. Throws only for files that can't be read at all; size problems come back in `problems`. */
export async function prepareFile(file: Blob & { name?: string }, opts: PrepareOptions = {}): Promise<PickedMedia> {
  const name = file.name || opts.sample?.src.split("/").pop() || "file";
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const mime = file.type || sniffMime(head) || "application/octet-stream";
  const kind = opts.sample?.kind ?? kindOf({ type: mime, name }) ?? "text";
  const mode: PrepareMode =
    opts.prepare ?? (kind === "image" ? "image" : kind === "audio" ? "audio" : kind === "video" ? "video" : "none");
  const maxBytes = opts.maxBytes ?? MAX_DEMO_FILE_BYTES;
  const base: PickedMedia = {
    blob: file,
    name,
    mime,
    bytes: file.size,
    kind,
    source: opts.source ?? (opts.sample ? "sample" : "upload"),
    sampleId: opts.sample?.id,
    description: opts.sample?.description,
    width: opts.sample?.width,
    height: opts.sample?.height,
    durationMs: opts.sample?.durationMs,
    fps: opts.sample?.fps,
    frames: opts.sample?.frames,
    problems: [],
  };

  if (mode === "image" && kind === "image") {
    const img = await downscaleImage(file);
    const out = {
      ...base,
      blob: img.blob,
      mime: img.mime,
      bytes: img.blob.size,
      width: img.width,
      height: img.height,
      name: img.changed ? renamed(name, img.mime === "image/webp" ? "webp" : "jpg") : name,
      note: img.changed
        ? `Resized from ${img.originalWidth} x ${img.originalHeight} to ${img.width} x ${img.height} (${formatBytes(img.blob.size)}) to send inline.`
        : undefined,
    };
    if (!out.width) Object.assign(out, await imageSize(img.blob).catch(() => ({})));
    return out;
  }

  if (mode === "audio" && kind === "audio") {
    const wav = await toTranscribeWav(file, { maxSeconds: opts.maxAudioSeconds ?? MAX_TRANSCRIBE_SECONDS });
    return {
      ...base,
      blob: wav.wav,
      mime: "audio/wav",
      bytes: wav.wav.size,
      name: wav.converted ? renamed(name, "wav") : name,
      durationMs: wav.durationMs,
      note: wav.converted
        ? `Converted from ${wav.source.channels > 1 ? `${wav.source.channels} channels` : "mono"} at ${wav.source.sampleRate / 1000} kHz to 16 kHz mono WAV (${formatDuration(wav.durationMs)}).`
        : undefined,
      problems: wav.wav.size > maxBytes ? [`The audio is ${formatBytes(wav.wav.size)} as WAV. Demos send up to ${formatBytes(maxBytes)}.`] : [],
    };
  }

  if (mode === "video" && kind === "video") {
    const probe = await probeVideo(file).catch(() => null);
    const out: PickedMedia = {
      ...base,
      width: probe?.width || base.width,
      height: probe?.height || base.height,
      durationMs: probe ? Math.round(probe.durationSec * 1000) : base.durationMs,
      fps: probe?.mp4?.fps || base.fps,
      frames: probe?.mp4?.frames || base.frames,
      codec: probe?.mp4?.codec ?? null,
    };
    out.problems = videoProblems(
      { bytes: file.size, mime, name, durationSec: probe?.durationSec, codec: probe?.mp4 ? probe.mp4.codec : undefined },
      { maxBytes: Math.min(maxBytes, MAX_INLINE_VIDEO_BYTES), forSam: opts.forSam },
    );
    if (probe?.mp4 && !probe.mp4.faststart) out.note = "The MP4 index is at the end; Meta remuxes it losslessly on upload.";
    if (probe?.mp4) out.note = [out.note, `${codecLabel(probe.mp4.codec)}, ${probe.mp4.fps} fps, ${probe.mp4.frames} frames.`].filter(Boolean).join(" ");
    return out;
  }

  return {
    ...base,
    problems: file.size > maxBytes ? [`${name} is ${formatBytes(file.size)}. Demos send files up to ${formatBytes(maxBytes)}.`] : [],
  };
}

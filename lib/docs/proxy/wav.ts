/**
 * Reads a WAV header far enough to check what Muse Voice Transcribe takes (docs/SPIKES.md, api-reference/voice):
 * mono, 16-bit PCM, 16 or 24 kHz. Realtime transcription streams the PCM samples after the header in 80 ms frames at
 * real-time pace (speech-to-text, "Send audio"), and the math for that lives here too, so it can be tested on its own.
 */

export class WavError extends Error {}

export interface WavInfo {
  sampleRate: 16_000 | 24_000;
  /** Where the PCM samples start, and how many bytes of them there are. */
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
}

/** 16-bit mono PCM: two bytes a sample. */
const BYTES_PER_SAMPLE = 2;
const PCM = 1;
const EXTENSIBLE = 0xfffe;

function ascii(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function khz(rate: number): string {
  return `${Number((rate / 1000).toFixed(2))} kHz`;
}

/** Milliseconds of 16-bit mono audio in `bytes` at `sampleRate`. */
export function audioMs(bytes: number, sampleRate: number): number {
  return (bytes / (sampleRate * BYTES_PER_SAMPLE)) * 1000;
}

/**
 * Parses a WAV file's header, refusing anything Voice Transcribe wouldn't take, with a message for a docs reader.
 * `maxDurationMs` refuses longer clips. Chunks other than "fmt " and "data" (LIST, fact) are skipped. A data chunk
 * whose size is 0 or 0xFFFFFFFF, as some recorders write while streaming, runs to the end of the file.
 */
export function parseWav(bytes: Uint8Array, opts: { maxDurationMs?: number } = {}): WavInfo {
  if (bytes.length < 12 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") {
    throw new WavError("The audio must be a WAV file (RIFF/WAVE): mono 16-bit PCM at 16 or 24 kHz.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: { tag: number; channels: number; rate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) throw new WavError("The WAV file's format chunk is cut short.");
      let tag = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE names the real format in the first two bytes of its sub-format GUID.
      if (tag === EXTENSIBLE && size >= 40 && body + 26 <= bytes.length) tag = view.getUint16(body + 24, true);
      format = {
        tag,
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new WavError("The WAV file has no format chunk before its audio.");
      if (format.tag !== PCM) {
        throw new WavError("The WAV must hold uncompressed PCM audio (16-bit mono, 16 or 24 kHz).");
      }
      if (format.channels !== 1) throw new WavError(`The WAV must be mono; this one has ${format.channels} channels.`);
      if (format.bits !== 16) throw new WavError(`The WAV must be 16-bit; this one is ${format.bits}-bit.`);
      if (format.rate !== 16_000 && format.rate !== 24_000) {
        throw new WavError(`The WAV must be 16 kHz or 24 kHz; this one is ${khz(format.rate)}.`);
      }
      const rest = bytes.length - body;
      const declared = size === 0 || size === 0xffffffff ? rest : Math.min(size, rest);
      // Whole samples only: a stray odd byte at the end isn't audio.
      const dataBytes = declared - (declared % BYTES_PER_SAMPLE);
      if (dataBytes <= 0) throw new WavError("The WAV file has no audio in it.");
      const durationMs = audioMs(dataBytes, format.rate);
      if (opts.maxDurationMs !== undefined && durationMs > opts.maxDurationMs) {
        const most = Math.round(opts.maxDurationMs / 1000);
        throw new WavError(`This clip is ${(durationMs / 1000).toFixed(1)} s; live demos take at most ${most} s of audio.`);
      }
      return { sampleRate: format.rate, dataOffset: body, dataBytes, durationMs };
    }
    // Chunks are padded to an even length.
    offset = body + size + (size % 2);
  }
  throw new WavError(format ? "The WAV file has no audio (data chunk) in it." : "The WAV file has no format chunk.");
}

/** Realtime frames are 80 ms of audio each, the pace Meta's own examples send. */
export const REALTIME_FRAME_MS = 80;

/** Bytes in one frame: 2,560 at 16 kHz, 3,840 at 24 kHz. */
export function frameBytes(sampleRate: number, frameMs: number = REALTIME_FRAME_MS): number {
  return (sampleRate * BYTES_PER_SAMPLE * frameMs) / 1000;
}

/** The PCM split into frames. The last one may be shorter. */
export function pcmFrames(pcm: Uint8Array, sampleRate: number, frameMs: number = REALTIME_FRAME_MS): Uint8Array[] {
  const size = frameBytes(sampleRate, frameMs);
  const frames: Uint8Array[] = [];
  for (let at = 0; at < pcm.length; at += size) frames.push(pcm.subarray(at, Math.min(at + size, pcm.length)));
  return frames;
}

/**
 * When frame `index` is due, in ms on the same clock as `startMs`. Each frame is scheduled from the start rather than
 * from the previous send, so timer lateness never adds up and the stream stays at real-time pace: Meta closes a stream
 * that runs more than five seconds ahead or stays slower than real time.
 */
export function frameDueAt(startMs: number, index: number, frameMs: number = REALTIME_FRAME_MS): number {
  return startMs + index * frameMs;
}

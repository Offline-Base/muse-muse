import { decodeWav, encodeWav, isTranscribeReady, parseWav } from "@/lib/docs/media/wav";
import { TRANSCRIBE_SAMPLE_RATE, toTranscribeSamples } from "@/lib/docs/media/resample";

/**
 * Audio for the voice demos: Muse Voice Transcribe takes only mono 16-bit PCM WAV at 16 or 24 kHz (docs/SPIKES.md).
 * A WAV is read in TypeScript; anything else (MP3, M4A, a browser recording) is decoded with Web Audio. Either way the
 * samples are mixed to mono and resampled to 16 kHz by lib/docs/media/resample.ts, then written as WAV.
 */

/** File transcription in the demos: the proxy takes 4.5 MB bodies, about 140 s of 16 kHz WAV. */
export const MAX_TRANSCRIBE_SECONDS = 120;
/** The realtime relay takes up to 60 s (docs/DOCS_MIRROR.md). */
export const MAX_REALTIME_SECONDS = 60;

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
}

type AudioCtor = new (options?: { sampleRate?: number }) => AudioContext;

function audioContextCtor(): AudioCtor {
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error("This browser can't decode audio. Try Chrome, Edge, Firefox or Safari.");
  return Ctor;
}

/** Decodes a WAV in TypeScript, or any other audio the browser can play with Web Audio. */
export async function decodeAudio(blob: Blob): Promise<DecodedAudio> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const wav = decodeWav(bytes);
  if (wav) return { sampleRate: wav.sampleRate, channels: wav.channels };
  const Ctor = audioContextCtor();
  const ctx = new Ctor();
  try {
    // decodeAudioData detaches the buffer it gets, so hand it a copy.
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
    return {
      sampleRate: buffer.sampleRate,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice()),
    };
  } catch {
    throw new Error("Couldn't read that audio. Try a WAV, MP3 or M4A file.");
  } finally {
    void ctx.close().catch(() => {});
  }
}

export interface TranscribeWav {
  wav: Blob;
  durationMs: number;
  sampleRate: number;
  /** False when the file was already mono 16-bit WAV at 16 or 24 kHz and passed through untouched. */
  converted: boolean;
  /** The source's own format, for the "converted from" note. */
  source: { sampleRate: number; channels: number };
}

/** Returns a WAV Muse Voice Transcribe accepts, converting only when it has to. */
export async function toTranscribeWav(blob: Blob, opts: { maxSeconds?: number } = {}): Promise<TranscribeWav> {
  const maxSeconds = opts.maxSeconds ?? MAX_TRANSCRIBE_SECONDS;
  const head = new Uint8Array(await blob.arrayBuffer());
  const info = parseWav(head);
  if (info && isTranscribeReady(info)) {
    if (info.durationMs > maxSeconds * 1000) throw tooLong(info.durationMs, maxSeconds);
    return {
      wav: blob.type === "audio/wav" ? blob : new Blob([head], { type: "audio/wav" }),
      durationMs: Math.round(info.durationMs),
      sampleRate: info.sampleRate,
      converted: false,
      source: { sampleRate: info.sampleRate, channels: info.channels },
    };
  }
  const decoded = await decodeAudio(blob);
  const length = decoded.channels[0]?.length ?? 0;
  const durationMs = (length / decoded.sampleRate) * 1000;
  if (durationMs > maxSeconds * 1000) throw tooLong(durationMs, maxSeconds);
  const samples = toTranscribeSamples(decoded.channels, decoded.sampleRate);
  return {
    wav: new Blob([encodeWav(samples, TRANSCRIBE_SAMPLE_RATE)], { type: "audio/wav" }),
    durationMs: Math.round((samples.length / TRANSCRIBE_SAMPLE_RATE) * 1000),
    sampleRate: TRANSCRIBE_SAMPLE_RATE,
    converted: true,
    source: { sampleRate: decoded.sampleRate, channels: decoded.channels.length },
  };
}

function tooLong(durationMs: number, maxSeconds: number): Error {
  return new Error(`That audio runs ${Math.round(durationMs / 1000)} s. This demo takes up to ${maxSeconds} s.`);
}

/** "0:07", "1:05": a clip length for labels. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Voice memo conversion. Muse Voice Transcribe accepts only mono 16-bit PCM WAV at 16 or 24 kHz (docs/SPIKES.md), so
 * every audio reference is decoded with Web Audio, resampled to 16 kHz, mixed down to mono and written as WAV in the
 * browser before upload.
 */
export const WAV_SAMPLE_RATE = 16_000;

export interface WavResult {
  blob: Blob;
  durationMs: number;
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineContext(): OfflineCtor {
  const w = window as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctor) throw new Error("This browser can't convert audio. Try Chrome, Edge, Firefox or Safari.");
  return Ctor;
}

/** Decodes any audio the browser can play and returns a 16 kHz mono 16-bit WAV. */
export async function toWav16k(input: Blob): Promise<WavResult> {
  const Ctor = offlineContext();
  const data = await input.arrayBuffer();
  // decodeAudioData resamples to the context's rate, so a 16 kHz context gives 16 kHz channel data.
  const decoder = new Ctor(1, 1, WAV_SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(data);
  } catch {
    throw new Error("Couldn't read that audio file. Try a WAV, MP3 or M4A voice memo.");
  }

  let samples: Float32Array;
  if (decoded.sampleRate === WAV_SAMPLE_RATE) {
    samples = mixDown(decoded);
  } else {
    // Some engines keep the file's own rate. Resample by rendering through a 16 kHz offline graph.
    const length = Math.max(1, Math.ceil(decoded.duration * WAV_SAMPLE_RATE));
    const ctx = new Ctor(1, length, WAV_SAMPLE_RATE);
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    source.start(0);
    samples = (await ctx.startRendering()).getChannelData(0);
  }

  return {
    blob: encodeWav(samples, WAV_SAMPLE_RATE),
    durationMs: Math.round((samples.length / WAV_SAMPLE_RATE) * 1000),
  };
}

function mixDown(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= buffer.numberOfChannels;
  return out;
}

/** 16-bit PCM WAV with a standard 44-byte header. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

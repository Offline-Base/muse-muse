/**
 * WAV reading and writing in plain TypeScript. Muse Voice Transcribe takes only mono 16-bit PCM WAV at 16 or 24 kHz
 * (docs/SPIKES.md), and the realtime relay streams the same PCM, so the demos write that one format and can read any
 * PCM or float WAV without Web Audio (which also keeps this testable in Node).
 */

export const TRANSCRIBE_RATES = [16_000, 24_000] as const;

export interface WavInfo {
  /** 1 integer PCM, 3 IEEE float. WAVE_FORMAT_EXTENSIBLE is resolved to its sub-format. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Byte offset of the sample data. */
  dataOffset: number;
  dataBytes: number;
  /** Sample frames (one sample per channel each). */
  frames: number;
  durationMs: number;
}

const ascii = (v: DataView, at: number, n: number) => {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(at + i));
  return s;
};

/** Writes 16-bit PCM WAV with the canonical 44-byte header. Float input is clipped to [-1, 1]. */
export function encodeWav(samples: Float32Array | Int16Array, sampleRate: number, channels = 1): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const put = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  put(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  put(8, "WAVE");
  put(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // integer PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true); // byte rate
  v.setUint16(32, channels * 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  put(36, "data");
  v.setUint32(40, dataBytes, true);
  let o = 44;
  if (samples instanceof Int16Array) {
    for (let i = 0; i < samples.length; i++, o += 2) v.setInt16(o, samples[i], true);
  } else {
    for (let i = 0; i < samples.length; i++, o += 2) v.setInt16(o, floatToInt16(samples[i]), true);
  }
  return new Uint8Array(buf);
}

/** One float sample as 16-bit PCM: clipped, scaled asymmetrically so -1 and 1 both land on the extremes. */
export function floatToInt16(s: number): number {
  const c = s > 1 ? 1 : s < -1 ? -1 : Number.isNaN(s) ? 0 : s;
  return c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff);
}

/**
 * Reads a WAV header, walking the chunks so extra ones (LIST, fact, FLLR padding from macOS tools) are skipped.
 * Returns null for anything that isn't a RIFF/WAVE file with fmt and data chunks.
 */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(v, 0, 4) !== "RIFF" || ascii(v, 8, 4) !== "WAVE") return null;
  let fmt: Omit<WavInfo, "dataOffset" | "dataBytes" | "frames" | "durationMs"> | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(v, at, 4);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      let format = v.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of its sub-format GUID.
      if (format === 0xfffe && size >= 40 && body + 26 <= bytes.length) format = v.getUint16(body + 24, true);
      fmt = {
        format,
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bitsPerSample: v.getUint16(body + 14, true),
      };
    } else if (id === "data" && fmt) {
      // Recorders that stream (and some that crash) leave a 0 or oversized length; trust the bytes we have.
      const available = bytes.length - body;
      const dataBytes = size === 0 || size > available ? available : size;
      const frameBytes = (fmt.bitsPerSample / 8) * fmt.channels;
      if (!fmt.channels || !fmt.sampleRate || !frameBytes) return null;
      const frames = Math.floor(dataBytes / frameBytes);
      return { ...fmt, dataOffset: body, dataBytes, frames, durationMs: (frames / fmt.sampleRate) * 1000 };
    }
    at = body + size + (size % 2); // chunks are word aligned
  }
  return null;
}

/** True when Muse Voice Transcribe takes the file as is: mono 16-bit integer PCM at 16 or 24 kHz. */
export function isTranscribeReady(info: WavInfo | null): boolean {
  return (
    !!info &&
    info.format === 1 &&
    info.channels === 1 &&
    info.bitsPerSample === 16 &&
    (TRANSCRIBE_RATES as readonly number[]).includes(info.sampleRate)
  );
}

/** Decodes a PCM (8, 16, 24 or 32-bit) or float (32 or 64-bit) WAV into one Float32Array per channel. */
export function decodeWav(bytes: Uint8Array): { sampleRate: number; channels: Float32Array[]; info: WavInfo } | null {
  const info = parseWav(bytes);
  if (!info) return null;
  const { format, bitsPerSample: bits, channels: n, frames, dataOffset } = info;
  const isFloat = format === 3;
  if (format !== 1 && !isFloat) return null;
  if (isFloat ? bits !== 32 && bits !== 64 : ![8, 16, 24, 32].includes(bits)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const step = bits / 8;
  const out = Array.from({ length: n }, () => new Float32Array(frames));
  let at = dataOffset;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < n; c++, at += step) {
      let s: number;
      if (isFloat) s = bits === 32 ? v.getFloat32(at, true) : v.getFloat64(at, true);
      else if (bits === 8) s = (v.getUint8(at) - 128) / 128;
      else if (bits === 16) s = v.getInt16(at, true) / 32768;
      else if (bits === 24) {
        const raw = v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getUint8(at + 2) << 16);
        s = (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608;
      } else s = v.getInt32(at, true) / 2147483648;
      out[c][f] = s;
    }
  }
  return { sampleRate: info.sampleRate, channels: out, info };
}

/** The PCM bytes of a WAV (no header), for streaming frames. */
export function wavPcm(bytes: Uint8Array): Uint8Array | null {
  const info = parseWav(bytes);
  return info ? bytes.subarray(info.dataOffset, info.dataOffset + info.dataBytes) : null;
}

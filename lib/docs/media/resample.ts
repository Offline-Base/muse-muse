/**
 * Mono mix-down and sample-rate conversion in plain TypeScript, so a microphone at 48 kHz or a 44.1 kHz file becomes
 * the 16 kHz mono that Muse Voice Transcribe takes (docs/SPIKES.md). It doesn't depend on OfflineAudioContext, which
 * resamples differently per browser, and it runs in Node for tests.
 *
 * The converter is a windowed-sinc low-pass (Blackman window) evaluated at each output instant. When downsampling, the
 * cutoff sits just under the new Nyquist frequency, so speech above 8 kHz is removed instead of folding back into the
 * band the model listens to, which a plain linear interpolation would do.
 */

export const TRANSCRIBE_SAMPLE_RATE = 16_000;

/** Averages any number of channels into one. A single channel is copied. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0].slice();
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);
  for (const ch of channels) for (let i = 0; i < length; i++) out[i] += ch[i];
  const n = channels.length;
  for (let i = 0; i < length; i++) out[i] /= n;
  return out;
}

export interface ResampleOptions {
  /** Zero crossings of the sinc on each side of the centre. More means a sharper filter and more work. */
  zeros?: number;
  /** Cutoff as a fraction of the lower Nyquist frequency. */
  rolloff?: number;
}

/** The number of output samples for `inputLength` samples converted from `fromRate` to `toRate`. */
export function resampledLength(inputLength: number, fromRate: number, toRate: number): number {
  return Math.max(0, Math.round((inputLength * toRate) / fromRate));
}

const TABLE_STEPS = 64; // kernel table entries per input sample

/** Converts mono samples from `fromRate` to `toRate`. Returns a copy when the rates match. */
export function resample(input: Float32Array, fromRate: number, toRate: number, opts: ResampleOptions = {}): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error("Sample rates must be positive.");
  if (fromRate === toRate) return input.slice();
  const ratio = toRate / fromRate;
  const outLength = resampledLength(input.length, fromRate, toRate);
  const out = new Float32Array(outLength);
  if (input.length === 0) return out;

  const zeros = opts.zeros ?? 10;
  const rolloff = opts.rolloff ?? 0.94;
  // Cutoff in cycles per input sample: half the lower of the two rates, pulled in by the rolloff.
  const cutoff = 0.5 * Math.min(1, ratio) * rolloff;
  const halfWidth = zeros / (2 * cutoff); // in input samples
  const table = kernelTable(cutoff, halfWidth);
  const step = fromRate / toRate; // input samples per output sample
  const last = input.length - 1;

  for (let j = 0; j < outLength; j++) {
    const t = j * step;
    const lo = Math.max(0, Math.ceil(t - halfWidth));
    const hi = Math.min(last, Math.floor(t + halfWidth));
    let acc = 0;
    let norm = 0;
    for (let k = lo; k <= hi; k++) {
      const d = Math.abs(t - k) * TABLE_STEPS;
      const i0 = d | 0;
      const w = table[i0] + (table[i0 + 1] - table[i0]) * (d - i0);
      acc += input[k] * w;
      norm += w;
    }
    // Dividing by the weights' sum keeps a constant signal constant, including near the edges where the window is cut.
    out[j] = norm !== 0 ? acc / norm : 0;
  }
  return out;
}

function kernelTable(cutoff: number, halfWidth: number): Float32Array {
  const size = Math.ceil(halfWidth * TABLE_STEPS) + 2;
  const table = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const u = i / TABLE_STEPS;
    if (u >= halfWidth) break; // the rest stays 0
    const x = 2 * cutoff * u;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = u / halfWidth;
    const blackman = 0.42 + 0.5 * Math.cos(Math.PI * r) + 0.08 * Math.cos(2 * Math.PI * r);
    table[i] = sinc * blackman;
  }
  return table;
}

/** Mixes to mono and converts to 16 kHz: what the transcribe and realtime demos send. */
export function toTranscribeSamples(channels: readonly Float32Array[], sampleRate: number): Float32Array {
  return resample(mixToMono(channels), sampleRate, TRANSCRIBE_SAMPLE_RATE);
}

/** Root mean square of a block, 0 to 1, for level meters. */
export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0;
  const n = Math.max(0, end - start);
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return n ? Math.sqrt(sum / n) : 0;
}

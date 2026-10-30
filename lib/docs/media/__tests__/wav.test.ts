/**
 * The audio path for the voice demos (lib/docs/media/wav.ts, resample.ts): the 16-bit PCM WAV writer and reader, the
 * transcribe-ready check (mono 16-bit at 16 or 24 kHz, docs/SPIKES.md), mono mix-down, and the windowed-sinc
 * resampler: lengths, DC, a tone kept in band, and a tone above the new Nyquist removed instead of aliased.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/media/__tests__/wav.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeWav, encodeWav, floatToInt16, isTranscribeReady, parseWav, wavPcm } from "@/lib/docs/media/wav";
import { mixToMono, resample, resampledLength, rms, toTranscribeSamples } from "@/lib/docs/media/resample";

const tone = (hz: number, rate: number, seconds: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

describe("encodeWav", () => {
  it("writes the canonical 44-byte PCM header", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16_000);
    const v = new DataView(wav.buffer);
    assert.equal(wav.length, 44 + 8);
    assert.equal(text(wav, 0, 4), "RIFF");
    assert.equal(v.getUint32(4, true), 36 + 8);
    assert.equal(text(wav, 8, 4), "WAVE");
    assert.equal(text(wav, 12, 4), "fmt ");
    assert.equal(v.getUint32(16, true), 16);
    assert.equal(v.getUint16(20, true), 1, "integer PCM");
    assert.equal(v.getUint16(22, true), 1, "mono");
    assert.equal(v.getUint32(24, true), 16_000);
    assert.equal(v.getUint32(28, true), 32_000, "byte rate");
    assert.equal(v.getUint16(32, true), 2, "block align");
    assert.equal(v.getUint16(34, true), 16, "bits per sample");
    assert.equal(text(wav, 36, 4), "data");
    assert.equal(v.getUint32(40, true), 8);
    assert.deepEqual([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true)), [0, 16384, -16384, 32767]);
  });

  it("clips out-of-range floats and maps -1 and 1 to the extremes", () => {
    assert.equal(floatToInt16(1), 32767);
    assert.equal(floatToInt16(-1), -32768);
    assert.equal(floatToInt16(3), 32767);
    assert.equal(floatToInt16(-3), -32768);
    assert.equal(floatToInt16(Number.NaN), 0);
  });

  it("writes Int16 samples unchanged and stereo headers", () => {
    const wav = encodeWav(new Int16Array([1, -2, 300, -400]), 24_000, 2);
    const info = parseWav(wav)!;
    assert.equal(info.channels, 2);
    assert.equal(info.frames, 2);
    assert.equal(new DataView(wav.buffer).getUint32(28, true), 24_000 * 4);
    assert.deepEqual(Array.from(new Int16Array(wavPcm(wav)!.slice().buffer)), [1, -2, 300, -400]);
  });
});

describe("parseWav and decodeWav", () => {
  it("round-trips samples within one 16-bit step", () => {
    const src = tone(440, 16_000, 0.1);
    const decoded = decodeWav(encodeWav(src, 16_000))!;
    assert.equal(decoded.sampleRate, 16_000);
    assert.equal(decoded.channels.length, 1);
    assert.equal(decoded.channels[0].length, src.length);
    for (let i = 0; i < src.length; i++) assert.ok(Math.abs(decoded.channels[0][i] - src[i]) < 1 / 16_000);
    assert.equal(Math.round(decoded.info.durationMs), 100);
  });

  it("skips extra chunks such as LIST and FLLR before the data", () => {
    const pcm = encodeWav(new Float32Array([0.25, -0.25]), 16_000);
    const chunk = (id: string, size: number) => {
      const c = new Uint8Array(8 + size + (size % 2)); // odd sizes get a pad byte
      c.set([...id].map((ch) => ch.charCodeAt(0)), 0);
      new DataView(c.buffer).setUint32(4, size, true);
      return c;
    };
    // The RIFF header and fmt chunk, a LIST chunk with an odd size, an FLLR chunk, then the data chunk.
    const parts = [pcm.subarray(0, 36), chunk("LIST", 5), chunk("FLLR", 4), pcm.subarray(36)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    const info = parseWav(out)!;
    assert.equal(info.frames, 2);
    assert.equal(info.dataOffset, 36 + 14 + 12 + 8);
    assert.deepEqual(Array.from(decodeWav(out)!.channels[0]).map((s) => Math.round(s * 4) / 4), [0.25, -0.25]);
  });

  it("reads 24-bit and float WAVs", () => {
    const head = (format: number, bits: number, data: number[]) => {
      const bytes = data.length;
      const b = new Uint8Array(44 + bytes);
      const v = new DataView(b.buffer);
      b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
      v.setUint32(4, 36 + bytes, true);
      b.set([..."WAVEfmt "].map((c) => c.charCodeAt(0)), 8);
      v.setUint32(16, 16, true);
      v.setUint16(20, format, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, 48_000, true);
      v.setUint32(28, 48_000 * (bits / 8), true);
      v.setUint16(32, bits / 8, true);
      v.setUint16(34, bits, true);
      b.set([..."data"].map((c) => c.charCodeAt(0)), 36);
      v.setUint32(40, bytes, true);
      b.set(data, 44);
      return b;
    };
    // 24-bit: 0x400000 (0.5) and 0xC00000 (-0.5), little-endian.
    const pcm24 = decodeWav(head(1, 24, [0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]))!;
    assert.deepEqual(Array.from(pcm24.channels[0]), [0.5, -0.5]);
    const f = new Uint8Array(new Float32Array([0.75, -0.125]).buffer);
    const float32 = decodeWav(head(3, 32, [...f]))!;
    assert.deepEqual(Array.from(float32.channels[0]), [0.75, -0.125]);
    assert.equal(isTranscribeReady(float32.info), false, "float WAVs need converting");
  });

  it("knows which WAVs Muse Voice Transcribe takes as is", () => {
    assert.equal(isTranscribeReady(parseWav(encodeWav(new Float32Array(10), 16_000))), true);
    assert.equal(isTranscribeReady(parseWav(encodeWav(new Float32Array(10), 24_000))), true);
    assert.equal(isTranscribeReady(parseWav(encodeWav(new Float32Array(10), 44_100))), false);
    assert.equal(isTranscribeReady(parseWav(encodeWav(new Float32Array(10), 16_000, 2))), false);
    assert.equal(isTranscribeReady(null), false);
  });

  it("rejects files that aren't WAV", () => {
    assert.equal(parseWav(new TextEncoder().encode("ID3 this is an mp3")), null);
    assert.equal(parseWav(new Uint8Array(4)), null);
    assert.equal(decodeWav(new Uint8Array(0)), null);
  });
});

describe("mixToMono", () => {
  it("averages channels and copies a single one", () => {
    assert.deepEqual(Array.from(mixToMono([new Float32Array([1, 0.5]), new Float32Array([0, -0.5])])), [0.5, 0]);
    const one = new Float32Array([0.1, 0.2]);
    const copy = mixToMono([one]);
    assert.notEqual(copy, one);
    assert.deepEqual(Array.from(copy), Array.from(one));
    assert.equal(mixToMono([]).length, 0);
  });
});

describe("resample", () => {
  it("gives the expected lengths", () => {
    assert.equal(resample(new Float32Array(48_000), 48_000, 16_000).length, 16_000);
    assert.equal(resample(new Float32Array(44_100), 44_100, 16_000).length, 16_000);
    assert.equal(resample(new Float32Array(16_000), 16_000, 24_000).length, 24_000);
    assert.equal(resampledLength(441, 44_100, 16_000), 160);
    assert.equal(resample(new Float32Array(0), 48_000, 16_000).length, 0);
    assert.throws(() => resample(new Float32Array(4), 0, 16_000));
  });

  it("returns a copy when the rates match", () => {
    const src = tone(100, 16_000, 0.01);
    const out = resample(src, 16_000, 16_000);
    assert.notEqual(out, src);
    assert.deepEqual(Array.from(out), Array.from(src));
  });

  it("keeps a constant signal constant, edges included", () => {
    const out = resample(new Float32Array(4800).fill(0.4), 48_000, 16_000);
    for (const s of out) assert.ok(Math.abs(s - 0.4) < 1e-5, `got ${s}`);
  });

  it("keeps a 1 kHz tone when going from 48 kHz to 16 kHz", () => {
    const out = resample(tone(1000, 48_000, 0.5), 48_000, 16_000);
    const ideal = tone(1000, 16_000, 0.5);
    let worst = 0;
    for (let i = 200; i < out.length - 200; i++) worst = Math.max(worst, Math.abs(out[i] - ideal[i]));
    assert.ok(worst < 0.01, `worst error ${worst}`);
  });

  it("removes a 12 kHz tone instead of folding it to 4 kHz", () => {
    const src = tone(12_000, 48_000, 0.5);
    const out = resample(src, 48_000, 16_000);
    const level = rms(out, 200, out.length - 200);
    assert.ok(level < 0.003, `alias level ${level}`);
    // Picking every third sample without a filter keeps most of it (as a 4 kHz alias).
    const naive = Float32Array.from({ length: 8000 }, (_, i) => src[i * 3 + 1]);
    assert.ok(rms(naive) > 0.1, `naive level ${rms(naive)}`);
  });

  it("converts 44.1 kHz stereo to 16 kHz mono for transcription", () => {
    const left = tone(500, 44_100, 0.2);
    const right = tone(500, 44_100, 0.2);
    const out = toTranscribeSamples([left, right], 44_100);
    assert.equal(out.length, 3200);
    const ideal = tone(500, 16_000, 0.2);
    for (let i = 300; i < out.length - 300; i++) assert.ok(Math.abs(out[i] - ideal[i]) < 0.01);
  });
});

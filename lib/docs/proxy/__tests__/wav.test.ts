import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { audioMs, frameBytes, frameDueAt, parseWav, pcmFrames, REALTIME_FRAME_MS, WavError } from "@/lib/docs/proxy/wav";
import { wavBytes } from "./helpers";

/** 16 kHz mono 16-bit speech, recorded for the gateway's tests. */
const speech = new Uint8Array(readFileSync(path.join(import.meta.dirname, "../../../gateway/__tests__/fixtures/speech.wav")));

test("the recorded 16 kHz speech clip parses", () => {
  const wav = parseWav(speech);
  assert.equal(wav.sampleRate, 16_000);
  assert.equal(wav.dataOffset, 44);
  assert.equal(wav.dataBytes, 124_416);
  assert.equal(wav.durationMs, 3_888);
});

test("24 kHz mono 16-bit parses, with its duration", () => {
  const wav = parseWav(wavBytes(24_000, 2_500));
  assert.equal(wav.sampleRate, 24_000);
  assert.equal(wav.dataBytes, 24_000 * 2 * 2.5);
  assert.equal(wav.durationMs, 2_500);
});

test("what Voice Transcribe refuses is refused with a reason a reader understands", () => {
  const cases: Array<[Uint8Array, RegExp]> = [
    [new TextEncoder().encode("ID3 not a wav at all"), /must be a WAV file/],
    [wavBytes(16_000, 100, { channels: 2 }), /must be mono; this one has 2 channels/],
    [wavBytes(16_000, 100, { bits: 8 }), /must be 16-bit; this one is 8-bit/],
    [wavBytes(44_100, 100), /16 kHz or 24 kHz; this one is 44.1 kHz/],
    [wavBytes(48_000, 100), /this one is 48 kHz/],
    [wavBytes(16_000, 100, { format: 3 }), /uncompressed PCM/],
    [wavBytes(16_000, 0), /no audio/],
  ];
  for (const [bytes, message] of cases) assert.throws(() => parseWav(bytes), (err) => err instanceof WavError && message.test(err.message));
});

test("clips over the limit are refused", () => {
  assert.throws(() => parseWav(wavBytes(16_000, 61_000), { maxDurationMs: 60_000 }), /61\.0 s; live demos take at most 60 s/);
  assert.equal(parseWav(wavBytes(16_000, 60_000), { maxDurationMs: 60_000 }).durationMs, 60_000);
});

test("extra chunks are skipped, odd chunks padded, extensible PCM accepted, streaming sizes run to the end", () => {
  const base = wavBytes(16_000, 100);
  // A LIST chunk of odd length (5 bytes plus a pad byte) between fmt and data.
  const list = new Uint8Array([...new TextEncoder().encode("LIST"), 5, 0, 0, 0, 1, 2, 3, 4, 5, 0]);
  const withList = new Uint8Array([...base.subarray(0, 36), ...list, ...base.subarray(36)]);
  const parsed = parseWav(withList);
  assert.equal(parsed.dataOffset, 44 + list.length);
  assert.equal(parsed.durationMs, 100);

  // WAVE_FORMAT_EXTENSIBLE: format tag 0xFFFE, sub-format GUID starting with 1 (PCM).
  const ext = new Uint8Array(68 + 3200);
  ext.set(base.subarray(0, 12));
  const v = new DataView(ext.buffer);
  ext.set(new TextEncoder().encode("fmt "), 12);
  v.setUint32(16, 40, true);
  v.setUint16(20, 0xfffe, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true);
  v.setUint32(28, 32_000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  v.setUint16(36, 22, true);
  v.setUint16(44, 1, true);
  ext.set(new TextEncoder().encode("data"), 60);
  v.setUint32(64, 0xffffffff, true);
  const extensible = parseWav(ext);
  assert.equal(extensible.dataOffset, 68);
  assert.equal(extensible.dataBytes, 3200, "a streaming size runs to the end of the file");
  assert.equal(extensible.durationMs, 100);
});

test("frame pacing: 80 ms frames, due on a schedule from the start", () => {
  assert.equal(REALTIME_FRAME_MS, 80);
  assert.equal(frameBytes(16_000), 2_560);
  assert.equal(frameBytes(24_000), 3_840);
  assert.equal(audioMs(2_560, 16_000), 80);
  assert.equal(audioMs(3_840, 24_000), 80);
  // Due times don't drift: frame 100 is 8 s after the first, however late the frames between were sent.
  assert.equal(frameDueAt(1_000, 0), 1_000);
  assert.equal(frameDueAt(1_000, 1), 1_080);
  assert.equal(frameDueAt(1_000, 100), 9_000);

  const pcm = new Uint8Array(2_560 * 3 + 100);
  const frames = pcmFrames(pcm, 16_000);
  assert.deepEqual(
    frames.map((f) => f.byteLength),
    [2_560, 2_560, 2_560, 100],
  );
  assert.equal(pcmFrames(new Uint8Array(0), 24_000).length, 0);
});

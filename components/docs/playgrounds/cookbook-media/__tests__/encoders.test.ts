/**
 * The sticker encoders and the pacing simulator. The GIF is decoded back by a small GIF reader in this file (LZW
 * with GIF's code-size rule) and compared pixel by pixel; the animated WebP's container is read back chunk by chunk
 * (the browser's encoder makes the frames, so here they are hand-built still WebP files). The simulator is checked
 * against the page's cutoff rules.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-media/__tests__/encoders.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeGif, lzwEncode, medianCut } from "@/components/docs/playgrounds/cookbook-media/gif";
import { buildAnimatedWebp, describeAnimatedWebp, readWebp } from "@/components/docs/playgrounds/cookbook-media/webp-anim";
import { CUTOFF, clock, simulatePacing } from "@/components/docs/playgrounds/cookbook-media/pacing";

/** Reads a GIF made by encodeGif: the global palette, then each frame's delay, transparent index and pixel indexes. */
function readGif(bytes: Uint8Array) {
  let at = 0;
  const u8 = () => bytes[at++];
  const u16 = () => bytes[at++] | (bytes[at++] << 8);
  const head = String.fromCharCode(...bytes.subarray(0, 6));
  at = 6;
  const width = u16();
  const height = u16();
  const packed = u8();
  u8();
  u8();
  const palette: number[][] = [];
  if (packed & 0x80) for (let i = 0; i < 2 << (packed & 7); i++) palette.push([u8(), u8(), u8()]);
  const frames: Array<{ delay: number; transparent: number; indexes: Uint8Array }> = [];
  let loops = -1;
  let gce = { delay: 0, transparent: -1 };
  const blocks = () => {
    const out: number[] = [];
    for (let n = u8(); n; n = u8()) for (let i = 0; i < n; i++) out.push(u8());
    return out;
  };
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      const data = blocks();
      if (label === 0xf9) gce = { delay: data[1] | (data[2] << 8), transparent: data[0] & 1 ? data[3] : -1 };
      if (label === 0xff && data.length >= 14) loops = data[12] | (data[13] << 8);
      continue;
    }
    assert.equal(b, 0x2c);
    u16();
    u16();
    const w = u16();
    const h = u16();
    u8();
    const min = u8();
    const data = blocks();
    frames.push({ ...gce, indexes: lzwDecode(data, min, w * h) });
  }
  return { head, width, height, palette, frames, loops };
}

function lzwDecode(data: number[], min: number, count: number): Uint8Array {
  const clear = 1 << min;
  const eoi = clear + 1;
  let size = min + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
    size = min + 1;
  };
  reset();
  const out: number[] = [];
  let bitPos = 0;
  let prev: number[] | null = null;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i++) {
      const byte = data[(bitPos + i) >> 3] ?? 0;
      code |= ((byte >> ((bitPos + i) & 7)) & 1) << i;
    }
    bitPos += size;
    return code;
  };
  while (out.length < count) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev && code === dict.length) entry = [...prev, prev[0]];
    else throw new Error(`Bad code ${code}`);
    out.push(...entry);
    if (prev && dict.length < 4096) {
      dict.push([...prev, entry[0]]);
      if (dict.length >= 1 << size && size < 12) size++;
    }
    prev = entry;
  }
  return Uint8Array.from(out.slice(0, count));
}

describe("GIF encoder", () => {
  it("round-trips a transparent two-frame animation", () => {
    const w = 37;
    const h = 23;
    const frame = (shift: number) =>
      Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => {
        const p = i >> 2;
        const x = p % w;
        const y = Math.floor(p / w);
        const c = i & 3;
        if (c === 3) return (x + y + shift) % 7 === 0 ? 0 : 255;
        return [((x * 7 + shift) * 13) % 256, (y * 11) % 256, ((x + y) * 5) % 256][c];
      });
    const frames = [frame(0), frame(3)];
    const gif = readGif(encodeGif(w, h, frames.map((rgba) => ({ rgba, delayMs: 80 }))));
    assert.equal(gif.head, "GIF89a");
    assert.equal(gif.width, w);
    assert.equal(gif.height, h);
    assert.equal(gif.palette.length, 256);
    assert.equal(gif.loops, 0);
    assert.equal(gif.frames.length, 2);
    gif.frames.forEach((f, k) => {
      assert.equal(f.delay, 8);
      assert.equal(f.transparent, 255);
      const src = frames[k];
      let worst = 0;
      let total = 0;
      let opaque = 0;
      for (let p = 0; p < w * h; p++) {
        if (src[p * 4 + 3] < 128) {
          assert.equal(f.indexes[p], 255, `pixel ${p} is transparent`);
          continue;
        }
        const [r, g, b] = gif.palette[f.indexes[p]];
        const err = Math.max(Math.abs(r - src[p * 4]), Math.abs(g - src[p * 4 + 1]), Math.abs(b - src[p * 4 + 2]));
        worst = Math.max(worst, err);
        total += err;
        opaque++;
      }
      // About 800 distinct colors share 255 entries here, so some error is expected; it stays small on average.
      assert.ok(total / opaque <= 16, `mean channel error ${total / opaque}`);
      assert.ok(worst <= 64, `worst channel error ${worst}`);
    });
  });

  it("keeps LZW in step with GIF's code-size growth on long runs", () => {
    const n = 300 * 300;
    const indexes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 9)) % 200);
    const blocks = lzwEncode(indexes);
    const data: number[] = [];
    for (let at = 1; blocks[at]; at += blocks[at] + 1) data.push(...blocks.subarray(at + 1, at + 1 + blocks[at]));
    assert.deepEqual(lzwDecode(data, 8, n), indexes);
  });

  it("builds at most 255 palette colors with median cut", () => {
    const buckets = Array.from({ length: 1000 }, (_, i) => ({ r: i % 256, g: (i * 3) % 256, b: (i * 7) % 256, n: 1 + (i % 5) }));
    assert.ok(medianCut(buckets, 255).length <= 255);
    assert.deepEqual(medianCut([], 255), [[0, 0, 0]]);
  });
});

describe("animated WebP", () => {
  const still = (chunks: Array<[string, number]>) => {
    const parts: number[] = [];
    for (const [fourcc, len] of chunks) {
      parts.push(...Array.from(fourcc, (c) => c.charCodeAt(0)), len & 255, (len >> 8) & 255, 0, 0, ...Array.from({ length: len }, (_, i) => (i * 17) & 255));
      if (len & 1) parts.push(0);
    }
    const size = 4 + parts.length;
    return Uint8Array.from([..."RIFF"].map((c) => c.charCodeAt(0)).concat([size & 255, (size >> 8) & 255, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0)), parts));
  };

  it("wraps still frames in VP8X, ANIM and one ANMF each", () => {
    const lossy = still([
      ["VP8X", 10],
      ["ALPH", 33],
      ["VP8 ", 120],
    ]);
    const lossless = still([["VP8L", 77]]);
    const file = buildAnimatedWebp({ width: 512, height: 512, frames: [lossy, lossless, lossy], durationMs: [80, 80, 120] });
    const riffSize = file[4] | (file[5] << 8) | (file[6] << 16) | (file[7] << 24);
    assert.equal(riffSize, file.length - 8);
    assert.deepEqual(describeAnimatedWebp(file), { width: 512, height: 512, frames: 3, durations: [80, 80, 120], loops: 0, alpha: true });
    const chunks = readWebp(file);
    assert.deepEqual(chunks.map((c) => c.fourcc), ["VP8X", "ANIM", "ANMF", "ANMF", "ANMF"]);
    // The first frame keeps its ALPH and VP8 chunks (with the odd one padded), the second its VP8L.
    const inner = (data: Uint8Array) => readWebp(Uint8Array.from([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0)), Array.from(data.subarray(16)))));
    assert.deepEqual(inner(chunks[2].data).map((c) => [c.fourcc, c.data.length]), [
      ["ALPH", 33],
      ["VP8 ", 120],
    ]);
    assert.deepEqual(inner(chunks[3].data).map((c) => c.fourcc), ["VP8L"]);
  });

  it("refuses frames without image data and files that aren't WebP", () => {
    assert.throws(() => buildAnimatedWebp({ width: 4, height: 4, frames: [still([["VP8X", 10]])], durationMs: 50 }), /no image data/);
    assert.throws(() => readWebp(new Uint8Array(20)), /isn't a WebP/);
  });
});

describe("realtime pacing simulator", () => {
  const base = { frameMs: 80, sendMs: 2, jitterMs: 0, audioMs: 120_000 };

  it("keeps an absolute schedule on time", () => {
    const r = simulatePacing({ ...base, strategy: "absolute" });
    assert.equal(r.close, null);
    assert.ok(r.maxLateMs <= 2.01);
    assert.equal(r.sentMs, 120_000);
  });

  it("drifts with a flat sleep until ten seconds of lateness close it", () => {
    const short = simulatePacing({ ...base, strategy: "fixed" });
    assert.equal(short.close, null);
    assert.ok(Math.abs(short.maxLateMs - 3000) < 5, `2 ms x 1,500 frames is 3 s late (${short.maxLateMs})`);
    const long = simulatePacing({ ...base, strategy: "fixed", audioMs: 600_000 });
    assert.equal(long.close?.code, 1008);
    assert.equal(long.close?.rule, "lateness");
    assert.ok(Math.abs(long.close!.atMs - 410_000) < 200, `closes about 6:50 in (${clock(long.close!.atMs)})`);
  });

  it("closes a blast past five seconds of backlog", () => {
    const r = simulatePacing({ ...base, strategy: "blast" });
    assert.equal(r.close?.rule, "backlog");
    assert.ok(r.close!.atMs < 1000);
    assert.ok(r.sentMs > CUTOFF.backlogMs);
  });

  it("closes when silence is skipped for ten seconds, and not when it's padded", () => {
    const silence = { atMs: 20_000, lengthMs: 12_000 };
    const skipped = simulatePacing({ ...base, strategy: "absolute", silence: { ...silence, pad: false } });
    assert.equal(skipped.close?.rule, "lateness");
    assert.ok(Math.abs(skipped.close!.atMs - 30_000) < 100);
    assert.match(skipped.close!.reason, /pad silence/);
    assert.equal(simulatePacing({ ...base, strategy: "absolute", silence: { ...silence, pad: true } }).close, null);
    assert.equal(simulatePacing({ ...base, strategy: "absolute", silence: { atMs: 20_000, lengthMs: 4_000, pad: false } }).close, null);
  });

  it("closes a session past 60 minutes with 1011", () => {
    const r = simulatePacing({ ...base, strategy: "absolute", frameMs: 1000, audioMs: 65 * 60_000 });
    assert.equal(r.close?.code, 1011);
    assert.equal(clock(r.close!.atMs), "60:00");
  });
});

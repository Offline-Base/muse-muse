/**
 * The QR encoder (lib/qr.ts), read back by a small decoder written here from the standard, so an encoder mistake can't
 * hide in shared code: it finds the format bits, undoes the mask, walks the zigzag, checks each block's Reed-Solomon
 * remainder and reads the bytes. The pinned hashes are of codes that macOS's own QR detector (CIDetector) read correctly
 * on Oct 31, 2026, so a change to them means the codes changed and should be read by a real scanner again.
 *   npx tsx --test lib/__tests__/qr.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { QR_MAX_BYTES, qrMatrix, qrPath, qrSvg, type QrMatrix } from "@/lib/qr";

const GF_EXP: number[] = [];
const GF_LOG: number[] = new Array(256).fill(0);
for (let i = 0, x = 1; i < 255; i++) {
  GF_EXP[i] = x;
  GF_LOG[x] = i;
  x = x & 0x80 ? ((x << 1) ^ 0x11d) & 0xff : x << 1;
}
const gfPow = (a: number, n: number) => (a === 0 ? 0 : GF_EXP[(GF_LOG[a]! * n) % 255]!);

/** A received block is a Reed-Solomon codeword when the polynomial is zero at each of α^0 to α^(ec-1). */
function blockIsValid(block: number[], ec: number): boolean {
  for (let i = 0; i < ec; i++) {
    const at = GF_EXP[i]!;
    let sum = 0;
    block.forEach((byte, j) => (sum ^= byte === 0 ? 0 : gfPow(at, block.length - 1 - j) === 0 ? 0 : GF_EXP[(GF_LOG[byte]! + GF_LOG[gfPow(at, block.length - 1 - j)]!) % 255]!));
    if (sum !== 0) return false;
  }
  return true;
}

// Level M, from the standard's tables: [total codewords, ec per block, blocks].
const TABLE: Record<number, [number, number, number]> = {
  1: [26, 10, 1],
  2: [44, 16, 1],
  3: [70, 26, 1],
  4: [100, 18, 2],
  5: [134, 24, 2],
  6: [172, 16, 4],
  7: [196, 18, 4],
  8: [242, 22, 4],
  9: [292, 22, 5],
  10: [346, 26, 5],
  14: [581, 24, 9],
  40: [3706, 28, 49],
};
const ALIGN: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  14: [6, 26, 46, 66],
  40: [6, 30, 58, 86, 114, 142, 170],
};

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Which modules hold patterns or format and version bits, from the standard's layout. */
function reserved(version: number, size: number): boolean[][] {
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const box = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) fixed[y]![x] = true;
  };
  box(0, 0, 9, 9);
  box(size - 8, 0, 8, 9);
  box(0, size - 8, 9, 8);
  box(6, 0, 1, size);
  box(0, 6, size, 1);
  const align = ALIGN[version]!;
  for (const cy of align) {
    for (const cx of align) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      box(cx - 2, cy - 2, 5, 5);
    }
  }
  if (version >= 7) {
    box(size - 11, 0, 3, 6);
    box(0, size - 11, 6, 3);
  }
  return fixed;
}

/** Decodes a code the way a scanner does, or throws saying what is wrong with it. */
function decode(m: QrMatrix): { text: string; version: number; mask: number } {
  const size = m.size;
  const version = (size - 17) / 4;
  const table = TABLE[version];
  assert.ok(table, `the test has no table for version ${version}`);
  const [total, ec, blocks] = table;
  const at = (x: number, y: number) => m.dark[y]![x]!;

  // Finder patterns: a 3x3 core in a dark ring, in three corners.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    assert.ok(at(cx, cy) && at(cx - 3, cy - 3) && !at(cx - 2, cy) && at(cx - 3, cy), "finder pattern");
  }
  assert.ok(at(8, size - 8), "the dark module");

  const readFormat = (cells: Array<[number, number]>) => cells.reduce((v, [x, y], i) => v | ((at(x, y) ? 1 : 0) << i), 0) ^ 0x5412;
  const first = readFormat([[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]);
  const second = readFormat([
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [size - 8, 8],
    [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ]);
  assert.equal(first, second, "the two copies of the format bits agree");
  let rem = first;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  assert.equal(rem, 0, "the format bits' BCH check");
  assert.equal(first >>> 13, 0, "error correction level M");
  const mask = (first >>> 10) & 7;

  if (version >= 7) {
    let bits = 0;
    for (let i = 0; i < 18; i++) bits |= (at(size - 11 + (i % 3), Math.floor(i / 3)) ? 1 : 0) << i;
    assert.equal(bits >>> 12, version, "the version bits say the version");
    let vr = bits;
    for (let i = 17; i >= 12; i--) if ((vr >>> i) & 1) vr ^= 0x1f25 << (i - 12);
    assert.equal(vr, 0, "the version bits' BCH check");
  }

  const fixed = reserved(version, size);
  const words: number[] = [];
  let current = 0;
  let count = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (fixed[y]![x]) continue;
        current = (current << 1) | (at(x, y) !== MASKS[mask]!(x, y) ? 1 : 0);
        if (++count === 8) {
          words.push(current);
          current = 0;
          count = 0;
        }
      }
    }
    upward = !upward;
  }
  assert.equal(words.length, total, "the codeword count");

  const shortLength = Math.floor(total / blocks);
  const longBlocks = total % blocks;
  const dataLengths = Array.from({ length: blocks }, (_, i) => shortLength - ec + (i >= blocks - longBlocks ? 1 : 0));
  const dataParts: number[][] = dataLengths.map(() => []);
  let next = 0;
  for (let i = 0; i < Math.max(...dataLengths); i++) {
    dataParts.forEach((part, b) => {
      if (i < dataLengths[b]!) part.push(words[next++]!);
    });
  }
  const ecParts: number[][] = dataLengths.map(() => []);
  for (let i = 0; i < ec; i++) ecParts.forEach((part) => part.push(words[next++]!));
  dataParts.forEach((part, b) => assert.ok(blockIsValid([...part, ...ecParts[b]!], ec), `block ${b}'s Reed-Solomon check`));

  const data = dataParts.flat();
  const bit = (i: number) => (data[i >>> 3]! >>> (7 - (i & 7))) & 1;
  const read = (from: number, n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + bit(from + i);
    return v;
  };
  assert.equal(read(0, 4), 0b0100, "byte mode");
  const countBits = version < 10 ? 8 : 16;
  const length = read(4, countBits);
  const bytes = Array.from({ length }, (_, i) => read(4 + countBits + i * 8, 8));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), version, mask };
}

const PINNED = { android: "83d1137b92e18c06", expo: "5b2936d33cf5514c", long: "0016dbde156ea622" };

const hash = (m: QrMatrix) => createHash("sha256").update(m.dark.map((r) => r.map((d) => (d ? "1" : "0")).join("")).join("\n")).digest("hex").slice(0, 16);

describe("qrMatrix", () => {
  it("reads back at every size class, with one block and many", () => {
    const cases: Array<[number, number]> = [
      [1, 14],
      [2, 26],
      [3, 42],
      [4, 62],
      [5, 84],
      [6, 106],
      [7, 122],
      [8, 152],
      [9, 180],
      [10, 213],
      [14, 362],
      [40, 2331],
    ];
    for (const [version, length] of cases) {
      const text = "https://example.com/".concat("abcdefghij".repeat(240)).slice(0, length);
      const out = decode(qrMatrix(text));
      assert.equal(out.version, version, `${length} bytes fit version ${version}`);
      assert.equal(out.text, text);
    }
  });

  it("moves up a version one byte past what a version holds", () => {
    assert.equal(qrMatrix("x".repeat(14)).size, 21);
    assert.equal(qrMatrix("x".repeat(15)).size, 25);
    assert.equal(qrMatrix("x".repeat(213)).size, 57);
    assert.equal(qrMatrix("x".repeat(214)).size, 61);
  });

  it("holds an empty string and text in any language, counted in bytes", () => {
    assert.equal(decode(qrMatrix("")).text, "");
    const text = "https://example.com/café/咖啡?q=1";
    assert.equal(decode(qrMatrix(text)).text, text);
  });

  it("refuses what no QR code can hold", () => {
    assert.equal(QR_MAX_BYTES, 2331);
    assert.throws(() => qrMatrix("x".repeat(2332)), RangeError);
  });

  it("makes the same code each time, and these are the ones a real scanner read", () => {
    assert.equal(hash(qrMatrix("https://muse-muse.vercel.app/p/bird-count/get/android")), PINNED.android);
    assert.equal(hash(qrMatrix("exp://u.expo.dev/ee7dbfb2-d11f-4e19-9eb7-d5bc6212a5de/--/p/bird-count?channel-name=production")), PINNED.expo);
    assert.equal(hash(qrMatrix("y".repeat(900))), PINNED.long);
  });

  it("tries the masks and doesn't always land on one", () => {
    const masks = new Set(["a", "bb", "https://a.example", "https://b.example/x", "tel:+15551234567", "quiet", "loud noises"].map((t) => decode(qrMatrix(t)).mask));
    assert.ok(masks.size > 1);
  });
});

describe("qrPath and qrSvg", () => {
  it("draws exactly the dark modules, inside the margin", () => {
    const m = qrMatrix("https://example.com");
    const painted = new Set<string>();
    for (const [, x, y, w] of qrPath(m, 4).matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(w); i++) painted.add(`${Number(x) + i - 4},${Number(y) - 4}`);
    }
    const dark = m.dark.flatMap((row, y) => row.flatMap((d, x) => (d ? [`${x},${y}`] : [])));
    assert.deepEqual([...painted].sort(), dark.sort());
  });

  it("is black on white with a quiet zone, whatever the theme", () => {
    const svg = qrSvg("https://example.com", { label: "Open the app" });
    const side = qrMatrix("https://example.com").size + 8;
    assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`));
    assert.match(svg, /<rect [^>]*fill="#fff"/);
    assert.match(svg, /<path fill="#000"/);
    assert.match(svg, /role="img"/);
  });

  it("escapes its label, and the text never reaches the markup", () => {
    const svg = qrSvg('https://example.com/"><script>', { label: 'A "quoted" <label> & more' });
    assert.ok(svg.includes('aria-label="A &quot;quoted&quot; &lt;label&gt; &amp; more"'));
    assert.ok(!svg.includes("<script>"));
  });
});


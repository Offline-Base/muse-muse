/**
 * QR codes as SVG, for every "Get it" panel (docs/NATIVE.md). Written here because the `qrcode` package isn't a
 * dependency and new ones wait for a merge. Byte mode at error correction level M, every size up to version 40, following
 * ISO/IEC 18004. Pure, and it needs nothing in the browser.
 */

/** Error correction codewords per block, and blocks, by version, at level M. Index 0 is unused. */
const EC_PER_BLOCK = [
  0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
const BLOCKS = [
  0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

/** Level M's format bits. */
const LEVEL_M = 0;

export type QrMatrix = { size: number; dark: boolean[][] };

/** Codeword modules a version has, once the function patterns are taken out. */
function rawCodewords(version: number): number {
  let bits = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    bits -= (25 * align - 10) * align - 55;
    if (version >= 7) bits -= 36;
  }
  return Math.floor(bits / 8);
}

const dataCodewords = (version: number) => rawCodewords(version) - EC_PER_BLOCK[version]! * BLOCKS[version]!;

/** The most bytes a QR code can hold at this level. */
export const QR_MAX_BYTES = dataCodewords(40) - 3;

/** Multiplication in GF(256) with the QR polynomial. */
function gfMul(a: number, b: number): number {
  let out = 0;
  for (let i = 7; i >= 0; i--) {
    out = (out << 1) ^ ((out >>> 7) * 0x11d);
    out ^= ((b >>> i) & 1) * a;
  }
  return out;
}

function reedSolomon(data: number[], degree: number): number[] {
  const divisor = new Array<number>(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMul(divisor[j]!, root);
      if (j + 1 < degree) divisor[j] ^= divisor[j + 1]!;
    }
    root = gfMul(root, 2);
  }
  const out = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ out.shift()!;
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] ^= gfMul(divisor[i]!, factor);
  }
  return out;
}

/** The message bytes as data codewords: mode, count, bytes, terminator and padding. */
function dataStream(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, -bits.length & 7);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  for (let pad = 0xec; out.length < capacity / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Splits the data into blocks, adds each one's error correction, and interleaves them. */
function codewords(data: number[], version: number): number[] {
  const blocks = BLOCKS[version]!;
  const ec = EC_PER_BLOCK[version]!;
  const raw = rawCodewords(version);
  const shortLength = Math.floor(raw / blocks);
  const shortBlocks = blocks - (raw % blocks);
  const parts: Array<{ data: number[]; ec: number[] }> = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const length = shortLength - ec + (i < shortBlocks ? 0 : 1);
    const part = data.slice(at, at + length);
    at += length;
    parts.push({ data: part, ec: reedSolomon(part, ec) });
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLength - ec; i++) {
    for (const part of parts) if (i < part.data.length) out.push(part.data[i]!);
  }
  for (let i = 0; i < ec; i++) for (const part of parts) out.push(part.ec[i]!);
  return out;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** `value` followed by its BCH remainder for this generator, as the format and version bits are made. */
function bch(value: number, generatorBits: number, generator: number): number {
  let rem = value << generatorBits;
  for (let i = 31 - Math.clz32(rem); i >= generatorBits; i--) if ((rem >>> i) & 1) rem ^= generator << (i - generatorBits);
  return (value << generatorBits) | rem;
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The grid with its function patterns drawn, and which modules they hold. */
function functionPatterns(version: number): { size: number; dark: boolean[][]; fixed: boolean[][] } {
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, on: boolean) => {
    dark[y]![x] = on;
    fixed[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(version);
  align.forEach((cy, i) =>
    align.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  // The format and version bits' places, drawn for real once the mask is chosen.
  writeFormat(set, size, 0);
  if (version >= 7) {
    const bits = bch(version, 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }
  return { size, dark, fixed };
}

function writeFormat(set: (x: number, y: number, on: boolean) => void, size: number, mask: number): void {
  const bits = bch((LEVEL_M << 3) | mask, 10, 0x537) ^ 0x5412;
  const on = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, on(i));
  set(8, 7, on(6));
  set(8, 8, on(7));
  set(7, 8, on(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, on(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, on(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, on(i));
  set(8, size - 8, true);
}

/** Lays the codewords out in the standard zigzag, skipping function patterns. */
function placeData(dark: boolean[][], fixed: boolean[][], size: number, words: number[]): void {
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - step : step;
        if (fixed[y]![x]) continue;
        const word = words[bit >>> 3];
        if (word !== undefined) dark[y]![x] = ((word >>> (7 - (bit & 7))) & 1) === 1;
        bit++;
      }
    }
  }
}

function applyMask(dark: boolean[][], fixed: boolean[][], size: number, mask: number): void {
  const invert = MASKS[mask]!;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y]![x] && invert(x, y)) dark[y]![x] = !dark[y]![x];
}

/** The standard's penalty score: runs, blocks, finder-like stretches and the balance of dark modules. */
function penalty(dark: boolean[][], size: number): number {
  let score = 0;
  let count = 0;
  const line = (at: (i: number) => boolean) => {
    let run = 0;
    let prev = false;
    let window = 0;
    for (let i = 0; i < size; i++) {
      const on = at(i);
      if (i > 0 && on === prev) run++;
      else run = 1;
      if (run === 5) score += 3;
      else if (run > 5) score += 1;
      prev = on;
      window = ((window << 1) | (on ? 1 : 0)) & 0x7ff;
      if (i >= 10 && (window === 0b10111010000 || window === 0b00001011101)) score += 40;
    }
  };
  for (let i = 0; i < size; i++) {
    line((x) => dark[i]![x]!);
    line((y) => dark[y]![i]!);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dark[y]![x]) count++;
      if (x + 1 < size && y + 1 < size && dark[y]![x] === dark[y]![x + 1] && dark[y]![x] === dark[y + 1]![x] && dark[y]![x] === dark[y + 1]![x + 1]) score += 3;
    }
  }
  score += Math.floor(Math.abs(count * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

/** The QR code for a piece of text, in the smallest version it fits. Throws a RangeError when it can't fit in any. */
export function qrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= 40 && bytes.length > dataCodewords(version) - (version < 10 ? 2 : 3)) version++;
  if (version > 40) throw new RangeError(`That is too long for a QR code: ${bytes.length} bytes, over the ${QR_MAX_BYTES} one can hold.`);
  const words = codewords(dataStream(bytes, version), version);
  const { size, dark, fixed } = functionPatterns(version);
  placeData(dark, fixed, size, words);
  let best = -1;
  let bestScore = Infinity;
  for (let mask = 0; mask < MASKS.length; mask++) {
    applyMask(dark, fixed, size, mask);
    writeFormat((x, y, on) => (dark[y]![x] = on), size, mask);
    const score = penalty(dark, size);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(dark, fixed, size, mask);
  }
  applyMask(dark, fixed, size, best);
  writeFormat((x, y, on) => (dark[y]![x] = on), size, best);
  return { size, dark };
}

/** The dark modules as SVG path data, with `margin` modules of quiet zone around them. Rows are merged into runs. */
export function qrPath(matrix: QrMatrix, margin = 4): string {
  const parts: string[] = [];
  matrix.dark.forEach((row, y) => {
    for (let x = 0; x < matrix.size; x++) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < matrix.size && row[end + 1]) end++;
      parts.push(`M${x + margin} ${y + margin}h${end - x + 1}v1h-${end - x + 1}z`);
      x = end;
    }
  });
  return parts.join("");
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A QR code as one SVG element, black on white whatever the page's theme, because scanners need the contrast and the
 * quiet zone. `label` says what it opens, for screen readers.
 */
export function qrSvg(text: string, opts: { label: string; margin?: number }): string {
  const margin = opts.margin ?? 4;
  const matrix = qrMatrix(text);
  const side = matrix.size + margin * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" role="img" aria-label="${escapeXml(opts.label)}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path fill="#000" d="${qrPath(matrix, margin)}"/></svg>`;
}

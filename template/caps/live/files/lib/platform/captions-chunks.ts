// Platform file (Muse Muse platform services). Don't edit: use useCaptions from lib/platform/captions.ts.
//
// The parts of captions with no browser in them: cutting recorded audio into overlapping pieces with their times, and
// taking the words the overlap repeats back out.

export const CAPTION_CHUNK = {
  /** New audio in each piece. Between 2 and 3 seconds: shorter costs more calls, longer shows text later. */
  defaultMs: 2500,
  minMs: 2000,
  maxMs: 3000,
  /** Audio each piece repeats from the one before, so a word cut at the seam is whole in one of them. */
  overlapMs: 400,
  /** A last piece shorter than this isn't worth a call. */
  flushMinMs: 500,
  /** The most repeated words looked for. 400 ms holds one to three words, and a little slack costs nothing. */
  overlapWords: 6,
} as const;

export interface AudioPiece {
  samples: Float32Array;
  startMs: number;
  endMs: number;
}

export interface Caption {
  text: string;
  startMs: number;
  endMs: number;
}

/** Takes the microphone's samples as they come and gives back pieces of `chunkMs` new audio, each with `overlapMs` before it. */
export class ChunkCutter {
  private readonly chunk: number;
  private readonly overlap: number;
  private buffer = new Float32Array(0);
  /** Where in the whole recording the buffer starts and the next piece ends, in samples. */
  private bufferStart = 0;
  private nextEnd: number;

  constructor(
    private readonly sampleRate: number,
    opts: { chunkMs?: number; overlapMs?: number } = {},
  ) {
    const ms = Math.min(CAPTION_CHUNK.maxMs, Math.max(CAPTION_CHUNK.minMs, opts.chunkMs ?? CAPTION_CHUNK.defaultMs));
    this.chunk = Math.round((ms / 1000) * sampleRate);
    this.overlap = Math.round(((opts.overlapMs ?? CAPTION_CHUNK.overlapMs) / 1000) * sampleRate);
    this.nextEnd = this.chunk;
  }

  private toMs(sample: number): number {
    return Math.round((sample / this.sampleRate) * 1000);
  }

  private cut(end: number): AudioPiece {
    const start = Math.max(this.bufferStart, end - this.chunk - this.overlap);
    const piece = { samples: this.buffer.slice(start - this.bufferStart, end - this.bufferStart), startMs: this.toMs(start), endMs: this.toMs(end) };
    const keepFrom = Math.max(this.bufferStart, end - this.overlap);
    this.buffer = this.buffer.slice(keepFrom - this.bufferStart);
    this.bufferStart = keepFrom;
    return piece;
  }

  push(samples: Float32Array): AudioPiece[] {
    const joined = new Float32Array(this.buffer.length + samples.length);
    joined.set(this.buffer);
    joined.set(samples, this.buffer.length);
    this.buffer = joined;
    const pieces: AudioPiece[] = [];
    while (this.bufferStart + this.buffer.length >= this.nextEnd) {
      pieces.push(this.cut(this.nextEnd));
      this.nextEnd += this.chunk;
    }
    return pieces;
  }

  /** What's left when recording stops, or null when it's too short to send. The overlap alone doesn't count. */
  flush(): AudioPiece | null {
    const end = this.bufferStart + this.buffer.length;
    const fresh = end - (this.nextEnd - this.chunk);
    if (this.toMs(fresh) < CAPTION_CHUNK.flushMinMs) return null;
    this.nextEnd = end + this.chunk;
    return this.cut(end);
  }
}

/** True for a piece with nothing to hear, which isn't worth a call. */
export function isSilent(samples: Float32Array, threshold = 0.003): boolean {
  if (!samples.length) return true;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length) < threshold;
}

const plain = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/**
 * `next` without the words at its start that `previous` ends with. A piece that overlaps the one before can repeat its
 * last words, sometimes with other capitals or punctuation. The longest match wins, up to CAPTION_CHUNK.overlapWords.
 */
export function trimOverlap(previous: string, next: string): string {
  const before = previous.trim().split(/\s+/).filter(Boolean);
  const after = next.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(CAPTION_CHUNK.overlapWords, before.length, after.length); n > 0; n--) {
    const tail = before.slice(-n).map(plain);
    const head = after.slice(0, n).map(plain);
    if (tail.every((w, i) => w !== "" && w === head[i])) return after.slice(n).join(" ");
  }
  return after.join(" ");
}

/**
 * The captions with this piece's added, in order. Only a piece that really overlaps the last one (silence can leave a gap
 * between them) has its repeats removed. A piece with no new words adds nothing.
 */
export function addCaption(captions: readonly Caption[], piece: Caption): Caption[] {
  const last = captions.at(-1);
  const overlaps = last !== undefined && piece.startMs < last.endMs;
  const text = tidyEnd(overlaps ? trimOverlap(last.text, piece.text) : piece.text.trim());
  if (!text) return [...captions];
  // The model ends every piece with a full stop, even mid-sentence. A next piece that carries on in lower case takes it back.
  const earlier = overlaps && /^\p{Ll}/u.test(text) ? [...captions.slice(0, -1), { ...last, text: last.text.replace(/\.$/, "") }] : captions;
  return [...earlier, { text, startMs: piece.startMs, endMs: piece.endMs }];
}

/** The model can end a piece on "..": one full stop is enough. */
const tidyEnd = (text: string) => text.replace(/\.{2,}$/, ".");

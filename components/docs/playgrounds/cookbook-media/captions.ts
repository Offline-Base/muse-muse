/**
 * The layout half of the headlocked captions recipe (cookbook/headlocked-speech-bubble-captions), as pure functions:
 * diarized speech turns become short timed caption chunks, SAM's people become speakers' tracks, the head anchor comes
 * from the top of each person's pixel mask, and each bubble goes on a stable side of its speaker without covering
 * the speaker's face or anyone else, its tail pointing at the top of the silhouette. The demo draws what these return.
 */

export interface SpeechTurn {
  turnId: number;
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

type RawTurn = { turnId?: number | null; startMs?: number; endMs?: number; transcript?: string; speaker?: string };

/**
 * The turns worth captioning from a transcription reply (asr/transcribe in DIARIZATION mode, or the realtime turns):
 * turns with text, a speaker label and a time span. Empty turns, which file transcription can return between speakers,
 * are dropped. Text loses the zero-width space transcripts can end with.
 */
export function speechTurns(turns: readonly RawTurn[] | null | undefined): SpeechTurn[] {
  return (turns ?? [])
    .map((t, i) => ({
      turnId: typeof t.turnId === "number" ? t.turnId : i,
      speaker: (t.speaker ?? "").trim(),
      startMs: Math.max(0, t.startMs ?? 0),
      endMs: Math.max(0, t.endMs ?? 0),
      text: (t.transcript ?? "").replace(/​/g, "").trim(),
    }))
    .filter((t) => t.text && t.speaker && t.endMs > t.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** Speaker labels in order of first appearance ("A", "B"). */
export function speakersOf(turns: readonly SpeechTurn[]): string[] {
  return [...new Set(turns.map((t) => t.speaker))];
}

export interface CaptionChunk {
  speaker: string;
  turnId: number;
  /** Position of the chunk in its turn. */
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Splits each turn into chunks of at most `maxWords` words, timed by their share of the turn's characters, so a long
 * sentence reads as two or three short bubbles rather than one wall of text.
 */
export function captionChunks(turns: readonly SpeechTurn[], maxWords = 7): CaptionChunk[] {
  const out: CaptionChunk[] = [];
  for (const t of turns) {
    const words = t.text.split(/\s+/).filter(Boolean);
    const groups: string[][] = [];
    // Balanced chunks: as many as needed, then words spread evenly, so the last bubble isn't a lone word.
    const count = Math.max(1, Math.ceil(words.length / Math.max(1, maxWords)));
    const per = Math.ceil(words.length / count);
    for (let i = 0; i < words.length; i += per) groups.push(words.slice(i, i + per));
    const chars = groups.map((g) => g.join(" ").length);
    const totalChars = chars.reduce((a, b) => a + b, 0) || 1;
    let at = t.startMs;
    groups.forEach((g, i) => {
      const span = ((t.endMs - t.startMs) * chars[i]) / totalChars;
      const end = i === groups.length - 1 ? t.endMs : Math.round(at + span);
      out.push({ speaker: t.speaker, turnId: t.turnId, index: i, text: g.join(" "), startMs: Math.round(at), endMs: end });
      at = end;
    });
  }
  return out;
}

/** The chunk on screen at `ms`: the one whose span holds it, held for `holdMs` after it ends if nothing follows yet. */
export function chunkAt(chunks: readonly CaptionChunk[], ms: number, holdMs = 600): CaptionChunk | null {
  let best: CaptionChunk | null = null;
  for (const c of chunks) {
    if (ms >= c.startMs && ms < c.endMs) return c;
    if (ms >= c.endMs && ms < c.endMs + holdMs && (!best || c.endMs > best.endMs)) best = c;
  }
  if (best && chunks.some((c) => c.startMs > best!.endMs && c.startMs <= ms)) return null;
  return best;
}

// ---- People ---------------------------------------------------------------------------------------------------

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Person {
  id: string;
  box: Box;
  /** Box area in pixels. */
  area: number;
  /** Frames the track appears in (video), 1 for an image. */
  frames: number;
}

interface RecordLike {
  objectId: string;
  frame: number;
  box: Box & { w: number; h: number };
}

/**
 * Tracked people big enough to caption: the recipe's data builder drops tiny detections (its --min-area-ratio), here
 * a person's largest box against the frame. Largest first, so the default mapping picks the people in front.
 */
export function peopleOf(records: readonly RecordLike[], minAreaRatio = 0.004): Person[] {
  const byId = new Map<string, { box: Box; area: number; frames: Set<number>; frameArea: number }>();
  for (const r of records) {
    const area = (r.box.x2 - r.box.x1 + 1) * (r.box.y2 - r.box.y1 + 1);
    const cur = byId.get(r.objectId);
    if (!cur) byId.set(r.objectId, { box: r.box, area, frames: new Set([r.frame]), frameArea: r.box.w * r.box.h });
    else {
      cur.frames.add(r.frame);
      if (area > cur.area) {
        cur.area = area;
        cur.box = r.box;
      }
    }
  }
  return [...byId.entries()]
    .filter(([, v]) => v.area / Math.max(1, v.frameArea) >= minAreaRatio)
    .map(([id, v]) => ({ id, box: { x1: v.box.x1, y1: v.box.y1, x2: v.box.x2, y2: v.box.y2 }, area: v.area, frames: v.frames.size }))
    .sort((a, b) => b.area - a.area);
}

/** Speakers to people: the first speaker to the largest person, the next to the next, as a starting point the reader changes. */
export function defaultMapping(speakers: readonly string[], people: readonly Person[]): Record<string, string> {
  const out: Record<string, string> = {};
  speakers.forEach((s, i) => {
    if (people[i]) out[s] = people[i].id;
  });
  return out;
}

/**
 * The top of a person's silhouette, where a bubble's tail points: the first mask row with a few pixels set, and the
 * middle of the pixels in a thin band below it (a head, not a raised hand). The raster is the box's size, row-major.
 * Without a raster it's the top middle of the box.
 */
export function headAnchor(raster: Uint8Array | null, box: Box): { x: number; y: number } {
  const w = box.x2 - box.x1 + 1;
  const h = box.y2 - box.y1 + 1;
  if (!raster || raster.length !== w * h) return { x: Math.round((box.x1 + box.x2) / 2), y: box.y1 };
  const need = Math.max(2, Math.round(w * 0.04));
  let top = -1;
  for (let y = 0; y < h && top < 0; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += raster[y * w + x];
    if (n >= need) top = y;
  }
  if (top < 0) return { x: Math.round((box.x1 + box.x2) / 2), y: box.y1 };
  const band = Math.max(3, Math.round(h * 0.06));
  let sum = 0;
  let count = 0;
  for (let y = top; y < Math.min(h, top + band); y++) {
    for (let x = 0; x < w; x++) {
      if (raster[y * w + x]) {
        sum += x;
        count++;
      }
    }
  }
  return { x: box.x1 + Math.round(sum / count), y: box.y1 + top };
}

/** Anchors per frame smoothed over `radius` frames each side, so a bubble glides instead of jittering with the mask. */
export function smoothAnchors(anchors: ReadonlyMap<number, { x: number; y: number }>, radius = 3): Map<number, { x: number; y: number }> {
  const out = new Map<number, { x: number; y: number }>();
  for (const f of anchors.keys()) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let d = -radius; d <= radius; d++) {
      const a = anchors.get(f + d);
      if (!a) continue;
      sx += a.x;
      sy += a.y;
      n++;
    }
    out.set(f, { x: Math.round(sx / n), y: Math.round(sy / n) });
  }
  return out;
}

/** The anchor for `frame`: its own, else the nearest frame's within `reach`, else null (the person is out of view). */
export function anchorNear(anchors: ReadonlyMap<number, { x: number; y: number }>, frame: number, reach = 6): { x: number; y: number } | null {
  for (let d = 0; d <= reach; d++) {
    const a = anchors.get(frame - d) ?? anchors.get(frame + d);
    if (a) return a;
  }
  return null;
}

// ---- Bubbles --------------------------------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Wraps text into lines no wider than maxWidth, with `measure` giving a string's width (a canvas's measureText in the demo). */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export interface Placement {
  rect: Rect;
  side: "left" | "right";
  /** Tail triangle: two points on the bubble's edge, then the anchor. */
  tail: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  cost: number;
}

export interface PlaceInput {
  anchor: { x: number; y: number };
  size: { w: number; h: number };
  frame: { w: number; h: number };
  /** The speaker's face, which a bubble must never cover. */
  face: Rect;
  /** Everyone else's boxes, to keep clear of. */
  others: readonly Rect[];
  /** The side this speaker's last bubble used: switching sides costs a little, so bubbles stay put. */
  prefer?: "left" | "right";
  gap?: number;
  margin?: number;
}

/**
 * Picks where a bubble goes: above and to one side of the head, or beside it, kept inside the frame. Each spot costs
 * what it covers (the speaker's face most, other people next), a switch from the preferred side, and its distance from
 * the head; the cheapest wins.
 */
export function placeBubble(p: PlaceInput): Placement {
  const gap = p.gap ?? 14;
  const margin = p.margin ?? 6;
  const { w, h } = p.size;
  const { x: ax, y: ay } = p.anchor;
  const raw: Array<{ side: "left" | "right"; x: number; y: number }> = [
    { side: "right", x: ax + gap, y: ay - gap - h },
    { side: "left", x: ax - gap - w, y: ay - gap - h },
    { side: "right", x: p.face.x + p.face.w + gap, y: ay - h / 2 },
    { side: "left", x: p.face.x - gap - w, y: ay - h / 2 },
    { side: "right", x: ax + gap * 2, y: ay - gap * 3 - h },
    { side: "left", x: ax - gap * 2 - w, y: ay - gap * 3 - h },
  ];
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  let best: Placement | null = null;
  for (const c of raw) {
    const rect = { x: clamp(c.x, margin, p.frame.w - w - margin), y: clamp(c.y, margin, p.frame.h - h - margin), w, h };
    const moved = Math.hypot(rect.x - c.x, rect.y - c.y);
    const faceHit = overlap(rect, p.face);
    const othersHit = p.others.reduce((n, o) => n + overlap(rect, o), 0);
    const cx = rect.x + w / 2;
    const cy = rect.y + h / 2;
    const cost =
      faceHit * 40 +
      othersHit * 3 +
      (p.prefer && p.prefer !== c.side ? w * h * 0.15 : 0) +
      moved * 4 +
      Math.hypot(cx - ax, cy - ay) * 2;
    if (!best || cost < best.cost) best = { rect, side: c.side, tail: tailFor(rect, p.anchor), cost };
  }
  return best!;
}

/** A tail from the bubble edge nearest the anchor to the anchor. */
export function tailFor(rect: Rect, anchor: { x: number; y: number }): Placement["tail"] {
  const base = Math.min(18, rect.w / 4);
  const below = anchor.y >= rect.y + rect.h;
  const above = anchor.y <= rect.y;
  if (below || above) {
    const y = below ? rect.y + rect.h : rect.y;
    const x = Math.min(Math.max(anchor.x, rect.x + base + 8), rect.x + rect.w - base - 8);
    return [{ x: x - base / 2, y }, { x: x + base / 2, y }, anchor];
  }
  const x = anchor.x < rect.x ? rect.x : rect.x + rect.w;
  const y = Math.min(Math.max(anchor.y, rect.y + base), rect.y + rect.h - base);
  return [{ x, y: y - base / 2 }, { x, y: y + base / 2 }, anchor];
}

/** The speaker's face box from the head anchor and the person's box: half the box's width, a fifth of its height. */
export function faceRect(anchor: { x: number; y: number }, box: Box): Rect {
  const w = Math.max(12, (box.x2 - box.x1 + 1) * 0.5);
  const h = Math.max(12, (box.y2 - box.y1 + 1) * 0.2);
  return { x: anchor.x - w / 2, y: anchor.y, w, h };
}

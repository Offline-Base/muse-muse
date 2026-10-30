import type { SamRecord } from "@/lib/docs/media/sam";

/**
 * Helpers for the SAM 3.1 demos, written from Meta's pages: the wire line split into the spans
 * sam/reading-segmentation names (frame marker, object id, box, mask, the record separator), objects followed across
 * frames by id, which frames a tracking direction covers and what it bills (sam/segmenting, "Choose a tracking
 * direction"), mask area in source pixels, and the concept-prompt rules from "Write the concept prompt" as warnings.
 * Parsing records stays in lib/docs/media/sam.ts; this file adds what the pages teach on top.
 */

export type WireSpanKind = "frame" | "id" | "box" | "mask" | "point" | "neg" | "sep" | "text" | "other";

export interface WireSpan {
  kind: WireSpanKind;
  text: string;
  start: number;
  end: number;
  /** Which record on the line the span belongs to (ids, boxes, masks). */
  record?: number;
  /** Fields of a box or mask token, by name, as on the wire. */
  fields?: Record<string, string>;
}

/** Splits one output line into spans for highlighting. Never throws: what it can't read is "other". */
export function wireSpans(line: string): WireSpan[] {
  const spans: WireSpan[] = [];
  let at = 0;
  let record = -1;
  const push = (kind: WireSpanKind, end: number, extra: Partial<WireSpan> = {}) => {
    if (end <= at) return;
    spans.push({ kind, text: line.slice(at, end), start: at, end, ...extra });
    at = end;
  };
  const head = /^<\d+f>/.exec(line);
  if (!head) {
    push(line.startsWith("<") ? "other" : "text", line.length);
    return spans;
  }
  push("frame", head[0].length);
  while (at < line.length) {
    const rest = line.slice(at);
    if (rest.startsWith(",")) {
      push("sep", at + 1);
      continue;
    }
    // Prompt text: a - before a point token makes it a negative point.
    if (rest.startsWith("-<|")) {
      push("neg", at + 1, { record: Math.max(record, 0) });
      continue;
    }
    const id = /^\d+/.exec(rest);
    if (id) {
      record++;
      push("id", at + id[0].length, { record });
      continue;
    }
    if (rest.startsWith("<|")) {
      const close = line.indexOf("|>", at + 2);
      const end = close < 0 ? line.length : close + 2;
      const body = line.slice(at + 2, close < 0 ? line.length : close);
      const name = body.split(";")[0];
      const fields: Record<string, string> = {};
      for (const part of body.split(";").slice(1)) {
        const eq = part.indexOf("=");
        if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
      }
      push(name === "box" ? "box" : name === "mask" ? "mask" : name === "point" ? "point" : "other", end, { record: Math.max(record, 0), fields });
      continue;
    }
    const next = rest.search(/[,<]|\d/);
    push("other", next <= 0 ? line.length : at + next);
  }
  return spans;
}

/** "data=226,236,!payload": the raster size and encoding marker, with the payload's length instead of its text. */
export function maskDataSummary(data: string): { height: number; width: number; marker: string; payloadChars: number } | null {
  const m = /^(\d+),(\d+),([\s\S])([\s\S]*)$/.exec(data);
  if (!m) return null;
  return { height: Number(m[1]), width: Number(m[2]), marker: m[3], payloadChars: m[4].length };
}

/** A payload shown short: its first characters and how many follow. */
export function shortPayload(data: string, keep = 18): string {
  const s = maskDataSummary(data);
  if (!s) return data.length > keep + 8 ? `${data.slice(0, keep)}...` : data;
  const all = data.slice(String(s.height).length + String(s.width).length + 2);
  return all.length > keep + 8 ? `${s.height},${s.width},${all.slice(0, keep)}... (${s.payloadChars + 1} chars)` : data;
}

/**
 * A mask token with its data field shown short, for the raw wire view. Rebuilt by slicing, never with String.replace
 * and a string replacement: the base85 alphabet includes $, &, ' and `, which a replacement string reads as patterns
 * ($&, $', $`), so the text shown would no longer be what SAM sent.
 */
export function shortMaskToken(token: string, data: string): string {
  const field = `data=${data}`;
  const at = token.indexOf(field);
  return at < 0 ? token : `${token.slice(0, at)}data=${shortPayload(data)}${token.slice(at + field.length)}`;
}

export interface ObjectTrack {
  objectId: string;
  /** Frames the object appears on, ascending. */
  frames: number[];
  first: number;
  last: number;
  /** Frames inside first..last where it's missing (left the frame, occluded, or not found). */
  gaps: number;
  minConfidence?: number;
  maxConfidence?: number;
}

/** Each object id's frames, in first-seen order (sam/reading-segmentation, "Track objects across frames"). */
export function objectTracks(records: readonly SamRecord[]): ObjectTrack[] {
  const byId = new Map<string, { frames: Set<number>; conf: number[] }>();
  for (const r of records) {
    let t = byId.get(r.objectId);
    if (!t) byId.set(r.objectId, (t = { frames: new Set(), conf: [] }));
    t.frames.add(r.frame);
    if (r.box.confidence !== undefined) t.conf.push(r.box.confidence);
  }
  return [...byId].map(([objectId, t]) => {
    const frames = [...t.frames].sort((a, b) => a - b);
    const first = frames[0] ?? 0;
    const last = frames.at(-1) ?? 0;
    return {
      objectId,
      frames,
      first,
      last,
      gaps: last - first + 1 - frames.length,
      ...(t.conf.length ? { minConfidence: Math.min(...t.conf), maxConfidence: Math.max(...t.conf) } : {}),
    };
  });
}

export type FrameOrder = "single" | "ascending" | "descending" | "forward-then-backward" | "other";

/**
 * How the lines' frames arrived. Concept prompts come in ascending order; box and point prompts tracked backward
 * come down from the earliest prompt frame, and with the default `both` they come forward from it, then backward
 * from the frame before it.
 */
export function frameOrder(arrival: readonly number[]): FrameOrder {
  if (arrival.length <= 1) return "single";
  let i = 1;
  while (i < arrival.length && arrival[i] > arrival[i - 1]) i++;
  if (i === arrival.length) return "ascending";
  const turn = i;
  while (i < arrival.length && arrival[i] < arrival[i - 1]) i++;
  if (i === arrival.length && turn === 1) return "descending";
  if (i === arrival.length && arrival[turn] < arrival[0]) return "forward-then-backward";
  return "other";
}

export type Propagation = "both" | "forward" | "backward";

/**
 * Which frames a tracking direction covers, measured from the earliest prompt frame, for a clip of `total` frames:
 * both runs from it to the end and then back to frame 0, forward to the end, backward to frame 0. Video is billed
 * per frame with a 50-frame minimum per request.
 */
export function trackedFrames(direction: Propagation, earliest: number, total: number): { frames: number; billed: number; range: string } {
  const last = Math.max(0, total - 1);
  const e = Math.min(Math.max(0, Math.floor(earliest)), last);
  const frames = direction === "both" ? total : direction === "forward" ? total - e : e + 1;
  const range =
    direction === "both"
      ? e > 0
        ? `${e} to ${last}, then ${e - 1} to 0`
        : `0 to ${last}`
      : direction === "forward"
        ? `${e} to ${last}`
        : `${e} to 0`;
  return { frames, billed: Math.max(50, frames), range };
}

/** $0.20 per 1,000 frames with the 50-frame minimum; $2.50 per 1,000 images. */
export function samCostUsd(kind: "image" | "video", frames = 1): number {
  return kind === "image" ? 0.0025 : Math.max(50, frames) * 0.0002;
}

/** Pixels a mask covers in source pixels: the raster's set pixels, scaled when the raster isn't the box's size. */
export function maskAreaPx(record: SamRecord, setPixels: number): number {
  const boxW = record.box.x2 - record.box.x1 + 1;
  const boxH = record.box.y2 - record.box.y1 + 1;
  const scale = (boxW / record.mask.width) * (boxH / record.mask.height);
  return Math.round(setPixels * scale);
}

export interface ConceptWarning {
  rule: string;
  message: string;
  /** "zero" when the page says it returns nothing, "unreliable" when results vary. */
  effect: "zero" | "unreliable" | "info";
}

/**
 * The concept prompt rules (sam/segmenting, "Write the concept prompt") as warnings for what the reader typed. The API
 * decides; these say what the page predicts so a surprising result has an explanation.
 */
export function lintConcept(prompt: string): ConceptWarning[] {
  const p = prompt.trim();
  const out: ConceptWarning[] = [];
  if (!p) return out;
  if (p.startsWith("<")) {
    out.push({ rule: "One kind of prompt", message: "This looks like box and point prompt text. Use the Boxes and points or Raw input_text mode.", effect: "info" });
    return out;
  }
  if (/[,;+]/.test(p)) {
    out.push({ rule: "One concept per request", message: "Comma, semicolon and plus lists return zero matches. Send one request per concept.", effect: "zero" });
  } else if (/\band\b|\n/i.test(p)) {
    out.push({ rule: "One concept per request", message: '"and" or a new line segments only one of the concepts. Send one request each.', effect: "unreliable" });
  }
  if (/\?\s*$/.test(p) || /^(where|what|which|how|is|are|can|find|show|segment|detect|locate|highlight|select|mask|cut out|outline)\b/i.test(p)) {
    out.push({ rule: "Name the object; don't instruct the model", message: "Commands and questions are unreliable and often return nothing. Write just the noun phrase.", effect: "unreliable" });
  }
  if (/\b(not|without|except|no)\b/i.test(p)) {
    out.push({ rule: "Skip negation", message: "Negation returns inconsistent results. Segment the plain concept, then filter in your app.", effect: "unreliable" });
  }
  if (/\bor\b/i.test(p)) {
    out.push({ rule: "Skip boolean OR", message: '"or" returns inconsistent results. Send one request per concept.', effect: "unreliable" });
  }
  if (/\b(left|right|top|bottom|middle|center|behind|in front of|next to|above|below|near|closest|farthest)\b/i.test(p)) {
    out.push({ rule: "Skip spatial phrasing", message: "Position words are only partially honored. Segment the concept and filter by the returned boxes.", effect: "unreliable" });
  }
  const words = p.split(/\s+/).filter(Boolean).length;
  if (words > 5) {
    out.push({ rule: "Keep it short", message: `${words} words. A concise noun phrase works as well as a long description, and filler degrades matching.`, effect: "unreliable" });
  }
  return out;
}

/** The earliest frame any prompt object sits on, for the tracking estimate. */
export function earliestPromptFrame(objects: ReadonlyArray<{ frame?: number }>): number {
  return objects.reduce((m, o) => Math.min(m, o.frame ?? 0), Number.POSITIVE_INFINITY);
}

/** Frame markers in box and point prompt text, such as <30f> and <120f>. */
export function promptFrames(text: string): number[] {
  return [...text.matchAll(/<(\d+)f>/g)].map((m) => Number(m[1]));
}

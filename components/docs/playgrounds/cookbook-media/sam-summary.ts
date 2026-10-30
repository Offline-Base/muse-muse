import { decodeMaskToSVGPath } from "@meta-sam/parser";
import { recordsByFrame, type SamDiagnostic, type SamRecord } from "@/lib/docs/media/sam";
import { decodeMaskRaster, rasterArea } from "@/lib/docs/media/sam-mask";

/**
 * The SAM API basics recipe's output, built in the browser from the kit's parser (lib/docs/media/sam.ts): one
 * summary per concept with the outcome, typed record counts, boxes, decoded masks with their foreground pixels, and
 * each video track's visibility range (the recipe's summary.json), plus a browser-viewable SVG per mask (its
 * mask-*.svg). Validation follows the recipe: HTTP errors, refusals, failed and incomplete responses and malformed
 * records fail clearly; a completed request with zero masks is a valid empty match.
 */

export type SamOutcome = "completed" | "incomplete" | "failed" | "refused" | "stopped" | "http_error";

export interface ConceptSummary {
  concept: string;
  media: "image" | "video";
  outcome: SamOutcome;
  /** Typed records, as Meta's parsers count them: a box record and a mask record per object per frame. */
  records: number;
  boxes: Array<{ object_id: string; frame: number | null; left: number; top: number; right: number; bottom: number; confidence?: number }>;
  masks: Array<{ object_id: string; frame: number | null; encoding: string; width: number; height: number; foreground_pixels: number | null }>;
  tracks: Array<{ object_id: string; first_frame: number; last_frame: number; frames: number; ranges: Array<[number, number]> }>;
  diagnostics: Array<{ line: number; code: string; message: string }>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/**
 * The outcome of one request from what came back: the HTTP result, and the final response object (a stream's
 * response.completed or response.incomplete or response.failed, or the plain reply).
 */
export function samOutcome(r: { httpOk: boolean; aborted?: boolean; final: unknown; streamError?: string | null }): {
  outcome: SamOutcome;
  problem: string | null;
} {
  if (r.aborted) return { outcome: "stopped", problem: "Stopped before the reply finished." };
  if (!r.httpOk) return { outcome: "http_error", problem: "The request failed." };
  const final = obj(r.final);
  if (r.streamError) return { outcome: "failed", problem: r.streamError };
  if (!final) return { outcome: "incomplete", problem: "The stream ended without a final response." };
  const status = typeof final.status === "string" ? final.status : "";
  for (const item of Array.isArray(final.output) ? final.output : []) {
    for (const part of Array.isArray(obj(item)?.content) ? (obj(item)!.content as unknown[]) : []) {
      if (obj(part)?.type === "refusal") return { outcome: "refused", problem: `SAM refused: ${String(obj(part)?.refusal ?? "")}`.trim() };
    }
  }
  if (status === "failed") {
    const err = obj(final.error);
    return { outcome: "failed", problem: `The response failed${err?.message ? `: ${String(err.message).replace(/\.$/, "")}` : ""}.` };
  }
  if (status === "incomplete") {
    const why = obj(final.incomplete_details)?.reason;
    return { outcome: "incomplete", problem: `The response is incomplete${why ? ` (${String(why)})` : ""}, so the masks may be missing frames.` };
  }
  if (status && status !== "completed") return { outcome: "incomplete", problem: `The response ended as ${status}.` };
  return { outcome: "completed", problem: null };
}

/** The records' frame as the recipe writes it: null for an image, the index for video. */
const frameOf = (media: "image" | "video", r: SamRecord) => (media === "image" ? null : r.frame);

/** Consecutive runs of frame numbers: [0, 1, 2, 5, 6] gives [[0, 2], [5, 6]]. */
export function frameRanges(frames: readonly number[]): Array<[number, number]> {
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const f of sorted) {
    const last = out.at(-1);
    if (last && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out;
}

/** One concept's summary.json entry. Masks are decoded with Meta's codec when it's registered; else foreground_pixels is null. */
export function summarizeConcept(
  concept: string,
  media: "image" | "video",
  outcome: SamOutcome,
  records: readonly SamRecord[],
  diagnostics: readonly SamDiagnostic[] = [],
): ConceptSummary {
  // Later lines for a frame replace earlier ones, as the parsers' cumulative snapshots do.
  const latest = [...recordsByFrame(records).entries()].sort((a, b) => a[0] - b[0]).flatMap(([, rs]) => rs);
  const boxes = latest.map((r) => ({
    object_id: r.objectId,
    frame: frameOf(media, r),
    // The wire's x2 and y2 are inclusive; the summary's right and bottom are half-open, like the mask's bounds.
    left: r.box.x1,
    top: r.box.y1,
    right: r.box.x2 + 1,
    bottom: r.box.y2 + 1,
    ...(r.box.confidence !== undefined ? { confidence: r.box.confidence } : {}),
  }));
  const masks = latest.map((r) => {
    const raster = decodeMaskRaster(r.mask);
    return {
      object_id: r.objectId,
      frame: frameOf(media, r),
      encoding: r.mask.encoding,
      width: r.mask.width,
      height: r.mask.height,
      foreground_pixels: raster.ok ? rasterArea(raster.raster) : null,
    };
  });
  const byObject = new Map<string, number[]>();
  for (const r of latest) byObject.set(r.objectId, [...(byObject.get(r.objectId) ?? []), r.frame]);
  const tracks =
    media === "video"
      ? [...byObject.entries()].map(([id, frames]) => ({
          object_id: id,
          first_frame: Math.min(...frames),
          last_frame: Math.max(...frames),
          frames: new Set(frames).size,
          ranges: frameRanges(frames),
        }))
      : [];
  return {
    concept,
    media,
    outcome,
    records: latest.length * 2,
    boxes,
    masks,
    tracks,
    diagnostics: diagnostics.map((d) => ({ line: d.line, code: d.code, message: d.message })),
  };
}

/** Whether a summary is a usable result, in the recipe's terms. An empty completed match is fine. */
export function validateSummary(s: ConceptSummary): { ok: boolean; message: string } {
  if (s.outcome !== "completed") return { ok: false, message: `"${s.concept}": ${s.outcome.replace("_", " ")}.` };
  const malformed = s.diagnostics.filter((d) => d.code === "malformed_record");
  if (malformed.length) return { ok: false, message: `"${s.concept}": ${malformed.length} malformed record${malformed.length === 1 ? "" : "s"} (line ${malformed[0].line}: ${malformed[0].message})` };
  const undecoded = s.masks.filter((m) => m.foreground_pixels === null).length;
  if (undecoded) return { ok: false, message: `"${s.concept}": ${undecoded} mask${undecoded === 1 ? "" : "s"} didn't decode.` };
  const objects = new Set(s.masks.map((m) => m.object_id)).size;
  if (!s.masks.length) return { ok: true, message: `"${s.concept}": a valid empty match (no objects), not an error.` };
  return {
    ok: true,
    message:
      s.media === "video"
        ? `"${s.concept}": ${objects} object${objects === 1 ? "" : "s"} tracked across ${new Set(s.masks.map((m) => m.frame)).size} frames, ${s.masks.length} masks.`
        : `"${s.concept}": ${s.masks.length} mask${s.masks.length === 1 ? "" : "s"}.`,
  };
}

/**
 * The one-line result a SAM run records for the copy prompt ("What I just ran"): what came back, in a few words. The
 * kit would quote the start of the wire text instead, which is mostly mask payload and says little to a reader's agent.
 */
export function samRunOutcome(r: {
  ok: boolean;
  status: number;
  aborted?: boolean;
  error?: string | null;
  media: "image" | "video";
  records: readonly SamRecord[];
}): string {
  if (r.aborted) return "stopped before the reply finished";
  if (!r.ok) return `error${r.status ? ` ${r.status}` : ""}: ${r.error ?? "the request failed"}`.slice(0, 200);
  if (!r.records.length) return "completed with no matches, a valid empty result";
  const objects = new Set(r.records.map((x) => x.objectId)).size;
  const encoding = r.records[0].mask.encoding;
  if (r.media === "image") return `${objects} ${objects === 1 ? "match" : "matches"}, each a box and a ${encoding} mask`;
  const frames = new Set(r.records.map((x) => x.frame)).size;
  return `${objects} tracked object${objects === 1 ? "" : "s"} across ${frames} frames, ${r.records.length} ${encoding} masks`;
}

/** The progress line the recipe prints: "Wrote 1 result(s) and 5 mask(s)". */
export function wroteLine(summaries: readonly ConceptSummary[]): string {
  const masks = summaries.reduce((n, s) => n + s.masks.length, 0);
  return `Wrote ${summaries.length} result(s) and ${masks} mask(s)`;
}

/**
 * One mask as a standalone SVG the size of its frame, the path from Meta's parser (decodeMaskToSVGPath) moved onto
 * the record's box. Null when the mask doesn't decode.
 */
export function maskSvg(r: SamRecord, color = "#1d6cf2"): string | null {
  let path: string;
  try {
    path = decodeMaskToSVGPath({ encoding: r.mask.encoding, payload: r.mask.payload, width: r.mask.width, height: r.mask.height });
  } catch {
    return null;
  }
  const { w, h, x1, y1 } = r.box;
  // The path traces pixel centers in the raster's own coordinates; half a pixel puts its edges on pixel boundaries.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<path d="${path}" transform="translate(${x1 + 0.5} ${y1 + 0.5})" fill="${color}" fill-opacity="0.75" fill-rule="evenodd"/>` +
    `</svg>`
  );
}

/** "mask-0.svg" for an image, "mask-0-f12.svg" for frame 12 of a video. */
export function maskFileName(media: "image" | "video", r: SamRecord, concept?: string): string {
  const stem = concept ? `${concept.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-` : "";
  return `mask-${stem}${r.objectId}${media === "video" ? `-f${r.frame}` : ""}.svg`;
}

import { base64ImageMime } from "@/lib/docs/media/base64";

/**
 * Reading Muse Image replies (image-generation, Read the response and Response shape): on the Responses API each
 * image is an `image_generation_call` item with base64 in `result` and a signed `id`, next to an optional `reasoning`
 * summary; the images endpoints return `data: [{ b64_json }]` or `data: [{ url }]`.
 */

export interface ReplyImage {
  b64?: string;
  url?: string;
  mime?: string;
  id?: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** The images in a Responses reply, by item type rather than position. */
export function imagesOfResponse(reply: unknown): ReplyImage[] {
  const output = obj(reply)?.output;
  if (!Array.isArray(output)) return [];
  return output
    .map(obj)
    .filter((o): o is Json => !!o && o.type === "image_generation_call" && typeof o.result === "string" && o.result.length > 0)
    .map((o) => ({ b64: o.result as string, mime: base64ImageMime(o.result as string), id: typeof o.id === "string" ? o.id : undefined }));
}

/** The reasoning summary Muse Image writes on the Responses API, when there is one. */
export function reasoningOfResponse(reply: unknown): string {
  const output = obj(reply)?.output;
  if (!Array.isArray(output)) return "";
  return output
    .map(obj)
    .filter((o): o is Json => !!o && o.type === "reasoning")
    .flatMap((o) => (Array.isArray(o.summary) ? o.summary : []))
    .map((s) => obj(s)?.text)
    .filter((t): t is string => typeof t === "string")
    .join("\n\n");
}

/** The images in an images/generations or images/edits reply. */
export function imagesOfImagesReply(reply: unknown): ReplyImage[] {
  const r = obj(reply);
  const data = r?.data;
  if (!Array.isArray(data)) return [];
  const format = typeof r?.output_format === "string" ? `image/${r.output_format === "jpg" ? "jpeg" : r.output_format}` : undefined;
  return data
    .map(obj)
    .filter((d): d is Json => !!d && (typeof d.b64_json === "string" || typeof d.url === "string"))
    .map((d) =>
      typeof d.b64_json === "string" ? { b64: d.b64_json, mime: base64ImageMime(d.b64_json) } : { url: d.url as string, mime: format },
    );
}

/** The image a streamed images reply carried (`image_generation.completed` or `image_edit.completed`). */
export function imageOfStreamEvent(event: unknown): ReplyImage | null {
  const e = obj(event);
  if (!e || (e.type !== "image_generation.completed" && e.type !== "image_edit.completed")) return null;
  return typeof e.b64_json === "string" ? { b64: e.b64_json, mime: base64ImageMime(e.b64_json) } : null;
}

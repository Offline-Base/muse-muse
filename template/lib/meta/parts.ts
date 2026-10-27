import type { ResponseInputFile, ResponseInputImage } from "openai/resources/responses/responses";

/** A public https URL (Meta downloads it) or a base64 data URL, as a string or `{ url }`. */
export type MediaUrl = string | { url: string };

/**
 * Content parts for Meta's Responses API. If Meta can't download a URL you get HTTP 400 media_url_origin_error: retry
 * with the bytes (see fetchAsDataUrl in ./media). Images take a URL only; video and PDFs also take a file id.
 */
export function imagePart(source: MediaUrl): ResponseInputImage {
  return { type: "input_image", detail: "auto", image_url: typeof source === "string" ? source : source.url };
}

/** PDFs: inline as a data URL ("data:application/pdf;base64,...") with a filename, or a file id from meta.files.create. */
export function filePart(source: { dataUrl: string; filename: string } | { fileId: string }): ResponseInputFile {
  return "fileId" in source
    ? { type: "input_file", file_id: source.fileId }
    : { type: "input_file", file_data: source.dataUrl, filename: source.filename };
}

/**
 * The OpenAI SDK types don't include Meta's input_video part. `url` can be a public https URL (best for anything
 * over a few MB, from uploadMedia) or a data URL; `fileId` comes from meta.files.create. MP4 or MOV, H.264/H.265.
 * Pass it inside respondJson's input as is; with meta.responses.create directly, cast the input (`as never`).
 */
export type VideoPart = { type: "input_video"; video_url?: string; file_id?: string };

export function videoPart(source: MediaUrl | { fileId: string }): VideoPart {
  if (typeof source !== "string" && "fileId" in source) return { type: "input_video", file_id: source.fileId };
  return { type: "input_video", video_url: typeof source === "string" ? source : source.url };
}

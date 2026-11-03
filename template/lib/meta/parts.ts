import type { ResponseInputFile, ResponseInputImage } from "openai/resources/responses/responses";

/** A public https URL (Meta downloads it) or a base64 data URL, as a string or `{ url }`. */
export type MediaUrl = string | { url: string };

/** The image types Meta's models read. Anything else (SVG, HEIC, BMP, TIFF) is refused, so a call fails in a second. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/**
 * Throws when an image URL is one Meta refuses: a data URL of another type, or a link to an .svg file. Says what to send
 * instead. Returns the URL unchanged otherwise.
 */
export function checkImageUrl(url: string): string {
  const data = /^data:([^;,]*)[;,]/i.exec(url);
  const type = data ? (data[1] || "text/plain").toLowerCase().trim() : null;
  const allowed = (IMAGE_TYPES as readonly string[]).includes(type === "image/jpg" ? "image/jpeg" : (type ?? ""));
  const svgLink = !data && /^https?:\/\/[^?#]+\.svgz?(?:[?#]|$)/i.test(url);
  if ((data && !allowed) || svgLink) {
    throw new Error(
      `An image for the model is ${data ? `a ${type} data URL` : "a link to an SVG file"}. Meta's models read only PNG, JPEG, WebP or GIF, ` +
        'so the call would fail. Draw it to a <canvas> in the browser and send canvas.toDataURL("image/png") (or resizeImage for a photo).',
    );
  }
  return url;
}

/**
 * Content parts for Meta's Responses API. If Meta can't download a URL you get HTTP 400 media_url_origin_error: retry
 * with the bytes (see fetchAsDataUrl in ./media). Images take a URL only; video and PDFs also take a file id. An image
 * must be PNG, JPEG, WebP or GIF: any other data URL throws (checkImageUrl).
 */
export function imagePart(source: MediaUrl): ResponseInputImage {
  return { type: "input_image", detail: "auto", image_url: checkImageUrl(typeof source === "string" ? source : source.url) };
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

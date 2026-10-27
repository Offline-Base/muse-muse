import type { ResponseInputImage } from "openai/resources/responses/responses";

/**
 * Content parts for Meta's Responses API.
 *
 * imagePart: OpenAI's TypeScript types require `detail` on input_image, while Meta's examples leave it out.
 * Day-one spike 3 confirms Meta accepts it. If it doesn't, drop the field here and cast.
 */
export function imagePart(url: string): ResponseInputImage {
  return { type: "input_image", image_url: url, detail: "auto" };
}

/** The OpenAI SDK types don't include Meta's input_video part (video_url or file_id, per the SAM 3.1 docs). */
export type VideoPart = { type: "input_video"; video_url?: string; file_id?: string };

export function videoPart(source: { url: string } | { fileId: string }): VideoPart {
  return "url" in source
    ? { type: "input_video", video_url: source.url }
    : { type: "input_video", file_id: source.fileId };
}

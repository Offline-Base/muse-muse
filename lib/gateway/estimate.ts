import type { ParsedRequest } from "@/lib/gateway/extract";
import { DEFAULT_LIMITS } from "@/lib/gateway/policy";
import { PRICES, usageCost } from "@/lib/meta/pricing";
import type { GatewayEndpoint } from "@/lib/types";

/**
 * A conservative cost estimate for one gateway call, made before it is forwarded. The gateway checks it against the
 * budgets and records it as a usage row, which the metered cost replaces when the call finishes. It errs high for
 * normal calls but is not a ceiling: Meta can still bill more (a long video by URL, say).
 */

/** Output tokens assumed when a Responses call sets no max_output_tokens. */
export const DEFAULT_OUTPUT_TOKENS = 8_000;
/** The most output tokens an estimate assumes, whatever max_output_tokens says. */
export const MAX_OUTPUT_TOKENS = 32_000;
/** Input tokens assumed per media part, since base64 or URL length says little about tokens. */
export const MEDIA_PART_TOKENS: Record<string, number> = {
  input_image: 3_000,
  input_file: 20_000,
  input_video: 50_000,
  input_audio: 20_000,
};
/** SAM video frames assumed per input_video part. */
const SAM_VIDEO_FRAMES = 300;
/** 16 kHz mono 16-bit WAV, the densest audio Voice Transcribe takes, so bytes / this is the longest it can be. */
const WAV_BYTES_PER_SECOND = 32_000;
const CHARS_PER_TOKEN = 4;

interface Shape {
  /** Text characters, not counting data URLs. */
  chars: number;
  /** Media parts by type (input_image, input_video, ...). */
  media: Record<string, number>;
}

/** Walks a JSON body, counting text characters and media parts. */
function shapeOf(value: unknown, shape: Shape = { chars: 0, media: {} }, depth = 0): Shape {
  if (depth > 64) return shape;
  if (typeof value === "string") {
    if (!value.startsWith("data:")) shape.chars += value.length;
  } else if (Array.isArray(value)) {
    for (const v of value) shapeOf(v, shape, depth + 1);
  } else if (value && typeof value === "object") {
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string" && type in MEDIA_PART_TOKENS) shape.media[type] = (shape.media[type] ?? 0) + 1;
    for (const v of Object.values(value)) shapeOf(v, shape, depth + 1);
  }
  return shape;
}

function countOf(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

function responsesEstimate(model: string, json: Record<string, unknown>): number {
  const shape = shapeOf(json.input);
  shapeOf(json.instructions, shape);
  const mediaCount = (type: string) => shape.media[type] ?? 0;
  if (model === "sam-3.1") {
    return usageCost({
      model,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      images: Math.max(1, mediaCount("input_image")),
      videoFrames: mediaCount("input_video") * SAM_VIDEO_FRAMES,
    });
  }
  if (model === "muse-image-1.0") return PRICES["muse-image-1.0"].perImage;
  const mediaTokens = Object.entries(shape.media).reduce((n, [type, count]) => n + count * MEDIA_PART_TOKENS[type], 0);
  const inputTokens = Math.ceil(shape.chars / CHARS_PER_TOKEN) + mediaTokens;
  const outputTokens = countOf(json.max_output_tokens, DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
  return usageCost({ model, inputTokens, cachedInputTokens: 0, outputTokens });
}

/** The estimated cost in USD of forwarding this request. Zero for the files endpoint, which Meta doesn't bill. */
export function estimateCost(endpoint: GatewayEndpoint, parsed: ParsedRequest, bodyBytes: number): number {
  const model = parsed.model;
  if (endpoint === "files" || !model) return 0;
  const field = (name: string): unknown =>
    parsed.kind === "json" ? parsed.json[name] : parsed.kind === "multipart" ? parsed.form.get(name) : undefined;
  switch (endpoint) {
    case "responses":
      return parsed.kind === "json" ? responsesEstimate(model, parsed.json) : 0;
    case "images/generations":
    case "images/edits":
      return countOf(field("n"), 1, 10) * PRICES["muse-image-1.0"].perImage;
    case "asr/transcribe": {
      // The JSON extension downloads up to asrAudioMaxBytes; a multipart body holds the audio itself.
      const bytes = parsed.kind === "json" ? DEFAULT_LIMITS.asrAudioMaxBytes : bodyBytes;
      return usageCost({ model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds: bytes / WAV_BYTES_PER_SECOND });
    }
  }
}

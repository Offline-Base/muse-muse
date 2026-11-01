import type { ParsedRequest } from "@/lib/gateway/extract";
import { BUILTIN_TOOL_CALL_CAPS, DEFAULT_LIMITS } from "@/lib/gateway/policy";
import { PREVIOUS_RESPONSE_TOKENS, SEARCH_CONTEXT_TOKENS, searchesAllowed } from "@/lib/gateway/search";
import { PRICES, usageCost, WEB_SEARCH_USD_PER_QUERY } from "@/lib/meta/pricing";
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

/** Media parts in each protocol, mapped to the Responses part whose token guess they share. */
const MEDIA_TYPES: Record<string, keyof typeof MEDIA_PART_TOKENS> = {
  input_image: "input_image",
  input_file: "input_file",
  input_video: "input_video",
  input_audio: "input_audio",
  // Chat Completions content parts.
  image_url: "input_image",
  file: "input_file",
  video_url: "input_video",
  // Messages content blocks.
  image: "input_image",
  document: "input_file",
  video: "input_video",
};

interface TokenShape {
  chars: number;
  mediaTokens: number;
}

/** File types by extension, for base64 file_data that comes with only a filename. */
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};

/** Bytes a base64 string decodes to. */
function base64Bytes(chars: number): number {
  return Math.floor(chars * 0.75);
}

/**
 * Input tokens for inline media of a type. Images, video and audio get the gateway's guesses per part, whatever their
 * size. A PDF is read page by page: about a page per 50 KB at about a thousand tokens a page, and at least the
 * gateway's guess. Text, JSON and anything unknown is read as text.
 */
export function inlineTokens(mime: string, bytes: number): number {
  const type = mime.toLowerCase();
  if (type.startsWith("image/")) return MEDIA_PART_TOKENS.input_image;
  if (type.startsWith("video/")) return MEDIA_PART_TOKENS.input_video;
  if (type.startsWith("audio/")) return MEDIA_PART_TOKENS.input_audio;
  if (type === "application/pdf") return Math.max(MEDIA_PART_TOKENS.input_file, Math.ceil(bytes / 50));
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

function dataUrlTokens(url: string): number {
  const comma = url.indexOf(",");
  if (comma < 0) return Math.ceil(url.length / CHARS_PER_TOKEN);
  const header = url.slice("data:".length, comma);
  const payload = url.length - comma - 1;
  const bytes = header.includes(";base64") ? base64Bytes(payload) : payload;
  return inlineTokens(header.split(";")[0] || "text/plain", bytes);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Walks a body, adding text characters and media tokens to `shape`. Returns true when the value held inline media, so
 * a media part that carries its bytes isn't also counted by its type. Parts that point at media (a URL, a file id) get
 * the gateway's guess for their type.
 */
function walk(value: unknown, shape: TokenShape, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      shape.mediaTokens += dataUrlTokens(value);
      return true;
    }
    shape.chars += value.length;
    return false;
  }
  if (Array.isArray(value)) {
    let inline = false;
    for (const v of value) inline = walk(v, shape, depth + 1) || inline;
    return inline;
  }
  if (!isObject(value)) return false;
  let inline = false;
  const skip = new Set<string>();
  // Base64 without a data: prefix, in each protocol's shape: Messages sources, Responses file_data, Chat input_audio.
  if (value.type === "base64" && typeof value.data === "string") {
    shape.mediaTokens += inlineTokens(String(value.media_type ?? ""), base64Bytes(value.data.length));
    skip.add("data");
    inline = true;
  }
  if (typeof value.file_data === "string" && !value.file_data.startsWith("data:")) {
    const extension = String(value.filename ?? "").split(".").pop()?.toLowerCase() ?? "";
    shape.mediaTokens += inlineTokens(MIME_BY_EXTENSION[extension] ?? "", base64Bytes(value.file_data.length));
    skip.add("file_data");
    inline = true;
  }
  if (isObject(value.input_audio) && typeof value.input_audio.data === "string") {
    shape.mediaTokens += MEDIA_PART_TOKENS.input_audio;
    skip.add("input_audio");
    inline = true;
  }
  for (const [k, v] of Object.entries(value)) if (!skip.has(k)) inline = walk(v, shape, depth + 1) || inline;
  const type = value.type;
  if (typeof type === "string" && type in MEDIA_TYPES && !inline) {
    shape.mediaTokens += MEDIA_PART_TOKENS[MEDIA_TYPES[type]];
  }
  return inline;
}

/** Input tokens for these parts of a body. */
export function inputTokensOf(...parts: unknown[]): number {
  const shape: TokenShape = { chars: 0, mediaTokens: 0 };
  for (const part of parts) walk(part, shape);
  return Math.ceil(shape.chars / CHARS_PER_TOKEN) + shape.mediaTokens;
}

function countOf(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

/**
 * Text models count everything the model reads: input, instructions, tools, a text.format schema and the stored turns
 * a previous_response_id brings along, never below the guess per media part. Then the output, and for each search the
 * web search allows, its fee and the results it adds to the input.
 */
function responsesEstimate(model: string, json: Record<string, unknown>, mostSearches: number): number {
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
  const perPart = Math.ceil(shape.chars / CHARS_PER_TOKEN) + mediaTokens;
  const chained = typeof json.previous_response_id === "string" && json.previous_response_id ? PREVIOUS_RESPONSE_TOKENS : 0;
  const counted = inputTokensOf(json.input, json.instructions, json.tools, json.text) + chained;
  const searches = searchesAllowed(json, mostSearches);
  const inputTokens = Math.max(perPart, counted) + searches * SEARCH_CONTEXT_TOKENS;
  const outputTokens = countOf(json.max_output_tokens, DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
  return usageCost({ model, inputTokens, cachedInputTokens: 0, outputTokens }) + searches * WEB_SEARCH_USD_PER_QUERY;
}

/**
 * The estimated cost in USD of forwarding this request. Zero for the files endpoint, which Meta doesn't bill.
 * `mostSearches` is the most web searches to assume when max_tool_calls doesn't say fewer: the gateway passes the
 * token's cap, and the docs proxy passes 0 because it adds search costs itself.
 */
export function estimateCost(
  endpoint: GatewayEndpoint,
  parsed: ParsedRequest,
  bodyBytes: number,
  mostSearches: number = BUILTIN_TOOL_CALL_CAPS.agent,
): number {
  const model = parsed.model;
  if (endpoint === "files" || !model) return 0;
  const field = (name: string): unknown =>
    parsed.kind === "json" ? parsed.json[name] : parsed.kind === "multipart" ? parsed.form.get(name) : undefined;
  switch (endpoint) {
    case "responses":
      return parsed.kind === "json" ? responsesEstimate(model, parsed.json, mostSearches) : 0;
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

// ---------- Wave 3, unit 2: fit max_output_tokens to the budget left (docs/CAPABILITIES.md, section 8) ----------

/** The fewest output tokens a fitted call keeps. A budget that can't pay for this many refuses the call, as today. */
export const MIN_FIT_OUTPUT_TOKENS = 1_024;

export interface OutputFit {
  /** The max_output_tokens the call is sent with, set or lowered. */
  maxOutputTokens: number;
  /** The call's estimate at that max_output_tokens, at most the budget left. */
  estimate: number;
}

/**
 * A Responses call whose estimate is more than the budget left, refitted: max_output_tokens set to the most output the
 * budget can still pay for after the input, searches included, at most MAX_OUTPUT_TOKENS. Then the estimate is a true
 * ceiling for the call's output, so the budget still holds, and a session that sends max_output_tokens 128000 (Muse Code
 * does) runs until its budget is really spent instead of stopping after about a quarter of it. Null when the call already
 * fits, isn't a token-priced Responses call, or the budget can't pay for MIN_FIT_OUTPUT_TOKENS. A call that isn't fitted
 * keeps what it asked for, which the estimate caps at MAX_OUTPUT_TOKENS: outputCeiling below makes that true for it too.
 */
export function fitOutputToBudget(input: {
  endpoint: GatewayEndpoint;
  parsed: ParsedRequest;
  bodyBytes: number;
  mostSearches: number;
  estimate: number;
  leftUsd: number;
}): OutputFit | null {
  const { endpoint, parsed } = input;
  if (endpoint !== "responses" || parsed.kind !== "json" || !parsed.model) return null;
  if (input.estimate <= input.leftUsd || input.leftUsd <= 0) return null;
  const at = (n: number) => estimateCost(endpoint, { ...parsed, json: { ...parsed.json, max_output_tokens: n } }, input.bodyBytes, input.mostSearches);
  const perToken = (at(1_001) - at(1)) / 1_000;
  if (!(perToken > 0)) return null;
  const base = at(1) - perToken;
  const fitted = Math.min(MAX_OUTPUT_TOKENS, Math.floor((input.leftUsd - base) / perToken));
  if (fitted < MIN_FIT_OUTPUT_TOKENS) return null;
  return { maxOutputTokens: fitted, estimate: at(fitted) };
}

/**
 * The max_output_tokens a call must be sent with for its estimate to be a true ceiling on its output: what it asked for,
 * at most MAX_OUTPUT_TOKENS, or what the estimate assumed when it asked for nothing. Used for every Muse Code session
 * call, since code in its sandbox controls the prompt and can force a long reply.
 */
export function outputCeiling(asked: unknown): number {
  return countOf(asked, DEFAULT_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
}

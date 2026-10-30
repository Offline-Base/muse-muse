import type { DocsEndpoint } from "@/lib/docs/proxy/endpoints";
import {
  DOCS_CONTEXT_TOKENS,
  DOCS_MAX_TOOL_CALLS,
  OUTPUT_TOKEN_CLAMPS,
  WEB_SEARCH_USD_PER_QUERY,
} from "@/lib/docs/proxy/policy";
import { isBuiltInTool } from "@/lib/docs/proxy/rewrite";
import { DEFAULT_OUTPUT_TOKENS, estimateCost, MAX_OUTPUT_TOKENS, MEDIA_PART_TOKENS } from "@/lib/gateway/estimate";
import type { ParsedRequest } from "@/lib/gateway/extract";
import { usageCost } from "@/lib/meta/pricing";

/**
 * A docs call's cost estimate, made before it is forwarded: what the budgets are checked against and what is reserved
 * until the metered cost replaces it. Images, transcription and the image and SAM models use the gateway's estimate.
 * Text calls are counted here, never below the gateway's figure: every message, the system prompt and the tools, inline
 * media sized by type (a PDF or a text file by its length, since that is what the model reads), web search, and the
 * stored turns a previous_response_id pulls in. Errs high: the estimate is what keeps one call inside a visitor's
 * dollars, since output is capped but input is only capped by the 4.5 MB body.
 */

const CHARS_PER_TOKEN = 4;
/** Input tokens assumed for the stored conversation a previous_response_id brings along. */
export const PREVIOUS_RESPONSE_TOKENS = 10_000;
/**
 * Searches assumed when web_search is on and max_tool_calls doesn't say fewer. The proxy sets max_tool_calls to this
 * whenever a built-in tool is on (lib/docs/proxy/rewrite.ts), so it is the most a call can run.
 */
export const SEARCHES_ASSUMED = DOCS_MAX_TOOL_CALLS;
/** Input tokens each search's results add. */
export const SEARCH_CONTEXT_TOKENS = 8_000;

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

interface Shape {
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
function walk(value: unknown, shape: Shape, depth = 0): boolean {
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
function inputTokensOf(...parts: unknown[]): number {
  const shape: Shape = { chars: 0, mediaTokens: 0 };
  for (const part of parts) walk(part, shape);
  return Math.ceil(shape.chars / CHARS_PER_TOKEN) + shape.mediaTokens;
}

function outputTokensOf(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  const valid = typeof n === "number" && Number.isFinite(n) && n >= 1;
  return valid ? Math.min(Math.floor(n), MAX_OUTPUT_TOKENS) : DEFAULT_OUTPUT_TOKENS;
}

function tokensCost(model: string, inputTokens: number, outputTokens = 0): number {
  return usageCost({ model, inputTokens, cachedInputTokens: 0, outputTokens });
}

/** Searches a request may run: none without a web_search tool, else max_tool_calls (when lower) or SEARCHES_ASSUMED. */
export function searchesAllowed(json: Record<string, unknown>): number {
  const tools = Array.isArray(json.tools) ? json.tools : [];
  const searching = tools.some((t) => {
    const type = (t as { type?: unknown } | null)?.type;
    return typeof type === "string" && type.startsWith("web_search");
  });
  if (!searching) return 0;
  const cap = Number(json.max_tool_calls);
  return Number.isFinite(cap) && cap >= 1 ? Math.min(Math.floor(cap), SEARCHES_ASSUMED) : SEARCHES_ASSUMED;
}

function searchCost(model: string, json: Record<string, unknown>): number {
  const searches = searchesAllowed(json);
  return searches ? searches * WEB_SEARCH_USD_PER_QUERY + tokensCost(model, searches * SEARCH_CONTEXT_TOKENS) : 0;
}

/** Built-in tool calls a Responses call may make: none without a built-in tool, else max_tool_calls up to the cap. */
function toolCallsAllowed(json: Record<string, unknown>): number {
  if (!Array.isArray(json.tools) || !json.tools.some(isBuiltInTool)) return 0;
  const cap = Number(json.max_tool_calls);
  return Number.isFinite(cap) && cap >= 1 ? Math.min(Math.floor(cap), DOCS_MAX_TOOL_CALLS) : DOCS_MAX_TOOL_CALLS;
}

/**
 * The most a background Responses call on a text model can cost: what it holds until Meta reports its usage
 * (lib/docs/proxy/background.ts), since nothing reads its bill when it starts. Input is the whole context window on
 * every pass (one, plus one per built-in tool call, as each call's results go back to the model), whatever the body
 * holds: files, URLs and a previous_response_id all bring input the body doesn't show. Then the output cap and every
 * search's fee. Zero for models that aren't priced by the token.
 */
export function backgroundWorstCase(model: string, json: Record<string, unknown>): number {
  if (!(tokensCost(model, 1_000_000) > 0)) return 0;
  const passes = 1 + toolCallsAllowed(json);
  // The request's own limit when it set a lower one (Meta enforces it), else the docs' cap for the model.
  const cap = OUTPUT_TOKEN_CLAMPS[model] ?? MAX_OUTPUT_TOKENS;
  const asked = Number(json.max_output_tokens);
  const output = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.ceil(asked), cap) : cap;
  return tokensCost(model, passes * DOCS_CONTEXT_TOKENS, output) + searchesAllowed(json) * WEB_SEARCH_USD_PER_QUERY;
}

/** Chat Completions and Messages: the text and media of every message, the system prompt and the tools, plus output. */
function chatOrMessagesEstimate(model: string, json: Record<string, unknown>, outputTokens: unknown): number {
  const inputTokens = inputTokensOf(json.messages, json.system, json.tools);
  return tokensCost(model, inputTokens, outputTokensOf(outputTokens)) + searchCost(model, json);
}

/**
 * Responses: the gateway's estimate for image and SAM models, which aren't token priced. Text models are counted here
 * (input, instructions, tools and a text.format schema), never below the gateway's figure, plus a chained conversation
 * and web search.
 */
function responsesEstimate(model: string, parsed: Extract<ParsedRequest, { kind: "json" }>, bodyBytes: number): number {
  const gateway = estimateCost("responses", parsed, bodyBytes);
  const json = parsed.json;
  const tokenPriced = tokensCost(model, 1_000_000) > 0;
  if (!tokenPriced) return gateway;
  // A background call's usage isn't in its reply, so it holds the most it can cost until it is settled.
  if (json.background === true) return backgroundWorstCase(model, json);
  const chained = typeof json.previous_response_id === "string" && json.previous_response_id;
  const chainedTokens = chained ? PREVIOUS_RESPONSE_TOKENS : 0;
  const inputTokens = inputTokensOf(json.input, json.instructions, json.tools, json.text) + chainedTokens;
  const counted = tokensCost(model, inputTokens, outputTokensOf(json.max_output_tokens));
  return Math.max(gateway, counted) + searchCost(model, json);
}

/**
 * The estimated cost in USD of a docs call. Zero for the free endpoints: listings, retrievals, deletes, cancels,
 * uploads and the token counters (token-counting: they "do not record generation usage"). `audioMs` is the length of
 * a transcription's WAV when the proxy could read its header.
 */
export function estimateDocsCost(
  endpoint: DocsEndpoint,
  parsed: ParsedRequest,
  bodyBytes: number,
  audioMs?: number | null,
): number {
  const model = parsed.model;
  if (!endpoint.meter || !model) return 0;
  switch (endpoint.meter) {
    case "responses":
      return parsed.kind === "json" ? responsesEstimate(model, parsed, bodyBytes) : 0;
    case "chat":
      // The deprecated max_tokens still counts when the request set it instead.
      return parsed.kind === "json"
        ? chatOrMessagesEstimate(model, parsed.json, parsed.json.max_completion_tokens ?? parsed.json.max_tokens)
        : 0;
    case "messages":
      return parsed.kind === "json" ? chatOrMessagesEstimate(model, parsed.json, parsed.json.max_tokens) : 0;
    case "images":
      return estimateCost(endpoint.gateway ?? "images/generations", parsed, bodyBytes);
    case "asr":
      if (audioMs && audioMs > 0) {
        const audioSeconds = audioMs / 1000;
        return usageCost({ model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds });
      }
      return estimateCost("asr/transcribe", parsed, bodyBytes);
  }
}

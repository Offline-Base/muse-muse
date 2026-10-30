import { PRICES, usageCost } from "@/lib/meta/pricing";
import { runsAs } from "@/lib/docs/client/models";

/**
 * Token counts and an estimated cost for a demo call, from whichever usage shape came back:
 *
 * - Responses: input_tokens (cached included), input_tokens_details.cached_tokens, output_tokens,
 *   output_tokens_details.reasoning_tokens; SAM adds images_processed or video_frames_processed.
 * - Chat Completions: prompt_tokens, prompt_tokens_details.cached_tokens, completion_tokens,
 *   completion_tokens_details.reasoning_tokens.
 * - Messages: input_tokens without the cache (Anthropic's convention: cache reads and writes are counted apart),
 *   cache_read_input_tokens, cache_creation_input_tokens, output_tokens, output_tokens_details.thinking_tokens.
 *
 * Prices come from lib/meta/pricing, like everywhere else on the platform, so every figure is an estimate.
 */

export interface TokenUsage {
  /** All input tokens, cached ones included. */
  input: number;
  cached: number;
  /** All output tokens, reasoning included. */
  output: number;
  reasoning: number;
  total: number;
}

export interface CostEstimate {
  usd: number;
  /** False when the model has no price on record, so `usd` covers only what is priced (web searches). */
  priced: boolean;
  tokens: TokenUsage | null;
  images?: number;
  videoFrames?: number;
  audioSeconds?: number;
  webSearches?: number;
}

export interface CostExtras {
  /** Images returned (Muse Image bills per image, whatever its usage says). */
  images?: number;
  /** web_search calls the model made: billed per query on top of tokens. */
  webSearches?: number;
  /** Audio transcribed, in milliseconds. */
  audioMs?: number;
}

/** $2.50 per 1,000 search queries (pricing-rate-limits, "Token pricing notes"). Not in lib/meta/pricing yet. */
export const WEB_SEARCH_USD = 2.5 / 1000;

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Tokens from any of the three usage shapes, or null when `usage` isn't one. */
export function tokenUsage(usage: unknown): TokenUsage | null {
  const u = obj(usage);
  if (!u) return null;
  if ("prompt_tokens" in u || "completion_tokens" in u) {
    const input = n(u.prompt_tokens);
    const output = n(u.completion_tokens);
    return {
      input,
      cached: Math.min(n(obj(u.prompt_tokens_details)?.cached_tokens), input),
      output,
      reasoning: n(obj(u.completion_tokens_details)?.reasoning_tokens),
      total: n(u.total_tokens) || input + output,
    };
  }
  if (!("input_tokens" in u) && !("output_tokens" in u)) return null;
  const details = obj(u.output_tokens_details);
  const anthropic = "cache_read_input_tokens" in u || "cache_creation_input_tokens" in u || (details && "thinking_tokens" in details);
  if (anthropic) {
    const cached = n(u.cache_read_input_tokens);
    const input = n(u.input_tokens) + cached + n(u.cache_creation_input_tokens);
    const output = n(u.output_tokens);
    return { input, cached, output, reasoning: n(details?.thinking_tokens), total: input + output };
  }
  const input = n(u.input_tokens);
  const output = n(u.output_tokens);
  return {
    input,
    cached: Math.min(n(obj(u.input_tokens_details)?.cached_tokens), input),
    output,
    reasoning: n(details?.reasoning_tokens),
    total: n(u.total_tokens) || input + output,
  };
}

function hasPrice(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRICES, model);
}

/**
 * The price list to use for a model id. muse-spark-1.3 runs as its Contributor variant. A model's own entry wins;
 * without one, Spark 1.2 Contributor takes the Contributor rates and Spark 1.1 the Standard rates of their siblings,
 * which is what the pricing-rate-limits page lists for them.
 */
function priceModel(model: string): string {
  const id = runsAs(model);
  if (hasPrice(id)) return id;
  if (id === "muse-spark-1.2-contributor") return "muse-spark-1.3-contributor";
  if (id === "muse-spark-1.1") return "muse-spark-1.2";
  return id;
}

/** An estimate for one call: tokens for text models, images for Muse Image, images and frames for SAM, audio time for transcription. */
export function estimateCost(model: string | null | undefined, usage: unknown, extras: CostExtras = {}): CostEstimate | null {
  const tokens = tokenUsage(usage);
  const u = obj(usage);
  const id = model ? priceModel(model) : "";
  const webSearches = extras.webSearches ?? 0;
  const searchUsd = webSearches * WEB_SEARCH_USD;
  const searchPart = webSearches ? { webSearches } : {};

  if (id === "muse-image-1.0") {
    const images = extras.images ?? 0;
    return { usd: usageCost({ model: id, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images }), priced: true, tokens, images };
  }
  if (id === "sam-3.1") {
    const images = n(u?.images_processed);
    const videoFrames = n(u?.video_frames_processed);
    if (!images && !videoFrames && !tokens) return null;
    return {
      usd: usageCost({ model: id, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, images, videoFrames }),
      priced: true,
      tokens,
      ...(images ? { images } : {}),
      ...(videoFrames ? { videoFrames } : {}),
    };
  }
  if (id === "muse-voice-transcribe-1.0") {
    // Billed in whole seconds, rounded down (pricing-rate-limits, "Muse Voice Transcribe").
    const audioSeconds = Math.floor(n(extras.audioMs) / 1000);
    return {
      usd: usageCost({ model: id, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds }),
      priced: true,
      tokens: null,
      audioSeconds,
    };
  }
  if (!tokens) return webSearches ? { usd: searchUsd, priced: false, tokens: null, ...searchPart } : null;
  if (!id || !hasPrice(id)) return { usd: searchUsd, priced: false, tokens, ...searchPart };
  const usd = usageCost({ model: id, inputTokens: tokens.input, cachedInputTokens: tokens.cached, outputTokens: tokens.output });
  return { usd: usd + searchUsd, priced: true, tokens, ...searchPart };
}

/**
 * An estimate from a whole reply, finding what it bills by: usage for text and SAM, the images in an images reply or
 * a Responses image_generation_call, a transcript's audioDurationMs, web_search_call items.
 */
export function estimateReplyCost(model: string | null | undefined, reply: unknown): CostEstimate | null {
  const r = obj(reply);
  if (!r) return null;
  return estimateCost(model ?? (typeof r.model === "string" ? r.model : null), r.usage, costExtrasOf(r));
}

/** What a whole reply bills by besides its usage: images returned, web searches run, audio transcribed. */
export function costExtrasOf(reply: unknown): CostExtras {
  const r = obj(reply);
  if (!r) return {};
  const output = Array.isArray(r.output) ? (r.output as unknown[]).map(obj) : [];
  const images =
    (Array.isArray(r.data) ? (r.data as unknown[]).filter((d) => obj(d)?.b64_json || obj(d)?.url).length : 0) +
    output.filter((o) => o?.type === "image_generation_call" && o.result).length;
  const webSearches = output.filter((o) => o?.type === "web_search_call").length;
  const extras: CostExtras = {};
  if (images) extras.images = images;
  if (webSearches) extras.webSearches = webSearches;
  if (typeof r.audioDurationMs === "number") extras.audioMs = r.audioDurationMs;
  return extras;
}

/** "$0.0004", "$0.012", "$1.25"; tiny amounts stay readable instead of rounding to $0.00. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 0.0001) return "under $0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4).replace(/0+$/, "")}`;
  if (usd < 1) {
    const s = usd.toFixed(3);
    return `$${s.endsWith("0") ? s.slice(0, -1) : s}`;
  }
  return `$${usd.toFixed(2)}`;
}

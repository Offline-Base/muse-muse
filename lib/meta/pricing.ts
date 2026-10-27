import type { ModelUsage } from "@/lib/types";

/**
 * Prices in USD. Token prices are per million tokens. From catalog/meta-models.json, which marks several as reported
 * rather than confirmed, so every cost Muse Muse shows is an estimate and is labeled that way.
 */
export const PRICES = {
  "muse-spark-1.3": { input: 1.25, cachedInput: 0.15, output: 4.25 },
  "muse-spark-1.3-contributor": { input: 0.1, cachedInput: 0.1, output: 0.2 },
  "muse-spark-1.2": { input: 1.25, cachedInput: 0.15, output: 4.25 },
  "muse-wonder-1.0": { input: 4, cachedInput: 0.2, output: 20 },
  "muse-image-1.0": { perImage: 0.01 },
  /** SAM 3.1 rates aren't in the catalog. These placeholders keep budgets meaningful until the pricing page is checked. */
  "sam-3.1": { perImage: 0.002, perVideoFrame: 0.0002, minVideoFrames: 50 },
  "muse-voice-transcribe-1.0": { perAudioHour: 0.18 },
} as const;

type TokenCounts = { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };

/** Cost of a token-billed call. `inputTokens` includes cached tokens, as in the API's usage object. */
export function tokenCost(model: string, counts: TokenCounts): number {
  const price = (PRICES as Record<string, { input?: number; cachedInput?: number; output?: number }>)[model];
  if (!price?.input || !price.output) return 0;
  const input = counts.inputTokens ?? 0;
  const cached = Math.min(counts.cachedInputTokens ?? 0, input);
  const output = counts.outputTokens ?? 0;
  return ((input - cached) * price.input + cached * (price.cachedInput ?? price.input) + output * price.output) / 1e6;
}

/** Cost of any call, given what it consumed. */
export function usageCost(u: Omit<ModelUsage, "costUsd">): number {
  switch (u.model) {
    case "muse-image-1.0":
      return (u.images ?? 0) * PRICES["muse-image-1.0"].perImage;
    case "sam-3.1": {
      const p = PRICES["sam-3.1"];
      const frames = u.videoFrames ?? 0;
      return (u.images ?? 0) * p.perImage + (frames > 0 ? Math.max(frames, p.minVideoFrames) * p.perVideoFrame : 0);
    }
    case "muse-voice-transcribe-1.0":
      return ((u.audioSeconds ?? 0) / 3600) * PRICES["muse-voice-transcribe-1.0"].perAudioHour;
    default:
      return tokenCost(u.model, u);
  }
}

/** Builds a ModelUsage from an OpenAI-style Responses usage object. */
export function fromResponsesUsage(
  model: string,
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number } | null;
        images_processed?: number;
      }
    | null
    | undefined,
): ModelUsage {
  const u = {
    model,
    inputTokens: usage?.input_tokens ?? 0,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    images: usage?.images_processed ?? 0,
  };
  return { ...u, costUsd: usageCost(u) };
}

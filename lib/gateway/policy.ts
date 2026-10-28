import type { GatewayEndpoint, MetaModelId } from "@/lib/types";

export const UPSTREAM_BASE_URL = "https://api.meta.ai/v1";

/** Which models each mirrored endpoint accepts. The files endpoint takes no model. */
export const ENDPOINT_MODELS: Record<GatewayEndpoint, readonly MetaModelId[]> = {
  responses: ["muse-spark-1.3", "muse-wonder-1.0", "muse-image-1.0", "sam-3.1"],
  "images/generations": ["muse-image-1.0"],
  "images/edits": ["muse-image-1.0"],
  files: [],
  "asr/transcribe": ["muse-voice-transcribe-1.0"],
};

export const GATEWAY_ENDPOINTS = Object.keys(ENDPOINT_MODELS) as GatewayEndpoint[];

/** Starting limits. Tune during the build week. */
export const DEFAULT_LIMITS = {
  /**
   * What one build's tests may spend on Meta through its build token: every verify run, every fix round and the demo
   * recording share it. The gateway reserves each call's estimate up front, from its max_output_tokens.
   */
  buildTokenBudgetUsd: 3,
  /** The same for a product that may call Muse Wonder, whose output costs about five times Spark's. */
  buildTokenBudgetWonderUsd: 10,
  liveTokenDailyBudgetUsd: 3,
  perTokenRequestsPerMinute: 120,
  /** Applies when the product forwards its end user's IP in x-musemuse-client-ip. */
  perIpRequestsPerMinute: 20,
  /** Meta calls one token may have running at once, so parallel calls can't overshoot the budget before metering. */
  perTokenInFlight: 4,
  /** In-flight slots are counted per bucket of this length, so a slot a crashed request never gave back expires. */
  inFlightBucketMs: 10 * 60_000,
  uploadMaxBytes: 100 * 1024 * 1024,
  uploadTtlHours: 24,
  /** Upload tickets per product token, and per end user when the product forwards x-musemuse-client-ip. */
  uploadTicketsPerToken: 30,
  uploadTicketsPerIp: 10,
  uploadTicketWindowMs: 10 * 60_000,
  /** How long a signed upload ticket stays usable. */
  uploadTicketValidMs: 5 * 60_000,
  /** Vercel Functions reject request bodies over 4.5 MB. Bigger files go through {GATEWAY_URL}/uploads. */
  requestBodyMaxBytes: 4.5 * 1024 * 1024,
  /** Cap for the asr/transcribe JSON extension's audioUrl download. */
  asrAudioMaxBytes: 60 * 1024 * 1024,
  upstreamTimeoutMs: 290_000,
  /** How long an MCP tool call waits for the product's /api/actions/<name>. */
  mcpActionTimeoutMs: 120_000,
} as const;

/** The build token's budget for a product allowed these models. */
export function buildTokenBudgetFor(models: readonly string[]): number {
  return models.includes("muse-wonder-1.0") ? DEFAULT_LIMITS.buildTokenBudgetWonderUsd : DEFAULT_LIMITS.buildTokenBudgetUsd;
}

/** Header a product sets to its end user's IP so the gateway can rate limit per person. Never used for auth. */
export const CLIENT_IP_HEADER = "x-musemuse-client-ip";

/** Hosts the asr/transcribe JSON extension may download audio from (public Vercel Blob). */
export const AUDIO_URL_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/**
 * Request checks, in order. Implemented by handleGateway in lib/gateway/handler.ts.
 *   1. Allowed endpoint.
 *   2. Bearer product token, looked up by hash. The product must not be disabled or failed.
 *   3. Model in the token's allowlist and the endpoint's.
 *   4. Per-token and per-IP rate limits, then an in-flight slot (at most perTokenInFlight calls per token).
 *   5. Token daily budget and platform daily cap, counting this call's estimated cost and the estimates of calls still
 *      running. The estimate is recorded as a usage row before forwarding.
 *   6. Forward to UPSTREAM_BASE_URL with MODEL_API_KEY and stream the response through.
 *   7. Replace the estimate with the metered usage, then give the slot back.
 */
export const GATEWAY_CHECKS = ["endpoint", "token", "allowlist", "rate_limit", "in_flight", "budget", "forward", "meter"] as const;

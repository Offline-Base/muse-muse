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
  buildTokenBudgetUsd: 1,
  liveTokenDailyBudgetUsd: 3,
  perTokenRequestsPerMinute: 120,
  /** Applies when the product forwards its end user's IP in x-musemuse-client-ip. */
  perIpRequestsPerMinute: 20,
  uploadMaxBytes: 200 * 1024 * 1024,
  uploadTtlHours: 24,
  /** Vercel Functions reject request bodies over 4.5 MB. Bigger files go through {GATEWAY_URL}/uploads. */
  requestBodyMaxBytes: 4.5 * 1024 * 1024,
  /** Cap for the asr/transcribe JSON extension's audioUrl download. */
  asrAudioMaxBytes: 60 * 1024 * 1024,
  upstreamTimeoutMs: 290_000,
  /** How long an MCP tool call waits for the product's /api/actions/<name>. */
  mcpActionTimeoutMs: 120_000,
} as const;

/** Header a product sets to its end user's IP so the gateway can rate limit per person. */
export const CLIENT_IP_HEADER = "x-musemuse-client-ip";

/** Hosts the asr/transcribe JSON extension may download audio from (public Vercel Blob). */
export const AUDIO_URL_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/**
 * Request checks, in order. Implemented by handleGateway in lib/gateway/handler.ts.
 *   1. Allowed endpoint.
 *   2. Bearer product token, looked up by hash. The product must not be disabled or failed.
 *   3. Model in the token's allowlist and the endpoint's.
 *   4. Token daily budget, platform daily cap, per-token and per-IP rate limits.
 *   5. Forward to UPSTREAM_BASE_URL with MODEL_API_KEY and stream the response through.
 *   6. Record usage from the response.
 */
export const GATEWAY_CHECKS = ["endpoint", "token", "allowlist", "budget", "rate_limit", "forward", "meter"] as const;

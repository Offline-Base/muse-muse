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

/** Starting limits. Tune during the build week. */
export const DEFAULT_LIMITS = {
  buildTokenBudgetUsd: 1,
  liveTokenDailyBudgetUsd: 3,
  perIpRequestsPerMinute: 20,
  uploadMaxBytes: 200 * 1024 * 1024,
  uploadTtlHours: 24,
} as const;

/**
 * Request checks, in order. TODO(kickoff, day 2): implement in app/api/gateway/v1/[...path]/route.ts.
 *   1. Bearer product token, looked up by hash.
 *   2. Endpoint and model in the product's allowlist.
 *   3. Daily budget and per-IP rate limit.
 *   4. Forward to UPSTREAM_BASE_URL with MODEL_API_KEY and stream the response through.
 *   5. Record usage from the response.
 */
export const GATEWAY_CHECKS = ["token", "allowlist", "budget", "forward", "meter"] as const;

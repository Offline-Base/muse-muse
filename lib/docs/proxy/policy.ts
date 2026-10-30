import { DEFAULT_LIMITS } from "@/lib/gateway/policy";

/**
 * What the live docs demos may run on Muse Muse's key (docs/DOCS_MIRROR.md, "Proxy" and "Defaults"): the models each
 * endpoint takes, the output-token ceilings, and the limits' defaults. Pure data with no server imports, so the docs
 * kit can show the same numbers the proxy enforces.
 */

export const UPSTREAM_REALTIME_URL = "wss://api.meta.ai/v1/asr/realtime";

/**
 * Text models the docs offer: the Contributor tier first (the demos' default), then Standard mode for readers who
 * don't want Meta training on what they send. muse-spark-1.3 is accepted too and runs as muse-spark-1.3-contributor.
 */
export const DOCS_TEXT_MODELS = [
  "muse-spark-1.3-contributor",
  "muse-spark-1.2",
  "muse-spark-1.2-contributor",
  "muse-spark-1.1",
  "muse-wonder-1.0",
] as const;

/** Which models each kind of endpoint accepts. */
export const DOCS_MODELS = {
  /** chat/completions, messages, messages/count_tokens, responses/input_tokens, and Ask. */
  text: DOCS_TEXT_MODELS,
  /** responses: the text models, Muse Image and SAM 3.1. */
  responses: [...DOCS_TEXT_MODELS, "muse-image-1.0", "sam-3.1"],
  /** images/generations and images/edits. */
  images: ["muse-image-1.0"],
  /** asr/transcribe and the realtime relay. */
  voice: ["muse-voice-transcribe-1.0"],
} as const satisfies Record<string, readonly string[]>;

export type DocsModelGroup = keyof typeof DOCS_MODELS;

/**
 * The most output tokens a text call may ask for, and what the proxy sets when a request leaves the limit out:
 * Muse Wonder 4,096, Spark in Standard mode 8,192, Spark in Contributor mode 16,384. These keep one run's cost small.
 */
export const OUTPUT_TOKEN_CLAMPS: Readonly<Record<string, number>> = {
  "muse-wonder-1.0": 4_096,
  "muse-spark-1.2": 8_192,
  "muse-spark-1.1": 8_192,
  "muse-spark-1.3-contributor": 16_384,
  "muse-spark-1.2-contributor": 16_384,
};

/** Images per images/generations or images/edits call. Meta allows 10; each costs $0.01. */
export const DOCS_IMAGES_MAX_N = 2;

/** Meta bills web search at $2.50 per 1,000 queries on top of tokens (pricing-rate-limits, "Token pricing notes"). */
export const WEB_SEARCH_USD_PER_QUERY = 0.0025;

/**
 * Built-in tool calls (web searches) one Responses call may make. Meta enforces no maximum of its own (tool-calling,
 * "max_tool_calls limits built-in tools only"), so the proxy sets max_tool_calls to this when web_search is on, which
 * makes the estimate's search count a ceiling rather than a guess.
 */
export const DOCS_MAX_TOOL_CALLS = 5;

/** Every text model's context window (models page): the most input one call can bill, whatever its body says. */
export const DOCS_CONTEXT_TOKENS = 1_048_576;

/**
 * Live docs runs a minute across every reader, per model. Meta's rate limits are per team, not per key, and Contributor
 * and Muse Image get 150 requests a minute each (pricing-rate-limits, "Rate limits"), shared with the live products the
 * gateway serves on Spark 1.3 Contributor. The docs keep to a third of that, so readers can't use up the team's limit.
 */
export const DOCS_MODEL_REQUESTS_PER_MINUTE: Readonly<Record<string, number>> = {
  "muse-spark-1.3-contributor": 50,
  "muse-spark-1.2-contributor": 50,
  "muse-image-1.0": 50,
  // Meta allows 3,000 a minute for these, and 256 concurrent transcription streams.
  "muse-wonder-1.0": 300,
  "muse-spark-1.2": 300,
  "muse-spark-1.1": 300,
  "sam-3.1": 300,
  "muse-voice-transcribe-1.0": 60,
};

/** Uploads every docs reader together may make an hour, so docs files stay a small part of the team's 100 GiB. */
export const DOCS_UPLOADS_PER_HOUR = 1_000;

/**
 * How long a docs upload lives at Meta: the proxy sets expires_after on every upload (file-handling, "File
 * expiration"), so a file is gone after an hour even when the hourly cleanup can't reach it. 3,600 s is Meta's minimum.
 */
export const DOCS_FILE_EXPIRES_SECONDS = 3_600;

/** Defaults for the per-visitor limits; each has an env override in lib/env.ts so a local test server can raise it. */
export const DOCS_DEFAULTS = {
  perIpRequestsPerMinute: 20,
  perIpRequestsPerDay: 400,
  perIpInFlight: 4,
  perIpDailyUsd: 2,
  docsDailySpendCapUsd: 25,
} as const;

/** Vercel Functions take at most 4.5 MB per request body; the demos keep uploads under 3 MB. */
export const DOCS_MAX_BODY_BYTES = DEFAULT_LIMITS.requestBodyMaxBytes;

/** Realtime transcription takes at most this much audio per run. */
export const REALTIME_MAX_AUDIO_MS = 60_000;

/** The visitor cookie: a random id naming whose files and responses are whose. */
export const DOCS_VISITOR_COOKIE = "mm_docs";
export const DOCS_VISITOR_COOKIE_DAYS = 30;

/** The model the proxy actually called (muse-spark-1.3 runs as muse-spark-1.3-contributor). */
export const DOCS_MODEL_HEADER = "x-docs-model";
/** What the proxy changed in the request, in a sentence or two. */
export const DOCS_NOTE_HEADER = "x-docs-note";

/** GET /api/docs/limits: what the UI shows about limits. No secrets. */
export interface DocsLimits {
  /** False while DOCS_LIVE=off pauses every live call. */
  live: boolean;
  models: { [K in DocsModelGroup]: string[] };
  maxBodyBytes: number;
  perIpDailyUsd: number;
  /** What this visitor's IP spent today (UTC), or null when it couldn't be read. */
  ipSpentUsd: number | null;
  docsDailyCapUsd: number;
  /** What every docs visitor together spent today (UTC), or null when it couldn't be read. */
  docsSpentUsd: number | null;
  perIpRequestsPerMinute: number;
  perIpRequestsPerDay: number;
  perIpInFlight: number;
  /** When the daily limits reset: the next 00:00 UTC, as ISO 8601. */
  resetsAt: string;
}

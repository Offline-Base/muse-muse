/**
 * Facts from the mirrored "start" pages, written down once so the demos, their tests and the copy prompts agree:
 * the model cards (content/meta-docs/pages/models.md), the prices and rate limits
 * (content/meta-docs/pages/pricing-rate-limits.md). Each value is the page's own; a test checks the prices against
 * lib/meta/pricing so a resync that changes one shows up. Pure data, safe in the browser and in tests.
 */

export type ModelLine = "Muse Wonder" | "Muse Spark" | "Muse Image" | "Muse Voice Transcribe" | "SAM 3.1";
export type PricingMode = "standard" | "contributor";

export interface ModelCard {
  id: string;
  line: ModelLine;
  /** "Muse Spark 1.3 Contributor" */
  label: string;
  mode: PricingMode;
  input: string;
  output: string;
  /** Model API endpoints the model is reached on, as the models page lists them. */
  endpoints: string[];
  /** Tokens, for the text models. */
  contextWindow?: number;
  /** Reasoning effort levels, as the models page says them. */
  effort?: string;
  /** The page's price line for this model and mode. */
  price: string;
  /** Anchor on the pricing page. */
  priceAnchor: string;
  /** What the models page says about this one in particular. */
  notes: string[];
}

const TEXT_IO = { input: "Text, image, video, audio, and PDF", output: "Text" };
const TEXT_ENDPOINTS = ["POST /v1/responses", "POST /v1/chat/completions", "POST /v1/messages"];
const CONTEXT = 1_048_576;
const SPARK_STANDARD_PRICE = "$1.25 input, $0.15 cached input, $4.25 output per 1M tokens";
const SPARK_CONTRIBUTOR_PRICE = "$0.10 input, $0.002 cached input, $0.20 output per 1M tokens";
const CONTRIBUTOR_NOTE = "Contributor mode: Meta may use what you send to train future Meta models, for a lower price.";

/** Every model GET /v1/models returns today, with its card from the models and pricing pages. */
export const MODEL_CARDS: readonly ModelCard[] = [
  {
    id: "muse-wonder-1.0",
    line: "Muse Wonder",
    label: "Muse Wonder 1.0",
    mode: "standard",
    ...TEXT_IO,
    endpoints: TEXT_ENDPOINTS,
    contextWindow: CONTEXT,
    effort: '"minimal" to "max"',
    price: "$4.00 input, $0.20 cached input, $20.00 output per 1M tokens",
    priceAnchor: "muse-wonder-pricing",
    notes: [
      "Meta's most capable model, for long-horizon agentic work and complex software engineering. In preview.",
      "Standard mode only on Model API: Contributor mode isn't available for Muse Wonder on pay-as-you-go.",
      'Muse Wonder Full is only in Muse Code with a subscription; "max" effort here doesn\'t select it.',
      "Not available in South Korea.",
    ],
  },
  {
    id: "muse-spark-1.3",
    line: "Muse Spark",
    label: "Muse Spark 1.3",
    mode: "standard",
    ...TEXT_IO,
    endpoints: TEXT_ENDPOINTS,
    contextWindow: CONTEXT,
    effort: 'All levels, including "max"',
    price: SPARK_STANDARD_PRICE,
    priceAnchor: "muse-spark-pricing",
    notes: [
      "The latest version, tuned for agentic workflows. Recommended for new work.",
      "Audio input isn't fully supported: use Muse Spark 1.2, or Muse Voice Transcribe for speech to text.",
      "The live docs run it as muse-spark-1.3-contributor.",
    ],
  },
  {
    id: "muse-spark-1.3-contributor",
    line: "Muse Spark",
    label: "Muse Spark 1.3 Contributor",
    mode: "contributor",
    ...TEXT_IO,
    endpoints: TEXT_ENDPOINTS,
    contextWindow: CONTEXT,
    effort: 'Every level except "max"',
    price: SPARK_CONTRIBUTOR_PRICE,
    priceAnchor: "muse-spark-pricing",
    notes: [CONTRIBUTOR_NOTE, "The live demos' default model."],
  },
  {
    id: "muse-spark-1.2",
    line: "Muse Spark",
    label: "Muse Spark 1.2",
    mode: "standard",
    ...TEXT_IO,
    endpoints: TEXT_ENDPOINTS,
    contextWindow: CONTEXT,
    price: SPARK_STANDARD_PRICE,
    priceAnchor: "muse-spark-pricing",
    notes: ["The previous version. The one to use for audio input."],
  },
  {
    id: "muse-spark-1.2-contributor",
    line: "Muse Spark",
    label: "Muse Spark 1.2 Contributor",
    mode: "contributor",
    ...TEXT_IO,
    endpoints: TEXT_ENDPOINTS,
    contextWindow: CONTEXT,
    price: SPARK_CONTRIBUTOR_PRICE,
    priceAnchor: "muse-spark-pricing",
    notes: [CONTRIBUTOR_NOTE],
  },
  {
    id: "muse-spark-1.1",
    line: "Muse Spark",
    label: "Muse Spark 1.1",
    mode: "standard",
    ...TEXT_IO,
    endpoints: TEXT_ENDPOINTS,
    contextWindow: CONTEXT,
    price: SPARK_STANDARD_PRICE,
    priceAnchor: "muse-spark-pricing",
    notes: ["The original version. Standard mode only, and not in Muse Code."],
  },
  {
    id: "muse-image-1.0",
    line: "Muse Image",
    label: "Muse Image 1.0",
    mode: "standard",
    input: "Text and image",
    output: "Image",
    endpoints: ["POST /v1/responses", "POST /v1/images/generations", "POST /v1/images/edits"],
    price: "$0.01 per generated image",
    priceAnchor: "image-generation",
    notes: ["One model generates and edits. It can search the web for references and run code before it renders."],
  },
  {
    id: "muse-voice-transcribe-1.0",
    line: "Muse Voice Transcribe",
    label: "Muse Voice Transcribe 1.0",
    mode: "standard",
    input: "Audio",
    output: "Text transcript",
    endpoints: ["POST /v1/asr/transcribe", "wss://api.meta.ai/v1/asr/realtime"],
    price: "$0.18 per hour of audio processed",
    priceAnchor: "muse-voice-transcribe-pricing",
    notes: ["Speech to text only: turn-level timestamps, no word-level timestamps, no speech synthesis."],
  },
  {
    id: "sam-3.1",
    line: "SAM 3.1",
    label: "SAM 3.1",
    mode: "standard",
    input: "Text prompt, image, and video",
    output: "Boxes and masks",
    endpoints: ["POST /v1/responses", "POST /v1/files"],
    price: "$2.50 per 1,000 images, $0.20 per 1,000 video frames",
    priceAnchor: "sam-pricing",
    notes: ["Open-weight, served on Model API. Each video request is billed for at least 50 frames."],
  },
];

export function modelCard(id: string): ModelCard | null {
  return MODEL_CARDS.find((m) => m.id === id) ?? null;
}

/** Per 1M tokens, from the pricing page's tables. Null where the page says "Not available". */
export interface TokenRates {
  input: number;
  cachedInput: number;
  output: number;
}

export const WONDER_RATES: { standard: TokenRates; contributor: TokenRates | null } = {
  standard: { cachedInput: 0.2, input: 4, output: 20 },
  contributor: null,
};

export const SPARK_RATES: { standard: TokenRates; contributor: TokenRates } = {
  standard: { cachedInput: 0.15, input: 1.25, output: 4.25 },
  contributor: { cachedInput: 0.002, input: 0.1, output: 0.2 },
};

/** "$2.50 per 1,000 search queries, in addition to the request's token cost." */
export const WEB_SEARCH_PER_1000 = 2.5;
export const IMAGE_PRICE = 0.01;
export const VOICE_PER_HOUR = 0.18;
export const SAM_PER_1000_IMAGES = 2.5;
export const SAM_PER_1000_FRAMES = 0.2;
/** "Each video request is billed for at least 50 frames." */
export const SAM_MIN_FRAMES = 50;

export interface TokenModelRow {
  /** The model id, or null for a row the page lists as "Not available" (Muse Wonder in Contributor mode). */
  id: string | null;
  label: string;
  mode: PricingMode;
  rates: TokenRates | null;
}

/** The token-priced models in the pricing page's order, with their rates, and Wonder's missing Contributor mode. */
export const TOKEN_MODELS: readonly TokenModelRow[] = [
  { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", mode: "standard", rates: WONDER_RATES.standard },
  { id: "muse-spark-1.3", label: "Muse Spark 1.3", mode: "standard", rates: SPARK_RATES.standard },
  { id: "muse-spark-1.2", label: "Muse Spark 1.2", mode: "standard", rates: SPARK_RATES.standard },
  { id: "muse-spark-1.1", label: "Muse Spark 1.1", mode: "standard", rates: SPARK_RATES.standard },
  { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor", mode: "contributor", rates: SPARK_RATES.contributor },
  { id: "muse-spark-1.2-contributor", label: "Muse Spark 1.2 Contributor", mode: "contributor", rates: SPARK_RATES.contributor },
  { id: null, label: "Muse Wonder 1.0 Contributor", mode: "contributor", rates: WONDER_RATES.contributor },
];

export function tokenRates(model: string): TokenRates | null {
  return TOKEN_MODELS.find((m) => m.id === model)?.rates ?? null;
}

export interface RateLimit {
  model: string;
  /** Requests per minute, or null for "None". */
  rpm: number | null;
  /** Tokens per minute, or null for "None". */
  tpm: number | null;
  other?: string;
}

/** The pricing page's rate-limit table. Limits are per team, not per key, and each model has its own. */
export const RATE_LIMITS: readonly RateLimit[] = [
  { model: "muse-wonder-1.0", rpm: 3000, tpm: 4_000_000 },
  { model: "muse-spark-1.3", rpm: 3000, tpm: 4_000_000 },
  { model: "muse-spark-1.2", rpm: 3000, tpm: 4_000_000 },
  { model: "muse-spark-1.3-contributor", rpm: 150, tpm: 3_000_000 },
  { model: "muse-spark-1.2-contributor", rpm: 150, tpm: 3_000_000 },
  { model: "muse-spark-1.1", rpm: 3000, tpm: 4_000_000 },
  { model: "sam-3.1", rpm: 3000, tpm: null },
  { model: "muse-image-1.0", rpm: 150, tpm: null },
  { model: "muse-voice-transcribe-1.0", rpm: null, tpm: null, other: "256 concurrent streams; 16,000 streams per hour" },
];

/** "Creating background responses is limited to 600 submissions per minute, per team." */
export const BACKGROUND_SUBMISSIONS_PER_MINUTE = 600;

export const RATE_LIMIT_HEADERS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "x-ratelimit-limit-tokens", description: "Total token budget for the current window." },
  { name: "x-ratelimit-remaining-tokens", description: "Tokens remaining before you hit the limit." },
  { name: "x-ratelimit-limit-requests", description: "Total request budget for the current window." },
  { name: "x-ratelimit-remaining-requests", description: "Requests remaining before you hit the limit." },
];

export const API_BASE_URL = "https://api.meta.ai/v1";
/** The Anthropic SDK appends /v1/messages itself (sdks page). */
export const ANTHROPIC_BASE_URL = "https://api.meta.ai";

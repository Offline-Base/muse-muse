import { BUILT_WITH_SPARK_OPEN, USAGE_POINTS } from "@/lib/caps/gpu/words";

/**
 * Muse Spark Open for products (SPARK_OPEN_PRODUCTS): Meta's open-weight model, run by a hosted provider the platform pays,
 * reached at the gateway's /v1/chat/completions with the product's own token. The provider's key stays on the platform.
 * Nothing here imports lib/env, so the gateway handler and the brief schema can import it.
 */

/** The id a brief, a gateway token and a product's code name. The gateway sends the provider's own id in its place. */
export const SPARK_OPEN_MODEL = "muse-spark-open";

/** The template overlay that marks a builder snapshot with the helper and the skill (template/caps/spark-open). */
export const SPARK_OPEN_OVERLAY = "spark-open";

/** Reply header naming the provider that ran the call, so a product's label says where it ran. */
export const SPARK_OPEN_HOST_HEADER = "x-musemuse-served-on";

/** USD per million tokens. A provider's reasoning tokens are billed as output. */
export interface SparkOpenPrice {
  input: number;
  cachedInput: number;
  output: number;
}

export interface SparkOpenProviderInfo {
  /** The provider's name as a product's label shows it: "Muse Spark Open, on <name>". */
  name: string;
  /** Its OpenAI-compatible Chat Completions root, with no slash at the end. */
  baseUrl: string;
  /** The provider's own model id for Muse Spark Open. */
  model: string;
  /** The env var that holds the provider's key. Server only, never in a reply, a header or a log. */
  keyEnv: string;
  price: SparkOpenPrice;
}

export type SparkOpenProvider = "baseten" | "fireworks";

/**
 * The providers, from Meta's hosted-provider table (content/meta-docs/pages/muse-spark-open/deploy.md). Fireworks' price is its
 * Standard serverless list price, checked Oct 30 (docs/knowledge-research/claim-check-2026-10-30.md, F4). Baseten's isn't in
 * the repo, so it is a conservative stand-in, twice Fireworks' with no cached discount, until someone reads Baseten's page: an
 * estimate that errs high only makes a budget refuse sooner.
 */
export const SPARK_OPEN_PROVIDERS: Record<SparkOpenProvider, SparkOpenProviderInfo> = {
  baseten: {
    name: "Baseten",
    baseUrl: "https://inference.baseten.co/v1",
    model: "meta-models/muse-spark-open",
    keyEnv: "BASETEN_API_KEY",
    price: { input: 2.5, cachedInput: 2.5, output: 8.5 },
  },
  fireworks: {
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/muse-spark-open",
    keyEnv: "FIREWORKS_API_KEY",
    price: { input: 1.25, cachedInput: 0.15, output: 4.25 },
  },
};

/** SPARK_OPEN_PROVIDER when it is unset. Fireworks' account was suspended on Nov 2, and Baseten answered. */
export const DEFAULT_SPARK_OPEN_PROVIDER: SparkOpenProvider = "baseten";

/** The provider SPARK_OPEN_PROVIDER names (baseten when unset). Null for an unknown name, so nothing is guessed. */
export function sparkOpenProviderFrom(source: Record<string, string | undefined> = process.env): SparkOpenProvider | null {
  const raw = (source.SPARK_OPEN_PROVIDER ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_SPARK_OPEN_PROVIDER;
  return Object.hasOwn(SPARK_OPEN_PROVIDERS, raw) ? (raw as SparkOpenProvider) : null;
}

/** The label beside every answer: "Muse Spark Open, on Baseten". */
export function sparkOpenLabel(providerName: string): string {
  return `Muse Spark Open, on ${providerName}`;
}

/** The Muse Model License's line, and the Usage Policy's age point, which a product on it shows word for word. */
export const SPARK_OPEN_CREDIT = `${BUILT_WITH_SPARK_OPEN}. ${USAGE_POINTS[0]}`;

/** Cost of one call, from its counts. `inputTokens` includes cached tokens, as in the usage object. */
export function sparkOpenCost(price: SparkOpenPrice, counts: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): number {
  const cached = Math.min(Math.max(0, counts.cachedInputTokens), Math.max(0, counts.inputTokens));
  return ((counts.inputTokens - cached) * price.input + cached * price.cachedInput + counts.outputTokens * price.output) / 1e6;
}

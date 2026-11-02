/**
 * What a Fireworks run costs, from Fireworks' own live pages, read fresh (docs/TRAINING.md "Train on Fireworks").
 * Fireworks has no call that prices a job before it exists, so nothing here assumes a price: the training line is $0
 * only while both the models page and the pricing page state the Muse Glimmer 30B offer and its date hasn't passed, and
 * scoring is priced from the serverless pricing page. Anything else leaves no quote, and the job is refused.
 */
export const FW_BASE_MODEL = "accounts/fireworks/models/muse-glimmer-30b";
export const FW_MODELS_URL = "https://docs.fireworks.ai/fine-tuning/models.md";
export const FW_PRICING_URL = "https://fireworks.ai/pricing";
export const FW_SERVERLESS_PRICING_URL = "https://docs.fireworks.ai/serverless/pricing.md";

/** Rough tokens one kept-aside prompt reads, with its system message. Rows are held to 1,500 characters a prompt. */
export const FW_EVAL_INPUT_TOKENS = 1500;
/** The most one answer may write: the same as the Lambda path's MAX_NEW_TOKENS. */
export const FW_EVAL_MAX_TOKENS = 1024;

export type FireworksQuote =
  | {
      ok: true;
      trainingUsd: 0;
      /** When the offer ends, ISO. */
      until: string;
      /** The offer, as the page words it. */
      words: string;
      sourceUrl: string;
      /** Dollars per million tokens to answer a prompt, the higher of input and output. */
      ratePerMTokens: number;
    }
  | { ok: false; reason: string };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function plainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * The offer's end, when both pages state it and agree on the day: the end of that day in Pacific time (UTC-8 in late
 * November, as Fireworks' own starter writes it). Null otherwise. Only "SFT" for this model counts.
 */
export function offerFrom(modelsPage: string, pricingPage: string): { until: Date; words: string } | null {
  const models = plainText(modelsPage).match(/Muse Glimmer 30B SFT is free[^.]*?until ([A-Z][a-z]+) (\d{1,2}), (\d{4})/);
  const pricing = plainText(pricingPage).match(/Muse Glimmer 30B SFT is free[^.]*?until (\d{1,2})\/(\d{1,2})/);
  if (!models || !pricing) return null;
  const month = MONTHS.indexOf(models[1]!.toLowerCase());
  const day = Number(models[2]);
  if (month < 0 || Number(pricing[1]) !== month + 1 || Number(pricing[2]) !== day) return null;
  return { until: new Date(Date.UTC(Number(models[3]), month, day + 1, 8)), words: pricing[0]! };
}

/** Dollars per million tokens for Muse Glimmer 30B: its own row, else the page's row for its size. Null when neither reads. */
export function answerRateFrom(pricingPage: string): number | null {
  const own = pricingPage.match(/Muse Glimmer 30B[^|\n]*\|\s*\\?\$([\d.]+)\s*\/\s*\\?\$[\d.]+\s*\/\s*\\?\$([\d.]+)/);
  if (own) return Math.max(Number(own[1]), Number(own[2]));
  const size = pricingPage.match(/More than 16B parameters\s*\|\s*\\?\$([\d.]+)/);
  const rate = size ? Number(size[1]) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** The quote from the pages and the model's catalog entry, or why there is none. Pure. */
export function quoteFrom(input: { modelsPage: string; pricingPage: string; serverlessPage: string; tunable: boolean; now: Date }): FireworksQuote {
  if (!input.tunable) return { ok: false, reason: "Fireworks' catalog doesn't list Muse Glimmer 30B as tunable for this account." };
  const offer = offerFrom(input.modelsPage, input.pricingPage);
  if (!offer) return { ok: false, reason: "Fireworks' pages don't confirm what this training costs right now." };
  if (input.now.getTime() >= offer.until.getTime()) return { ok: false, reason: "Fireworks' stated offer for this training has ended." };
  const ratePerMTokens = answerRateFrom(input.serverlessPage);
  if (ratePerMTokens === null) return { ok: false, reason: "Fireworks' pricing page doesn't confirm what answering prompts costs." };
  return { ok: true, trainingUsd: 0, until: offer.until.toISOString(), words: offer.words, sourceUrl: FW_PRICING_URL, ratePerMTokens };
}

/** The most answering `items` kept-aside prompts can cost, base and tuned, at the full (not batch) rate, rounded up to a cent. */
export function evalCeilingUsd(items: number, ratePerMTokens: number): number {
  const tokens = 2 * Math.max(0, items) * (FW_EVAL_INPUT_TOKENS + FW_EVAL_MAX_TOKENS);
  return Math.ceil((tokens * ratePerMTokens) / 1e6 * 100) / 100;
}

/** The smallest dollar limit a job has (MIN_MAX_USD), so a run's hold counts against the limits even when training is free. */
const MIN_HOLD_USD = 0.1;

/** What a run holds against the limits, and whether scoring fits within the most scoring may cost (FIREWORKS_EVAL_MAX_USD). */
export function holdFor(items: number, ratePerMTokens: number, evalCapUsd: number): { scoring: boolean; evalMaxUsd: number; holdUsd: number } {
  const evalMaxUsd = evalCeilingUsd(items, ratePerMTokens);
  const scoring = items > 0 && evalMaxUsd <= evalCapUsd;
  return { scoring, evalMaxUsd, holdUsd: Math.max(MIN_HOLD_USD, scoring ? evalMaxUsd : 0) };
}

/** A Fireworks money value in dollars: null when it gave none, Infinity for another currency so it never passes as cheap. */
export function moneyUsd(m: { currencyCode?: string; units?: string | number; nanos?: number } | null | undefined): number | null {
  if (!m) return null;
  if (m.currencyCode && m.currencyCode !== "USD") return Infinity;
  const usd = Number(m.units ?? 0) + Number(m.nanos ?? 0) / 1e9;
  return Number.isFinite(usd) ? usd : Infinity;
}

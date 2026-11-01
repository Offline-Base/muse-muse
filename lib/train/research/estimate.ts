/**
 * What a research run should cost, and the most its next call can. Pure and browser-safe: the New dataset card shows the
 * same range the route's budget uses. These are estimates at Muse Wonder's prices, not measurements.
 */
import { tokenCost, WEB_SEARCH_USD_PER_QUERY } from "@/lib/meta/pricing";

const PRICED_MODEL = "muse-wonder-1.0";

/** Narrow sub-questions a run searches, one Meta call each. */
export const RESEARCH_QUESTIONS = 4;
/** Built-in search calls one sub-question may make (max_tool_calls). */
export const SEARCH_CALLS = 4;
/** One search call can run several queries; billed per query. */
const QUERIES_PER_CALL = 3;
export const SEARCH_MAX_OUTPUT_TOKENS = 3000;

const usd = (input: number, output: number) => tokenCost(PRICED_MODEL, { inputTokens: input, outputTokens: output });
const PLAN = { low: usd(500, 200), high: usd(1500, 600) * 2 };
const SEARCH = {
  low: usd(10_000, 600) + WEB_SEARCH_USD_PER_QUERY,
  high: usd(40_000, SEARCH_MAX_OUTPUT_TOKENS) + SEARCH_CALLS * QUERIES_PER_CALL * WEB_SEARCH_USD_PER_QUERY,
};
/** High counts the repair attempt a structured call may make. */
const REPORT = { low: usd(5_000, 1_500), high: usd(16_000, 6_000) * 2 };

/** The most one search is expected to add. Its output and searches are capped; its input is an estimate. */
export const SEARCH_WORST_USD = SEARCH.high;
export const REPORT_WORST_USD = REPORT.high;

/** A whole run's expected range, in cents-rounded dollars. */
export function researchEstimate(): { low: number; high: number } {
  return {
    low: Math.floor((PLAN.low + SEARCH.low * RESEARCH_QUESTIONS + REPORT.low) * 100) / 100,
    high: Math.ceil((PLAN.high + SEARCH.high * RESEARCH_QUESTIONS + REPORT.high) * 100) / 100,
  };
}

/** True when another search still leaves room under the run's cap for the report that follows it. */
export function canSearchAgain(spentUsd: number, maxUsd: number): boolean {
  return spentUsd + SEARCH_WORST_USD + REPORT_WORST_USD <= maxUsd;
}

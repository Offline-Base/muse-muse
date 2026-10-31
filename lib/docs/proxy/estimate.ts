import type { DocsEndpoint } from "@/lib/docs/proxy/endpoints";
import {
  DOCS_CONTEXT_TOKENS,
  DOCS_MAX_TOOL_CALLS,
  OUTPUT_TOKEN_CLAMPS,
  WEB_SEARCH_USD_PER_QUERY,
} from "@/lib/docs/proxy/policy";
import { DEFAULT_OUTPUT_TOKENS, estimateCost, inlineTokens, inputTokensOf, MAX_OUTPUT_TOKENS } from "@/lib/gateway/estimate";
import type { ParsedRequest } from "@/lib/gateway/extract";
import {
  isBuiltInTool,
  PREVIOUS_RESPONSE_TOKENS,
  SEARCH_CONTEXT_TOKENS,
  searchesAllowed as searchesUpTo,
} from "@/lib/gateway/search";
import { usageCost } from "@/lib/meta/pricing";

export { inlineTokens, PREVIOUS_RESPONSE_TOKENS, SEARCH_CONTEXT_TOKENS };

/**
 * A docs call's cost estimate, made before it is forwarded: what the budgets are checked against and what is reserved
 * until the metered cost replaces it. Images, transcription and the image and SAM models use the gateway's estimate.
 * Text calls are counted here, never below the gateway's figure: every message, the system prompt and the tools, inline
 * media sized by type (a PDF or a text file by its length, since that is what the model reads), web search, and the
 * stored turns a previous_response_id pulls in. Errs high: the estimate is what keeps one call inside a visitor's
 * dollars, since output is capped but input is only capped by the 4.5 MB body.
 */

/**
 * Searches assumed when web_search is on and max_tool_calls doesn't say fewer. The proxy sets max_tool_calls to this
 * whenever a built-in tool is on (lib/docs/proxy/rewrite.ts), so it is the most a call can run.
 */
export const SEARCHES_ASSUMED = DOCS_MAX_TOOL_CALLS;

function outputTokensOf(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  const valid = typeof n === "number" && Number.isFinite(n) && n >= 1;
  return valid ? Math.min(Math.floor(n), MAX_OUTPUT_TOKENS) : DEFAULT_OUTPUT_TOKENS;
}

function tokensCost(model: string, inputTokens: number, outputTokens = 0): number {
  return usageCost({ model, inputTokens, cachedInputTokens: 0, outputTokens });
}

/** Searches a request may run: none without a web_search tool, else max_tool_calls (when lower) or SEARCHES_ASSUMED. */
export function searchesAllowed(json: Record<string, unknown>): number {
  return searchesUpTo(json, SEARCHES_ASSUMED);
}

function searchCost(model: string, json: Record<string, unknown>): number {
  const searches = searchesAllowed(json);
  return searches ? searches * WEB_SEARCH_USD_PER_QUERY + tokensCost(model, searches * SEARCH_CONTEXT_TOKENS) : 0;
}

/** Built-in tool calls a Responses call may make: none without a built-in tool, else max_tool_calls up to the cap. */
function toolCallsAllowed(json: Record<string, unknown>): number {
  if (!Array.isArray(json.tools) || !json.tools.some(isBuiltInTool)) return 0;
  const cap = Number(json.max_tool_calls);
  return Number.isFinite(cap) && cap >= 1 ? Math.min(Math.floor(cap), DOCS_MAX_TOOL_CALLS) : DOCS_MAX_TOOL_CALLS;
}

/**
 * The most a background Responses call on a text model can cost: what it holds until Meta reports its usage
 * (lib/docs/proxy/background.ts), since nothing reads its bill when it starts. Input is the whole context window on
 * every pass (one, plus one per built-in tool call, as each call's results go back to the model), whatever the body
 * holds: files, URLs and a previous_response_id all bring input the body doesn't show. Then the output cap and every
 * search's fee. Zero for models that aren't priced by the token.
 */
export function backgroundWorstCase(model: string, json: Record<string, unknown>): number {
  if (!(tokensCost(model, 1_000_000) > 0)) return 0;
  const passes = 1 + toolCallsAllowed(json);
  // The request's own limit when it set a lower one (Meta enforces it), else the docs' cap for the model.
  const cap = OUTPUT_TOKEN_CLAMPS[model] ?? MAX_OUTPUT_TOKENS;
  const asked = Number(json.max_output_tokens);
  const output = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.ceil(asked), cap) : cap;
  return tokensCost(model, passes * DOCS_CONTEXT_TOKENS, output) + searchesAllowed(json) * WEB_SEARCH_USD_PER_QUERY;
}

/** Chat Completions and Messages: the text and media of every message, the system prompt and the tools, plus output. */
function chatOrMessagesEstimate(model: string, json: Record<string, unknown>, outputTokens: unknown): number {
  const inputTokens = inputTokensOf(json.messages, json.system, json.tools);
  return tokensCost(model, inputTokens, outputTokensOf(outputTokens)) + searchCost(model, json);
}

/**
 * Responses: the gateway's estimate for image and SAM models, which aren't token priced. Text models are counted here
 * (input, instructions, tools and a text.format schema), never below the gateway's figure, plus a chained conversation
 * and web search.
 */
function responsesEstimate(model: string, parsed: Extract<ParsedRequest, { kind: "json" }>, bodyBytes: number): number {
  // Searches are added below, once, so the gateway's figure leaves them out.
  const gateway = estimateCost("responses", parsed, bodyBytes, 0);
  const json = parsed.json;
  const tokenPriced = tokensCost(model, 1_000_000) > 0;
  if (!tokenPriced) return gateway;
  // A background call's usage isn't in its reply, so it holds the most it can cost until it is settled.
  if (json.background === true) return backgroundWorstCase(model, json);
  const chained = typeof json.previous_response_id === "string" && json.previous_response_id;
  const chainedTokens = chained ? PREVIOUS_RESPONSE_TOKENS : 0;
  const inputTokens = inputTokensOf(json.input, json.instructions, json.tools, json.text) + chainedTokens;
  const counted = tokensCost(model, inputTokens, outputTokensOf(json.max_output_tokens));
  return Math.max(gateway, counted) + searchCost(model, json);
}

/**
 * The estimated cost in USD of a docs call. Zero for the free endpoints: listings, retrievals, deletes, cancels,
 * uploads and the token counters (token-counting: they "do not record generation usage"). `audioMs` is the length of
 * a transcription's WAV when the proxy could read its header.
 */
export function estimateDocsCost(
  endpoint: DocsEndpoint,
  parsed: ParsedRequest,
  bodyBytes: number,
  audioMs?: number | null,
): number {
  const model = parsed.model;
  if (!endpoint.meter || !model) return 0;
  switch (endpoint.meter) {
    case "responses":
      return parsed.kind === "json" ? responsesEstimate(model, parsed, bodyBytes) : 0;
    case "chat":
      // The deprecated max_tokens still counts when the request set it instead.
      return parsed.kind === "json"
        ? chatOrMessagesEstimate(model, parsed.json, parsed.json.max_completion_tokens ?? parsed.json.max_tokens)
        : 0;
    case "messages":
      return parsed.kind === "json" ? chatOrMessagesEstimate(model, parsed.json, parsed.json.max_tokens) : 0;
    case "images":
      return estimateCost(endpoint.gateway ?? "images/generations", parsed, bodyBytes);
    case "asr":
      if (audioMs && audioMs > 0) {
        const audioSeconds = audioMs / 1000;
        return usageCost({ model, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds });
      }
      return estimateCost("asr/transcribe", parsed, bodyBytes);
  }
}

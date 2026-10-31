import { WEB_SEARCH_USD_PER_QUERY } from "@/lib/meta/pricing";
import type { ModelUsage } from "@/lib/types";

/**
 * What Meta's built-in tools cost and how to count them, shared by the gateway and the live docs proxy
 * (lib/docs/proxy): web_search is billed per query on top of tokens, and each search adds input (search-grounding,
 * pricing-rate-limits "Token pricing notes").
 */

type Json = Record<string, unknown>;

/** Input tokens assumed for the stored conversation a previous_response_id brings along. */
export const PREVIOUS_RESPONSE_TOKENS = 10_000;
/** Input tokens each search's results add. */
export const SEARCH_CONTEXT_TOKENS = 8_000;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Tool types Meta runs itself, which max_tool_calls counts (tool-calling, "max_tool_calls limits built-in tools only"). */
export function isBuiltInTool(tool: unknown): boolean {
  const type = (tool as { type?: unknown } | null)?.type;
  return typeof type === "string" && (type.startsWith("web_search") || type === "tool_search");
}

/** Adds Meta's web search charge ($2.50 per 1,000 queries) to a token-billed item. */
export function withSearches(item: ModelUsage, searches: number): ModelUsage {
  return searches > 0 ? { ...item, costUsd: item.costUsd + searches * WEB_SEARCH_USD_PER_QUERY } : item;
}

/** Queries one web_search_call item ran: its search action's queries, or one when it doesn't list them. */
export function searchItemQueries(item: Json): number {
  const action = isObject(item.action) ? item.action : null;
  if (action && action.type !== undefined && action.type !== "search") return 0;
  return Math.max(1, Array.isArray(action?.queries) ? action.queries.length : 0);
}

/** Web search queries in a Responses result's output. Opening or searching within a page isn't a query. */
export function responsesSearches(response: Json | null | undefined): number {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.reduce<number>(
    (n, item) => n + (isObject(item) && item.type === "web_search_call" ? searchItemQueries(item) : 0),
    0,
  );
}

/** Whether an output item is a call Meta ran with a built-in tool, the calls max_tool_calls counts. */
export function isBuiltInCall(item: unknown): boolean {
  return isObject(item) && (item.type === "web_search_call" || item.type === "tool_search_call");
}

/** Built-in tool calls in a Responses result's output. One call can run several queries, so this isn't the search count. */
export function builtInCalls(response: Json | null | undefined): number {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output.filter(isBuiltInCall).length;
}

/** Searches a request may run: none without a web_search tool, else max_tool_calls (when lower) or `most`. */
export function searchesAllowed(json: Json, most: number): number {
  const tools = Array.isArray(json.tools) ? json.tools : [];
  const searching = tools.some((t) => {
    const type = (t as { type?: unknown } | null)?.type;
    return typeof type === "string" && type.startsWith("web_search");
  });
  if (!searching) return 0;
  const cap = Number(json.max_tool_calls);
  return Number.isFinite(cap) && cap >= 1 ? Math.min(Math.floor(cap), most) : most;
}

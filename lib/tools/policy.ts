/** Limits and the check order of the tool gateway (docs/AGENT_TOOLS.md). lib/tools/handler.ts follows them. */

export const TOOL_LIMITS = {
  perTokenPerMinute: 60,
  /** Per end user: the visitor's id and, when the product forwards it, the IP. */
  perVisitorPerMinute: 20,
  /** Per toolkit across the platform. A catalog tool's own perMinute can be lower. */
  perToolkitPerMinute: 120,
  /** Tool calls one token may have running at once. Separate from its Meta slots. */
  perTokenInFlight: 6,
  argumentsMaxBytes: 16 * 1024,
  /** The whole request: arguments, an approval and the person's input for read_page. */
  bodyMaxBytes: 128 * 1024,
  userInputMaxBytes: 64 * 1024,
  /** Applied after the catalog's output rules, or a plain cut would lose results. */
  outputMaxBytes: 32 * 1024,
  sourcesMax: 20,
  /** A tool can do billable work, so a timed-out call is never tried again. */
  executeTimeoutMs: 30_000,
  /** Everyone a write reaches: to, cc and bcc together, or a calendar event's attendees. */
  recipientsMax: 5,
  approvalValidMs: 10 * 60_000,
  connectStateValidMs: 15 * 60_000,
  ownerCodeValidMs: 5 * 60_000,
  ownerSessionValidMs: 12 * 3_600_000,
} as const;

/**
 * Tools whose address must come from the person, never from a page or the model. Meta's open_page only opens URLs from
 * its own results, so read_page is what a prompt injection would reach for.
 */
export const USER_INPUT_URL_PARAMS: Readonly<Record<string, string>> = { read_page: "url" };

/**
 * The checks on POST /tools/execute, in order.
 *   1. Bearer token, then product status.
 *   2. The token has `agent` and `tool:<id>`, the manifest allows it, the tool isn't denied and its tier's flag is on.
 *   3. resolvePrincipal, then tierAllowed. A personal tool also needs a live connection.
 *   4. Arguments (size, catalog names, types, required, URLs, read_page's rule), recipients, then the confirmation.
 *   5. Rate limits (token, visitor, IP, tool, toolkit), the tool's daily cap, then an in-flight slot.
 *   6. Budgets: the token's daily spend, TOOLS_DAILY_SPEND_CAP_USD, DAILY_SPEND_CAP_USD, TOOLS_DAILY_CALLS, the run's caps.
 *   7. Reserve the estimate as a usage row, and spend the approval.
 *   8. A build token gets a canned result. A live token calls the provider with a 30-second timeout and no retry.
 *   9. Settle, apply the output rules, take the sources, trim to 32 KB and answer.
 */
export const TOOL_CHECKS = ["token", "allowlist", "principal", "arguments", "rate_limit", "budget", "reserve", "execute", "settle"] as const;

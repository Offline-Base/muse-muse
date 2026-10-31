/**
 * The names the tool gateway's contract shares (docs/AGENT_TOOLS.md): tool ids, principals, error codes and token
 * markers. The ids come from lib/tools/catalog.source.ts, so there is no second list to keep in step.
 */
import { TOOL_POLICIES, type ToolPolicy } from "@/lib/tools/catalog.source";

export type ToolId = (typeof TOOL_POLICIES)[number]["id"];

export const TOOL_IDS = TOOL_POLICIES.map((p) => p.id);

const idsWhere = (test: (p: ToolPolicy) => boolean) => TOOL_POLICIES.filter(test).map((p) => p.id);

/** Tools anyone may use. */
export const PUBLIC_TOOL_IDS = idsWhere((p) => p.tier === "public");
/** Tools on the owner's own accounts, behind COMPOSIO_PERSONAL_ENABLED. */
export const PERSONAL_TOOL_IDS = idsWhere((p) => p.tier === "personal");
/** Tools Meta runs itself, on /v1/responses. They never go through /tools/execute. */
export const BUILTIN_TOOL_IDS = idsWhere((p) => p.builtin === true);

export function isToolId(id: unknown): id is ToolId {
  return (TOOL_IDS as readonly unknown[]).includes(id);
}

/** Who is asking, weakest claim first after `build`. `user` waits for platform sign-in. */
export const TOOL_PRINCIPALS = ["build", "product", "visitor", "owner", "user"] as const;
export type ToolPrincipal = (typeof TOOL_PRINCIPALS)[number];

/** In a token's allowedModels: it may use the tool routes, and its built-in tool cap is the agent one. */
export const AGENT_MARKER = "agent";

/** In a token's allowedModels: the brief picked this tool. A product's manifest can narrow this list, never widen it. */
export const toolMarker = (id: ToolId): string => `tool:${id}`;

/** The tool a `tool:<id>` marker allows, or null for any other entry. */
export function toolOfMarker(marker: string): ToolId | null {
  const id = marker.startsWith("tool:") ? marker.slice(5) : null;
  return isToolId(id) ? id : null;
}

/** Each refusal the tool routes give, with its status. They come back in the gateway's usual error shape. */
export const TOOL_ERRORS = {
  tool_not_allowed: 403,
  sign_in_required: 403,
  invalid_arguments: 400,
  rate_limited: 429,
  run_limit: 429,
  budget_exceeded: 429,
  tools_paused: 503,
  tool_failed: 502,
} as const;
export type ToolErrorCode = keyof typeof TOOL_ERRORS;

/** Not errors: /tools/execute answers these with ok:false and status 200, and the product shows a card. */
export type ToolPauseCode = "needs_confirmation" | "needs_connection";

/** The canned outputs a build's tool calls get, by Composio slug (builds.tool_fixtures). */
export type ToolFixtures = Record<string, unknown[]>;

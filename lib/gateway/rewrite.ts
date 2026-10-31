import { createHash } from "node:crypto";
import { BUILTIN_TOOL_CALL_CAPS, hasAgentMarker } from "@/lib/gateway/policy";
import { isBuiltInTool } from "@/lib/gateway/search";
import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";

/**
 * What the gateway changes in a Responses request before it goes to Meta, each visible change said in x-musemuse-note.
 * Background runs are refused, since Meta bills them later and the gateway can't read the bill back. Built-in tool
 * calls are capped, which makes the estimate's search count a ceiling. Every request gets a safety identifier hashed
 * with the product's id, so Meta can act on one person, and one product's users never share an id with another's.
 * Tokens with the agent marker can't run on Contributor: Meta may train on that tier, and agents read other people's
 * pages. web_search itself stays open to every product. Only its calls are capped.
 */

export interface RewriteToken {
  productId: string;
  scope: string;
  allowedModels: readonly string[];
}

export interface RewriteRefusal {
  status: number;
  code: string;
  message: string;
}

export interface ResponsesRewrite {
  json: Record<string, unknown>;
  notes: string[];
  /** False when nothing changed, so the request's own bytes can be forwarded. */
  changed: boolean;
  /** Why the request can't run, or null. `json` is the input when it's set. */
  refusal: RewriteRefusal | null;
}

/** The most built-in tool calls one Responses call may make with this token. */
export function builtInToolCap(token: Pick<RewriteToken, "scope" | "allowedModels">): number {
  if (token.scope === "build") return BUILTIN_TOOL_CALL_CAPS.build;
  return hasAgentMarker(token.allowedModels) ? BUILTIN_TOOL_CALL_CAPS.agent : BUILTIN_TOOL_CALL_CAPS.live;
}

function whoFor(token: Pick<RewriteToken, "scope" | "allowedModels">): string {
  if (token.scope === "build") return "builds run";
  return hasAgentMarker(token.allowedModels) ? "agents run" : "products run";
}

/** A value as a note can show it: short, and printable in a header. */
function shown(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "a number too large to read";
  if (typeof value === "string") return JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}...` : value);
  if (value === null) return "null";
  return Array.isArray(value) ? "a list" : typeof value === "object" ? "an object" : String(value);
}

/**
 * max_tool_calls ends up a whole number from 1 to `cap` when the request offers a built-in tool: Meta has no maximum of
 * its own and treats null as no limit, so a value the gateway can't read as a limit in range is replaced.
 */
function clampBuiltInToolCalls(json: Record<string, unknown>, cap: number, who: string, notes: string[]): boolean {
  if (!Array.isArray(json.tools) || !json.tools.some(isBuiltInTool)) return false;
  const value = json.max_tool_calls;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= cap) return false;
  json.max_tool_calls = cap;
  notes.push(
    value === undefined || value === null
      ? `Set max_tool_calls to ${cap}: ${who} at most ${cap} built-in tool calls, such as searches, per response.`
      : `Set max_tool_calls to ${cap} (it was ${shown(value)}): ${who} at most ${cap} built-in tool calls, such as searches, per response.`,
  );
  return true;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** "p_" and 40 hex characters of a hash of the product and the person, inside Meta's limit of 64 characters. */
export function productSafetyIdentifier(productId: string, subject: string): string {
  return `p_${createHash("sha256").update(`${productId}:${subject}`).digest("hex").slice(0, 40)}`;
}

/** Rewrites a Responses JSON body. The input is not changed. `visitorKey` names the person when the body doesn't. */
export function rewriteResponsesRequest(
  input: Record<string, unknown>,
  opts: { token: RewriteToken; visitorKey?: string | null; testRun?: boolean },
): ResponsesRewrite {
  const refuse = (code: string, message: string): ResponsesRewrite => ({
    json: input,
    notes: [],
    changed: false,
    refusal: { status: 400, code, message },
  });
  const { token, visitorKey } = opts;
  if (input.background !== undefined && input.background !== null && input.background !== false) {
    return refuse("background_unsupported", "Products can't run background responses here yet. Stream it with stream: true instead.");
  }
  // A test build's agent reads made-up data on purpose, so TEST_MODEL may run it. A live agent never runs on Contributor.
  if (!opts.testRun && hasAgentMarker(token.allowedModels) && (input.model === SPARK_STANDIN || input.model === RETIRED_SPARK)) {
    return refuse(
      "model_not_for_agents",
      `Agents can't run on ${SPARK_STANDIN}: Meta may train on that tier, and agents read other people's pages. Use muse-wonder-1.0 instead.`,
    );
  }
  const json = { ...input };
  const notes: string[] = [];
  clampBuiltInToolCalls(json, builtInToolCap(token), whoFor(token), notes);
  // The deprecated `user` names the person too when safety_identifier doesn't. Meta prefers safety_identifier, so
  // sending both is fine (protocols/responses, "Safety identifiers").
  const subject = nonEmpty(json.safety_identifier) ?? nonEmpty(json.user) ?? visitorKey ?? "anon";
  json.safety_identifier = productSafetyIdentifier(token.productId, subject);
  return { json, notes, changed: true, refusal: null };
}

/** x-musemuse-note: the notes as one line of printable ASCII, as a header value must be. */
export function noteHeaderValue(notes: readonly string[]): string | null {
  const text = notes.join(" ").replace(/[^\x20-\x7e]/g, " ").trim();
  return text ? text.slice(0, 1000) : null;
}

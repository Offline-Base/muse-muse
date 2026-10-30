import { collectReply, protocolOfPath } from "@/lib/docs/client/stream";
import { runsAs } from "@/lib/docs/client/models";

/**
 * Live checks of a page's rules: each one sends the smallest request that shows a rule ("a function name may contain
 * at most one dot", "strict: true needs additionalProperties: false") and compares what the API answered with what
 * the page says. Most expect HTTP 400, which costs nothing; the accepted ones are a few tokens on Spark 1.3
 * Contributor. A difference from the page is shown as one, never hidden.
 */

export type RulePath = "responses" | "chat/completions" | "messages" | "responses/input_tokens" | "messages/count_tokens";

export interface RuleCheck {
  /** Stable id, for React keys and results. */
  id: string;
  /** The page's rule, in a short sentence. */
  rule: string;
  /** What this check sends, in a few words: "A function named crm.orders.list". */
  sends: string;
  path: RulePath;
  body: Record<string, unknown>;
  /** What the page says happens. */
  expect: "accepted" | "rejected";
  /** The page section the rule comes from (its heading id), for a link. */
  anchor?: string;
  /** Something a reader should know, such as how the live API differed when these docs were made. */
  note?: string;
  /**
   * For an accepted check whose rule is about the reply's shape: the type of an output item (Responses) or content
   * block (Messages) the reply must hold, such as "server_tool_use". A 2xx without it differs from the page.
   */
  replyHas?: string;
}

export type Verdict = "matches" | "differs" | "unknown";

/**
 * Whether a status agrees with the page. Only a 2xx counts as accepted and only a 400 (or 422) as rejected: a rate
 * limit, a paused demo or a network failure says nothing about the rule, so it is "unknown".
 */
export function verdictOf(expect: RuleCheck["expect"], status: number): Verdict {
  const accepted = status >= 200 && status < 300;
  const rejected = status === 400 || status === 422;
  if (!accepted && !rejected) return "unknown";
  return (expect === "accepted") === accepted ? "matches" : "differs";
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The first output item (Responses) or content block (Messages) of a type in a reply, or null. */
export function replyBlock(json: unknown, type: string): Record<string, unknown> | null {
  const o = obj(json);
  const list = Array.isArray(o?.content) ? (o.content as unknown[]) : Array.isArray(o?.output) ? (o.output as unknown[]) : [];
  for (const raw of list) {
    const b = obj(raw);
    if (b?.type === type) return b;
  }
  return null;
}

/**
 * A check's verdict from its whole reply: the status decides, and an accepted check with `replyHas` also needs that
 * block in the reply, so a 200 that lacks what the rule is about can't pass as "Matches the page".
 */
export function checkVerdict(check: Pick<RuleCheck, "expect" | "replyHas">, status: number, json: unknown): Verdict {
  const verdict = verdictOf(check.expect, status);
  if (verdict !== "matches" || check.expect !== "accepted" || !check.replyHas) return verdict;
  return replyBlock(json, check.replyHas) ? "matches" : "differs";
}

/** "HTTP 400" or "accepted (200)", the way a check's result line says it. */
export function outcomeLabel(status: number): string {
  if (status >= 200 && status < 300) return `Accepted (${status})`;
  if (status === 0) return "No connection";
  return `Rejected (${status})`;
}

function clip(text: string, max = 140): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/** "server_tool_use tool_search {"paths":[""]}": the block a check looked for, named and with its input. */
export function blockLabel(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? ` ${block.name}` : "";
  const input = block.input !== undefined ? block.input : block.arguments;
  const args = input === undefined ? "" : ` ${typeof input === "string" ? input : JSON.stringify(input)}`;
  return `${String(block.type)}${name}${args}`;
}

/**
 * One line on what an accepted reply held: the block the rule is about (when the check names one), then the tool it
 * called, its first words, or the token count.
 */
export function acceptedSummary(path: RulePath, json: unknown, replyHas?: string): string {
  const o = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (!o) return "The API accepted the request.";
  if (replyHas) {
    const block = replyBlock(o, replyHas);
    const rest = acceptedSummary(path, o);
    return block ? clip(`The reply has ${blockLabel(block)}. ${rest}`, 220) : clip(`The reply has no ${replyHas} block. ${rest}`, 220);
  }
  if (typeof o.input_tokens === "number" && (path === "responses/input_tokens" || path === "messages/count_tokens")) {
    return `Counted ${o.input_tokens.toLocaleString("en-US")} input tokens.`;
  }
  const protocol = protocolOfPath(path);
  if (!protocol) return "The API accepted the request.";
  const reply = collectReply(protocol, o);
  const calls = reply.toolCalls.filter((t) => t.name);
  if (calls.length) return clip(`The model called ${calls.map((t) => `${t.name}(${t.arguments || ""})`).join(", ")}.`);
  if (reply.finishReason === "max_output_tokens") return "Accepted; the reply ran out of output tokens.";
  if (reply.text.trim()) return clip(`The model answered: ${reply.text}`);
  return "The API accepted the request.";
}

/** The body with the model the reader picked, when it names one; requests without a model stay as they are. */
export function withModel(body: Record<string, unknown>, model: string | null): Record<string, unknown> {
  if (!model || typeof body.model !== "string") return body;
  return { ...body, model: runsAs(model) };
}

/** A check's request costs nothing when the page expects a 400 and the API agrees; this says which ones may bill. */
export function mayBill(check: Pick<RuleCheck, "expect" | "path">): boolean {
  return check.expect === "accepted" && check.path !== "responses/input_tokens" && check.path !== "messages/count_tokens";
}

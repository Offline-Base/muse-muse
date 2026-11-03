/**
 * The agent loop's guards and trace (recipe-agent-patterns, 02/01 and 02/02). Pure and import-free: copy it to
 * lib/agent/loop-guards.ts and use it on the page that drives the loop and in its tests.
 *
 * A loop ends one of six ways: done (the model answers with no tool call), the turn cap, the token budget, stuck (the
 * same tool with the same arguments three times), the model saying it can't finish, or the person pressing Stop.
 * Only done counts as success, and only when the product's own test run afterwards is green.
 */

export interface LoopCall {
  name: string;
  /** The call's arguments as the model sent them (a JSON string). */
  arguments: string;
}

export interface LoopTurn {
  turn: number;
  /** The narration or reasoning summary that came with the call, if any. */
  think?: string;
  /** usage.output_tokens_details.reasoning_tokens for this model call. */
  reasoningTokens?: number;
  /** usage.total_tokens for this model call. */
  tokens: number;
  /** The tool call this turn made, or null when the model answered instead. */
  call: LoopCall | null;
  /** What the tool returned, as sent back to the model. */
  result?: string;
  ok?: boolean;
  /** The model's final text, on the turn with no call. */
  answer?: string;
}

export interface Guards {
  maxTurns: number;
  tokenBudget: number;
  /** Stop when one (tool, arguments) pair has been called this many times. 3 in the recipe. */
  repeatLimit: number;
}

export type StopKind = "done" | "turn_cap" | "token_budget" | "stuck" | "gave_up" | "cancelled";

export interface Stop {
  kind: StopKind;
  message: string;
}

/** The same call with its arguments in any key order is one key. */
export function callKey(call: LoopCall): string {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return `${call.name}:${call.arguments}`;
  }
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return `${call.name}:${JSON.stringify(sort(args))}`;
}

const GAVE_UP = /\b(can(?:no|')t|unable to|not able to)\b.{0,40}\b(fix|solve|finish|complete|do)\b/i;

/**
 * Whether the loop must stop after these turns, and why. Null means take another turn. Call it after every turn,
 * before the next model call.
 */
export function guardStop(turns: readonly LoopTurn[], guards: Guards, cancelled = false): Stop | null {
  if (cancelled) return { kind: "cancelled", message: "Stopped by you." };
  const last = turns[turns.length - 1];
  if (last && last.call === null) {
    return GAVE_UP.test(last.answer ?? "")
      ? { kind: "gave_up", message: "The model said it couldn't finish the task." }
      : { kind: "done", message: "The model finished." };
  }
  const used = turns.reduce((sum, t) => sum + (t.tokens || 0), 0);
  if (used >= guards.tokenBudget) return { kind: "token_budget", message: `Stopped at the token budget: ${used} of ${guards.tokenBudget} tokens used.` };
  const counts = new Map<string, number>();
  for (const t of turns) {
    if (!t.call) continue;
    const key = callKey(t.call);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n >= guards.repeatLimit) return { kind: "stuck", message: `Stopped as stuck: ${t.call.name} was called with the same arguments ${n} times.` };
  }
  if (turns.length >= guards.maxTurns) return { kind: "turn_cap", message: `Stopped at the turn cap of ${guards.maxTurns}.` };
  return null;
}

/** Success needs both: the model said it was done, and the product's own test run after the loop is green. */
export function outcome(stop: Stop, testsGreen: boolean): { success: boolean; label: string } {
  if (stop.kind === "done" && testsGreen) return { success: true, label: "Fixed: the tests pass." };
  if (stop.kind === "done") return { success: false, label: "The model said it was done, but the tests still fail." };
  return { success: false, label: stop.message };
}

/**
 * True when a model reply has no reasoning, no text and no tool call: a dropped or cut-off stream, not a decision.
 * Re-run that turn once, and don't count it as a turn.
 */
export function isEmptyTurn(output: ReadonlyArray<{ type?: string; content?: unknown; summary?: unknown }>): boolean {
  return !output.some((item) => {
    if (item.type === "function_call") return true;
    if (item.type === "message") return Array.isArray(item.content) && item.content.some((c) => typeof (c as { text?: unknown })?.text === "string" && (c as { text: string }).text.trim() !== "");
    if (item.type === "reasoning") return Array.isArray(item.summary) && item.summary.length > 0;
    return false;
  });
}

function short(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** The recipe's trace: one block per turn with THINK, ACT, RESULT and EVAL lines, then how it ended. */
export function traceText(turns: readonly LoopTurn[], stop: Stop | null): string {
  const lines: string[] = [];
  turns.forEach((t, i) => {
    const pad = `[Turn ${t.turn}]`;
    const indent = " ".repeat(pad.length + 1);
    const think = t.think ? `THINK${t.reasoningTokens !== undefined ? ` (${t.reasoningTokens} tok)` : ""}: ${short(t.think, 160)}` : null;
    const first = think ?? (t.call ? `ACT:   ${t.call.name}(${short(t.call.arguments, 80)})` : `DONE:  ${short(t.answer ?? "", 160)}`);
    lines.push(`${pad} ${first}`);
    if (think && t.call) lines.push(`${indent}ACT:   ${t.call.name}(${short(t.call.arguments, 80)})`);
    if (t.call) lines.push(`${indent}RESULT: ${short(t.result ?? "", 120)}`);
    const isLast = i === turns.length - 1;
    lines.push(`${indent}EVAL:  ${isLast && stop ? (stop.kind === "done" ? "done" : `stop (${stop.kind})`) : "continue"}`);
  });
  if (stop) lines.push("", `${stop.kind === "done" ? "DONE" : "STOPPED"}: ${stop.message}`);
  return lines.join("\n");
}

/** One run's totals, for comparing runs at two reasoning efforts. */
export function runTotals(turns: readonly LoopTurn[]): { turns: number; toolCalls: number; reasoningTokens: number; totalTokens: number } {
  return {
    turns: turns.length,
    toolCalls: turns.filter((t) => t.call).length,
    reasoningTokens: turns.reduce((s, t) => s + (t.reasoningTokens ?? 0), 0),
    totalTokens: turns.reduce((s, t) => s + (t.tokens || 0), 0),
  };
}

/**
 * The computer-use lab's two budgets, pure so they can be tested.
 *
 * Output tokens per call: a reply that reasons past max_output_tokens comes back HTTP 200 with status "incomplete"
 * (incomplete_details.reason "max_output_tokens") and no action. The guide's "Handle done and incomplete" section says
 * to raise the budget and continue from the same state, so the lab sends the same turn again one step up instead of
 * treating the reply as the end of the task. 1,500 tokens was too few for a Mines move (a live run spent 1,498 of
 * 1,500 on reasoning); 4,000 is the default.
 *
 * Model calls per run: direct stateless replay of the computer tool holds up to 29 call/output pairs (the guide's
 * "Manage conversation state"), so in that mode the step budget stops at 29.
 */

export const BUDGETS: readonly number[] = [1500, 4000, 8000, 16000];
export const DEFAULT_BUDGET = 4000;
export const REPLAY_MAX_PAIRS = 29;
export const STEP_OPTIONS: readonly number[] = [6, 12, 24, 40];

/** The proxy's output cap for a model (docs/DOCS_MIRROR.md "Clamps"): Spark Contributor 16,384, Spark Standard 8,192. */
export function outputCap(model: string): number {
  return model.endsWith("-contributor") ? 16384 : 8192;
}

/** The budgets the menu offers for a model. */
export function budgetsFor(model: string): number[] {
  const cap = outputCap(model);
  return BUDGETS.filter((b) => b <= cap);
}

/** The budget for the same turn again after a cut-off: the next one up within the model's cap, or null at the top. */
export function raisedBudget(current: number, model: string): number | null {
  const cap = outputCap(model);
  const next = BUDGETS.find((b) => b > current && b <= cap);
  if (next !== undefined) return next;
  return current < cap ? cap : null;
}

/** The most model calls one run may make. */
export function stepCap(protocol: "computer" | "cua" | "metacua", mode: "server" | "replay"): number {
  return protocol === "computer" && mode === "replay" ? REPLAY_MAX_PAIRS : STEP_OPTIONS[STEP_OPTIONS.length - 1];
}

/** The step budget menu under a cap: the usual sizes below it, then the cap itself. */
export function stepOptionsUnder(cap: number): number[] {
  return [...STEP_OPTIONS.filter((v) => v < cap), cap];
}

type Json = Record<string, unknown>;

/** What a cut-off reply spent, for its step in the list. */
export function cutOffText(usage: unknown, budget: number): string {
  const u = (usage && typeof usage === "object" ? usage : {}) as Json;
  const out = typeof u.output_tokens === "number" ? u.output_tokens : budget;
  const details = (u.output_tokens_details && typeof u.output_tokens_details === "object" ? u.output_tokens_details : {}) as Json;
  const reasoning = typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : null;
  return `Cut off: the reply used ${out.toLocaleString("en-US")} of its ${budget.toLocaleString("en-US")} output tokens${reasoning !== null ? ` (${reasoning.toLocaleString("en-US")} of them reasoning)` : ""} before it chose an action, so it came back status "incomplete" with nothing to run.`;
}

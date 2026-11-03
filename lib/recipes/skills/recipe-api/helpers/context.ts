/**
 * Fitting long text into one call's budget, and showing what was left out. Pure, with no imports.
 * The gateway doesn't serve /v1/responses/input_tokens, so counts here are estimates, about 4 characters a token,
 * and the real count is read from the reply's usage afterwards.
 */
export const CHARS_PER_TOKEN = 4;

/** The plan per call: about 100,000 input tokens, about $0.40 uncached. The window itself is 1,048,576. */
export const PLAN_INPUT_TOKENS = 100_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface Section {
  id: string;
  title: string;
  text: string;
}

export interface Fit {
  kept: Section[];
  /** Shown to the person: these sections weren't sent. */
  leftOut: Section[];
  estTokens: number;
  totalEstTokens: number;
}

/**
 * Keeps sections in document order until the budget is reached. `pick` lists ids a first pass chose; they go first,
 * then the rest in order while room remains. Nothing is cut mid-section.
 */
export function fitSections(sections: readonly Section[], budgetTokens: number = PLAN_INPUT_TOKENS, pick: readonly string[] = []): Fit {
  const order = [...sections.filter((s) => pick.includes(s.id)), ...sections.filter((s) => !pick.includes(s.id))];
  const keptIds = new Set<string>();
  let est = 0;
  for (const s of order) {
    const t = estimateTokens(s.text) + estimateTokens(s.title) + 4;
    if (est + t > budgetTokens) continue;
    est += t;
    keptIds.add(s.id);
  }
  return {
    kept: sections.filter((s) => keptIds.has(s.id)),
    leftOut: sections.filter((s) => !keptIds.has(s.id)),
    estTokens: est,
    totalEstTokens: sections.reduce((sum, s) => sum + estimateTokens(s.text) + estimateTokens(s.title) + 4, 0),
  };
}

/** The document as one stable string: same sections, same bytes, every call, so it can be the cached prefix. */
export function documentText(sections: readonly Section[]): string {
  return sections.map((s) => `## ${s.id}. ${s.title}\n${s.text.trim()}`).join("\n\n");
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/** A sliding window: the newest turns that fit, oldest dropped first. Says how many were dropped. */
export function slidingWindow(turns: readonly Turn[], budgetTokens: number): { turns: Turn[]; dropped: number } {
  const kept: Turn[] = [];
  let est = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = estimateTokens(turns[i].text) + 4;
    if (est + t > budgetTokens && kept.length) break;
    est += t;
    kept.unshift(turns[i]);
  }
  return { turns: kept, dropped: turns.length - kept.length };
}

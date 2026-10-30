/**
 * Keeping a long conversation's context under control, as the multi-turn-context-management and long-context recipes
 * do it: a sliding window (keep the instructions, drop the oldest turns: the long-context recipe's trim_history), a
 * running state the model keeps itself (the STATE.md the multi-turn recipe prompts for, sent back instead of the old
 * turns), and summarizing older turns into one note when the context passes a threshold (compaction). Pure, so the
 * demo, its tests and the copy prompt agree on what each strategy sends.
 */

export type Role = "developer" | "system" | "user" | "assistant";

export interface Msg {
  role: Role;
  content: string;
}

const isInstruction = (m: Msg) => m.role === "developer" || m.role === "system";

/**
 * The long-context recipe's trim_history: every instruction message, then the newest turns that fit in maxMessages.
 * (Its Python slices turns[-keep:], which returns every turn when keep is 0; here keep 0 keeps no turns.)
 */
export function trimHistory(messages: readonly Msg[], maxMessages = 8): Msg[] {
  const instructions = messages.filter(isInstruction);
  const turns = messages.filter((m) => !isInstruction(m));
  const keep = Math.max(0, maxMessages - instructions.length);
  return [...instructions, ...(keep ? turns.slice(-keep) : [])];
}

/** The recipe's 20 made-up turns about numbers, and the question that ends them. */
export function numberFactsHistory(turns = 20): Msg[] {
  const history: Msg[] = [{ role: "developer", content: "You are a concise assistant." }];
  for (let i = 0; i < turns; i++) {
    history.push({ role: "user", content: `Tell me one fact about the number ${i}.` });
    history.push({ role: "assistant", content: `A fact about ${i}.` });
  }
  history.push({ role: "user", content: `Give me one fact about the number ${Math.max(0, turns - 1)}.` });
  return history;
}

// ---------------------------------------------------------------------------------------------------------------
// The running state (STATE.md)

const STATE_FENCE = /```(?:state|md|markdown)?[^\n]*\n(#[^\n]*(?:Working Memory|STATE)[\s\S]*?)\n```/i;
const ANY_STATE = /```state[^\n]*\n([\s\S]*?)\n```/i;

/** The STATE.md block in a reply (a ```state fence, or a fenced document titled like one), and the reply without it. */
export function extractState(reply: string): { state: string | null; rest: string } {
  const m = ANY_STATE.exec(reply) ?? STATE_FENCE.exec(reply);
  if (!m) return { state: null, rest: reply.trim() };
  return { state: m[1].trim(), rest: reply.replace(m[0], "").trim() };
}

export type Strategy = "full" | "window" | "state" | "summary";

export const STRATEGY_LABEL: Record<Strategy, string> = {
  full: "Full history",
  window: "Sliding window",
  state: "Running state",
  summary: "Summarize older turns",
};

export interface Transcript {
  /** The standing instructions (a developer message). */
  instructions: string;
  /** Every turn so far, in order, ending with the user's newest message. */
  turns: Msg[];
  /** The newest STATE.md the model wrote. */
  state: string | null;
  /** The compaction note that stands in for the turns before `summaryUpTo`. */
  summary: string | null;
  /** How many of `turns` the summary covers. */
  summaryUpTo: number;
}

export interface Planned {
  messages: Msg[];
  /** Turns left out of this request. */
  dropped: number;
  /** A line on what this strategy sent, for the demo. */
  note: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What one strategy sends for the newest turn. */
export function planRequest(strategy: Strategy, t: Transcript, opts: { windowMessages: number }): Planned {
  const dev: Msg = { role: "developer", content: t.instructions };
  const all = [dev, ...t.turns];
  if (strategy === "full") return { messages: all, dropped: 0, note: `Sent the whole conversation: ${plural(t.turns.length, "message")}.` };
  if (strategy === "window") {
    const messages = trimHistory(all, opts.windowMessages);
    const dropped = all.length - messages.length;
    return {
      messages,
      dropped,
      note: dropped ? `Kept the instructions and the last ${messages.length - 1} messages; left out ${dropped}.` : "Everything still fits the window.",
    };
  }
  if (strategy === "state") {
    if (!t.state) return { messages: all, dropped: 0, note: "No STATE.md yet, so this turn sends the conversation as it is." };
    const newest = t.turns[t.turns.length - 1];
    const state: Msg = { role: "developer", content: `The current STATE.md, your working memory so far:\n\n${t.state}` };
    // The newest exchange stays, so a follow-up that refers back still has its referent, but without the STATE.md
    // block that reply ended with: the developer message above already carries the current one, and sending it twice
    // would make every turn pay for it twice.
    const before = t.turns.length >= 2 ? t.turns[t.turns.length - 2] : null;
    const reply = before?.role === "assistant" ? extractState(before.content).rest : "";
    const kept: Msg[] = [...(reply ? [{ role: "assistant" as const, content: reply }] : []), ...(newest ? [newest] : [])];
    const dropped = t.turns.length - kept.length;
    return {
      messages: [dev, state, ...kept],
      dropped,
      note: `Sent STATE.md and the newest exchange (its STATE.md block left out, since it's sent above); left out ${plural(dropped, "older message")}.`,
    };
  }
  // summary: the compaction note stands in for the turns it covers.
  const tail = t.turns.slice(t.summaryUpTo);
  const note: Msg[] = t.summary ? [{ role: "developer", content: `Summary of the conversation so far (older turns were compacted into this note):\n\n${t.summary}` }] : [];
  return {
    messages: [dev, ...note, ...tail],
    dropped: t.summaryUpTo,
    note: t.summary
      ? `Sent the summary note and the ${plural(tail.length, "message")} after it; ${plural(t.summaryUpTo, "message")} compacted.`
      : "Nothing compacted yet.",
  };
}

/** The share of the declared window at which the summary strategy compacts. */
export const COMPACT_AT = 0.5;

/**
 * The declared window a strategy starts on, in tokens, until the reader picks one: 2k, which the running state stays
 * well inside (as the recipe's own run stayed near 54% of its window), or 1k for compaction, so its threshold is
 * crossed within the demo's five turns.
 */
export function defaultDeclaredWindow(strategy: Strategy): number {
  return strategy === "summary" ? 1000 : 2000;
}

/**
 * Where the meter turns to a warning, as a share of the window: the compaction threshold when compaction is on (that's
 * when crossing it means something), else 80%. Past the whole window it's red either way.
 */
export function meterWarnAt(strategy: Strategy): number {
  return strategy === "summary" ? COMPACT_AT : 0.8;
}

/** True when the last request's input passed the compaction threshold of the declared window. */
export function shouldCompact(inputTokens: number, declaredWindow: number, threshold = COMPACT_AT): boolean {
  return declaredWindow > 0 && inputTokens >= declaredWindow * threshold;
}

/** The request that compacts turns[0, upTo) into one note, keeping the goal, decisions, files and plan. */
export function compactionMessages(t: Transcript, upTo: number): Msg[] {
  const covered = t.turns.slice(0, upTo);
  const prior = t.summary ? `An earlier summary:\n${t.summary}\n\n` : "";
  return [
    {
      role: "developer",
      content:
        "You compact an engineering conversation into a note another model will continue from. Keep the goal, every key decision with the requirement change that introduced it, the file map, the current step and open questions. Under 200 words, plain text.",
    },
    { role: "user", content: `${prior}Conversation to compact:\n\n${covered.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n")}` },
  ];
}

/** A rough token count (about four characters a token) for planning before the API's own usage comes back. */
export function roughTokens(messages: readonly Msg[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length + 8, 0) / 4);
}

import type { Effort } from "@/lib/docs/client/models";
import { fitEffort } from "@/lib/docs/client/models";
import { capWonder, WONDER_OUTPUT_CAP } from "@/components/docs/playgrounds/start/wonder";

/**
 * "Same prompt on two models" for the models page (Choose Muse Wonder or Muse Spark): the request each side sends,
 * and a one-line comparison of what came back. Muse Wonder gets the group's output cap (wonder.ts) so a side-by-side
 * run stays around a cent; the rest run at the proxy's limits.
 */

/** Output cap for Muse Wonder in the comparison: the group's cap for every paid Wonder demo. */
export const WONDER_COMPARE_CAP = WONDER_OUTPUT_CAP;

export function compareBody(model: string, prompt: string, effort: Effort | null): Record<string, unknown> {
  const body: Record<string, unknown> = { model, input: prompt };
  const e = fitEffort(model, effort);
  if (e) body.reasoning = { effort: e };
  return { ...capWonder(body), stream: true };
}

/** What separates two request bodies, in words, for a code view that shows one of them. */
export function bodyDifferences(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const words: Record<string, string> = {
    model: "the model",
    reasoning: "the reasoning effort, fitted to each model",
    max_output_tokens: "Muse Wonder's output cap",
  };
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => words[k] ?? k);
}

/** "the model", "the model and Muse Wonder's output cap", "a, b and c". */
export function listWords(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
}

export interface SideStats {
  model: string;
  ms: number;
  usd: number | null;
  outputTokens: number;
}

function ratio(a: number, b: number): string {
  const r = a / b;
  return r >= 10 ? `${Math.round(r)}x` : `${r.toFixed(1)}x`;
}

/** "Muse Wonder 1.0 took 2.1x as long and cost 90x as much as Muse Spark 1.3 Contributor." */
export function compareLine(a: SideStats & { label: string }, b: SideStats & { label: string }): string | null {
  if (!a.ms || !b.ms) return null;
  const [slow, fast] = a.ms >= b.ms ? [a, b] : [b, a];
  const time = slow.ms / fast.ms < 1.1 ? `${slow.label} and ${fast.label} took about as long` : `${slow.label} took ${ratio(slow.ms, fast.ms)} as long as ${fast.label}`;
  if (a.usd === null || b.usd === null || !a.usd || !b.usd) return `${time}.`;
  const [dear, cheap] = a.usd >= b.usd ? [a, b] : [b, a];
  const cost = dear.usd! / cheap.usd! < 1.1 ? "cost about the same" : `${dear.label} cost ${ratio(dear.usd!, cheap.usd!)} as much`;
  return `${time}; ${cost}.`;
}

export interface ComparePreset {
  label: string;
  left: string;
  right: string;
  prompt: string;
  /** What the pair shows. */
  shows: string;
}

export const COMPARE_PRESETS: readonly ComparePreset[] = [
  {
    label: "Muse Spark vs Muse Wonder",
    left: "muse-spark-1.3-contributor",
    right: "muse-wonder-1.0",
    prompt: "A train leaves at 9:47 and arrives at 13:12. How long is the trip, and what is that in minutes? One line.",
    shows: "Same request, only the model id changes. Muse Wonder is for long, complex work where capability matters more than cost per token.",
  },
  {
    label: "Standard vs Contributor",
    left: "muse-spark-1.2",
    right: "muse-spark-1.2-contributor",
    prompt: "Name three uses for a paperclip, one line each.",
    shows: "One model in both modes: Contributor mode is the same model at a lower price, in exchange for letting Meta train on what you send.",
  },
  {
    label: "Muse Spark 1.3 vs 1.2",
    left: "muse-spark-1.3-contributor",
    right: "muse-spark-1.2-contributor",
    prompt: "Write a regular expression that matches an ISO 8601 date (YYYY-MM-DD) and explain it in one sentence.",
    shows: "1.3 is the latest, tuned for agentic workflows with better coding; 1.2 is the previous version.",
  },
];

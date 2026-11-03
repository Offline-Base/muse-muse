import type { Brief, CostItem } from "@/lib/brief/schema";

/**
 * A plan's cost per run, worked out in code from its parts (Nov 3 audit: the parking plan's parts came to about $0.02
 * under "Total about $0.12"). A brief from before costItems has only the writer's total and notes, shown as they were.
 */

/** Rounded to a hundredth of a cent, as normalizeRawBrief rounds the total. */
export function roundCost(usd: number): number {
  return Math.max(0, Math.round(usd * 10_000) / 10_000);
}

/** The brief's parts with a real dollar figure, or none. */
export function costItemsOf(brief: Pick<Brief, "costItems">): CostItem[] {
  return (brief.costItems ?? []).filter((i) => i.what.trim() && Number.isFinite(i.usd) && i.usd >= 0);
}

/** The sum of the parts, rounded. */
export function sumCostItems(items: readonly CostItem[]): number {
  return roundCost(items.reduce((s, i) => s + i.usd, 0));
}

/** One run's cost: the sum of its parts when it has them, otherwise the writer's own total. */
export function runCostUsd(brief: Pick<Brief, "costItems" | "estimatedCostPerRunUsd">): number {
  const items = costItemsOf(brief);
  return items.length ? sumCostItems(items) : brief.estimatedCostPerRunUsd;
}

/** $0.12 from a dime up, and down to a hundredth of a cent below it: $0.0011, $0.005. */
export function planMoney(usd: number): string {
  return usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;
}

/**
 * The writer's notes without any sentence holding a dollar figure, for a brief whose parts carry the dollars and whose
 * total code adds up: a figure there could only repeat a part or disagree with it. A sentence ends at . ! or ? before a
 * space, so "$0.12" stays whole.
 */
export function notesWithoutDollars(notes: string): string {
  return notes
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/\$\s?\d/.test(s))
    .join(" ")
    .trim();
}

/**
 * "About $0.0172 per run (estimate). Parts: Summary call (10k in, 600 out) $0.0011; Fact check searches $0.01." and then
 * the notes, for the build prompt and brief.md. A brief with no parts reads as it always did.
 */
export function costSentence(brief: Pick<Brief, "costItems" | "estimatedCostPerRunUsd" | "costNotes">): string {
  const items = costItemsOf(brief);
  const parts = items.length ? ` Parts: ${items.map((i) => `${i.what.replace(/[.;\s]+$/, "")} ${planMoney(i.usd)}`).join("; ")}.` : "";
  return `About ${planMoney(runCostUsd(brief))} per run (estimate).${parts} ${brief.costNotes}`.trim();
}

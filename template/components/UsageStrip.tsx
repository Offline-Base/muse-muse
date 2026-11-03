"use client";

import { useId, useLayoutEffect, useSyncExternalStore } from "react";

/** What one result took. Leave out what the brief doesn't ask to show. Token counts are totals across the calls. */
export interface Usage {
  /** Estimated dollars. Shown as "About $0.084". */
  costUsd?: number;
  /** Input tokens, cached ones included. */
  input?: number;
  output?: number;
  /** Input tokens read from the cache: `usage.input_tokens_details.cached_tokens`. 0 is shown as 0. */
  cached?: number;
}

/** The one rounding rule for money on screen: 3 decimals under 10 cents, 2 above. */
export function formatUsd(usd: number): string {
  if (!(usd > 0)) return "$0";
  if (usd < 0.001) return "under $0.001";
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
}

const count = (n: number) => Math.round(n).toLocaleString("en-US");

/** The strip's words, like "About $0.084 in model costs · 1,185 tokens · 0 from cache". Empty when there is nothing. */
export function usageText(usage: Usage, what = "in model costs"): string {
  const parts: string[] = [];
  if (typeof usage.costUsd === "number" && usage.costUsd > 0) {
    const money = formatUsd(usage.costUsd);
    // "Under $0.001", never "About under $0.001".
    parts.push((money.startsWith("under ") ? `Under ${money.slice(6)} ${what}` : `About ${money} ${what}`).trim());
  }
  const tokens = (usage.input ?? 0) + (usage.output ?? 0);
  if (usage.input !== undefined || usage.output !== undefined) parts.push(`${count(tokens)} tokens`);
  if (usage.cached !== undefined) parts.push(`${count(usage.cached)} from cache`);
  return parts.join(" · ");
}

// Every strip on the page. Only one shows: the first the app placed, or, when the app placed none, the first a kit
// component (AgentRun) placed as a fallback. So a page never shows cost twice.
type Claim = { id: string; fallback: boolean };
let claims: Claim[] = [];
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = () => listeners.forEach((fn) => fn());

/** Which strip shows, of those on the page in order. */
export function shownStrip(list: Claim[]): string | null {
  return (list.find((c) => !c.fallback) ?? list[0])?.id ?? null;
}

/**
 * The one place a result's cost and usage show, as a `.meta` line under the result. Put one on the result screen,
 * with the totals for that result. A second strip on the page stays hidden, and AgentRun's own cost line gives way to
 * yours. Tests find it by `[data-usage]`.
 */
export function UsageStrip({ usage, what, fallback = false }: { usage: Usage; what?: string; fallback?: boolean }) {
  const id = useId();
  const text = usageText(usage, what);
  const has = text !== "";
  useLayoutEffect(() => {
    if (!has) return;
    claims = [...claims, { id, fallback }];
    emit();
    return () => {
      claims = claims.filter((c) => c.id !== id);
      emit();
    };
  }, [id, fallback, has]);
  const shown = useSyncExternalStore(
    subscribe,
    () => shownStrip(claims),
    () => id,
  );
  if (!has || (shown !== null && shown !== id)) return null;
  return (
    <p className="meta" data-usage>
      {text}
    </p>
  );
}

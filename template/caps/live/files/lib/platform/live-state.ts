// Platform file (Muse Muse platform services). Don't edit: use useLive from lib/platform/live.ts.
//
// How a browser's copy of a collection follows the stream's changes, with no browser in it.

export interface LiveChange<T = unknown> {
  seq: number;
  op: "put" | "delete";
  id: string;
  data: T | null;
}

export interface LiveItem<T = unknown> {
  id: string;
  data: T;
  seq: number;
}

/** Items kept in a browser, the newest changes. */
export const LIVE_MAX_ITEMS = 500;
/** A browser away longer than this reads the collection from the start: deleted rows are gone from the stream after an hour. */
export const LIVE_RESYNC_AFTER_MS = 45 * 60_000;

/** The items after one change, oldest change first. A change older than what's held (a repeat) changes nothing. */
export function applyLiveChange<T>(items: readonly LiveItem<T>[], change: LiveChange<T>, max: number = LIVE_MAX_ITEMS): LiveItem<T>[] {
  const held = items.find((i) => i.id === change.id);
  if (held && held.seq >= change.seq) return items as LiveItem<T>[];
  const rest = items.filter((i) => i.id !== change.id);
  if (change.op === "delete") return rest;
  const next = [...rest, { id: change.id, data: change.data as T, seq: change.seq }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Reads one stream message, or null for anything that isn't a change. */
export function readLiveChange<T>(raw: string): LiveChange<T> | null {
  try {
    const c = JSON.parse(raw) as LiveChange<T>;
    return Number.isSafeInteger(c?.seq) && (c.op === "put" || c.op === "delete") && typeof c.id === "string" ? c : null;
  } catch {
    return null;
  }
}

/** How long to wait before the next try after `failures` failed ones: 1 s, doubling, at most 30 s, with some spread. */
export function liveBackoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

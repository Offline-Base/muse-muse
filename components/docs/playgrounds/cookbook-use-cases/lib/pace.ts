/**
 * Spaces out the multi-step demos' calls to the docs proxy's per-network limit: 20 runs a minute in production
 * (docs/DOCS_MIRROR.md "Limits"), more on a local test server. Fired back to back, a long agent run (a 44-call board
 * run took 83 s) reaches the limit within its first minute; spaced 60 / limit seconds apart, a run on its own never
 * does, and lib/retry.ts waits out the 429s that other tabs or demos on the same network cause. The limit comes from
 * GET /api/docs/limits, which is free and not counted; when it can't be read, the production default applies. One
 * pacer per tab, shared by every demo on the page.
 */

export const DEFAULT_PER_MINUTE = 20;

/** Milliseconds between call starts for a per-minute limit, with 5% to spare for clock and network jitter. */
export function paceGapMs(perMinute: number): number {
  const n = Number.isFinite(perMinute) && perMinute > 0 ? perMinute : DEFAULT_PER_MINUTE;
  return Math.ceil((60_000 / n) * 1.05);
}

/** Resolves after `ms`, or sooner once `stopped()` turns true (checked every 200 ms), so Stop never waits out a pause. */
export function sleepUnlessStopped(ms: number, stopped?: () => boolean): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      const left = end - Date.now();
      if (left <= 0 || stopped?.()) return resolve();
      setTimeout(tick, Math.min(200, left));
    };
    tick();
  });
}

export interface Pacer {
  /** Waits for this call's turn and returns how long it waited (0 when the gap has already passed). */
  next(stopped?: () => boolean): Promise<number>;
}

export interface PacerOptions {
  /** The per-minute limit, read once. */
  limit(): Promise<number>;
  now?(): number;
  sleep?(ms: number, stopped?: () => boolean): Promise<void>;
}

/** A pacer that starts calls at least paceGapMs(limit) apart. Slots are handed out in order, so calls never bunch up. */
export function createPacer(opts: PacerOptions): Pacer {
  let gap: Promise<number> | null = null;
  let nextAt = 0;
  return {
    async next(stopped) {
      gap ??= opts.limit().then(paceGapMs, () => paceGapMs(DEFAULT_PER_MINUTE));
      const g = await gap;
      const now = (opts.now ?? Date.now)();
      const at = Math.max(now, nextAt);
      nextAt = at + g;
      const wait = at - now;
      if (wait > 0) await (opts.sleep ?? sleepUnlessStopped)(wait, stopped);
      return wait;
    },
  };
}

/** The proxy's per-minute limit for this network, from GET /api/docs/limits. */
async function proxyLimit(): Promise<number> {
  const res = await fetch("/api/docs/limits", { credentials: "same-origin", cache: "no-store" });
  const json = (await res.json()) as { perIpRequestsPerMinute?: unknown };
  return typeof json.perIpRequestsPerMinute === "number" ? json.perIpRequestsPerMinute : DEFAULT_PER_MINUTE;
}

/** The tab's pacer. Nothing is fetched until the first paced call. */
export const docsPacer: Pacer = createPacer({ limit: proxyLimit });

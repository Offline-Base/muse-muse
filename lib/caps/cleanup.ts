import type { CapId } from "@/lib/caps/ids";

/**
 * Cleanup for what caps store (docs/CAPABILITIES.md, 2.9). Every unit that stores anything adds one entry to
 * CAP_CLEANUPS, in plan order. cleanupStep calls buildEnded after it revokes the build token, disabling or taking down a
 * product calls productOff, and the hourly cleanup cron calls sweep, which also clears build namespaces older than 24
 * hours from builds that crashed.
 */
export interface CapCleanup {
  cap: CapId;
  buildEnded?(buildId: string): Promise<void>;
  /**
   * The product was turned off (an admin's switch, which can be turned back on) or taken down (unit 1). Pause and revoke
   * what the cap runs for it. Deleting its data belongs to deleting the product (decision 13), not to this.
   */
  productOff?(productId: string): Promise<void>;
  /** Returns how many things it removed. */
  sweep?(now: Date): Promise<number>;
}

export const CAP_CLEANUPS: CapCleanup[] = [];

const registered: CapCleanup[] = [];

/** Adds a cleanup at run time (tests, or a module that can't sit in CAP_CLEANUPS). The same cap twice replaces it. */
export function registerCapCleanup(cleanup: CapCleanup): void {
  const at = registered.findIndex((c) => c.cap === cleanup.cap);
  if (at >= 0) registered[at] = cleanup;
  else registered.push(cleanup);
}

/** Forgets every run-time registration. For tests. */
export function resetCapCleanups(): void {
  registered.length = 0;
}

function all(): CapCleanup[] {
  return [...CAP_CLEANUPS, ...registered];
}

async function each(what: string, run: (c: CapCleanup) => Promise<unknown> | undefined): Promise<string[]> {
  const failed: string[] = [];
  for (const cleanup of all()) {
    try {
      await run(cleanup);
    } catch (err) {
      console.error(`[caps] ${cleanup.cap} ${what} failed:`, err);
      failed.push(cleanup.cap);
    }
  }
  return failed;
}

/** After a build ends: every cap clears that build's namespace. Never throws, so cleanup can't mask the build's outcome. */
export async function capsBuildEnded(buildId: string): Promise<void> {
  await each("buildEnded", (c) => c.buildEnded?.(buildId));
}

/** True when some cap pauses things for a product turned off, so callers look the product up only then. */
export function capsWatchProductOff(): boolean {
  return all().some((c) => c.productOff);
}

/** When a product is disabled or taken down. Never throws. */
export async function capsProductOff(productId: string): Promise<void> {
  await each("productOff", (c) => c.productOff?.(productId));
}

/** The hourly sweep. Null when no cap has registered one, so the cron's answer is today's. */
export async function sweepCaps(now: Date = new Date()): Promise<{ ok: boolean; removed: number; failed: string[] } | null> {
  const sweeps = all().filter((c) => c.sweep);
  if (!sweeps.length) return null;
  let removed = 0;
  const failed = await each("sweep", async (c) => {
    if (c.sweep) removed += await c.sweep(now);
  });
  return { ok: failed.length === 0, removed, failed };
}

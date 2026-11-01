import { finishSession, withSessionLock, type MuseCodeDeps } from "@/lib/caps/code/musecode/handler";
import { deleteResult, museCodeDeps } from "@/lib/caps/code/musecode/deps";
import { activeSandboxNames, activeSessionsWhere, buildResultUrls, clearResult, deleteBuildSessions, deleteSession, expiredResults, oldBuildSessionResults, overdueSessions } from "@/lib/caps/code/musecode/store";
import { sandboxesWithRole, stopSessionByName } from "@/lib/caps/code/session";

/**
 * Muse Code sessions' cleanup (docs/CAPABILITIES.md, 2.9 and 15b), from the code cap's CAP_CLEANUPS entry while
 * MUSE_CODE_ENABLED is on. Every sandbox also stops itself (its own timeout: the limit plus 3 minutes), and every token
 * dies at its end time, so the sweep is the record-keeper, not the only guard.
 *
 *   sweep        sessions past their end are closed (their files kept if the sandbox is still up, the time settled, the
 *                token revoked); any cap-musecode sandbox no session holds is stopped; zips past 24 hours are deleted;
 *                crashed builds' session rows go after two days
 *   productOff   the product's running sessions are stopped
 *   buildEnded   the build's running sessions are stopped, then its rows and zips go
 */

export interface SweepDeps {
  deps: MuseCodeDeps;
  overdue(now: Date): Promise<Parameters<typeof finishSession>[0][]>;
  active(by: { productId?: string; namespace?: string }): Promise<Parameters<typeof finishSession>[0][]>;
  heldNames(): Promise<Set<string>>;
  runningNames(): Promise<string[]>;
  stopByName(name: string): Promise<boolean>;
  expired(now: Date): Promise<Array<{ id: string; url: string }>>;
  deleteResult(url: string): Promise<void>;
  clearResult(id: string): Promise<void>;
  oldBuildResults(before: Date): Promise<Array<{ id: string; url: string | null; namespace: string }>>;
  deleteSession(id: string): Promise<void>;
  deleteBuildSessions(namespace: string): Promise<void>;
  buildResultUrls(namespace: string): Promise<string[]>;
}

export function sweepDeps(): SweepDeps {
  return {
    deps: museCodeDeps(),
    overdue: overdueSessions,
    active: activeSessionsWhere,
    heldNames: activeSandboxNames,
    runningNames: () => sandboxesWithRole("cap-musecode"),
    stopByName: stopSessionByName,
    expired: expiredResults,
    deleteResult,
    clearResult,
    oldBuildResults: oldBuildSessionResults,
    deleteSession,
    deleteBuildSessions,
    buildResultUrls,
  };
}

const BUILD_ROWS_MAX_AGE_MS = 48 * 3_600_000;

/** The hourly sweep. Returns how many things it closed, stopped or deleted. */
export async function sweepMuseCode(now: Date, s: SweepDeps = sweepDeps()): Promise<number> {
  let n = 0;
  for (const row of await s.overdue(now)) {
    // Under the session's lock, so a poll at the same moment can't collect and upload its result as well.
    const done = await withSessionLock(s.deps, row.id, now, () => finishSession(row, { status: "expired", reason: "It ran past its limit with nobody following it." }, s.deps, now));
    if (done) n += 1;
  }
  const held = await s.heldNames();
  for (const name of await s.runningNames().catch(() => [] as string[])) {
    if (held.has(name)) continue;
    if (await s.stopByName(name)) n += 1;
  }
  for (const r of await s.expired(now)) {
    await s.deleteResult(r.url).catch((err) => console.error("[caps] code session zip delete failed:", err instanceof Error ? err.message : "unknown"));
    await s.clearResult(r.id);
    n += 1;
  }
  for (const r of await s.oldBuildResults(new Date(now.getTime() - BUILD_ROWS_MAX_AGE_MS))) {
    if (r.url) await s.deleteResult(r.url).catch(() => undefined);
    await s.deleteSession(r.id);
    n += 1;
  }
  return n;
}

/** A product turned off or taken down: its running sessions stop now. */
export async function stopProductSessions(productId: string, s: SweepDeps = sweepDeps()): Promise<void> {
  const now = new Date();
  for (const row of await s.active({ productId })) await finishSession(row, { status: "stopped", reason: "The product was turned off." }, s.deps, now);
}

/** A build ended: its running sessions stop, then its session rows and their zips go (the build's checks are done). */
export async function endBuildSessions(buildId: string, s: SweepDeps = sweepDeps()): Promise<void> {
  const namespace = `b:${buildId}`;
  const now = new Date();
  for (const row of await s.active({ namespace })) await finishSession(row, { status: "stopped", reason: "The build ended." }, s.deps, now);
  for (const url of await s.buildResultUrls(namespace)) await s.deleteResult(url).catch(() => undefined);
  await s.deleteBuildSessions(namespace);
}

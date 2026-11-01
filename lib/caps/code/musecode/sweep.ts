import { advanceSession, finishSession, withSessionLock, type CodeSessionRow, type MuseCodeDeps } from "@/lib/caps/code/musecode/handler";
import { deleteResult, museCodeDeps } from "@/lib/caps/code/musecode/deps";
import { MUSE_CODE_LIMITS } from "@/lib/caps/code/musecode/limits";
import { redactText } from "@/lib/caps/code/musecode/redact";
import { activeSandboxNames, activeSessionsWhere, buildResultUrls, clearOldSessionText, clearResult, deleteBuildSessions, deleteSession, expiredResults, oldBuildSessionResults } from "@/lib/caps/code/musecode/store";
import { sessionTokenFor } from "@/lib/caps/code/musecode/token";
import { ENDED_STATUSES } from "@/lib/caps/code/musecode/types";
import { sandboxesWithRole, stopSessionByName } from "@/lib/caps/code/session";

/**
 * Muse Code sessions' cleanup (docs/CAPABILITIES.md, 2.9 and 15b). Every sandbox also stops itself (its own timeout: the
 * limit plus 3 minutes), and every token dies at its end time, so the sweep is the record-keeper, not the only guard.
 *
 *   sweepActiveMuseCode  every 2 minutes (app/api/cron/musecode-sweep) while MUSE_CODE_ENABLED is on, and in the hourly
 *                        sweep: moves on the sessions nobody is following, so a finished one ends, keeps its files and
 *                        gives back its slots while its sandbox is still up. The sandbox outlives a limit by 3 minutes,
 *                        so a sweep every 2 always catches one that reached its limit.
 *   sweepMuseCode        hourly: that, then any cap-musecode sandbox no session holds is stopped, zips past 24 hours are
 *                        deleted, steps and final text past 24 hours are cleared, and crashed builds' rows go after two
 *                        days. With the part off, all but the sandbox listing still runs, so turning it off can't strand
 *                        a person's zip. A zip's record is cleared only once the zip is deleted, so a failed delete is
 *                        tried again
 *   productOff           the product's running sessions are stopped
 *   buildEnded           the build's running sessions are stopped, then its rows and zips go
 */

export interface SweepDeps {
  deps: MuseCodeDeps;
  active(by: { productId?: string; namespace?: string }): Promise<CodeSessionRow[]>;
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
  clearOldText(before: Date): Promise<number>;
}

export function sweepDeps(): SweepDeps {
  return {
    deps: museCodeDeps(),
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
    clearOldText: clearOldSessionText,
  };
}

const BUILD_ROWS_MAX_AGE_MS = 48 * 3_600_000;

/** Runs a delete and says whether it worked, with the failure logged through the secret scan. */
async function tryDelete(url: string, s: SweepDeps): Promise<boolean> {
  try {
    await s.deleteResult(url);
    return true;
  } catch (err) {
    console.error("[caps] code session zip delete failed:", err instanceof Error ? redactText(err.message, s.deps.secrets([])).text.slice(0, 300) : "unknown");
    return false;
  }
}

/** Moves on every session still running. Returns how many ended. One session's failure never stops another's. */
export async function sweepActiveMuseCode(now: Date, s: SweepDeps = sweepDeps()): Promise<number> {
  const ends = await Promise.all(
    (await s.active({})).map(async (row) => {
      try {
        // Under the session's lock, so a poll at the same moment can't collect and upload its result as well.
        const done = await withSessionLock(s.deps, row.id, now, () => advanceSession(row, s.deps, now));
        return done && ENDED_STATUSES.includes(done.status) ? 1 : 0;
      } catch (err) {
        console.error("[caps] code session sweep failed:", err instanceof Error ? redactText(err.message, s.deps.secrets([sessionTokenFor(row.id, s.deps.pepper())])).text.slice(0, 300) : "unknown");
        return 0;
      }
    }),
  );
  return ends.reduce<number>((n, e) => n + e, 0);
}

/** The hourly sweep. Returns how many things it closed, stopped or deleted. With `orphans` false it asks Vercel for nothing unless a session is still running. */
export async function sweepMuseCode(now: Date, s: SweepDeps = sweepDeps(), opts: { orphans: boolean } = { orphans: true }): Promise<number> {
  let n = await sweepActiveMuseCode(now, s);
  if (opts.orphans) {
    // Running ones first: a session that starts after this list can't be taken for an orphan.
    const running = await s.runningNames().catch(() => [] as string[]);
    const held = await s.heldNames();
    for (const name of running) {
      if (held.has(name)) continue;
      if (await s.stopByName(name)) n += 1;
    }
  }
  for (const r of await s.expired(now)) {
    if (!(await tryDelete(r.url, s))) continue;
    await s.clearResult(r.id);
    n += 1;
  }
  n += await s.clearOldText(new Date(now.getTime() - MUSE_CODE_LIMITS.resultKeepMs));
  for (const r of await s.oldBuildResults(new Date(now.getTime() - BUILD_ROWS_MAX_AGE_MS))) {
    if (r.url && !(await tryDelete(r.url, s))) continue;
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

/** A build ended: its running sessions stop, then its session rows and their zips go. A zip that won't delete keeps its rows, and the sweep tries again. */
export async function endBuildSessions(buildId: string, s: SweepDeps = sweepDeps()): Promise<void> {
  const namespace = `b:${buildId}`;
  const now = new Date();
  for (const row of await s.active({ namespace })) await finishSession(row, { status: "stopped", reason: "The build ended." }, s.deps, now);
  const deletes = await Promise.all((await s.buildResultUrls(namespace)).map((url) => tryDelete(url, s)));
  if (deletes.every(Boolean)) await s.deleteBuildSessions(namespace);
}

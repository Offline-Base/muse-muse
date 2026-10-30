import { settleFinished, TERMINAL_STATUSES, type BackgroundSettleDeps } from "@/lib/docs/proxy/background";
import type { DocsObjectKind } from "@/lib/docs/proxy/endpoints";
import type { DocsHoldState } from "@/lib/docs/proxy/types";
import type { CleanupResult } from "@/lib/gateway/cleanup";

/**
 * The docs step of the hourly cleanup (app/api/cron/cleanup). First, background responses still holding their worst
 * case are looked up at Meta, and settled from their usage once they're finished (lib/docs/proxy/background.ts). Then
 * files a docs visitor uploaded are deleted after an hour and stored responses after a day, at Meta and in
 * docs_objects, in batches until the step is caught up or near the cron's time limit. Uploads also expire at Meta an
 * hour after upload (expires_after), so a file outlives a failed cleanup by at most that. Best effort: an id whose
 * delete fails stays for the next run, and after a week it is dropped from the table anyway, so one stuck id can't hold
 * the queue.
 */

const HOUR = 3_600_000;
export const DOCS_FILE_TTL_MS = HOUR;
export const DOCS_RESPONSE_TTL_MS = 24 * HOUR;
const GIVE_UP_MS = 7 * 24 * HOUR;
/** Deletes per batch, a few at a time. */
const BATCH = 100;
const CONCURRENCY = 4;
/** No new upstream call starts after this long, which leaves the cron (maxDuration 300 s) time to finish the ones running. */
export const DOCS_CLEANUP_BUDGET_MS = 200_000;
/** Background responses looked up per run. */
const SWEEP_BATCH = 50;
/** A hold this new is left to the reader, who is likely still polling the response. */
const SWEEP_MIN_AGE_MS = 60_000;

export interface DocsCleanupDeps extends BackgroundSettleDeps {
  /** Ids of a kind created before `before`, oldest first. */
  stale(kind: DocsObjectKind, before: Date, limit: number): Promise<string[]>;
  /** Deletes one object at Meta. "gone" when it was deleted or was already gone (404); "failed" otherwise. */
  deleteUpstream(kind: DocsObjectKind, id: string): Promise<"gone" | "failed">;
  /** Removes rows from docs_objects; returns how many. */
  forget(ids: string[]): Promise<number>;
  /** Background responses still holding their spend, created before `before`, oldest first. */
  pendingHolds(before: Date, limit: number): Promise<Array<{ id: string; hold: DocsHoldState }>>;
  /** GET /v1/responses/{id} at Meta: its HTTP status and JSON body, or null when Meta couldn't be reached. */
  retrieveResponse(id: string): Promise<{ status: number; json: unknown } | null>;
  /** Milliseconds on a clock, for the time budget. Date.now unless a test passes its own. */
  clock?(): number;
}

/** Runs `fn` over `items`, `limit` at a time, starting none after `deadline`. */
async function eachUntil<T>(
  items: readonly T[],
  limit: number,
  deadline: number,
  clock: () => number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length && clock() < deadline) await fn(items[next++]);
    }),
  );
}

/**
 * Settles background responses that finished since they started, from what Meta says they used; one cancelled or
 * failed without reporting usage used nothing and settles at zero. A response Meta no longer has, or one that
 * completed without saying what it used, has its hold taken off the row and the worst case stays as its charge. One
 * that's still running is looked up again next run.
 */
async function sweepHolds(deps: DocsCleanupDeps, now: Date, deadline: number, clock: () => number): Promise<number> {
  const pending = await deps.pendingHolds(new Date(now.getTime() - SWEEP_MIN_AGE_MS), SWEEP_BATCH);
  let settled = 0;
  await eachUntil(pending, CONCURRENCY, deadline, clock, async ({ id, hold }) => {
    const reply = await deps.retrieveResponse(id).catch(() => null);
    if (!reply) return;
    if (reply.status === 404) {
      await deps.claimHold(id);
      return;
    }
    if (reply.status < 200 || reply.status >= 300) return;
    const outcome = await settleFinished(deps, id, hold, reply.json);
    if (outcome === "settled") settled++;
    const status = (reply.json as { status?: unknown } | null)?.status;
    if (outcome === "pending" && TERMINAL_STATUSES.has(String(status))) await deps.claimHold(id);
  });
  return settled;
}

async function cleanKind(
  deps: DocsCleanupDeps,
  kind: DocsObjectKind,
  ttlMs: number,
  now: Date,
  deadline: number,
  clock: () => number,
): Promise<number> {
  const before = new Date(now.getTime() - ttlMs);
  let total = 0;
  for (;;) {
    const ids = await deps.stale(kind, before, BATCH);
    const gone: string[] = [];
    await eachUntil(ids, CONCURRENCY, deadline, clock, async (id) => {
      const outcome = await deps.deleteUpstream(kind, id).catch(() => "failed" as const);
      if (outcome === "gone") gone.push(id);
    });
    if (gone.length) await deps.forget(gone);
    total += gone.length;
    // Caught up, out of time, or left only with ids whose delete fails (they wait for the next run).
    if (ids.length < BATCH || !gone.length || clock() >= deadline) break;
  }
  const abandoned = await deps.stale(kind, new Date(now.getTime() - GIVE_UP_MS), BATCH);
  if (abandoned.length) {
    console.warn(`[docs] cleanup gave up on ${abandoned.length} ${kind} ids older than a week`);
    await deps.forget(abandoned);
  }
  return total;
}

/** Runs the sweep, then both kinds on their own, so one failing doesn't stop the others. Results are in the cron's shape. */
export async function cleanupDocsObjects(deps: DocsCleanupDeps, now: Date = new Date()): Promise<CleanupResult> {
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + DOCS_CLEANUP_BUDGET_MS;
  const run = async (task: () => Promise<number>) => {
    try {
      return { ok: true as const, count: await task() };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  };
  // The sweep reads stored responses, so it goes before the deletes.
  const docsBackground = await run(() => sweepHolds(deps, now, deadline, clock));
  const [docsFiles, docsResponses] = await Promise.all([
    run(() => cleanKind(deps, "file", DOCS_FILE_TTL_MS, now, deadline, clock)),
    run(() => cleanKind(deps, "response", DOCS_RESPONSE_TTL_MS, now, deadline, clock)),
  ]);
  return { docsBackground, docsFiles, docsResponses };
}

/** Deletes a docs object at Meta with `fetch` and the docs key. 2xx and 404 both mean it's gone. */
export async function deleteUpstreamObject(
  fetchFn: typeof fetch,
  baseUrl: string,
  key: string,
  kind: DocsObjectKind,
  id: string,
): Promise<"gone" | "failed"> {
  const path = kind === "file" ? "files" : "responses";
  try {
    const res = await fetchFn(`${baseUrl}/${path}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok || res.status === 404 ? "gone" : "failed";
  } catch {
    return "failed";
  }
}

/** Reads a stored response at Meta with `fetch` and the docs key: its status and JSON, or null when unreachable. */
export async function retrieveUpstreamResponse(
  fetchFn: typeof fetch,
  baseUrl: string,
  key: string,
  id: string,
): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetchFn(`${baseUrl}/responses/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } catch {
    return null;
  }
}

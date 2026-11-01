import { JOB_HEADER } from "@/lib/caps/principal";
import { JOBS_LIMITS } from "@/lib/caps/jobs/limits";
import type { ClaimedRun, NoticeInput } from "@/lib/caps/jobs/store";
import { mintJobToken } from "@/lib/caps/jobs/token";
import { dayWindow } from "@/lib/caps/gate";

/**
 * GET /api/cron/jobs, every 5 minutes (docs/CAPABILITIES.md, section 12): pause schedules whose owner stayed away, queue
 * what's due, then claim queued runs 10 at a time and call each product's route with a new job token. Never a build's
 * run. A timeout leaves the tick running, since the product may still be on it: the next pass after its token runs out
 * retries it or fails it. Any other answer that isn't a success tries once more, then fails and tells the owner.
 */
export interface JobsCronDeps {
  dailyRuns(): number;
  runUsd(): number;
  pauseDays(): number;
  pauseAbsent(now: Date, days: number): Promise<number>;
  queueDueSchedules(now: Date, budgetUsd: number): Promise<number>;
  expireStale(now: Date): Promise<Array<{ id: string; productId: string; name: string }>>;
  claimQueued(limit: number, now: Date, passStartedAt: Date): Promise<ClaimedRun[]>;
  retryOrFail(run: ClaimedRun, error: string, now: Date): Promise<"queued" | "failed" | "stale">;
  addNoticeOnce(input: NoticeInput): Promise<void>;
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
  fetch: typeof fetch;
  now(): Date;
}

export interface JobsCronResult {
  ok: boolean;
  paused: number;
  queued: number;
  fired: number;
  failed: number;
  capped: boolean;
}

const failedNotice = (run: { productId: string; name: string }, why: string): NoticeInput => ({
  productId: run.productId,
  namespace: "live",
  kind: "job_failed",
  title: `Job ${run.name} failed`,
  body: why,
});

/** One tick's call to the product. Only ever POSTs to the product's own live link, with no redirects followed. */
async function fire(run: ClaimedRun, deps: JobsCronDeps): Promise<boolean> {
  const started = deps.now();
  const token = mintJobToken({ productId: run.productId, runId: run.id, expiresAt: new Date(started.getTime() + JOBS_LIMITS.tokenMs) });
  const fail = async (why: string) => {
    if ((await deps.retryOrFail(run, why, deps.now())) === "failed") {
      await deps.addNoticeOnce(failedNotice(run, why));
      return false;
    }
    return true;
  };
  try {
    const res = await deps.fetch(`${run.liveUrl.replace(/\/+$/, "")}/api/jobs/${run.name}`, {
      method: "POST",
      headers: { [JOB_HEADER]: token, "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(JOBS_LIMITS.fireTimeoutMs),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) {
      // The product's handler closes the tick itself. A success that didn't (a route that isn't jobHandler) is a failure.
      return fail("Its route answered without finishing the run.");
    }
    return fail(res.status === 404 ? "The product has no route for this job." : `Its route answered ${res.status}.`);
  } catch (err) {
    // A timeout may still be working: the stale sweep decides later. Anything else never reached the product.
    if ((err as { name?: string })?.name === "TimeoutError") return true;
    return fail("The product couldn't be reached.");
  }
}

export async function runJobsCron(deps: JobsCronDeps): Promise<JobsCronResult> {
  const startedAt = deps.now();
  const out: JobsCronResult = { ok: true, paused: 0, queued: 0, fired: 0, failed: 0, capped: false };
  const budget = deps.runUsd();
  const daily = deps.dailyRuns();
  if (budget === 0 || daily === 0) return { ...out, capped: true };
  out.paused = await deps.pauseAbsent(startedAt, deps.pauseDays());
  out.queued = await deps.queueDueSchedules(startedAt, budget);
  for (const run of await deps.expireStale(startedAt)) await deps.addNoticeOnce(failedNotice(run, "It didn't finish in time."));
  const day = dayWindow(startedAt);
  while (deps.now().getTime() - startedAt.getTime() < JOBS_LIMITS.cronBudgetMs) {
    // Each tick takes one of the day's runs before it's claimed, and a batch that came up short gives the rest back.
    let room = 0;
    while (room < JOBS_LIMITS.concurrency && (await deps.reserveCounter("jobs-runs", day, 1, daily)) !== null) room += 1;
    if (room === 0) {
      out.capped = true;
      break;
    }
    const batch = await deps.claimQueued(room, deps.now(), startedAt);
    if (batch.length < room) await deps.adjustCounter("jobs-runs", day, batch.length - room);
    if (!batch.length) break;
    const results = await Promise.all(batch.map((run) => fire(run, deps).catch(() => false)));
    out.fired += batch.length;
    out.failed += results.filter((ok) => !ok).length;
  }
  return out;
}

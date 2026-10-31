/**
 * The device lab's 5-minute sweep (app/api/cron/native-sweep). Each task runs on its own, as in lib/gateway/cleanup.ts, so
 * AWS being down can't stop silent jobs being re-queued.
 */
import { spendView, syncMacHost } from "@/lib/native/ledger";
import { tickMac, tickWindows, wakeWindows, type BoxAws, type MacTick, type WindowsTick } from "@/lib/native/lab-box";
import { expireQueuedJobs, requeueSilentJobs } from "@/lib/native/queue";

export type TaskResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SweepResult {
  ok: boolean;
  silent: TaskResult<{ requeued: number; failed: number }>;
  expired: TaskResult<{ expired: number; backfilled: number }>;
  windows: TaskResult<WindowsTick>;
  mac: TaskResult<MacTick>;
  spend: TaskResult<{ totalUsd: number; alerting: boolean }>;
}

async function task<T>(run: () => Promise<T>): Promise<TaskResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sweepNative(aws?: BoxAws, now: Date = new Date()): Promise<SweepResult> {
  // Silent jobs first, so a job that just lost its box counts as queued when the Windows plan looks.
  const silent = await task(() => requeueSilentJobs(now));
  const expired = await task(() => expireQueuedJobs(now, aws ? { wakeWindows: () => wakeWindows(aws, now) } : {}));
  const [windows, mac, spend] = await Promise.all([
    task(() => tickWindows(aws, now)),
    task(() => tickMac(aws, now)),
    task(async () => {
      await syncMacHost();
      const view = await spendView();
      if (view.alerting) {
        console.error(`[native/sweep] device lab spend is $${view.lanes.total.usedUsd.toFixed(2)}, past the $${view.alertUsd} alert line.`);
      }
      return { totalUsd: view.lanes.total.usedUsd, alerting: view.alerting };
    }),
  ]);
  const ok = silent.ok && expired.ok && windows.ok && mac.ok && spend.ok;
  return { ok, silent, expired, windows, mac, spend };
}

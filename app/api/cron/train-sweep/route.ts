import { env } from "@/lib/env";
import { cronAuthorized } from "@/lib/gateway/cleanup";
import { recordSweepOk } from "@/lib/train/store";
import { sweepTraining } from "@/lib/train/sweep";

// Every 5 minutes (vercel.json): terminates "mm-train-" Lambda instances whose job is missing, ended or past its
// limits, and fails training jobs stuck before launch (lib/train/sweep.ts). Vercel Cron calls it with
// "Authorization: Bearer <CRON_SECRET>". A run whose Lambda listing answered is noted (recordSweepOk): new jobs start
// only while the last one is recent (app/api/train/shared.ts sweepRunning).
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!env.cronSecret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!cronAuthorized(req.headers.get("authorization"), env.cronSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Without a key no job can launch, so there is nothing to sweep.
  if (!process.env.LAMBDA_API_KEY) return Response.json({ ok: true, skipped: "LAMBDA_API_KEY is not set" });
  const result = await sweepTraining();
  if (result.instances !== null) {
    await recordSweepOk().catch((err) => {
      result.errors.push(`Noting the sweep's run failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  // OPEN_TRAIN: visitor jobs that ended give back the part of their dollars they didn't use, and their GPU slot.
  if (env.openTrain) {
    const { settleVisitorRuns } = await import("@/lib/train/public/limits");
    await settleVisitorRuns().catch((err) => {
      result.errors.push(`Settling visitor runs failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  const ok = result.errors.length === 0;
  if (!ok) console.error("[cron/train-sweep] some tasks failed:", result.errors);
  if (result.terminated.length) console.log("[cron/train-sweep] terminated:", result.terminated);
  return Response.json({ ok, result }, { status: ok ? 200 : 500 });
}

import { sweepCaps } from "@/lib/caps/cleanup";
import { cleanupDocsObjects } from "@/lib/docs/proxy/cleanup";
import { docsCleanupDeps } from "@/lib/docs/proxy/deps";
import { registerGpuSweep } from "@/lib/caps/gpu/sweep";
import { env } from "@/lib/env";
import { cronAuthorized, runCleanup } from "@/lib/gateway/cleanup";
import { deleteRateLimitsBefore } from "@/lib/gateway/store";
import { revokeExpiredBuildTokens } from "@/lib/gateway/tokens";
import { failStaleBuilds } from "@/lib/pipeline/sweep";
import { revokeDisabledProductConnections } from "@/lib/tools/deps";
import { deleteSamTuneUploads, SAM_UPLOAD_KEEP_MS } from "@/lib/train/sam/cleanup";
import { deleteOlderThan } from "@/lib/storage";

// Hourly (vercel.json): expire product uploads and judge screenshots, prune rate-limit windows, revoke expired
// build tokens, fail builds that stopped reporting, and delete the live docs demos' files (after an hour) and stored
// responses (after a day) at Meta. With agents on, it also takes connected accounts off products that are off. Vercel Cron calls it with "Authorization: Bearer <CRON_SECRET>".
export const runtime = "nodejs";
export const maxDuration = 300;

// Wave 3, unit 11. Here, not in lib/caps/cleanup.ts, so the build's steps don't bundle what it reaches. Off with its flags.
registerGpuSweep();

export async function GET(req: Request) {
  if (!env.cronSecret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!cronAuthorized(req.headers.get("authorization"), env.cronSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const [platform, docs, caps, samtune] = await Promise.all([
    runCleanup({
      deleteBlobsOlderThan: deleteOlderThan,
      deleteRateLimitsBefore,
      revokeExpiredBuildTokens,
      failStaleBuilds,
      ...(env.agentsEnabled ? { revokeDisabledProductConnections } : {}),
    }),
    cleanupDocsObjects(docsCleanupDeps()),
    // Wave 3 caps' sweeps (docs/CAPABILITIES.md, 2.9). Null, and left out of the answer, until a cap registers one.
    sweepCaps().catch((err: unknown) => ({ ok: false, removed: 0, failed: [String(err)] })),
    // SAM_TUNE: a run's own photos and look-alikes go after 7 days; its report/ files stay. Left out with the flag off.
    env.samTune ? samTuneSweep() : null,
  ]);
  const results = { ...platform, ...docs, ...(caps ? { caps } : {}), ...(samtune ? { samtune } : {}) };
  const ok = Object.values(results).every((r) => r.ok);
  if (!ok) console.error("[cron/cleanup] some tasks failed:", results);
  return Response.json({ ok, results }, { status: ok ? 200 : 500 });
}

async function samTuneSweep(): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    return { ok: true, count: await deleteSamTuneUploads(new Date(Date.now() - SAM_UPLOAD_KEEP_MS)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

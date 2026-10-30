import { cleanupDocsObjects } from "@/lib/docs/proxy/cleanup";
import { docsCleanupDeps } from "@/lib/docs/proxy/deps";
import { env } from "@/lib/env";
import { cronAuthorized, runCleanup } from "@/lib/gateway/cleanup";
import { deleteRateLimitsBefore } from "@/lib/gateway/store";
import { revokeExpiredBuildTokens } from "@/lib/gateway/tokens";
import { failStaleBuilds } from "@/lib/pipeline/sweep";
import { deleteOlderThan } from "@/lib/storage";

// Hourly (vercel.json): expire product uploads and judge screenshots, prune rate-limit windows, revoke expired
// build tokens, fail builds that stopped reporting, and delete the live docs demos' files (after an hour) and stored
// responses (after a day) at Meta. Vercel Cron calls it with "Authorization: Bearer <CRON_SECRET>".
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!env.cronSecret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!cronAuthorized(req.headers.get("authorization"), env.cronSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const [platform, docs] = await Promise.all([
    runCleanup({
      deleteBlobsOlderThan: deleteOlderThan,
      deleteRateLimitsBefore,
      revokeExpiredBuildTokens,
      failStaleBuilds,
    }),
    cleanupDocsObjects(docsCleanupDeps()),
  ]);
  const results = { ...platform, ...docs };
  const ok = Object.values(results).every((r) => r.ok);
  if (!ok) console.error("[cron/cleanup] some tasks failed:", results);
  return Response.json({ ok, results }, { status: ok ? 200 : 500 });
}

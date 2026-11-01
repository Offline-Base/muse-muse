import { env } from "@/lib/env";
import { cronAuthorized } from "@/lib/gateway/cleanup";
import { hostDeps } from "@/lib/train/host/deps";
import { sweepEndpoints } from "@/lib/train/host/service";

// Every 5 minutes (vercel.json): stops any hosted endpoint past its limits (lib/train/host/service.ts). Runs with
// HOST_TUNED off too, so an endpoint can't outlive the flag. Then it stops everything, and with nothing running only reads
// the table. A failure answers 500, so it shows in Vercel's cron log.
export const runtime = "nodejs";
export const maxDuration = 280;

export async function GET(req: Request) {
  if (!env.cronSecret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!cronAuthorized(req.headers.get("authorization"), env.cronSecret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const result = await sweepEndpoints(hostDeps());
  if (result.stopped.length || result.orphans.length) console.log("[cron/host-sweep] stopped:", result);
  if (!result.errors.length) return Response.json({ ok: true, result });
  console.error("[cron/host-sweep] some tasks failed:", result.errors);
  // With the flag off this table may not exist yet on a deployment that hasn't migrated: nothing can be running there.
  return Response.json({ ok: false, result }, { status: env.hostTuned ? 500 : 200 });
}

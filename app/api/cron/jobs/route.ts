import { env } from "@/lib/env";
import { cronAuthorized } from "@/lib/gateway/cleanup";

// Every 5 minutes (vercel.json): starts due schedules and queued job runs on owners' live products
// (docs/CAPABILITIES.md, section 12). With the jobs cap off it reads nothing. Vercel Cron calls it with
// "Authorization: Bearer <CRON_SECRET>".
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!env.cronSecret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!cronAuthorized(req.headers.get("authorization"), env.cronSecret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!env.servedCaps.includes("jobs")) return Response.json({ ok: true, skipped: "Jobs are off" });
  const [{ runJobsCron }, { jobsCronDeps }] = await Promise.all([import("@/lib/caps/jobs/cron"), import("@/lib/caps/jobs/deps")]);
  const result = await runJobsCron(jobsCronDeps());
  return Response.json(result, { status: result.ok ? 200 : 500 });
}

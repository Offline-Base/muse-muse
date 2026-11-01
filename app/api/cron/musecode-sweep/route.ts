import { env } from "@/lib/env";
import { cronAuthorized } from "@/lib/gateway/cleanup";

// Every 2 minutes (vercel.json): moves on the Muse Code sessions nobody is following, so one that has finished ends, keeps
// its files and gives back its slots while its sandbox is still up (lib/caps/code/musecode/sweep.ts,
// docs/CAPABILITIES.md 15b). A sandbox outlives its session's limit by 3 minutes, which is why every 2 and not every 5.
// With MUSE_CODE_ENABLED off it reads nothing. Vercel Cron calls it with "Authorization: Bearer <CRON_SECRET>".
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!env.cronSecret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!cronAuthorized(req.headers.get("authorization"), env.cronSecret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!env.servedCaps.includes("code") || !env.museCodeEnabled) return Response.json({ ok: true, skipped: "Muse Code is off" });
  const { sweepActiveMuseCode } = await import("@/lib/caps/code/musecode/sweep");
  return Response.json({ ok: true, ended: await sweepActiveMuseCode(new Date()) });
}

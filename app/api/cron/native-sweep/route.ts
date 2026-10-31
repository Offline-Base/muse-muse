import { env } from "@/lib/env";
import { cronAuthorized } from "@/lib/gateway/cleanup";
import { sweepNative } from "@/lib/native/sweep";

// Every 5 minutes (vercel.json): re-queues jobs whose box went quiet, expires jobs that waited too long, keeps the lab boxes
// and their bills in order (lib/native/lab-box.ts) and brings the ledger up to date. With NATIVE_LAB off it's a 404 and
// touches nothing. Vercel Cron calls it with "Authorization: Bearer <CRON_SECRET>".
export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!env.nativeLab) return Response.json({ error: "not_found" }, { status: 404 });
  if (!env.cronSecret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!cronAuthorized(req.headers.get("authorization"), env.cronSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await sweepNative();
  if (!result.ok) console.error("[cron/native-sweep] some tasks failed:", result);
  return Response.json(result, { status: result.ok ? 200 : 500 });
}

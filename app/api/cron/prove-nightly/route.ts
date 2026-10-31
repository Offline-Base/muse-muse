import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { env } from "@/lib/env";
import { cronAuthorized } from "@/lib/gateway/cleanup";
import { proveProduct } from "@/lib/pipeline/prove";
import { nightlyCandidates } from "@/lib/pipeline/prove-nightly";

// Nightly (vercel.json), off unless PROVE_NIGHTLY is on: re-checks a few live products on Muse Spark Contributor, with no
// new video (docs/PRODUCT_OUTPUTS.md). Vercel Cron calls it with "Authorization: Bearer <CRON_SECRET>".
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!env.cronSecret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!cronAuthorized(req.headers.get("authorization"), env.cronSecret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!env.proveNightly) return Response.json({ ok: true, off: true, started: 0 });
  const picked = await nightlyCandidates(env.proveNightlyProducts);
  let started = 0;
  for (const { buildId } of picked) {
    try {
      await start(proveProduct, [{ buildId, runId: randomUUID(), origin: "nightly" as const }]);
      started++;
    } catch (err) {
      console.error(`[cron/prove-nightly] ${buildId}`, err);
    }
  }
  return Response.json({ ok: true, started });
}

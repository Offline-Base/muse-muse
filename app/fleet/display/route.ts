/**
 * GET /fleet/display: the e-ink fleet screen for the Boox in front of the Jetsons (lib/fleet/display.ts). Plain HTML, no
 * site chrome and no JavaScript, refreshing itself every minute. With FLEET_DISPLAY_CODE set it needs ?k=<code>.
 */
import { connection } from "next/server";
import { env } from "@/lib/env";
import { loadDisplay, renderDisplay } from "@/lib/fleet/display";

export async function GET(req: Request): Promise<Response> {
  await connection();
  const code = env.fleetDisplayCode;
  if (code && new URL(req.url).searchParams.get("k") !== code) return new Response("Not found", { status: 404 });
  const data = await loadDisplay({ base: env.fleetDisplayUrl, token: env.fleetViewerToken });
  return new Response(renderDisplay(data, new Date()), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

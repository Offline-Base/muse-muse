/**
 * GET /fleet/display: the e-ink fleet screen for the Boox in front of the Jetsons (lib/fleet/display.ts). Plain HTML, no
 * site chrome and no JavaScript, refreshing itself every minute. With FLEET_DISPLAY_CODE set it needs ?k=<code>.
 * ?jolly=up|down|around picks Jolly's video for filming; otherwise the fleet's state picks it (jollyMood). ?g= picks the
 * graph (tokens, memory, heat, power); each refresh moves to the next one the data can draw.
 */
import { connection } from "next/server";
import { env } from "@/lib/env";
import { type JollyMood, loadDisplay, renderDisplay } from "@/lib/fleet/display";

const MOODS: readonly JollyMood[] = ["up", "down", "around"];

export async function GET(req: Request): Promise<Response> {
  await connection();
  const params = new URL(req.url).searchParams;
  const code = env.fleetDisplayCode;
  if (code && params.get("k") !== code) return new Response("Not found", { status: 404 });
  const data = await loadDisplay({ base: env.fleetDisplayUrl, token: env.fleetViewerToken });
  return new Response(renderDisplay(data, new Date(), {
      mood: MOODS.find((m) => m === params.get("jolly")),
      graph: params.get("g"),
      keep: Object.fromEntries(["k", "jolly"].flatMap((name) => (params.get(name) ? [[name, params.get(name)!]] : []))),
      roverSrc: env.fleetDisplayRover ? `/fleet/display/rover${code ? `?k=${encodeURIComponent(code)}` : ""}` : null,
    }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=50, stale-while-revalidate=60", "x-robots-tag": "noindex" },
  });
}

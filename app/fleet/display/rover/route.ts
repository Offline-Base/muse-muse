/**
 * GET /fleet/display/rover: the rover's camera, outlined by SAM 3.1, as one SVG for the e-ink display's <img>
 * (lib/fleet/rover-view.ts). Behind FLEET_DISPLAY_ROVER, and FLEET_DISPLAY_CODE when that is set. Cached on the CDN, so the
 * rover and the SAM board see about one look every few minutes however many screens are open.
 */
import { connection } from "next/server";
import { samLook, fleetSamSettings } from "@/lib/caps/fleet/sam";
import { callDeviceTool, deviceConfig } from "@/lib/device/client";
import { env } from "@/lib/env";
import { ROVER_VIEW, roverFrame, roverSvg } from "@/lib/fleet/rover-view";
import { acquireInFlight, hitRateLimits, releaseInFlight } from "@/lib/gateway/store";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req: Request): Promise<Response> {
  await connection();
  const code = env.fleetDisplayCode;
  if (!env.fleetDisplayRover || (code && new URL(req.url).searchParams.get("k") !== code)) return new Response("Not found", { status: 404 });
  const prompt = env.fleetRoverPrompt;
  const frame = await roverFrame(
    {
      camera: () => deviceConfig({ quiet: true }),
      sam: () => fleetSamSettings(),
      capture: (config, args) => callDeviceTool(config, "capture_image", args),
      look: (settings, look, signal) => samLook(settings, { fetch: (url, init) => fetch(url, init) }, look, signal),
      hitRateLimits,
      acquireInFlight,
      releaseInFlight,
    },
    prompt,
  );
  // A frame with SAM's outlines keeps longest; a failure is retried sooner.
  const keep = frame.outlined ? ROVER_VIEW.cacheS : 60;
  return new Response(roverSvg(frame, prompt, new Date()), {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": `public, max-age=0, s-maxage=${keep}, stale-while-revalidate=600`,
      "x-robots-tag": "noindex",
    },
  });
}

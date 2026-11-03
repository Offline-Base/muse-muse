import { fleetSamDeps } from "@/lib/caps/fleet/deps";
import { handleFleetSegment } from "@/lib/caps/fleet/sam";

// Meta SAM 3.1 on an office Jetson, for a hosted product's segmentOrEdge (lib/caps/fleet/sam.ts). 404 unknown_endpoint while
// FLEET_SAM is off. A look is at most 100 s (FLEET_SAM_TIMEOUT_MS).
export const runtime = "nodejs";
export const maxDuration = 120;

async function handle(req: Request) {
  return handleFleetSegment(req, fleetSamDeps());
}

export const GET = handle;
export const POST = handle;

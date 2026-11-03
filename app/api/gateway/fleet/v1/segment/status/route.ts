import { fleetSamDeps } from "@/lib/caps/fleet/deps";
import { handleFleetSamStatus } from "@/lib/edge/fleet-status";

// Whether the office board a hosted product's segmentOrEdge reaches is online for it, for the product's board status line
// (lib/edge/fleet-status.ts). 404 unknown_endpoint while FLEET_SAM is off. It sends no photo and asks no model.
export const runtime = "nodejs";
export const maxDuration = 20;

async function handle(req: Request) {
  return handleFleetSamStatus(req, fleetSamDeps());
}

export const GET = handle;
export const POST = handle;

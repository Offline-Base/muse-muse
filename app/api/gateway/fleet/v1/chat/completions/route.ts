import { fleetDeps } from "@/lib/caps/fleet/deps";
import { handleFleetChat } from "@/lib/caps/fleet/handler";

// One whole chat answer from the Jetson fleet's boards (docs/CAPABILITIES.md, 17b). 404 unknown_endpoint while FLEET_PRODUCTS
// is off. A fleet call is at most 100 s (FLEET_TIMEOUT_MS).
export const runtime = "nodejs";
export const maxDuration = 120;

async function handle(req: Request) {
  return handleFleetChat(req, fleetDeps());
}

export const GET = handle;
export const POST = handle;

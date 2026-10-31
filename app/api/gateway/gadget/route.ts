import { callDeviceTool, deviceConfig, listDeviceTools } from "@/lib/device/client";
import { handleGadgetCall, handleGadgetTools, type GadgetDeps } from "@/lib/gateway/gadget";
import { hitRateLimits, productStatusById } from "@/lib/gateway/store";
import { findToken } from "@/lib/gateway/tokens";

// Gadgets for products (lib/gateway/gadget.ts, docs/GADGETS.md). A photo takes a few seconds and a recording up to 30,
// plus the trip to the board.
export const runtime = "nodejs";
export const maxDuration = 60;

const deps: GadgetDeps = {
  findToken,
  productStatus: productStatusById,
  hitRateLimits,
  board() {
    // One board for every product for now: the one the platform has connected. Per-owner boards come later.
    const config = deviceConfig();
    return config
      ? { listTools: () => listDeviceTools(config), callTool: (name, args) => callDeviceTool(config, name, args) }
      : null;
  },
};

export async function GET(req: Request) {
  return handleGadgetTools(req, deps);
}

export async function POST(req: Request) {
  return handleGadgetCall(req, deps);
}

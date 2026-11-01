import { linkedBoardFor } from "@/lib/caps/hardware/board";
import { boardToolsOn, driveToolsUsable, gadgetOwnerCheckOn } from "@/lib/caps/hardware/flags";
import { callDeviceTool, deviceConfig, listDeviceTools } from "@/lib/device/client";
import { env } from "@/lib/env";
import { handleGadgetCall, handleGadgetTools, type GadgetDeps, type GadgetDrive } from "@/lib/gateway/gadget";
import { hitRateLimits, productStatusById } from "@/lib/gateway/store";
import { findToken } from "@/lib/gateway/tokens";

// Gadgets for products (lib/gateway/gadget.ts, docs/GADGETS.md). A photo takes a few seconds and a recording up to 30,
// plus the trip to the board.
export const runtime = "nodejs";
export const maxDuration = 60;

/** Drive export's code (plans, the kit, the lab's rows) loads only for a drive tool call. */
const drive: GadgetDrive = {
  call: async (call) => (await import("@/lib/device/drive-product-deps")).runProductDrive(call),
};

const deps: GadgetDeps = {
  // Wave 3, unit 13 (docs/CAPABILITIES.md, section 19). Off: every line below is as it was.
  get linkedBoard() {
    return gadgetOwnerCheckOn() ? linkedBoardFor : undefined;
  },
  get boardTools() {
    return boardToolsOn();
  },
  // docs/DRIVE_EXPORT.md, "From a product". Off, the cap unserved included: every line below is as it was. A token made while
  // the cap was on keeps its markers, so the markers can't be what stops it.
  get drive() {
    return driveToolsUsable() && env.servedCaps.includes("hardware") ? drive : undefined;
  },
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

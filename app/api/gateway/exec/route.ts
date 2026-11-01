import { codeDeps } from "@/lib/caps/code/deps";
import { handleExec } from "@/lib/caps/code/handler";

// Runs a product's Python or Node program in a fresh sandbox with no network (docs/CAPABILITIES.md, section 15). The
// checks are the cap gate's (lib/caps/gate.ts). 404 unknown_endpoint while CODE_EXEC or CODE_ENABLED is off, or the code
// cap isn't ready.
export const runtime = "nodejs";
// A run is at most 15 s, plus starting and stopping its sandbox.
export const maxDuration = 90;

async function handle(req: Request) {
  return handleExec(req, codeDeps());
}

export const GET = handle;
export const POST = handle;

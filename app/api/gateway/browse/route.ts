import { codeDeps } from "@/lib/caps/code/deps";
import { handleBrowse } from "@/lib/caps/code/handler";

// Opens one page whose address the person typed, in a sandbox that reaches only that site (docs/CAPABILITIES.md,
// section 15). The checks are the cap gate's (lib/caps/gate.ts). 404 unknown_endpoint while CODE_BROWSE or CODE_ENABLED
// is off, or the code cap isn't ready.
export const runtime = "nodejs";
// A page gets 30 s, plus starting and stopping its sandbox.
export const maxDuration = 120;

async function handle(req: Request) {
  return handleBrowse(req, codeDeps());
}

export const GET = handle;
export const POST = handle;

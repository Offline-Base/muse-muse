import { museCodeDeps } from "@/lib/caps/code/musecode/deps";
import { handleCodeSessions } from "@/lib/caps/code/musecode/handler";

// Muse Code sessions in products (docs/CAPABILITIES.md, 15b): start, events, steer, stop, result. The checks are the cap
// gate's (lib/caps/gate.ts). 404 unknown_endpoint while MUSE_CODE_ENABLED or CODE_ENABLED is off, or the code cap isn't
// ready, and nothing is touched.
export const runtime = "nodejs";
// A start makes a sandbox, installs the bridge's SDK and starts it: about 5 to 10 s (the spike), 75 s at most.
export const maxDuration = 120;

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return handleCodeSessions(req, path ?? [], museCodeDeps());
}

export const GET = handle;
export const POST = handle;

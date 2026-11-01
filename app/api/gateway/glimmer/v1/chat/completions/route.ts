import { glimmerDeps } from "@/lib/caps/gpu/deps";
import { handleGlimmerChat } from "@/lib/caps/gpu/handler";

// One chat answer from the hosted Muse Glimmer, during a demo window (docs/CAPABILITIES.md, section 17). 404
// unknown_endpoint while GPU_GLIMMER_SHARED is off. A GPU call is at most 150 s (serveTiming.chatMs).
export const runtime = "nodejs";
export const maxDuration = 180;

async function handle(req: Request) {
  return handleGlimmerChat(req, glimmerDeps());
}

export const GET = handle;
export const POST = handle;

import { platformDeps } from "@/lib/caps/platform/deps";
import { handlePlatform } from "@/lib/caps/platform/handler";

// Platform powers (docs/PLATFORM_POWERS.md). The checks are the cap gate's (lib/caps/gate.ts). 404 unknown_endpoint while
// PLATFORM_POWERS is off or the cap isn't ready, and nothing is touched.
export const runtime = "nodejs";
// A sandbox start makes a sandbox and starts its bridge: 75 s at most, as for /code/sessions.
export const maxDuration = 120;

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return handlePlatform(req, path ?? [], platformDeps());
}

export const GET = handle;
export const POST = handle;

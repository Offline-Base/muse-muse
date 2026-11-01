import { liveDeps } from "@/lib/caps/live/deps";
import { handleLive } from "@/lib/caps/live/handler";

// Live shared updates (docs/CAPABILITIES.md, section 13): a read ticket, and a stream the browser opens with it. 404
// unknown_endpoint while LIVE_ENABLED, LIVE_UPDATES or the data cap is off, or the live cap isn't ready. A stream closes
// itself at 55 s and the browser reconnects.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  return handleLive(req, path, liveDeps());
}

export const GET = handle;
export const POST = handle;

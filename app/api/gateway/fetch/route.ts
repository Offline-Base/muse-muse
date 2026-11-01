import { connectDeps } from "@/lib/caps/connect/deps";
import { handleFetch } from "@/lib/caps/connect/handler";

// One call to an allowlisted keyless public API, cached (docs/CAPABILITIES.md, section 11). 404 unknown_endpoint while
// CONNECT_ENABLED is off or the connect cap isn't ready.
export const runtime = "nodejs";

export const POST = (req: Request) => handleFetch(req, connectDeps());
export const GET = POST;

import { connectDeps } from "@/lib/caps/connect/deps";
import { handleSend } from "@/lib/caps/connect/handler";

// A message sent with the product owner's own key, after one confirmation (docs/CAPABILITIES.md, section 11). 404
// unknown_endpoint while CONNECT_SENDS is off, on production without CONNECT_SENDS_PRODUCTION, or the cap isn't ready.
export const runtime = "nodejs";

export const POST = (req: Request) => handleSend(req, connectDeps());
export const GET = POST;

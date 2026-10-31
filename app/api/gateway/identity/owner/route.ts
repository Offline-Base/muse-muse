import { toolsDeps } from "@/lib/tools/deps";
import { handleOwnerExchange } from "@/lib/tools/handler";

// A product trades an owner code for a 12-hour owner session (docs/AGENT_TOOLS.md).
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleOwnerExchange(req, toolsDeps());
}

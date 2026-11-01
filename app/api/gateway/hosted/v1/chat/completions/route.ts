import { hostDeps } from "@/lib/train/host/deps";
import { handleHostedChat } from "@/lib/train/host/gateway";

// One answer from a hosted tuned model (lib/train/host/gateway.ts). 404 unknown_endpoint with HOST_TUNED off.
export const runtime = "nodejs";
export const maxDuration = 180;

async function handle(req: Request) {
  return handleHostedChat(req, hostDeps());
}

export const GET = handle;
export const POST = handle;

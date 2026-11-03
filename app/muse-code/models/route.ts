import { env } from "@/lib/env";
import { handleSandboxMeta } from "@/lib/sandbox/host/meta-proxy";

// Muse Code asks for its model catalog at the root of its endpoint's host, whatever the base_url's path
// (docs/spikes/musecode-2026-10-31). For Modal build sandboxes only (SANDBOX_HOST=modal); 404 on the default host.
export const runtime = "nodejs";
export const maxDuration = 60;

async function handle(req: Request) {
  return handleSandboxMeta(req, ["muse-code", "models"], { enabled: env.sandboxHost === "modal", modelApiKey: () => env.modelApiKey });
}

export const GET = handle;
export const POST = handle;

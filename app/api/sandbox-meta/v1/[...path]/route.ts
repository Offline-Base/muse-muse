import { env } from "@/lib/env";
import { handleSandboxMeta } from "@/lib/sandbox/host/meta-proxy";

// Meta proxy for Modal build sandboxes (SANDBOX_HOST=modal, docs/MODAL_HOST.md). Answers 404 on the default host.
// The checks live in lib/sandbox/host/meta-proxy.ts.
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return handleSandboxMeta(req, ["v1", ...path], { enabled: env.sandboxHost === "modal", modelApiKey: () => env.modelApiKey });
}

export const GET = handle;
export const POST = handle;

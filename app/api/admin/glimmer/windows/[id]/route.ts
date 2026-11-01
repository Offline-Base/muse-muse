import { AuthError, requireAdmin } from "@/lib/auth";
import { windowDeps } from "@/lib/caps/gpu/deps";
import { closeWindow, windowView } from "@/lib/caps/gpu/windows";
import { env } from "@/lib/env";

// Closes a demo window (docs/CAPABILITIES.md, section 17): products lose it at once and its GPU is asked to stop. Admins only.
export const runtime = "nodejs";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!env.gpuGlimmerShared) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  const { id } = await params;
  const window = await closeWindow(id, windowDeps());
  if (!window) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ window: windowView(window) });
}

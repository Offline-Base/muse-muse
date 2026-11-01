import { AuthError, requireAdmin } from "@/lib/auth";
import { windowDeps } from "@/lib/caps/gpu/deps";
import { listGlimmerWindows } from "@/lib/caps/gpu/store";
import { openWindow, windowView } from "@/lib/caps/gpu/windows";
import { env } from "@/lib/env";

// Demo windows of the shared Glimmer endpoint (docs/CAPABILITIES.md, section 17). Admins only. Opening one starts a GPU.
// 404 while GPU_GLIMMER_SHARED is off, before anything is read.
export const runtime = "nodejs";
// launchJob asks Lambda for its GPU list and starts the job's workflow.
export const maxDuration = 60;

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

async function admin(): Promise<{ id: string } | Response> {
  try {
    return await requireAdmin();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

export async function GET() {
  if (!env.gpuGlimmerShared) return notFound();
  const user = await admin();
  if (user instanceof Response) return user;
  return Response.json({ windows: (await listGlimmerWindows()).map(windowView) });
}

export async function POST(req: Request) {
  if (!env.gpuGlimmerShared) return notFound();
  const user = await admin();
  if (user instanceof Response) return user;
  const body = (await req.json().catch(() => null)) as { adapterJobId?: unknown; minutes?: unknown; instanceType?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ code: "invalid_arguments", error: "Send a JSON object." }, { status: 400 });
  const result = await openWindow(body, { userId: user.id }, windowDeps());
  if (!result.ok) return Response.json({ code: result.code, error: result.message, ...result.body }, { status: result.status });
  return Response.json({ window: windowView(result.window) }, { status: 201 });
}

import { env } from "@/lib/env";
import { hostDeps } from "@/lib/train/host/deps";
import { hostFacts } from "@/lib/train/host/facts";
import { hostErrorResponse } from "@/lib/train/host/gateway";
import { deployer } from "@/lib/train/host/who";
import { loadHostView } from "@/lib/train/host/page";
import { deployEndpoint, refreshEndpoint, stopEndpoint } from "@/lib/train/host/service";
import { HOST_PROVIDERS, type HostProvider } from "@/lib/train/host/types";
import { getAdapterSource } from "@/lib/train/store";

// A tuned model's hosted endpoint: read it, start it, stop it. 404 with HOST_TUNED off, before anything is read. Who may:
// mayDeploy. Starting can run a provider's tool in a sandbox for a few minutes.
export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };
const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

const refusal = async (err: unknown) => {
  const res = hostErrorResponse(err);
  const body = (await res.json()) as { error: { code: string; message: string } };
  return Response.json({ code: body.error.code, error: body.error.message }, { status: res.status });
};

/** The view, after asking the provider about a starting endpoint, so the page moves on without waiting for the sweep. */
export async function GET(_req: Request, { params }: Ctx) {
  if (!env.hostTuned) return notFound();
  const user = await deployer();
  if (user instanceof Response) return user;
  const { id } = await params;
  const deps = hostDeps();
  const now = new Date();
  const mine = (await deps.rows(now)).find((e) => e.adapterJobId === id && e.status === "starting");
  if (mine) await refreshEndpoint(mine, deps, now);
  const view = await loadHostView(id, now);
  return view ? Response.json({ view }) : notFound();
}

export async function POST(req: Request, { params }: Ctx) {
  if (!env.hostTuned) return notFound();
  const user = await deployer();
  if (user instanceof Response) return user;
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { provider?: unknown } | null;
  const provider = body?.provider;
  if (typeof provider !== "string" || !HOST_PROVIDERS.includes(provider as HostProvider)) return Response.json({ code: "invalid_arguments", error: "Pick Fireworks, Modal, Baseten or Lambda." }, { status: 400 });
  const source = await getAdapterSource(id);
  if (!source) return notFound();
  try {
    const { ownerToken } = await deployEndpoint({ provider: provider as HostProvider, facts: hostFacts(source.job, source.metrics), callerId: user.id }, hostDeps());
    // The one time this token is sent. Only its hash is kept.
    return Response.json({ ownerToken, view: await loadHostView(id) }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return refusal(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  if (!env.hostTuned) return notFound();
  const user = await deployer();
  if (user instanceof Response) return user;
  const { id } = await params;
  const deps = hostDeps();
  const row = (await deps.rows(new Date())).find((e) => e.adapterJobId === id && (e.status === "starting" || e.status === "live" || e.status === "stopping"));
  if (row) {
    try {
      await stopEndpoint(row, "person", deps);
    } catch (err) {
      // It is marked stopping, so it gets no traffic, and the sweep tries again.
      console.error("[host] stop", err instanceof Error ? err.name : "error");
    }
  }
  return Response.json({ view: await loadHostView(id) });
}

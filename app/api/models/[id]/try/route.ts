import { isCrossSite } from "@/lib/auth";
import { clientIpKey } from "@/lib/gateway/extract";
import { tryDeps } from "@/lib/train/host/deps";
import { hostFacts } from "@/lib/train/host/facts";
import { hostErrorResponse } from "@/lib/train/host/gateway";
import { refreshEndpoint } from "@/lib/train/host/service";
import { askAsVisitor, tryMessagesProblem, tryView, type TryAsk } from "@/lib/train/host/try";
import { env } from "@/lib/env";
import { getAdapterSource, getResultJob } from "@/lib/train/store";

// The public Try box: read its state, and one answer. 404 with TRY_TUNED or HOST_TUNED off, or for a model with no public
// page, before anything else is read. Asking never starts anything: POST ./wake does.
export const runtime = "nodejs";
export const maxDuration = 180;

type Ctx = { params: Promise<{ id: string }> };
const noStore = { "cache-control": "no-store" };
const notFound = () => Response.json({ error: "not_found" }, { status: 404 });
const BODY_MAX = 32 * 1024;

function parseBody(text: string): { variant?: unknown; messages?: unknown } | null {
  try {
    return JSON.parse(text) as { variant?: unknown; messages?: unknown } | null;
  } catch {
    return null;
  }
}

async function publicSource(id: string) {
  if (!env.tryTuned || !env.hostTuned) return null;
  if (!(await getResultJob(id))) return null;
  return getAdapterSource(id);
}

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const source = await publicSource(id);
  if (!source) return notFound();
  const deps = tryDeps();
  const now = new Date();
  const starting = (await deps.rows(now)).find((e) => e.adapterJobId === id && e.status === "starting");
  if (starting) {
    // Many open pages look at one endpoint: only a couple of looks a minute reach the provider.
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const key = `try:refresh:${starting.id}`;
    const seen = await deps.hitRateLimits([key], minute);
    if ((seen[key] ?? 0) <= 2) await refreshEndpoint(starting, deps, now);
  }
  return Response.json({ view: await tryView(hostFacts(source.job, source.metrics), deps, now) }, { headers: noStore });
}

export async function POST(req: Request, { params }: Ctx) {
  if (isCrossSite(req.headers)) return Response.json({ code: "cross_site", error: "Ask from the model's page." }, { status: 403 });
  const { id } = await params;
  const source = await publicSource(id);
  if (!source) return notFound();
  const text = await req.text();
  if (Buffer.byteLength(text) > BODY_MAX) return Response.json({ code: "too_large", error: "That's too long." }, { status: 413 });
  const body = parseBody(text);
  const problem = tryMessagesProblem(body?.messages);
  if (problem) return Response.json({ code: "invalid_arguments", error: problem }, { status: 400 });
  const system = typeof source.metrics?.system === "string" && source.metrics.system.startsWith("You are ") ? source.metrics.system : null;
  const ask: TryAsk = {
    facts: hostFacts(source.job, source.metrics),
    visitor: clientIpKey(req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")) ?? "unknown",
    variant: body?.variant === "base" ? "base" : "tuned",
    messages: (body!.messages as TryAsk["messages"]).map((m) => ({ role: m.role, content: m.content })),
    system,
    signal: req.signal,
  };
  try {
    return Response.json(await askAsVisitor(ask, tryDeps()), { headers: noStore });
  } catch (err) {
    const res = hostErrorResponse(err);
    const out = (await res.json()) as { error: { code: string; message: string } };
    const retry = res.headers.get("retry-after");
    return Response.json({ code: out.error.code, error: out.error.message, ...(retry ? { retryAfterSeconds: Number(retry) } : {}) }, { status: res.status, headers: noStore });
  }
}

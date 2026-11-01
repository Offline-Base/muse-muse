import { isCrossSite } from "@/lib/auth";
import { env } from "@/lib/env";
import { clientIpKey } from "@/lib/gateway/extract";
import { tryDeps } from "@/lib/train/host/deps";
import { hostFacts } from "@/lib/train/host/facts";
import { hostErrorResponse } from "@/lib/train/host/gateway";
import { tryView, wakeForVisitor } from "@/lib/train/host/try";
import { getAdapterSource, getResultJob } from "@/lib/train/store";

// A visitor wakes a tuned model on its public page, within lib/train/host/try.ts's limits. Starting can run a provider's
// tool in a sandbox for a few minutes. 404 with either flag off, or for a model with no public page.
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "cache-control": "no-store" };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!env.tryTuned || !env.hostTuned) return Response.json({ error: "not_found" }, { status: 404 });
  if (isCrossSite(req.headers)) return Response.json({ code: "cross_site", error: "Wake it from the model's page." }, { status: 403 });
  const { id } = await params;
  if (!(await getResultJob(id))) return Response.json({ error: "not_found" }, { status: 404 });
  const source = await getAdapterSource(id);
  if (!source) return Response.json({ error: "not_found" }, { status: 404 });
  const facts = hostFacts(source.job, source.metrics);
  const deps = tryDeps();
  const visitor = clientIpKey(req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")) ?? "unknown";
  try {
    await wakeForVisitor({ facts, visitor }, deps);
    return Response.json({ view: await tryView(facts, deps) }, { status: 202, headers: noStore });
  } catch (err) {
    const res = hostErrorResponse(err);
    const out = (await res.json()) as { error: { code: string; message: string } };
    return Response.json({ code: out.error.code, error: out.error.message }, { status: res.status, headers: noStore });
  }
}

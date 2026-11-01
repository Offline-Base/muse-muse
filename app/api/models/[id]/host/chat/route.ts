import { env } from "@/lib/env";
import { hostDeps } from "@/lib/train/host/deps";
import { hostErrorResponse, readHostedCall } from "@/lib/train/host/gateway";
import { deployer } from "@/lib/train/host/who";
import { chatOnEndpoint } from "@/lib/train/host/service";

// The Run it section's chat box. Same limits as the gateway route, for someone who may deploy, and metered the same way.
// The browser never sees the provider's address or key.
export const runtime = "nodejs";
export const maxDuration = 180;

const PER_MINUTE = 20;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!env.hostTuned) return Response.json({ error: "not_found" }, { status: 404 });
  const user = await deployer();
  if (user instanceof Response) return user;
  const { id } = await params;
  const call = readHostedCall(await req.text());
  const reply = async (res: Response) => {
    const body = (await res.json()) as { error: { code: string; message: string } };
    return Response.json({ code: body.error.code, error: body.error.message }, { status: res.status, headers: { ...(res.headers.get("retry-after") ? { "retry-after": res.headers.get("retry-after")! } : {}) } });
  };
  if (call instanceof Response) return reply(call);
  const deps = hostDeps();
  try {
    const now = new Date();
    const endpoint = await deps.byModel(id);
    if (!endpoint) return Response.json({ code: "endpoint_closed", error: "This model isn't running right now." }, { status: 503 });
    const key = `hosted:box:${user.id}`;
    const counts = await deps.hitRateLimits([key], new Date(Math.floor(now.getTime() / 60_000) * 60_000));
    if ((counts[key] ?? 0) > PER_MINUTE) return Response.json({ code: "rate_limited", error: `The limit is ${PER_MINUTE} questions a minute.` }, { status: 429 });
    const answer = await chatOnEndpoint(endpoint, { messages: call.messages, stop: call.stop, maxTokens: call.maxTokens, signal: req.signal }, deps, now);
    await deps
      .recordUsage({ source: "hosted", endpoint: "/models/host/chat" }, [{ model: `hosted-${endpoint.provider}`, inputTokens: answer.usage.input, cachedInputTokens: 0, outputTokens: answer.usage.output, units: 1, costUsd: 0 }])
      .catch((err) => console.error("[hosted] metering failed:", err instanceof Error ? err.name : "error"));
    return Response.json({ text: answer.text, finish: answer.finish }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return reply(hostErrorResponse(err));
  }
}

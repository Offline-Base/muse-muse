// Platform file (Muse Muse platform services). Keep this file as it is.
//
// POST /api/musemuse/live-ticket {collection, scope}: asks the gateway for a read ticket for this browser, which
// useLive opens the stream with. The product's token stays on this server. The gateway decides who may read what.
import { identityHeaders, newVisitorId, visitorCookie, visitorId } from "@/lib/platform/identity";
import { userHeaders } from "@/lib/platform/user";

export async function POST(request: Request): Promise<Response> {
  // Only this product's own pages ask for tickets. Older browsers don't send the header, and SameSite covers them.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return Response.json({ error: "This only works from the product's own page." }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { collection?: unknown; scope?: unknown } | null;
  if (!body || typeof body.collection !== "string" || typeof body.scope !== "string") return Response.json({ error: "Say which collection and scope." }, { status: 400 });
  const base = (process.env.GATEWAY_URL ?? "").replace(/\/+$/, "");
  // A visitor's own items need this browser's id, which a first visit doesn't have yet.
  const created = body.scope === "visitor" && !visitorId(request) ? newVisitorId() : null;
  try {
    const res = await fetch(`${base}/live/ticket`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.PRODUCT_TOKEN ?? ""}`,
        "content-type": "application/json",
        ...identityHeaders(request, created),
        ...userHeaders(request),
      },
      body: JSON.stringify({ collection: body.collection, scope: body.scope }),
      signal: AbortSignal.timeout(15_000),
    });
    const reply = (await res.json().catch(() => ({}))) as { ticket?: string; expiresAt?: string; error?: { message?: string; code?: string } };
    if (!res.ok || !reply.ticket) {
      const retry = res.headers.get("retry-after");
      return Response.json({ error: reply.error?.message ?? "Live updates aren't available right now.", code: reply.error?.code }, { status: res.status === 200 ? 502 : res.status, ...(retry ? { headers: { "retry-after": retry } } : {}) });
    }
    const headers = new Headers({ "cache-control": "no-store" });
    if (created) headers.append("set-cookie", visitorCookie(created));
    return Response.json({ ticket: reply.ticket, expiresAt: reply.expiresAt, streamUrl: `${base}/live/stream` }, { headers });
  } catch {
    return Response.json({ error: "Live updates couldn't reach Muse Muse. Trying again." }, { status: 502 });
  }
}

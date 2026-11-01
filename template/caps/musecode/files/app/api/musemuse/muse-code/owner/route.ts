// Platform file (Muse Muse platform services). Keep this file as it is.
//
// GET /api/musemuse/muse-code/owner?code=... is where Muse Muse's "Open as owner" lands for a product that runs Muse Code
// tasks and has no other owner page: the code becomes the owner's 12-hour session in the HttpOnly mm_owner cookie,
// which starting a task needs. The gateway decides who may do what.
import { clientIpHeaders } from "@/lib/meta/client";
import { isOwnerSession, ownerCookie } from "@/lib/platform/identity";

function home(cookie?: string): Response {
  const headers = new Headers({ location: "/", "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function GET(request: Request): Promise<Response> {
  const code = new URL(request.url).searchParams.get("code");
  if (!code || code.length > 1024) return home();
  try {
    const base = (process.env.GATEWAY_URL ?? "").replace(/\/+$/, "");
    const res = await fetch(`${base}/identity/owner`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.PRODUCT_TOKEN ?? ""}`, "content-type": "application/json", ...clientIpHeaders(request) },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(15_000),
    });
    const reply = (await res.json().catch(() => ({}))) as { session?: unknown };
    return res.ok && isOwnerSession(reply.session) ? home(ownerCookie(reply.session)) : home();
  } catch {
    // A used or expired code lands on the normal page, without the owner's items.
    return home();
  }
}

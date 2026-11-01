// Platform file (Muse Muse platform services). Keep this file as it is.
//
// Signing people in to this product through Muse Muse, between its pages and the gateway:
//   GET  /api/musemuse/user?returnTo=/path          on to Muse Muse's passkey page for this product, with a fresh value
//                                                    in this browser's short-lived mm_signin cookie
//   GET  /api/musemuse/user?code=...&returnTo=/path  back from it: the code becomes a 30-day session cookie, only in the
//                                                    browser whose mm_signin cookie started it
//   POST /api/musemuse/user {"test": "Ana"}         a build's tests only: a made-up person (tests/caps/data.ts)
import { randomBytes } from "node:crypto";
import { clientIpHeaders } from "@/lib/meta/client";
import { samePath } from "@/lib/platform/identity";
import { clearSignInCookie, isUserSession, signInBind, signInCookie, userCookies } from "@/lib/platform/user";

function gateway(path: string, body: unknown, from: Request): Promise<Response> {
  const base = (process.env.GATEWAY_URL ?? "").replace(/\/+$/, "");
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.PRODUCT_TOKEN ?? ""}`, "content-type": "application/json", ...clientIpHeaders(from) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}

function redirectTo(path: string, cookies: string[] = []): Response {
  const headers = new Headers({ location: path, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

interface Session {
  session?: unknown;
  expiresAt?: unknown;
  user?: { name?: unknown };
}

function sessionCookies(reply: Session): string[] | null {
  if (!isUserSession(reply.session) || typeof reply.expiresAt !== "string") return null;
  return userCookies(reply.session, reply.expiresAt, typeof reply.user?.name === "string" ? reply.user.name : "");
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const back = samePath(url.searchParams.get("returnTo"));
  const code = url.searchParams.get("code");
  try {
    if (!code) {
      const bind = randomBytes(18).toString("base64url");
      const res = await gateway("/identity/user/link", { returnTo: back, bind }, request);
      const reply = (await res.json().catch(() => ({}))) as { url?: unknown };
      return typeof reply.url === "string" && /^https?:\/\//.test(reply.url) ? redirectTo(reply.url, [signInCookie(bind)]) : redirectTo(back);
    }
    // Only the browser that started this sign-in holds its value. A code from anywhere else signs no one in here.
    const bind = signInBind(request);
    if (code.length > 1024 || !bind) return redirectTo(back, [clearSignInCookie()]);
    const res = await gateway("/identity/user", { code, bind }, request);
    const cookies = res.ok ? sessionCookies((await res.json().catch(() => ({}))) as Session) : null;
    // A used or expired code lands on the page signed out. Nothing else to do from a link.
    return redirectTo(back, [clearSignInCookie(), ...(cookies ?? [])]);
  } catch (err) {
    console.error("[musemuse] sign-in failed:", err instanceof Error ? err.message : "unknown");
    return redirectTo(back);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "This only works from this product's own pages." }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { test?: unknown } | null;
  if (!body || typeof body.test !== "string" || !body.test.trim() || body.test.length > 40) return Response.json({ error: "Say the made-up person's name." }, { status: 400 });
  try {
    const res = await gateway("/identity/user/test", { name: body.test }, request);
    const reply = (await res.json().catch(() => ({}))) as Session & { error?: { message?: string } };
    const cookies = res.ok ? sessionCookies(reply) : null;
    if (!cookies) return Response.json({ error: reply.error?.message ?? "Only a build's tests can sign in a made-up person." }, { status: res.ok ? 502 : res.status });
    const headers = new Headers({ "cache-control": "no-store" });
    for (const c of cookies) headers.append("set-cookie", c);
    return Response.json({ user: reply.user }, { headers });
  } catch {
    return Response.json({ error: "The sign-in service is unreachable. Try again in a minute." }, { status: 502 });
  }
}

import { clientIpHeaders } from "@/lib/meta/client";
import { ToolError, connectTool, disconnectTool, exchangeOwnerCode, toolConnections } from "@/lib/agent/tools";
import { clearOwnerCookie, identityHeaders, isOwnerSession, ownerCookie, samePath } from "@/lib/platform/identity";

// The owner's sign-in and account connections, between the product's pages and the Muse Muse gateway. Keep this file as
// it is. The gateway decides who may do what. This route only carries the signed session and keeps it out of page scripts.
//
//   GET  /api/musemuse/owner?code=...   the platform's "Open as owner" link lands here
//   POST /api/musemuse/sign-out         forgets the owner session on this browser
//   GET  /api/musemuse/connections      this person's connected accounts
//   POST /api/musemuse/connect          { toolkit, returnTo } gives a link to connect an account
//   POST /api/musemuse/disconnect       { toolkit }
//   GET  /api/musemuse/connected        back from connecting: on to the page they came from

const MAX_BODY_BYTES = 8 * 1024;

type Context = { params: Promise<{ path: string[] }> };

function refused(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/** The gateway's refusal in plain words, or a generic line for anything else. */
function failed(err: unknown): Response {
  if (err instanceof ToolError) return Response.json({ error: err.message, code: err.code }, { status: err.status });
  console.error("[musemuse] a gateway call failed:", err);
  return refused("The accounts service is unreachable. Try again in a minute.", 502);
}

/** Only this product's own pages use these. A link another site opens (the owner's, the connected page) is a GET. */
function crossSite(request: Request): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site";
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toolkitOf(body: Record<string, unknown> | null): string | null {
  return typeof body?.toolkit === "string" && /^[a-z0-9_-]{1,64}$/i.test(body.toolkit) ? body.toolkit : null;
}

/** A redirect on this site. Relative, so it works behind any host and never leaves it. */
function redirectTo(path: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location: path, "cache-control": "no-store", ...headers } });
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const [route, extra] = (await params).path;
  if (extra !== undefined) return refused("Not found.", 404);
  const url = new URL(request.url);

  if (route === "owner") {
    const code = url.searchParams.get("code");
    if (!code || code.length > 1024) return redirectTo("/");
    try {
      const reply = await exchangeOwnerCode(code, { headers: clientIpHeaders(request) });
      if (!isOwnerSession(reply.session)) return redirectTo("/");
      return redirectTo("/", { "set-cookie": ownerCookie(reply.session) });
    } catch (err) {
      // A used or expired code lands on the normal page, without the owner's tools. Nothing else to do from a link.
      if (!(err instanceof ToolError)) console.error("[musemuse] the owner exchange failed:", err);
      return redirectTo("/");
    }
  }

  if (route === "connected") {
    const back = samePath(url.searchParams.get("returnTo"));
    const target = new URL(back, "https://this-site.invalid");
    const toolkit = url.searchParams.get("toolkit");
    const outcome = url.searchParams.has("error") ? "connect_failed" : "connected";
    // A second try starts from the page the first one came back to.
    target.searchParams.delete("connected");
    target.searchParams.delete("connect_failed");
    target.searchParams.set(outcome, toolkit && /^[a-z0-9_-]{1,64}$/i.test(toolkit) ? toolkit : "1");
    return redirectTo(`${target.pathname}${target.search}${target.hash}`);
  }

  if (route === "connections") {
    if (crossSite(request)) return refused("This only works from this product's own pages.", 403);
    try {
      return Response.json(await toolConnections({ headers: identityHeaders(request) }), { headers: { "cache-control": "no-store" } });
    } catch (err) {
      return failed(err);
    }
  }
  return refused("Not found.", 404);
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const [route, extra] = (await params).path;
  if (extra !== undefined) return refused("Not found.", 404);
  if (crossSite(request)) return refused("This only works from this product's own pages.", 403);

  if (route === "sign-out") {
    return new Response(null, { status: 204, headers: { "set-cookie": clearOwnerCookie() } });
  }

  if (route === "connect") {
    const body = await readJson(request);
    const toolkit = toolkitOf(body);
    if (!toolkit) return refused("Say which account to connect.", 400);
    try {
      return Response.json(await connectTool(toolkit, samePath(body?.returnTo), { headers: identityHeaders(request) }));
    } catch (err) {
      return failed(err);
    }
  }

  if (route === "disconnect") {
    const toolkit = toolkitOf(await readJson(request));
    if (!toolkit) return refused("Say which account to disconnect.", 400);
    try {
      return Response.json(await disconnectTool(toolkit, { headers: identityHeaders(request) }));
    } catch (err) {
      return failed(err);
    }
  }
  return refused("Not found.", 404);
}

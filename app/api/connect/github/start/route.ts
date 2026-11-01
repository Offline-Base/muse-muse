import { cookies } from "next/headers";
import { getSessionUser, isCrossSite } from "@/lib/auth";
import { bindConnectionOwner } from "@/lib/connected/owner";
import { env } from "@/lib/env";
import { authorizeUrl, githubConfig, newOAuthState, STATE_COOKIE, STATE_MINUTES } from "@/lib/github/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });

/** GET ?slug=<product> -> GitHub's consent page, with a state only this browser can finish. */
export async function GET(req: Request) {
  if (!env.githubExport) return new Response("Not found\n", { status: 404 });
  if (isCrossSite(req.headers)) return new Response("Connect GitHub from a product's Code page.\n", { status: 403 });
  const asked = new URL(req.url).searchParams.get("slug") ?? "";
  if (!/^[a-z0-9-]{1,80}$/.test(asked)) return new Response("Connect GitHub from a product's Code page.\n", { status: 400 });
  const back = `/p/${asked}/code`;
  const config = githubConfig();
  if (!config) return redirect(`${back}?github=off`);
  const user = await getSessionUser();
  if (!user) return redirect(`${back}?github=signin`);
  const owner = await bindConnectionOwner(user);
  const { state, cookie } = newOAuthState(`${owner.kind}:${owner.key}`, asked);
  (await cookies()).set(STATE_COOKIE, cookie, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/connect/github", maxAge: STATE_MINUTES * 60 });
  return redirect(authorizeUrl(config, state));
}

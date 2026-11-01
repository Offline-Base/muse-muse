import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/auth";
import { currentConnectionOwner } from "@/lib/connected/owner";
import { saveConnection } from "@/lib/connected/store";
import { env } from "@/lib/env";
import { exchangeCode, fetchAccount, githubConfig, hasRepoScope, readOAuthState, revokeGrant, STATE_COOKIE, stateMatches } from "@/lib/github/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const redirect = (location: string) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });

/**
 * GitHub sends the person back here. It finishes only with the state this browser was given, while the same owner is
 * asking, so someone else's link can't connect their account here. Where it goes back to comes from the signed state.
 */
export async function GET(req: Request) {
  if (!env.githubExport) return new Response("Not found\n", { status: 404 });
  const url = new URL(req.url);
  const jar = await cookies();
  const held = readOAuthState(jar.get(STATE_COOKIE)?.value);
  jar.delete({ name: STATE_COOKIE, path: "/api/connect/github" });
  if (!held || !stateMatches(held.state, url.searchParams.get("state"))) return new Response("This sign-in expired or didn't start here. Connect GitHub again from the Code page.\n", { status: 400 });
  const back = `/p/${held.slug}/code`;
  const owner = await currentConnectionOwner(await getSessionUser());
  if (!owner || `${owner.kind}:${owner.key}` !== held.owner) return new Response("This sign-in didn't start here. Connect GitHub again from the Code page.\n", { status: 400 });
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) return redirect(`${back}?github=denied`);
  const config = githubConfig();
  if (!config) return redirect(`${back}?github=off`);
  try {
    const got = await exchangeCode(config, code);
    if (!got) return redirect(`${back}?github=failed`);
    if (!hasRepoScope(got.scopes)) {
      await revokeGrant(config, got.token);
      return redirect(`${back}?github=scope`);
    }
    const account = await fetchAccount(config, got.token);
    if (!account) return redirect(`${back}?github=failed`);
    await saveConnection({ provider: "github", owner, externalId: account.id, externalLogin: account.login, scopes: got.scopes, token: got.token });
    return redirect(`${back}?github=connected`);
  } catch (err) {
    console.error("[github] sign-in failed:", err instanceof Error ? err.name : "unknown");
    return redirect(`${back}?github=failed`);
  }
}

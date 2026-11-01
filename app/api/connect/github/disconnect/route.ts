import { isCrossSite, requireUser } from "@/lib/auth";
import { currentConnectionOwner } from "@/lib/connected/owner";
import { openConnection, revokeConnection } from "@/lib/connected/store";
import { env } from "@/lib/env";
import { githubConfig, revokeGrant } from "@/lib/github/api";
import { errorJson, route } from "@/lib/http";

export const runtime = "nodejs";

/** POST -> {disconnected, revokedOnGitHub}. The token here is destroyed whatever GitHub answers; the reply says if GitHub's grant still stands. */
export const POST = route(async (req: Request) => {
  if (!env.githubExport) return errorJson(404, "not_found");
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const owner = await currentConnectionOwner(await requireUser());
  if (!owner) return Response.json({ disconnected: false, revokedOnGitHub: false });
  const config = githubConfig();
  const connection = config ? await openConnection("github", owner) : null;
  const revokedOnGitHub = config && connection ? await revokeGrant(config, connection.token) : false;
  return Response.json({ disconnected: await revokeConnection("github", owner), revokedOnGitHub });
});

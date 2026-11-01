import { eq } from "drizzle-orm";
import { AuthError, canActAsOwner, requireUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { codeBlock } from "@/lib/caps/code/brief";
import { env } from "@/lib/env";
import { mintOwnerCode, ownerSubject } from "@/lib/tools/principal";

// "Open as owner": signs a one-time code and sends the browser to the product, which trades it through the gateway for
// a 12-hour owner session (docs/AGENT_TOOLS.md). Products under the shared guest account can't get one.
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  // Wave 3, unit 3: a product that saves data has owner items too, so the pass also works while the data cap is served.
  // Wave 3, unit 4: the same for owner files and shared spaces only the owner adds to, while the files cap is served.
  // Wave 3, unit 9 (15b): and for products that run Muse Code sessions, which are owner-only.
  const ownerPassOn = (env.agentsEnabled && env.composioPersonalEnabled) || env.servedCaps.includes("data") || env.servedCaps.includes("files") || museCodeServed();
  if (!ownerPassOn) return Response.json({ error: "Owner access isn't on here." }, { status: 503 });
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  const { slug } = await params;
  const [product] = await db()
    .select({ id: schema.products.id, ownerId: schema.products.ownerId, liveUrl: schema.products.liveUrl, status: schema.products.status, latestBuildId: schema.products.latestBuildId })
    .from(schema.products)
    .where(eq(schema.products.slug, slug))
    .limit(1);
  if (!product) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canActAsOwner(user, product.ownerId)) {
    return Response.json(
      { error: user.openAccess ? "Sign in first. Everyone shares the guest account, so it can't tell who owns what." : "Only the product's owner can do this." },
      { status: 403 },
    );
  }
  if (!product.liveUrl || product.status === "disabled" || product.status === "failed") {
    return Response.json({ error: "This product isn't live yet." }, { status: 409 });
  }
  const code = mintOwnerCode({ productId: product.id, subject: ownerSubject(user.id) }, new Date());
  const target = new URL(await ownerLandingPath(product.latestBuildId), product.liveUrl);
  target.searchParams.set("code", code);
  return Response.redirect(target.toString(), 303);
}

// ---------- Wave 3, unit 9: Muse Code sessions are owner-only (docs/CAPABILITIES.md, 15b) ----------

function museCodeServed(): boolean {
  return env.servedCaps.includes("code") && env.museCodeEnabled;
}

/**
 * Where the owner's code lands in the product. /api/musemuse/owner comes with the data overlay and the agent kit; a
 * product that has neither and runs Muse Code gets the musecode overlay's own landing, which sets the same cookie.
 */
async function ownerLandingPath(latestBuildId: string | null): Promise<string> {
  if (!museCodeServed() || !latestBuildId) return "/api/musemuse/owner";
  const [build] = await db().select({ brief: schema.builds.brief }).from(schema.builds).where(eq(schema.builds.id, latestBuildId)).limit(1);
  const brief = (build?.brief ?? null) as { data?: unknown; agent?: unknown } | null;
  if (!brief || brief.data || brief.agent || codeBlock(brief)?.museCode !== true) return "/api/musemuse/owner";
  return "/api/musemuse/muse-code/owner";
}

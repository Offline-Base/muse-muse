import { eq } from "drizzle-orm";
import { isCrossSite, requireUser } from "@/lib/auth";
import { currentConnectionOwner } from "@/lib/connected/owner";
import { db, schema } from "@/lib/db/client";
import { canEditProduct } from "@/lib/edit-pass";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { githubConfig, isValidRepoName } from "@/lib/github/api";
import { exportProduct, pushNewVersions } from "@/lib/github/export";
import { errorJson, readJson, route } from "@/lib/http";
import { canReadCode } from "@/lib/versions/policy";

export const runtime = "nodejs";
export const maxDuration = 300;

const OWNER_HOUR = 12;
const SITE_HOUR = 120;

type Ctx = { params: Promise<{ slug: string }> };

/**
 * POST {action:"create", name, private?} makes a repo (private unless private is false) and pushes every saved version.
 * POST {action:"push"} pushes what's new. Whoever may read the code may export it, using only their own connection.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.githubExport) return errorJson(404, "not_found");
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const user = await requireUser();
  const { slug } = await params;
  const body = await readJson(req, 1024);
  const [product] = await db().select().from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
  if (!product || !canReadCode(product, await canEditProduct(user, product))) return errorJson(404, "not_found");
  const config = githubConfig();
  if (!config) return errorJson(503, "not_set_up", { message: "GitHub export isn't set up on this site. Download the source instead." });
  const owner = await currentConnectionOwner(user);
  if (!owner) return errorJson(409, "not_connected", { message: "Connect your GitHub account first." });
  if (body.action !== "create" && body.action !== "push") return errorJson(400, "action must be create or push.");
  if (body.action === "create" && !isValidRepoName(body.name)) return errorJson(400, "bad_name", { message: "A repo name is letters, numbers, dots, dashes and underscores." });

  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const ownerKey = `github-export:${owner.kind}:${owner.key}`;
  if ((await reserveCounter(ownerKey, hour, 1, OWNER_HOUR)) === null) return errorJson(429, "busy", { message: "You've pushed a lot this hour. Try again later." });
  if ((await reserveCounter("github-export:all", hour, 1, SITE_HOUR)) === null) {
    await adjustCounter(ownerKey, hour, -1).catch(() => {});
    return errorJson(429, "busy", { message: "This site has made all the pushes it makes in an hour. Try again later." });
  }

  const result =
    body.action === "create"
      ? await exportProduct({ config, owner, product, name: body.name as string, isPrivate: body.private !== false })
      : await pushNewVersions({ config, owner, productId: product.id });
  if (!result.ok) return errorJson(result.status, result.error, { message: result.message });
  return Response.json(result);
});

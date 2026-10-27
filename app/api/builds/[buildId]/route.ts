import { eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { errorJson, isUuid, route } from "@/lib/http";

type Ctx = { params: Promise<{ buildId: string }> };

function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const out = { ...obj };
  for (const key of keys) delete out[key];
  return out;
}

/**
 * GET -> 200 {build, product | null, inspiration, viewer}. Public, like the build room. Internal ids (user and owner
 * ids, the workflow run id) are left out. `viewer` says whether the signed-in user may send refinements.
 */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { buildId } = await params;
  if (!isUuid(buildId)) return errorJson(404, "not_found");
  const [build] = await db().select().from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  if (!build) return errorJson(404, "not_found");
  const [inspirations, products, viewer] = await Promise.all([
    db().select().from(schema.inspirations).where(eq(schema.inspirations.id, build.inspirationId)).limit(1),
    build.productId
      ? db().select().from(schema.products).where(eq(schema.products.id, build.productId)).limit(1)
      : Promise.resolve([]),
    getSessionUser(),
  ]);
  const inspiration = inspirations[0];
  const product = products[0];

  return Response.json({
    build: omit(build, "userId", "workflowRunId"),
    product: product ? omit(product, "ownerId") : null,
    inspiration: inspiration ? omit(inspiration, "userId") : null,
    viewer: {
      signedIn: Boolean(viewer),
      isOwner: Boolean(viewer && !viewer.openAccess && viewer.id === (product?.ownerId ?? build.userId)),
      isAdmin: Boolean(viewer?.isAdmin),
    },
  });
});

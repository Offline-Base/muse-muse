import { eq } from "drizzle-orm";
import { requireUser } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { canEditProduct } from "@/lib/edit-pass";
import { errorJson, readJson, route } from "@/lib/http";

type Ctx = { params: Promise<{ slug: string }> };

/** POST {public: boolean} -> 200 {public}. Whoever can edit a product chooses whether anyone may read its code. requireUser refuses other sites. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser();
  const { slug } = await params;
  const body = await readJson(req, 1024);
  if (typeof body.public !== "boolean") return errorJson(400, "public must be true or false.");
  const [product] = await db().select({ id: schema.products.id, ownerId: schema.products.ownerId, takenDownAt: schema.products.takenDownAt }).from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
  if (!product || product.takenDownAt) return errorJson(404, "not_found");
  if (!(await canEditProduct(user, product))) return errorJson(403, "Only someone who can edit this product can change this.");
  await db().update(schema.products).set({ sourcePublic: body.public }).where(eq(schema.products.id, product.id));
  return Response.json({ public: body.public });
});

import { eq } from "drizzle-orm";
import { AuthError, canActAsOwner, requireUser } from "@/lib/auth";
import { handleOwnerData } from "@/lib/caps/data/owner";
import { dataStore } from "@/lib/caps/data/store";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

// The product's builder, or an admin, browses and exports its saved data (docs/CAPABILITIES.md, section 9): shared
// collections in full, private scopes as counts only. 404 while the data cap is off.
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!env.servedCaps.includes("data")) return Response.json({ error: "not_found" }, { status: 404 });
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
    throw err;
  }
  const { slug } = await params;
  const [product] = await db()
    .select({ id: schema.products.id, ownerId: schema.products.ownerId })
    .from(schema.products)
    .where(eq(schema.products.slug, slug))
    .limit(1);
  if (!product) return Response.json({ error: "not_found" }, { status: 404 });
  if (!canActAsOwner(user, product.ownerId)) return Response.json({ error: "Only the product's owner can see its saved data." }, { status: 403 });
  return handleOwnerData(req, product.id, dataStore);
}

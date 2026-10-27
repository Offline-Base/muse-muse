import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { McpProduct } from "@/lib/mcp/server";

/** A product the connector may serve: live or partial. */
export async function findServableProduct(slug: string): Promise<McpProduct | null> {
  const [row] = await db()
    .select({
      slug: schema.products.slug,
      name: schema.products.name,
      tagline: schema.products.tagline,
      status: schema.products.status,
      liveUrl: schema.products.liveUrl,
      manifest: schema.products.manifest,
    })
    .from(schema.products)
    .where(and(eq(schema.products.slug, slug), inArray(schema.products.status, ["live", "partial"])))
    .limit(1);
  return row ?? null;
}

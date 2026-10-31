/**
 * Saving an import bundle (lib/promote/bundle.ts) on the live site, for POST /api/admin/import-product: the muses,
 * the product (live, with no link until it is published), its builds and their events, all under the guest account,
 * in one batch. Neon runs a batch as one transaction, so an import is saved whole or not at all.
 */
import { eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db, schema } from "@/lib/db/client";
import type { ImportBundle, ImportInspiration } from "@/lib/promote/bundle";
import type { ProductStatus } from "@/lib/types";

/** Events per insert statement, well under Postgres's limit on parameters. */
const EVENTS_PER_INSERT = 500;

export type ImportResult =
  | { status: "imported" | "already"; productId: string; slug: string }
  | { status: "slug_taken"; slug: string }
  | { status: "ids_taken"; ids: string[] };

/**
 * What already stands in the way: the product itself (imported before, which changes nothing), another product with
 * its slug, or a build or muse id that is already used. Null when the import can go ahead.
 */
async function obstacle(bundle: ImportBundle): Promise<ImportResult | null> {
  const p = bundle.product;
  const [same] = await db()
    .select({ id: schema.products.id, slug: schema.products.slug })
    .from(schema.products)
    .where(eq(schema.products.id, p.id))
    .limit(1);
  if (same) return { status: "already", productId: same.id, slug: same.slug };
  const [other] = await db().select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.slug, p.slug)).limit(1);
  if (other) return { status: "slug_taken", slug: p.slug };
  const museIds = [bundle.inspiration.id, ...bundle.refineInspirations.map((i) => i.id)];
  const [builds, muses] = await Promise.all([
    db().select({ id: schema.builds.id }).from(schema.builds).where(inArray(schema.builds.id, bundle.builds.map((b) => b.id))),
    db().select({ id: schema.inspirations.id }).from(schema.inspirations).where(inArray(schema.inspirations.id, museIds)),
  ]);
  const taken = [...builds, ...muses].map((r) => r.id);
  return taken.length ? { status: "ids_taken", ids: taken } : null;
}

function inserts(bundle: ImportBundle, ownerId: string): BatchItem<"pg">[] {
  const d = db();
  const p = bundle.product;
  const muse = (i: ImportInspiration) => ({
    id: i.id,
    userId: ownerId,
    note: i.note,
    references: i.references,
    createdAt: new Date(i.createdAt),
  });
  const statements: BatchItem<"pg">[] = [
    d.insert(schema.inspirations).values([bundle.inspiration, ...bundle.refineInspirations].map(muse)),
    d.insert(schema.products).values({
      id: p.id,
      slug: p.slug,
      name: p.name,
      tagline: p.tagline,
      ownerId,
      inspirationId: p.inspirationId,
      rebuildOf: p.rebuildOf,
      manifest: p.manifest as (typeof schema.products.$inferInsert)["manifest"],
      latestBuildId: p.latestBuildId,
      sandboxName: p.sandboxName,
      museSessionId: p.museSessionId,
      // The publish workflow (lib/promote/workflow.ts) sets both once the product's own deployment is live.
      vercelProjectId: null,
      liveUrl: null,
      demoVideoUrl: p.demoVideoUrl,
      demoPosterUrl: p.demoPosterUrl,
      transcriptUrl: p.transcriptUrl,
      status: "live" satisfies ProductStatus,
      createdAt: new Date(p.createdAt),
      updatedAt: new Date(p.updatedAt),
    }),
    d.insert(schema.builds).values(
      bundle.builds.map((b) => ({
        ...b,
        userId: ownerId,
        workflowRunId: null,
        startedAt: new Date(b.startedAt),
        finishedAt: b.finishedAt ? new Date(b.finishedAt) : null,
      })),
    ),
  ];
  // In the bundle's order, so the live ids keep the events in the order the build room showed them.
  for (let i = 0; i < bundle.events.length; i += EVENTS_PER_INSERT) {
    const chunk = bundle.events.slice(i, i + EVENTS_PER_INSERT);
    statements.push(d.insert(schema.buildEvents).values(chunk.map((e) => ({ ...e, at: new Date(e.at) }))));
  }
  return statements;
}

/**
 * Saves the bundle's rows under `ownerId`, ids kept. The same product again saves nothing and answers "already"; a
 * slug another product has, or an id already in use, saves nothing either. Usage rows are never written: they would
 * count against today's spend caps here.
 */
export async function importProduct(bundle: ImportBundle, ownerId: string): Promise<ImportResult> {
  const before = await obstacle(bundle);
  if (before) return before;
  const statements = inserts(bundle, ownerId);
  try {
    await db().batch(statements as [BatchItem<"pg">, ...BatchItem<"pg">[]]);
  } catch (err) {
    // Two imports of the same product at once: the batch that lost was rolled back whole, and the one that won says
    // what happened.
    const after = await obstacle(bundle);
    if (after) return after;
    throw err;
  }
  return { status: "imported", productId: bundle.product.id, slug: bundle.product.slug };
}

export interface ImportedProduct {
  productId: string;
  slug: string;
  status: ProductStatus;
  liveUrl: string | null;
  latestBuildId: string | null;
}

/** Where a product stands, for the script waiting on its link. Null when there's no product with this id. */
export async function importedProduct(productId: string): Promise<ImportedProduct | null> {
  const [row] = await db()
    .select({
      productId: schema.products.id,
      slug: schema.products.slug,
      status: schema.products.status,
      liveUrl: schema.products.liveUrl,
      latestBuildId: schema.products.latestBuildId,
    })
    .from(schema.products)
    .where(eq(schema.products.id, productId.toLowerCase()))
    .limit(1);
  return row ?? null;
}

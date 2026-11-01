/**
 * The build a run is planned from (docs/TRAINING.md "Fine-tune like a build", B), read for POST /api/train/plan
 * {fromBuildId} and /fine-tuning/new?fromBuild=: the build, its product, the product's owner and whether its brief
 * picked muse-glimmer. Server only.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { offersOwnModel } from "@/lib/train/tune/from-build";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TuneBuildSource {
  buildId: string;
  productId: string;
  productName: string;
  ownerId: string;
  /** The brief picked muse-glimmer and the build is live or partial (offersOwnModel), as the build room's row needs. */
  offers: boolean;
}

/** The build and its product, or null when the id isn't a uuid, there is no such build, or it has no product yet. */
export async function buildForTune(buildId: string): Promise<TuneBuildSource | null> {
  if (!UUID_RE.test(buildId)) return null;
  const b = schema.builds;
  const p = schema.products;
  const [row] = await db()
    .select({ buildId: b.id, status: b.status, brief: b.brief, productId: p.id, productName: p.name, ownerId: p.ownerId })
    .from(b)
    .innerJoin(p, eq(p.id, b.productId))
    .where(eq(b.id, buildId.toLowerCase()))
    .limit(1);
  if (!row) return null;
  return {
    buildId: row.buildId,
    productId: row.productId,
    productName: row.productName,
    ownerId: row.ownerId,
    offers: offersOwnModel(row.brief, row.status),
  };
}

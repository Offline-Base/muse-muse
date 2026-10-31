/**
 * The queries behind the "Get it" panel, the download route and the Quest links (docs/NATIVE.md). Runs an agent started
 * checked a preview, not the live product, so nothing here reads them.
 */
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { briefTargets } from "@/lib/native/targets";
import { buildProductNativeView, type ProductNativeView } from "@/lib/native/product-view";
import type { TargetId } from "@/lib/brief/schema";

const MAX_ARTIFACTS = 120;
const MAX_JOBS = 40;

/** Products that can be shown or fetched: a turned-off or failed product has no downloads and no links. */
const SHIPPED = ["live", "partial"] as const;

/**
 * Downloads are counted per package in rate_limits, under a window that never starts: the hourly prune only deletes
 * windows that started over an hour ago. That keeps the count with the other counters, with no migration.
 */
export const DOWNLOADS_WINDOW = new Date("2100-01-01T00:00:00.000Z");
export const downloadsKey = (artifactId: string) => `native-downloads:${artifactId}`;

/**
 * A product's apps, as the panel shows them. A product with no run has no packages and no checks, so most products cost
 * this two small queries, and every product page runs it.
 */
export async function readProductNative(productId: string, targets: TargetId[]): Promise<ProductNativeView> {
  const d = db();
  const [runs, clips] = await Promise.all([
    d
      .select({ status: schema.nativeRuns.status })
      .from(schema.nativeRuns)
      .where(and(eq(schema.nativeRuns.productId, productId), ne(schema.nativeRuns.origin, "agent")))
      .orderBy(desc(schema.nativeRuns.createdAt))
      .limit(10),
    d.select({ extraClips: schema.products.extraClips }).from(schema.products).where(eq(schema.products.id, productId)).limit(1),
  ]);
  const extraClips = clips[0]?.extraClips ?? [];
  if (!runs.length) return buildProductNativeView({ targets, artifacts: [], jobs: [], runs, clips: extraClips });
  const [artifacts, jobs] = await Promise.all([
    d
      .select({
        id: schema.nativeArtifacts.id,
        runId: schema.nativeArtifacts.runId,
        jobId: schema.nativeArtifacts.jobId,
        kind: schema.nativeArtifacts.kind,
        platform: schema.nativeArtifacts.platform,
        device: schema.nativeArtifacts.device,
        caption: schema.nativeArtifacts.caption,
        url: schema.nativeArtifacts.url,
        bytes: schema.nativeArtifacts.bytes,
        check: schema.nativeArtifacts.check,
        createdAt: schema.nativeArtifacts.createdAt,
      })
      .from(schema.nativeArtifacts)
      .innerJoin(schema.nativeRuns, eq(schema.nativeArtifacts.runId, schema.nativeRuns.id))
      .where(and(eq(schema.nativeArtifacts.productId, productId), isNull(schema.nativeArtifacts.supersededAt), ne(schema.nativeRuns.origin, "agent")))
      .orderBy(desc(schema.nativeArtifacts.createdAt))
      .limit(MAX_ARTIFACTS),
    d
      .select({
        id: schema.nativeJobs.id,
        runId: schema.nativeJobs.runId,
        kind: schema.nativeJobs.kind,
        status: schema.nativeJobs.status,
        result: schema.nativeJobs.result,
        createdAt: schema.nativeJobs.createdAt,
      })
      .from(schema.nativeJobs)
      .innerJoin(schema.nativeRuns, eq(schema.nativeJobs.runId, schema.nativeRuns.id))
      .where(and(eq(schema.nativeJobs.productId, productId), ne(schema.nativeRuns.origin, "agent")))
      .orderBy(desc(schema.nativeJobs.createdAt))
      .limit(MAX_JOBS),
  ]);
  return buildProductNativeView({ targets, artifacts, jobs, runs, clips: extraClips });
}

/** A product's id and where it runs, by slug, when it's shipped. */
export async function shippedProductBySlug(slug: string): Promise<{ id: string; name: string; liveUrl: string | null; targets: TargetId[] } | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const d = db();
  const [product] = await d
    .select({ id: schema.products.id, name: schema.products.name, liveUrl: schema.products.liveUrl })
    .from(schema.products)
    .where(and(eq(schema.products.slug, slug), inArray(schema.products.status, [...SHIPPED])))
    .limit(1);
  if (!product) return null;
  // A refinement's build has no brief of its own: where a product runs comes from the newest one that does.
  const [build] = await d
    .select({ brief: schema.builds.brief })
    .from(schema.builds)
    .where(and(eq(schema.builds.productId, product.id), sql`${schema.builds.brief} is not null`))
    .orderBy(desc(schema.builds.startedAt))
    .limit(1);
  return { ...product, targets: briefTargets(build?.brief) };
}

/** How many times each package was downloaded, for its owner. */
export async function downloadCounts(artifactIds: readonly string[]): Promise<Map<string, number>> {
  if (!artifactIds.length) return new Map();
  const rows = await db()
    .select({ key: schema.rateLimits.key, count: schema.rateLimits.count })
    .from(schema.rateLimits)
    .where(and(inArray(schema.rateLimits.key, artifactIds.map(downloadsKey)), eq(schema.rateLimits.windowStart, DOWNLOADS_WINDOW)));
  const byKey = new Map(rows.map((r) => [r.key, r.count]));
  return new Map(artifactIds.map((id) => [id, byKey.get(downloadsKey(id)) ?? 0]));
}

export interface VrProductView {
  slug: string;
  name: string;
  tagline: string;
}

/** Shipped VR products, newest first, for the list people bookmark on their Quest. Their newest brief says where they run. */
export async function listVrProducts(limit = 48): Promise<VrProductView[]> {
  return db()
    .select({ slug: schema.products.slug, name: schema.products.name, tagline: schema.products.tagline })
    .from(schema.products)
    .where(
      and(
        inArray(schema.products.status, [...SHIPPED]),
        sql`${schema.products.liveUrl} is not null`,
        sql`coalesce((select ${schema.builds.brief} -> 'targets' from ${schema.builds} where ${schema.builds.productId} = ${schema.products.id} and ${schema.builds.brief} is not null order by ${schema.builds.startedAt} desc limit 1), '[]'::jsonb) @> '[{"id":"vr"}]'::jsonb`,
      ),
    )
    .orderBy(desc(schema.products.updatedAt))
    .limit(limit);
}

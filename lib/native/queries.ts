/**
 * The queries behind the "Get it" panel, the download route and the Quest links (docs/NATIVE.md). Runs an agent started
 * checked a preview, not the live product, so nothing here reads them.
 */
import { and, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { HIDDEN_FROM_GALLERY } from "@/lib/gallery/hidden";
import { briefTargets } from "@/lib/native/targets";
import { buildProductNativeView, type ProductNativeView } from "@/lib/native/product-view";
import { NATIVE_DOWNLOADS } from "@/lib/native/types";
import type { TargetId } from "@/lib/brief/schema";

const MAX_MEDIA = 120;
const MAX_JOBS = 40;
/** What a check leaves that the panel shows. A refinement only checks again, so these pile up with no new package. */
const MEDIA_KINDS = ["clip", "poster", "shot"] as const;

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
      .select({ status: schema.nativeRuns.status, createdAt: schema.nativeRuns.createdAt })
      .from(schema.nativeRuns)
      .where(and(eq(schema.nativeRuns.productId, productId), ne(schema.nativeRuns.origin, "agent")))
      .orderBy(desc(schema.nativeRuns.createdAt))
      .limit(10),
    d.select({ extraClips: schema.products.extraClips }).from(schema.products).where(eq(schema.products.id, productId)).limit(1),
  ]);
  const extraClips = clips[0]?.extraClips ?? [];
  if (!runs.length) return buildProductNativeView({ targets, artifacts: [], jobs: [], runs, clips: extraClips });
  const artifactColumns = {
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
  };
  const current = and(eq(schema.nativeArtifacts.productId, productId), isNull(schema.nativeArtifacts.supersededAt), ne(schema.nativeRuns.origin, "agent"));
  const [packages, media, jobs] = await Promise.all([
    // The newest of each package, on its own, so no amount of media can push a download out of the view.
    d
      .selectDistinctOn([schema.nativeArtifacts.kind], artifactColumns)
      .from(schema.nativeArtifacts)
      .innerJoin(schema.nativeRuns, eq(schema.nativeArtifacts.runId, schema.nativeRuns.id))
      .where(and(current, inArray(schema.nativeArtifacts.kind, Object.values(NATIVE_DOWNLOADS))))
      .orderBy(schema.nativeArtifacts.kind, desc(schema.nativeArtifacts.createdAt)),
    d
      .select(artifactColumns)
      .from(schema.nativeArtifacts)
      .innerJoin(schema.nativeRuns, eq(schema.nativeArtifacts.runId, schema.nativeRuns.id))
      .where(and(current, inArray(schema.nativeArtifacts.kind, [...MEDIA_KINDS])))
      .orderBy(desc(schema.nativeArtifacts.createdAt))
      .limit(MAX_MEDIA),
    d
      .select({
        id: schema.nativeJobs.id,
        runId: schema.nativeJobs.runId,
        kind: schema.nativeJobs.kind,
        status: schema.nativeJobs.status,
        result: schema.nativeJobs.result,
        createdAt: schema.nativeJobs.createdAt,
        expiresAt: schema.nativeJobs.expiresAt,
        deadlineAt: schema.nativeJobs.deadlineAt,
      })
      .from(schema.nativeJobs)
      .innerJoin(schema.nativeRuns, eq(schema.nativeJobs.runId, schema.nativeRuns.id))
      .where(and(eq(schema.nativeJobs.productId, productId), ne(schema.nativeRuns.origin, "agent")))
      .orderBy(desc(schema.nativeJobs.createdAt))
      .limit(MAX_JOBS),
  ]);
  return buildProductNativeView({ targets, artifacts: [...packages, ...media], jobs, runs, clips: extraClips });
}

/** A product's newest brief. A refinement's build has no brief of its own, so it's often an earlier build's. */
export async function newestBrief(productId: string): Promise<typeof schema.builds.$inferSelect.brief> {
  const [build] = await db()
    .select({ brief: schema.builds.brief })
    .from(schema.builds)
    .where(and(eq(schema.builds.productId, productId), sql`${schema.builds.brief} is not null`))
    .orderBy(desc(schema.builds.startedAt))
    .limit(1);
  return build?.brief ?? null;
}

/** A product's id and where it runs, by slug, when it's shipped. */
export async function shippedProductBySlug(slug: string): Promise<{ id: string; name: string; liveUrl: string | null; targets: TargetId[] } | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const [product] = await db()
    .select({ id: schema.products.id, name: schema.products.name, liveUrl: schema.products.liveUrl })
    .from(schema.products)
    .where(and(eq(schema.products.slug, slug), inArray(schema.products.status, [...SHIPPED])))
    .limit(1);
  if (!product) return null;
  return { ...product, targets: briefTargets(await newestBrief(product.id)) };
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

/**
 * Shipped VR products, newest first, for the list people bookmark on their Quest. Their newest brief says where they run.
 * Like the gallery, it leaves out the products hidden from it (lib/gallery/hidden.ts).
 */
export async function listVrProducts(limit = 48): Promise<VrProductView[]> {
  return db()
    .select({ slug: schema.products.slug, name: schema.products.name, tagline: schema.products.tagline })
    .from(schema.products)
    .where(
      and(
        inArray(schema.products.status, [...SHIPPED]),
        sql`${schema.products.liveUrl} is not null`,
        notInArray(schema.products.slug, [...HIDDEN_FROM_GALLERY]),
        sql`coalesce((select ${schema.builds.brief} -> 'targets' from ${schema.builds} where ${schema.builds.productId} = ${schema.products.id} and ${schema.builds.brief} is not null order by ${schema.builds.startedAt} desc limit 1), '[]'::jsonb) @> '[{"id":"vr"}]'::jsonb`,
      ),
    )
    .orderBy(desc(schema.products.updatedAt))
    .limit(limit);
}

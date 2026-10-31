/**
 * Saving an import bundle (lib/promote/bundle.ts) on the live site, for POST /api/admin/import-product: the muses,
 * the product (live, with no link until it is published), its builds and their events, all under the guest account,
 * in one batch. Neon runs a batch as one transaction, so an import is saved whole or not at all. Then the claim on its
 * publish: the line in the latest build's room that says a publish started, written before the workflow starts, so a
 * product never has two publishes at once and one that ended without a link can be published again.
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db, schema } from "@/lib/db/client";
import { emit } from "@/lib/events";
import type { ImportBundle, ImportInspiration } from "@/lib/promote/bundle";
import { IMPORTED_RUN } from "@/lib/quota";
import type { ProductStatus } from "@/lib/types";

/** Events per insert statement, well under Postgres's limit on parameters. */
const EVENTS_PER_INSERT = 500;

export type ImportResult =
  | { status: "imported" | "already"; productId: string; slug: string }
  | { status: "slug_taken"; slug: string }
  | { status: "ids_taken"; ids: string[] };

/**
 * What already stands in the way: the product itself (imported before, which changes nothing), another product with
 * its slug, or a build or muse id that is already used. Null when the import can go ahead. It writes nothing, so the
 * route's check mode asks it too.
 */
export async function importObstacle(bundle: ImportBundle): Promise<ImportResult | null> {
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
        // No workflow here ran them, and the marker keeps them out of the guest's daily build quota (lib/quota.ts).
        workflowRunId: IMPORTED_RUN,
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
 * count against today's spend caps here. The builds are marked IMPORTED_RUN, so they don't count against the guest's
 * daily builds either, however recently they started.
 */
export async function importProduct(bundle: ImportBundle, ownerId: string): Promise<ImportResult> {
  const before = await importObstacle(bundle);
  if (before) return before;
  const statements = inserts(bundle, ownerId);
  try {
    await db().batch(statements as [BatchItem<"pg">, ...BatchItem<"pg">[]]);
  } catch (err) {
    // Two imports of the same product at once: the batch that lost was rolled back whole, and the one that won says
    // what happened.
    const after = await importObstacle(bundle);
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

// ---------------------------------------------------------------------------------------------------------------
// Publishing

/** The line a publish starts with in the latest build's room. claimPublish writes it, before the workflow starts. */
export const PUBLISH_STARTED = {
  first: "Imported from a local run. Publishing it to its own link now.",
  again: "Publishing it to its own link again.",
} as const;

/** How the line starts that ends a publish without a link: importFailedStep's, or the route's when start() fails. */
export const PUBLISH_FAILED = "Publishing the imported product didn't finish, so it stays in the gallery without a link of its own.";

export function publishFailedLine(message: string): string {
  return `${PUBLISH_FAILED} ${message}`;
}

/**
 * Longer than any publish runs: the deploy step's retries and the 6-minute wait on Vercel end well before. A start line
 * this old with no end after it is a run that died without a word (cancelled, say), so the product may be published
 * again.
 */
export const PUBLISH_STALE_MS = 30 * 60_000;

export type PublishClaim =
  | { claimed: true; buildId: string; sandboxName: string }
  /** Nothing written: a publish of it is running, or there's nothing to publish (it has its link, is off, or wasn't imported). */
  | { claimed: false; running: boolean };

/** The rows of a db().execute() result: Neon and PGlite both answer { rows }. */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/**
 * Claims the publish of an imported product: writes PUBLISH_STARTED in its latest build's room and answers that build
 * and the product's sandbox, for publishImportedProduct. Only for a live product with no link of its own whose latest
 * build was imported, and only while no publish of it is running, which is a start line from the last PUBLISH_STALE_MS
 * with no PUBLISH_FAILED line after it. The product row is locked first, and the check and the line are one statement
 * in the same transaction (Neon runs a batch as one), so two requests at once can't both start a deploy: the second
 * would revoke the first one's live token.
 */
export async function claimPublish(productId: string, opts: { again: boolean; now?: Date }): Promise<PublishClaim> {
  const now = opts.now ?? new Date();
  const sinceIso = new Date(now.getTime() - PUBLISH_STALE_MS).toISOString();
  const starts = sql.join(
    [PUBLISH_STARTED.first, PUBLISH_STARTED.again].map((text) => sql`${text}`),
    sql`, `,
  );
  const running = sql`exists (
    select 1 from build_events s
    where s.build_id = p.latest_build_id and s.type = 'log' and s.payload->>'text' in (${starts})
      and s.at > ${sinceIso}::timestamptz
      and not exists (
        select 1 from build_events e
        where e.build_id = s.build_id and e.id > s.id and e.type = 'log' and starts_with(e.payload->>'text', ${PUBLISH_FAILED})
      )
  )`;
  const line = { type: "log", text: opts.again ? PUBLISH_STARTED.again : PUBLISH_STARTED.first };
  const [, inserted, state] = await db().batch([
    db().execute(sql`select id from products where id = ${productId}::uuid for update`),
    db().execute(
      sql`insert into build_events (build_id, type, payload, at)
          select p.latest_build_id, 'log', ${JSON.stringify(line)}::jsonb, ${now.toISOString()}::timestamptz
          from products p join builds b on b.id = p.latest_build_id
          where p.id = ${productId}::uuid and p.status = 'live' and p.live_url is null and p.sandbox_name is not null
            and b.workflow_run_id = ${IMPORTED_RUN} and not ${running}
          returning build_id`,
    ),
    db().execute(sql`select p.sandbox_name, ${running} as running from products p where p.id = ${productId}::uuid`),
  ]);
  const buildId = rowsOf(inserted)[0]?.build_id;
  const after = rowsOf(state)[0];
  if (typeof buildId === "string" && typeof after?.sandbox_name === "string") {
    return { claimed: true, buildId, sandboxName: after.sandbox_name };
  }
  return { claimed: false, running: after?.running === true };
}

/** Ends a publish that never started (start() failed) with a PUBLISH_FAILED line, so it can be claimed again at once. */
export async function endPublish(buildId: string, message: string): Promise<void> {
  await emit(buildId, { type: "log", text: publishFailedLine(message) });
}

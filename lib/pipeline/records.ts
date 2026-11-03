/**
 * Rows the build API creates before it starts a workflow run: the muse (inspirations) and its build (builds).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { TargetId } from "@/lib/brief/schema";
import { setBuildStatus } from "@/lib/events";
import { TERMINAL_STATUSES, type Reference } from "@/lib/types";

/** Saves a muse and a queued build for a new product. */
export async function insertBuild(input: {
  userId: string;
  note: string | null;
  references: Reference[];
  rebuildOf: string | null;
  /** Where the person picked for it to run. Empty or missing lets the brief writer choose. */
  requestedTargets?: TargetId[] | null;
}): Promise<{ buildId: string; inspirationId: string }> {
  const inspirationId = randomUUID();
  const buildId = randomUUID();
  await db().batch([
    db().insert(schema.inspirations).values({
      id: inspirationId,
      userId: input.userId,
      note: input.note,
      references: input.references,
    }),
    db().insert(schema.builds).values({
      id: buildId,
      inspirationId,
      userId: input.userId,
      kind: "build",
      rebuildOf: input.rebuildOf,
      status: "queued",
      ...(input.requestedTargets?.length ? { requestedTargets: input.requestedTargets } : {}),
    }),
  ]);
  return { buildId, inspirationId };
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Saves a refinement (its message as the muse's note) and a queued refine build, but only if no other build of the
 * product is running. The product row is locked first, so two requests at once can't both get in. Returns null when
 * the product is busy. A refinement keeps what the person picked for the product's first build.
 */
export async function insertRefineBuild(input: {
  userId: string;
  productId: string;
  rebuildOf: string | null;
  message: string;
  references: Reference[];
  buildId?: string;
  /** A per-build model override, set only by the polish round (lib/polish/logic.ts). Null leaves loadRefineStep to choose. */
  buildModel?: string | null;
}): Promise<{ buildId: string; inspirationId: string } | null> {
  const inspirationId = randomUUID();
  const buildId = input.buildId ?? randomUUID();
  const terminal = sql.join(
    TERMINAL_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const notBusy = sql`not exists (select 1 from builds where product_id = ${input.productId}::uuid and status not in (${terminal}))`;
  const [, , inserted] = await db().batch([
    db().execute(sql`select id from products where id = ${input.productId}::uuid for update`),
    db().execute(
      sql`insert into inspirations (id, user_id, note, "references")
          select ${inspirationId}::uuid, ${input.userId}::uuid, ${input.message}::text, ${JSON.stringify(input.references)}::jsonb
          where ${notBusy}`,
    ),
    db().execute(
      sql`insert into builds (id, inspiration_id, user_id, kind, message, rebuild_of, product_id, status, build_model, requested_targets)
          select ${buildId}::uuid, ${inspirationId}::uuid, ${input.userId}::uuid, 'refine', ${input.message}::text,
                 ${input.rebuildOf}::text, ${input.productId}::uuid, 'queued', ${input.buildModel ?? null}::text,
                 (select original.requested_targets from builds original
                  where original.product_id = ${input.productId}::uuid and original.kind = 'build'
                  order by original.created_at desc limit 1)
          where ${notBusy}
          returning id`,
    ),
  ]);
  return rowsOf(inserted).length ? { buildId, inspirationId } : null;
}

export async function attachRun(buildId: string, workflowRunId: string): Promise<void> {
  await db().update(schema.builds).set({ workflowRunId }).where(eq(schema.builds.id, buildId));
}

/** When start() itself fails, the build can never run: fail it so it doesn't sit in "queued" or block refinements. */
export async function markStartFailed(buildId: string, err: unknown): Promise<void> {
  console.error("[start]", buildId, err);
  const message = "The build could not be started. Try again in a minute.";
  await setBuildStatus(buildId, "failed", { message, set: { error: message } }).catch((e) =>
    console.error("[start] could not mark the build failed", e),
  );
}

/** Builds of a product that are still running. */
export async function runningBuildsFor(productId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.builds)
    .where(and(eq(schema.builds.productId, productId), notInArray(schema.builds.status, [...TERMINAL_STATUSES])));
  return Number(row?.n ?? 0);
}

/** Catalog ids that already have a live or partial product, or a build in flight. */
export async function rebuildIdsTaken(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const shipped = await db()
    .select({ id: schema.products.rebuildOf })
    .from(schema.products)
    .where(and(inArray(schema.products.rebuildOf, ids), inArray(schema.products.status, ["live", "partial"])));
  const running = await db()
    .select({ id: schema.builds.rebuildOf })
    .from(schema.builds)
    .where(and(inArray(schema.builds.rebuildOf, ids), notInArray(schema.builds.status, [...TERMINAL_STATUSES])));
  return new Set([...shipped, ...running].map((r) => r.id).filter((id): id is string => Boolean(id)));
}

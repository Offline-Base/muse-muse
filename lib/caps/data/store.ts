import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { DATA_LIMITS } from "@/lib/caps/data/limits";
import type { DataScope } from "@/lib/caps/data/types";

/**
 * The data cap's database calls (docs/CAPABILITIES.md, section 9). Each write is one batch: it makes sure the product's
 * count row exists, locks it, then writes the row and changes the count in one statement, only when the quotas allow.
 * Neon runs a batch as one transaction, so two writes to one product's namespace can't both take the last of a quota.
 * Kept apart from the handler so the routes' logic runs in tests without a database.
 */

/** Where one document lives. `ownerKey` is null for a shared row. */
export interface RowKey {
  productId: string;
  namespace: string;
  collection: string;
  scope: DataScope;
  ownerKey: string | null;
  docId: string;
}

export interface StoredDoc {
  id: string;
  data: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** What a write may take. `subjectRows` is null for a shared row, which only the product's totals hold. */
export interface WriteLimits {
  rows: number;
  bytes: number;
  collections: number;
  subjectRows: number | null;
}

export type WriteRefusal = "rows" | "bytes" | "collections" | "subject" | "version_conflict";
export type WriteResult = { ok: true; doc: StoredDoc } | { ok: false; reason: WriteRefusal };

export type QueryOrder = "newest" | "oldest" | "recent";

export interface QueryInput {
  productId: string;
  namespace: string;
  collection: string;
  scope: DataScope;
  ownerKey: string | null;
  where: Record<string, string | number | boolean | null> | null;
  order: QueryOrder;
  limit: number;
  after: string | null;
}

export interface DataStore {
  create(key: RowKey, data: unknown, bytes: number, limits: WriteLimits): Promise<WriteResult>;
  get(key: RowKey): Promise<StoredDoc | null>;
  put(key: RowKey, data: unknown, bytes: number, ifVersion: number | null, limits: WriteLimits): Promise<WriteResult>;
  remove(key: RowKey): Promise<boolean>;
  query(input: QueryInput): Promise<{ items: StoredDoc[]; next: string | null }>;
  deleteMine(productId: string, namespace: string, ownerKeys: string[]): Promise<number>;
  collections(productId: string, namespace: string): Promise<Array<{ collection: string; scope: DataScope; rows: number; bytes: number }>>;
}

const rowsOf = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
};

/** created_at and updated_at with their microseconds, so a page's cursor is exact. */
const ISO_US = (column: string) => sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

interface RawDoc {
  doc_id: string;
  data: unknown;
  version: number;
  created_at: string;
  updated_at: string;
}

const toDoc = (r: RawDoc): StoredDoc => ({ id: r.doc_id, data: r.data, version: Number(r.version), createdAt: r.created_at, updatedAt: r.updated_at });

const keyWhere = (k: RowKey, alias = "") => {
  const c = (name: string) => sql.raw(`${alias}${name}`);
  return sql`${c("product_id")} = ${k.productId}::uuid and ${c("namespace")} = ${k.namespace} and ${c("collection")} = ${k.collection} and ${c("scope")} = ${k.scope} and ${c("owner_key")} is not distinct from ${k.ownerKey}::text and ${c("doc_id")} = ${k.docId}`;
};

function ensureCounts(productId: string, namespace: string) {
  return db().insert(schema.productDataCounts).values({ productId, namespace }).onConflictDoNothing();
}

function lockCounts(productId: string, namespace: string) {
  return db().execute(sql`select rows from product_data_counts where product_id = ${productId}::uuid and namespace = ${namespace} for update`);
}

/** The checks every write that may add a row makes, as SQL over the CTEs `c` (counts) and `d` (drow, dbytes). */
function fits(k: RowKey, limits: WriteLimits): SQL {
  const subject =
    limits.subjectRows === null || k.ownerKey === null
      ? sql`true`
      : sql`(d.drow = 0 or (select count(*) from product_rows s where s.product_id = ${k.productId}::uuid and s.namespace = ${k.namespace} and s.owner_key = ${k.ownerKey}::text and s.deleted_at is null) < ${limits.subjectRows}::int)`;
  return sql`c.rows + d.drow <= ${limits.rows}::int and c.bytes + d.dbytes <= ${limits.bytes}::bigint and ${subject}
    and (exists (select 1 from product_rows s where s.product_id = ${k.productId}::uuid and s.namespace = ${k.namespace} and s.collection = ${k.collection} and s.deleted_at is null)
      or (select count(distinct s.collection) from product_rows s where s.product_id = ${k.productId}::uuid and s.namespace = ${k.namespace} and s.deleted_at is null) < ${limits.collections}::int)`;
}

/** Why a write that wrote nothing was refused, read after it. */
async function whyRefused(k: RowKey, bytes: number, limits: WriteLimits, ifVersion: number | null): Promise<WriteRefusal> {
  const [row] = rowsOf<{ rows: number; bytes: number; live_version: number | null; live_bytes: number | null; subject_rows: number; has_collection: boolean; collections: number }>(
    await db().execute(sql`select
        coalesce((select rows from product_data_counts where product_id = ${k.productId}::uuid and namespace = ${k.namespace}), 0)::int as rows,
        coalesce((select bytes from product_data_counts where product_id = ${k.productId}::uuid and namespace = ${k.namespace}), 0)::bigint as bytes,
        (select version from product_rows where ${keyWhere(k)} and deleted_at is null) as live_version,
        (select bytes from product_rows where ${keyWhere(k)} and deleted_at is null) as live_bytes,
        (select count(*) from product_rows s where s.product_id = ${k.productId}::uuid and s.namespace = ${k.namespace} and s.owner_key is not distinct from ${k.ownerKey}::text and s.deleted_at is null)::int as subject_rows,
        exists (select 1 from product_rows s where s.product_id = ${k.productId}::uuid and s.namespace = ${k.namespace} and s.collection = ${k.collection} and s.deleted_at is null) as has_collection,
        (select count(distinct s.collection) from product_rows s where s.product_id = ${k.productId}::uuid and s.namespace = ${k.namespace} and s.deleted_at is null)::int as collections`),
  );
  if (!row) return "rows";
  const live = row.live_version !== null && row.live_version !== undefined;
  if (ifVersion !== null && (!live || Number(row.live_version) !== ifVersion)) return "version_conflict";
  if (!live && Number(row.rows) + 1 > limits.rows) return "rows";
  if (Number(row.bytes) + bytes - (live ? Number(row.live_bytes) : 0) > limits.bytes) return "bytes";
  if (!live && limits.subjectRows !== null && k.ownerKey !== null && Number(row.subject_rows) >= limits.subjectRows) return "subject";
  if (!row.has_collection && Number(row.collections) >= limits.collections) return "collections";
  // A create that met every quota and still wrote nothing hit an id that's taken.
  return "version_conflict";
}

async function write(k: RowKey, data: unknown, bytes: number, ifVersion: number | null, limits: WriteLimits, create: boolean): Promise<WriteResult> {
  const json = JSON.stringify(data);
  const conflict = create
    ? sql`on conflict on constraint product_rows_key do nothing`
    : sql`on conflict on constraint product_rows_key do update set data = excluded.data, bytes = excluded.bytes, version = product_rows.version + 1,
        deleted_at = null, updated_at = now(), seq = nextval('product_rows_seq'),
        created_at = case when product_rows.deleted_at is null then product_rows.created_at else now() end`;
  const version = ifVersion === null ? sql`true` : sql`exists (select 1 from old where old.live and old.version = ${ifVersion}::int)`;
  const [, , result] = await db().batch([
    ensureCounts(k.productId, k.namespace),
    lockCounts(k.productId, k.namespace),
    db().execute(sql`with c as (select rows, bytes from product_data_counts where product_id = ${k.productId}::uuid and namespace = ${k.namespace}),
      old as (select bytes, version, deleted_at is null as live from product_rows where ${keyWhere(k)}),
      d as (select case when exists (select 1 from old where old.live) then 0 else 1 end as drow,
                   ${bytes}::bigint - coalesce((select bytes from old where old.live), 0) as dbytes),
      ok as (select 1 as one from c, d where ${version} and ${fits(k, limits)}),
      up as (
        insert into product_rows (product_id, namespace, collection, scope, owner_key, doc_id, data, bytes)
        select ${k.productId}::uuid, ${k.namespace}, ${k.collection}, ${k.scope}, ${k.ownerKey}::text, ${k.docId}, ${json}::jsonb, ${bytes}::int from ok
        ${conflict}
        returning doc_id, data, version, ${ISO_US("created_at")} as created_at, ${ISO_US("updated_at")} as updated_at
      ),
      cnt as (
        update product_data_counts set rows = rows + (select drow from d), bytes = bytes + (select dbytes from d)
        where product_id = ${k.productId}::uuid and namespace = ${k.namespace} and exists (select 1 from up)
        returning rows
      )
      select up.*, (select count(*) from cnt) as counted from up`),
  ]);
  const [row] = rowsOf<RawDoc>(result);
  if (row) return { ok: true, doc: toDoc(row) };
  return { ok: false, reason: await whyRefused(k, bytes, limits, create ? null : ifVersion) };
}

function orderBy(order: QueryOrder): { by: SQL; cursorColumn: string; desc: boolean } {
  if (order === "oldest") return { by: sql`created_at asc, id asc`, cursorColumn: "created_at", desc: false };
  if (order === "recent") return { by: sql`updated_at desc, id desc`, cursorColumn: "updated_at", desc: true };
  return { by: sql`created_at desc, id desc`, cursorColumn: "created_at", desc: true };
}

/** A page's cursor: the last item's time (to the microsecond) and its row id, base64url. */
export function encodeCursor(at: string, rowId: string): string {
  return Buffer.from(JSON.stringify([at, rowId])).toString("base64url");
}

export function decodeCursor(cursor: string): { at: string; rowId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, rowId] = parsed as [unknown, unknown];
    if (typeof at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(at)) return null;
    if (typeof rowId !== "string" || !/^[0-9a-f-]{36}$/.test(rowId)) return null;
    return { at, rowId };
  } catch {
    return null;
  }
}

export const dataStore: DataStore = {
  create: (k, data, bytes, limits) => write(k, data, bytes, null, limits, true),
  put: (k, data, bytes, ifVersion, limits) => write(k, data, bytes, ifVersion, limits, false),

  async get(k) {
    const [row] = rowsOf<RawDoc>(
      await db().execute(sql`select doc_id, data, version, ${ISO_US("created_at")} as created_at, ${ISO_US("updated_at")} as updated_at
        from product_rows where ${keyWhere(k)} and deleted_at is null`),
    );
    return row ? toDoc(row) : null;
  },

  async remove(k) {
    const [, , result] = await db().batch([
      ensureCounts(k.productId, k.namespace),
      lockCounts(k.productId, k.namespace),
      db().execute(sql`with del as (
          update product_rows set deleted_at = now(), updated_at = now(), seq = nextval('product_rows_seq')
          where ${keyWhere(k)} and deleted_at is null returning bytes
        ), cnt as (
          update product_data_counts set rows = greatest(rows - (select count(*) from del), 0), bytes = greatest(bytes - coalesce((select sum(bytes) from del), 0), 0)
          where product_id = ${k.productId}::uuid and namespace = ${k.namespace} and exists (select 1 from del) returning rows
        ) select (select count(*) from del)::int as n, (select count(*) from cnt)::int as counted`),
    ]);
    return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0) > 0;
  },

  async query(q) {
    const { by, cursorColumn, desc } = orderBy(q.order);
    const cursor = q.after ? decodeCursor(q.after) : null;
    const col = sql.raw(cursorColumn);
    const after = cursor ? (desc ? sql`and (${col}, id) < (${cursor.at}::timestamptz, ${cursor.rowId}::uuid)` : sql`and (${col}, id) > (${cursor.at}::timestamptz, ${cursor.rowId}::uuid)`) : sql``;
    const where = q.where && Object.keys(q.where).length ? sql`and data @> ${JSON.stringify(q.where)}::jsonb` : sql``;
    const rows = rowsOf<RawDoc & { row_id: string; cursor_at: string }>(
      await db().execute(sql`select id as row_id, doc_id, data, version, ${ISO_US("created_at")} as created_at, ${ISO_US("updated_at")} as updated_at, ${ISO_US(cursorColumn)} as cursor_at
        from product_rows
        where product_id = ${q.productId}::uuid and namespace = ${q.namespace} and collection = ${q.collection} and scope = ${q.scope}
          and owner_key is not distinct from ${q.ownerKey}::text and deleted_at is null ${where} ${after}
        order by ${by} limit ${q.limit + 1}`),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return { items: page.map(toDoc), next: rows.length > q.limit && last ? encodeCursor(last.cursor_at, last.row_id) : null };
  },

  async deleteMine(productId, namespace, ownerKeys) {
    if (!ownerKeys.length) return 0;
    const keys = sql.join(ownerKeys.map((k) => sql`${k}::text`), sql`, `);
    const [, , result] = await db().batch([
      ensureCounts(productId, namespace),
      lockCounts(productId, namespace),
      db().execute(sql`with del as (
          update product_rows set deleted_at = now(), updated_at = now(), seq = nextval('product_rows_seq')
          where product_id = ${productId}::uuid and namespace = ${namespace} and owner_key in (${keys}) and scope in ('visitor', 'user') and deleted_at is null
          returning bytes
        ), cnt as (
          update product_data_counts set rows = greatest(rows - (select count(*) from del), 0), bytes = greatest(bytes - coalesce((select sum(bytes) from del), 0), 0)
          where product_id = ${productId}::uuid and namespace = ${namespace} and exists (select 1 from del) returning rows
        ) select (select count(*) from del)::int as n, (select count(*) from cnt)::int as counted`),
    ]);
    return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0);
  },

  async collections(productId, namespace) {
    const rows = rowsOf<{ collection: string; scope: DataScope; rows: number; bytes: number }>(
      await db().execute(sql`select collection, scope, count(*)::int as rows, coalesce(sum(bytes), 0)::bigint as bytes
        from product_rows where product_id = ${productId}::uuid and namespace = ${namespace} and deleted_at is null
        group by collection, scope order by collection, scope`),
    );
    return rows.map((r) => ({ collection: r.collection, scope: r.scope, rows: Number(r.rows), bytes: Number(r.bytes) }));
  },
};

/** A new document's id. */
export const newDocId = () => randomUUID();

// ---------------------------------------------------------------------------------------------------------------
// The gateway's record, cleanup and the owner's view

/** The product a build belongs to and the collections its brief named, for /caps/proof. */
async function buildInfo(buildId: string): Promise<{ productId: string | null; collections: Array<{ name: string; scope: string }> }> {
  const [row] = await db()
    .select({ productId: schema.builds.productId, brief: schema.builds.brief })
    .from(schema.builds)
    .where(eq(schema.builds.id, buildId))
    .limit(1);
  const list = (row?.brief as { data?: { collections?: Array<{ name?: unknown; scope?: unknown }> } | null } | null | undefined)?.data?.collections;
  const collections = Array.isArray(list)
    ? list.flatMap((c) => (typeof c?.name === "string" && typeof c?.scope === "string" ? [{ name: c.name, scope: c.scope }] : []))
    : [];
  return { productId: row?.productId ?? null, collections };
}

/**
 * What the gateway saw in a build's namespace (CAP_PROOF.data, 2.8): rows written since `since`, rows there now by
 * scope, how many visitors and signed-in people wrote, and one `brief:<name>:<scope>` count per collection the brief
 * named, so verify can hold the product's manifest to it. Product code can't write any of it.
 */
export async function dataProof(buildId: string, window: { since: Date | null }): Promise<Record<string, number>> {
  const { productId, collections } = await buildInfo(buildId);
  const out: Record<string, number> = { writes: 0, rows: 0, shared: 0, visitor: 0, owner: 0, user: 0, visitors: 0, users: 0 };
  for (const c of collections) out[`brief:${c.name}:${c.scope}`] = 1;
  if (!productId) return out;
  const since = window.since ? sql`updated_at >= ${window.since.toISOString()}::timestamptz` : sql`true`;
  const [row] = rowsOf<Record<string, number>>(
    await db().execute(sql`select
        count(*) filter (where ${since})::int as writes,
        count(*) filter (where deleted_at is null)::int as rows,
        count(*) filter (where deleted_at is null and scope = 'shared')::int as shared,
        count(*) filter (where deleted_at is null and scope = 'visitor')::int as visitor,
        count(*) filter (where deleted_at is null and scope = 'owner')::int as owner,
        count(*) filter (where deleted_at is null and scope = 'user')::int as "user",
        count(distinct owner_key) filter (where scope = 'visitor' and ${since})::int as visitors,
        count(distinct owner_key) filter (where scope = 'user' and ${since})::int as users
      from product_rows where product_id = ${productId}::uuid and namespace = ${`b:${buildId}`}`),
  );
  for (const [k, v] of Object.entries(row ?? {})) out[k] = Number(v);
  return out;
}

/** A build ended: its namespace's rows and count go. */
export async function clearBuildNamespace(buildId: string): Promise<void> {
  const { productId } = await buildInfo(buildId);
  if (!productId) return;
  const namespace = `b:${buildId}`;
  await db().batch([
    db().delete(schema.productRows).where(and(eq(schema.productRows.productId, productId), eq(schema.productRows.namespace, namespace))),
    db().delete(schema.productDataCounts).where(and(eq(schema.productDataCounts.productId, productId), eq(schema.productDataCounts.namespace, namespace))),
  ]);
}

/**
 * The hourly sweep: rows deleted over an hour ago, and the namespaces of builds that crashed (nothing written there for
 * 24 hours). Returns how many rows it removed.
 */
export async function sweepData(now: Date): Promise<number> {
  const purgeBefore = new Date(now.getTime() - DATA_LIMITS.purgeAfterMs).toISOString();
  const deadBefore = new Date(now.getTime() - DATA_LIMITS.buildNamespaceMaxAgeMs).toISOString();
  const [purged, dead] = await db().batch([
    db().execute(sql`with gone as (delete from product_rows where deleted_at is not null and deleted_at < ${purgeBefore}::timestamptz returning 1) select count(*)::int as n from gone`),
    db().execute(sql`with dead as (
        select product_id, namespace from product_rows where namespace like 'b:%' group by product_id, namespace having max(updated_at) < ${deadBefore}::timestamptz
      ), gone as (
        delete from product_rows r using dead where r.product_id = dead.product_id and r.namespace = dead.namespace returning 1
      ), counts as (
        delete from product_data_counts pc using dead where pc.product_id = dead.product_id and pc.namespace = dead.namespace returning 1
      ) select (select count(*) from gone)::int as n, (select count(*) from counts)::int as counted`),
  ]);
  return Number(rowsOf<{ n: number }>(purged)[0]?.n ?? 0) + Number(rowsOf<{ n: number }>(dead)[0]?.n ?? 0);
}

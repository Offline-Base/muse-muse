import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { FILES_LIMITS } from "@/lib/caps/files/limits";
import { filesBlock, filesRule } from "@/lib/caps/files/brief";
import { filesDatasetsOn, filesSearchOn, type FileScope, type SearchSource } from "@/lib/caps/files/types";

/**
 * The files cap's database calls (docs/CAPABILITIES.md, section 10), kept apart from the handler so the routes' logic
 * runs in tests without a database. A ticket's quota check and its insert are one statement after a per-namespace
 * advisory lock in the same batch (one transaction on Neon), so two uploads can't both take the last of a quota.
 */

export interface FileKey {
  productId: string;
  namespace: string;
}

/** Where a file or document belongs: its scope and, for a private one, its person's subject key. */
export interface OwnerSpace extends FileKey {
  scope: FileScope;
  ownerKey: string | null;
}

export interface StoredFile {
  id: string;
  scope: FileScope;
  ownerKey: string | null;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string | null;
  blobPath: string;
  status: "pending" | "ready";
  createdAt: string;
}

export interface FileLimits {
  productBytes: number;
  productFiles: number;
  /** A visitor's or a user's bytes, or null for a shared or owner file, which only the product's totals hold. */
  subjectBytes: number | null;
}

export type TicketRefusal = "bytes" | "files" | "subject";

export interface SearchChunk {
  body: string;
  offset: number;
}

export interface SearchHit {
  source: SearchSource;
  title: string;
  body: string;
  offset: number;
  rank: number;
  snippet: string;
}

export interface FilesStore {
  createPending(space: OwnerSpace, file: { id: string; name: string; contentType: string; bytes: number; blobPath: string }, limits: FileLimits): Promise<{ ok: true; file: StoredFile } | { ok: false; reason: TicketRefusal }>;
  get(key: FileKey, id: string): Promise<StoredFile | null>;
  markReady(key: FileKey, id: string, facts: { bytes: number; sha256: string }): Promise<StoredFile | null>;
  list(space: OwnerSpace, page: { limit: number; after: string | null }): Promise<{ items: StoredFile[]; next: string | null }>;
  /** Sets deleted_at and gives back the blob's path, or null when there is no such file. */
  beginDelete(key: FileKey, id: string): Promise<string | null>;
  /** Removes the row and its search chunks, after the blob is gone. */
  finishDelete(key: FileKey, id: string): Promise<void>;
  indexDoc(space: OwnerSpace, doc: { source: SearchSource; sourceKey: string; title: string; chunks: SearchChunk[] }, maxDocs: number): Promise<{ ok: true } | { ok: false }>;
  removeDoc(key: FileKey, sourceKey: string): Promise<number>;
  query(space: OwnerSpace, q: { text: string; prefix: string | null; limit: number }): Promise<SearchHit[]>;
  recordDatasetRead(key: FileKey, datasetId: string, file: string): Promise<void>;
}

const rowsOf = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
};

interface RawFile {
  id: string;
  scope: FileScope;
  owner_key: string | null;
  name: string;
  content_type: string;
  bytes: number | string;
  sha256: string | null;
  blob_path: string;
  status: "pending" | "ready";
  created_at: string;
}

const fileOf = (r: RawFile): StoredFile => ({
  id: r.id,
  scope: r.scope,
  ownerKey: r.owner_key,
  name: r.name,
  contentType: r.content_type,
  bytes: Number(r.bytes),
  sha256: r.sha256,
  blobPath: r.blob_path,
  status: r.status,
  createdAt: r.created_at,
});

/** A file's columns, created_at with its microseconds so a page's cursor is exact. */
const FILE_COLUMNS = sql.raw(`id, scope, owner_key, name, content_type, bytes, sha256, blob_path, status, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`);

/** A page cursor: the last item's time and id, base64url. */
export function encodeFilesCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString("base64url");
}

export function decodeFilesCursor(cursor: string): { at: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, id] = parsed as [unknown, unknown];
    if (typeof at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(at) || typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

const ownerIs = (ownerKey: string | null): SQL => (ownerKey === null ? sql`owner_key is null` : sql`owner_key = ${ownerKey}`);
const lockKey = (key: FileKey) => sql`select pg_advisory_xact_lock(hashtext(${`files:${key.productId}:${key.namespace}`}))`;

/** The source of a search document as one string, so indexing it again replaces it. */
export function sourceKeyOf(source: SearchSource): string {
  return "fileId" in source ? `file:${source.fileId}` : `item:${source.collection}:${source.docId}`;
}

export const filesStore: FilesStore = {
  async createPending(space, file, limits) {
    const subject = space.ownerKey !== null && limits.subjectBytes !== null;
    const [, inserted] = await db().batch([
      db().execute(lockKey(space)),
      db().execute(sql`insert into product_files (id, product_id, namespace, scope, owner_key, name, content_type, bytes, blob_path, status)
        select ${file.id}::uuid, ${space.productId}::uuid, ${space.namespace}, ${space.scope}, ${space.ownerKey}, ${file.name}, ${file.contentType}, ${file.bytes}::bigint, ${file.blobPath}, 'pending'
        where (select coalesce(sum(bytes), 0) from product_files where product_id = ${space.productId}::uuid and namespace = ${space.namespace} and deleted_at is null) + ${file.bytes}::bigint <= ${limits.productBytes}::bigint
          and (select count(*) from product_files where product_id = ${space.productId}::uuid and namespace = ${space.namespace} and deleted_at is null) < ${limits.productFiles}::int
          and (${!subject}::boolean or (select coalesce(sum(bytes), 0) from product_files where product_id = ${space.productId}::uuid and namespace = ${space.namespace} and owner_key = ${space.ownerKey ?? ""} and deleted_at is null) + ${file.bytes}::bigint <= ${limits.subjectBytes ?? 0}::bigint)
        returning ${FILE_COLUMNS}`),
    ]);
    const row = rowsOf<RawFile>(inserted)[0];
    if (row) return { ok: true, file: fileOf(row) };
    // Why not: read the totals after the fact. A refusal never wrote anything.
    const [totals] = rowsOf<{ bytes: number | string; files: number; mine: number | string }>(
      await db().execute(sql`select coalesce(sum(bytes), 0) as bytes, count(*)::int as files,
          coalesce(sum(bytes) filter (where owner_key = ${space.ownerKey ?? ""}), 0) as mine
        from product_files where product_id = ${space.productId}::uuid and namespace = ${space.namespace} and deleted_at is null`),
    );
    if (Number(totals?.files ?? 0) >= limits.productFiles) return { ok: false, reason: "files" };
    if (Number(totals?.bytes ?? 0) + file.bytes > limits.productBytes) return { ok: false, reason: "bytes" };
    return { ok: false, reason: "subject" };
  },

  async get(key, id) {
    const rows = rowsOf<RawFile>(
      await db().execute(sql`select ${FILE_COLUMNS} from product_files where id = ${id}::uuid and product_id = ${key.productId}::uuid and namespace = ${key.namespace} and deleted_at is null`),
    );
    return rows[0] ? fileOf(rows[0]) : null;
  },

  async markReady(key, id, facts) {
    const rows = rowsOf<RawFile>(
      await db().execute(sql`update product_files set status = 'ready', bytes = ${facts.bytes}, sha256 = ${facts.sha256}
        where id = ${id}::uuid and product_id = ${key.productId}::uuid and namespace = ${key.namespace} and deleted_at is null
        returning ${FILE_COLUMNS}`),
    );
    return rows[0] ? fileOf(rows[0]) : null;
  },

  async list(space, page) {
    const after = page.after ? decodeFilesCursor(page.after) : null;
    const rows = rowsOf<RawFile>(
      await db().execute(sql`select ${FILE_COLUMNS} from product_files
        where product_id = ${space.productId}::uuid and namespace = ${space.namespace} and scope = ${space.scope} and ${ownerIs(space.ownerKey)}
          and status = 'ready' and deleted_at is null
          ${after ? sql`and (created_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
        order by created_at desc, id desc limit ${page.limit + 1}`),
    );
    const items = rows.slice(0, page.limit).map(fileOf);
    const last = items.at(-1);
    return { items, next: rows.length > page.limit && last ? encodeFilesCursor(last.createdAt, last.id) : null };
  },

  async beginDelete(key, id) {
    const rows = rowsOf<{ blob_path: string }>(
      await db().execute(sql`update product_files set deleted_at = now()
        where id = ${id}::uuid and product_id = ${key.productId}::uuid and namespace = ${key.namespace} and deleted_at is null
        returning blob_path`),
    );
    return rows[0]?.blob_path ?? null;
  },

  async finishDelete(key, id) {
    await db().batch([
      db().delete(schema.productSearchDocs).where(and(eq(schema.productSearchDocs.productId, key.productId), eq(schema.productSearchDocs.namespace, key.namespace), eq(schema.productSearchDocs.sourceKey, `file:${id}`))),
      db().delete(schema.productFiles).where(and(eq(schema.productFiles.id, id), eq(schema.productFiles.productId, key.productId))),
    ]);
  },

  async indexDoc(space, doc, maxDocs) {
    const values = doc.chunks.map((c, i) => sql`(${space.productId}::uuid, ${space.namespace}::text, ${space.scope}::text, ${space.ownerKey}::text, ${JSON.stringify(doc.source)}::jsonb, ${doc.sourceKey}::text, ${doc.title}::text, ${c.body}::text, ${i}::int, ${c.offset}::int)`);
    const [, , inserted] = await db().batch([
      db().execute(lockKey(space)),
      db().execute(sql`delete from product_search_docs where product_id = ${space.productId}::uuid and namespace = ${space.namespace} and source_key = ${doc.sourceKey}`),
      db().execute(sql`insert into product_search_docs (product_id, namespace, scope, owner_key, source, source_key, title, body, chunk, "offset")
        select * from (values ${sql.join(values, sql`, `)}) as v(product_id, namespace, scope, owner_key, source, source_key, title, body, chunk, "offset")
        where (select count(distinct source_key) from product_search_docs where product_id = ${space.productId}::uuid and namespace = ${space.namespace}) < ${maxDocs}
        returning 1 as n`),
    ]);
    return rowsOf(inserted).length ? { ok: true } : { ok: false };
  },

  async removeDoc(key, sourceKey) {
    const rows = rowsOf<{ n: number }>(
      await db().execute(sql`with gone as (delete from product_search_docs where product_id = ${key.productId}::uuid and namespace = ${key.namespace} and source_key = ${sourceKey} returning 1)
        select count(*)::int as n from gone`),
    );
    return Number(rows[0]?.n ?? 0);
  },

  async query(space, q) {
    // websearch_to_tsquery takes what a person types (quotes, OR, -word) and never fails on it. The prefix query, made
    // only of letters and digits, also finds a word someone has only begun to type.
    const query = q.prefix ? sql`(websearch_to_tsquery('simple', ${q.text}) || to_tsquery('simple', ${q.prefix}))` : sql`websearch_to_tsquery('simple', ${q.text})`;
    const rows = rowsOf<{ source: SearchSource | string; title: string; body: string; offset: number; rank: number; snippet: string }>(
      await db().execute(sql`with q as (select ${query} as query)
        select d.source, d.title, d.body, d."offset", ts_rank_cd(d.tsv, q.query) as rank,
          ts_headline('simple', d.body, q.query, ${`StartSel=<<, StopSel=>>, MaxWords=${FILES_LIMITS.snippetWords}, MinWords=10, ShortWord=1, MaxFragments=1`}) as snippet
        from product_search_docs d, q
        where d.product_id = ${space.productId}::uuid and d.namespace = ${space.namespace} and d.scope = ${space.scope} and ${space.ownerKey === null ? sql`d.owner_key is null` : sql`d.owner_key = ${space.ownerKey}`}
          and d.tsv @@ q.query
        order by rank desc, d.created_at desc, d.chunk asc
        limit ${q.limit}`),
    );
    return rows.map((r) => ({
      source: (typeof r.source === "string" ? JSON.parse(r.source) : r.source) as SearchSource,
      title: r.title,
      body: r.body,
      offset: Number(r.offset),
      rank: Number(r.rank),
      snippet: r.snippet,
    }));
  },

  async recordDatasetRead(key, datasetId, file) {
    await db().insert(schema.productDatasetReads).values({ productId: key.productId, namespace: key.namespace, datasetId, file });
  },
};

/** A build's product and brief, for its proof and cleanup. */
async function buildRow(buildId: string): Promise<{ productId: string | null; brief: unknown }> {
  const [row] = await db().select({ productId: schema.builds.productId, brief: schema.builds.brief }).from(schema.builds).where(eq(schema.builds.id, buildId)).limit(1);
  return { productId: row?.productId ?? null, brief: row?.brief ?? null };
}

/**
 * What the gateway saw for a build's namespace (CAP_PROOF.files): files made ready, documents indexed and dataset files
 * read since `since`, the files there now, and the brief's choices (`brief:scope:<scope>`, `brief:uploads:<who>` for a
 * shared space, `brief:search`, `brief:dataset:<id>`), which the checker compares with what the product did.
 */
export async function filesProof(buildId: string, window: { since: Date | null }): Promise<Record<string, number>> {
  const { productId, brief } = await buildRow(buildId);
  const out: Record<string, number> = { uploaded: 0, files: 0, bytes: 0, indexed: 0, docs: 0, datasetReads: 0 };
  // The brief's choices as the build prompt gave them: search and datasets only while their switches are on.
  const rule = filesRule(filesBlock(brief as object | null));
  if (rule) {
    out[`brief:scope:${rule.scope}`] = 1;
    if (rule.scope === "shared") out[`brief:uploads:${rule.uploads}`] = 1;
    if (rule.search && filesSearchOn()) out["brief:search"] = 1;
    if (filesDatasetsOn()) for (const d of rule.datasets) out[`brief:dataset:${d}`] = 1;
  }
  if (!productId) return out;
  const namespace = `b:${buildId}`;
  const since = window.since ? window.since.toISOString() : null;
  const sinceIs = (column: string) => (since ? sql`${sql.raw(column)} >= ${since}::timestamptz` : sql`true`);
  const [files] = rowsOf<Record<string, number | string>>(
    await db().execute(sql`select count(*) filter (where status = 'ready' and ${sinceIs("created_at")})::int as uploaded,
        count(*) filter (where status = 'ready')::int as files, coalesce(sum(bytes) filter (where status = 'ready'), 0) as bytes
      from product_files where product_id = ${productId}::uuid and namespace = ${namespace} and deleted_at is null`),
  );
  const [docs] = rowsOf<Record<string, number | string>>(
    await db().execute(sql`select count(distinct source_key) filter (where ${sinceIs("created_at")})::int as indexed, count(distinct source_key)::int as docs
      from product_search_docs where product_id = ${productId}::uuid and namespace = ${namespace}`),
  );
  const reads = rowsOf<{ dataset_id: string; n: number }>(
    await db().execute(sql`select dataset_id, count(*)::int as n from product_dataset_reads
      where product_id = ${productId}::uuid and namespace = ${namespace} and ${sinceIs("created_at")} group by dataset_id`),
  );
  for (const [k, v] of Object.entries({ ...files, ...docs })) out[k] = Number(v);
  for (const r of reads) {
    out.datasetReads += Number(r.n);
    out[`dataset:${r.dataset_id}`] = Number(r.n);
  }
  return out;
}

/** Every blob path in a namespace, and the namespace's rows, removed. Blobs first: a row is the only way to find one. */
export async function clearNamespace(productId: string, namespace: string, removeBlobs: (paths: string[]) => Promise<void>): Promise<number> {
  const paths = await db()
    .select({ blobPath: schema.productFiles.blobPath })
    .from(schema.productFiles)
    .where(and(eq(schema.productFiles.productId, productId), eq(schema.productFiles.namespace, namespace)));
  for (let i = 0; i < paths.length; i += 500) await removeBlobs(paths.slice(i, i + 500).map((p) => p.blobPath));
  await db().batch([
    db().delete(schema.productFiles).where(and(eq(schema.productFiles.productId, productId), eq(schema.productFiles.namespace, namespace))),
    db().delete(schema.productSearchDocs).where(and(eq(schema.productSearchDocs.productId, productId), eq(schema.productSearchDocs.namespace, namespace))),
    db().delete(schema.productDatasetReads).where(and(eq(schema.productDatasetReads.productId, productId), eq(schema.productDatasetReads.namespace, namespace))),
  ]);
  return paths.length;
}

/** A build ended: its files, index and dataset reads go. */
export async function clearFilesBuild(buildId: string, removeBlobs: (paths: string[]) => Promise<void>): Promise<void> {
  const { productId } = await buildRow(buildId);
  if (productId) await clearNamespace(productId, `b:${buildId}`, removeBlobs);
}

/**
 * The hourly sweep: tickets never finished (pending for over two hours), deletes that stopped half way, and the
 * namespaces of builds that crashed (nothing new for 24 hours). Returns how many files it removed.
 */
export async function sweepFiles(now: Date, removeBlobs: (paths: string[]) => Promise<void>): Promise<number> {
  const stale = new Date(now.getTime() - FILES_LIMITS.pendingMaxAgeMs).toISOString();
  const dead = new Date(now.getTime() - FILES_LIMITS.buildNamespaceMaxAgeMs).toISOString();
  const loose = rowsOf<{ id: string; product_id: string; namespace: string; blob_path: string }>(
    await db().execute(sql`select id, product_id, namespace, blob_path from product_files
      where deleted_at is not null or (status = 'pending' and created_at < ${stale}::timestamptz) limit 500`),
  );
  if (loose.length) {
    await removeBlobs(loose.map((r) => r.blob_path));
    for (const r of loose) await filesStore.finishDelete({ productId: r.product_id, namespace: r.namespace }, r.id);
  }
  let removed = loose.length;
  const crashed = rowsOf<{ product_id: string; namespace: string }>(
    await db().execute(sql`select product_id, namespace from (
        select product_id, namespace, max(created_at) as last from product_files where namespace like 'b:%' group by product_id, namespace
        union all select product_id, namespace, max(created_at) from product_search_docs where namespace like 'b:%' group by product_id, namespace
        union all select product_id, namespace, max(created_at) from product_dataset_reads where namespace like 'b:%' group by product_id, namespace
      ) t group by product_id, namespace having max(last) < ${dead}::timestamptz limit 50`),
  );
  for (const c of crashed) removed += await clearNamespace(c.product_id, c.namespace, removeBlobs);
  return removed;
}

/** A taken-down product's live files and index go (section 10, Guards). Returns how many files. */
export async function clearLiveFiles(productId: string, removeBlobs: (paths: string[]) => Promise<void>): Promise<number> {
  return clearNamespace(productId, "live", removeBlobs);
}

/** Whether a product is taken down (unit 1), for productOff. */
export async function productTakenDown(productId: string): Promise<boolean> {
  const [row] = await db().select({ takenDownAt: schema.products.takenDownAt }).from(schema.products).where(eq(schema.products.id, productId)).limit(1);
  return Boolean(row?.takenDownAt);
}

/** One file by id, whatever its product, for the gateway's signed read and upload routes. Deleted files are none. */
export async function fileById(id: string): Promise<(StoredFile & { productId: string; namespace: string }) | null> {
  const rows = rowsOf<RawFile & { product_id: string; namespace: string }>(
    await db().execute(sql`select ${FILE_COLUMNS}, product_id, namespace from product_files where id = ${id}::uuid and deleted_at is null`),
  );
  const r = rows[0];
  return r ? { ...fileOf(r), productId: r.product_id, namespace: r.namespace } : null;
}

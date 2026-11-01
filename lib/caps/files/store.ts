import { and, eq, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import type { FilesBlobMode } from "@/lib/caps/files/blob";
import { FILES_LIMITS } from "@/lib/caps/files/limits";
import { filesBlock, filesRule } from "@/lib/caps/files/brief";
import { filesDatasetsOn, filesSearchOn, type FileScope, type SearchSource } from "@/lib/caps/files/types";

/**
 * The files cap's database calls (docs/CAPABILITIES.md, section 10), kept apart from the handler so the routes' logic
 * runs in tests without a database. Each quota check and its write are one statement after a per-namespace advisory lock
 * in the same batch (one transaction on Neon), so two uploads can't both take the last of a quota. A product's totals
 * count ready files only, at the ticket and again at done, so tickets nobody finishes never block anyone else's upload.
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
  /** The Blob mode the file was written in, which every later call for it uses. */
  store: FilesBlobMode;
  status: "pending" | "ready";
  createdAt: string;
}

export interface FileLimits {
  productBytes: number;
  productFiles: number;
  /** A visitor's or a user's bytes, or null for a shared or owner file, which only the product's totals hold. */
  subjectBytes: number | null;
}

export type TicketRefusal = "bytes" | "files" | "subject" | "tickets";

/** Removes blobs written in one Blob mode. */
export type RemoveBlobs = (store: FilesBlobMode, paths: string[]) => Promise<void>;

/** What one document may add to an index. `replaceAny` is false only for someone other than the owner in a shared space. */
export interface IndexCaps {
  maxDocs: number;
  maxBytes: number;
  /** The adder's own caps, or null for the owner. */
  subject: { docs: number; bytes: number } | null;
  replaceAny: boolean;
}

export type IndexRefusal = "taken" | "docs" | "bytes" | "subject_docs" | "subject_bytes";

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
  /** `ticketKey` is the asking address's keyed hash, or null when the call names no address. */
  createPending(space: OwnerSpace, file: { id: string; name: string; contentType: string; bytes: number; blobPath: string; store: FilesBlobMode; ticketKey: string | null }, limits: FileLimits): Promise<{ ok: true; file: StoredFile } | { ok: false; reason: TicketRefusal }>;
  get(key: FileKey, id: string): Promise<StoredFile | null>;
  /** Makes a pending file ready if the product's (and its person's) ready files still have room for it; null if it's gone. */
  markReady(key: FileKey, id: string, facts: { bytes: number; sha256: string }, limits: FileLimits): Promise<{ ok: true; file: StoredFile } | { ok: false; reason: TicketRefusal } | null>;
  list(space: OwnerSpace, page: { limit: number; after: string | null }): Promise<{ items: StoredFile[]; next: string | null }>;
  /** Sets deleted_at and gives back the blob's path, or null when there is no such file. */
  beginDelete(key: FileKey, id: string): Promise<string | null>;
  /** Removes the row and its search chunks, after the blob is gone. */
  finishDelete(key: FileKey, id: string): Promise<void>;
  /** Adds a document, or replaces the same source in the same space (another adder's only with `replaceAny`). */
  indexDoc(space: OwnerSpace, doc: { source: SearchSource; sourceKey: string; title: string; chunks: SearchChunk[]; addedBy: string | null }, caps: IndexCaps): Promise<{ ok: true } | { ok: false; reason: IndexRefusal }>;
  /** Removes a source's text from this space only. */
  removeDoc(space: OwnerSpace, sourceKey: string): Promise<number>;
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
  store: FilesBlobMode;
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
  store: r.store,
  status: r.status,
  createdAt: r.created_at,
});

/** A file's columns, created_at with its microseconds so a page's cursor is exact. */
const FILE_COLUMNS = sql.raw(`id, scope, owner_key, name, content_type, bytes, sha256, blob_path, store, status, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`);

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

/** One document in an index: its scope, its person and its source. */
const DOC_KEY = sql.raw(`scope || ':' || coalesce(owner_key, '') || ':' || source_key`);
const ownerIs = (ownerKey: string | null): SQL => (ownerKey === null ? sql`owner_key is null` : sql`owner_key = ${ownerKey}`);
const lockKey = (key: FileKey) => sql`select pg_advisory_xact_lock(hashtext(${`files:${key.productId}:${key.namespace}`}))`;
const inKey = (key: FileKey) => sql`product_id = ${key.productId}::uuid and namespace = ${key.namespace}`;
const ms = (n: number) => sql`(${n}::int * interval '1 millisecond')`;
/** Ready files, the only ones a product's totals count. */
const readyRow = sql`status = 'ready' and deleted_at is null`;
/** A person's own files: ready ones, and pending ones whose ticket is still good. */
const subjectRow = sql`deleted_at is null and (status = 'ready' or (status = 'pending' and created_at > now() - ${ms(FILES_LIMITS.ticketValidMs)}))`;

/** The source of a search document as one string, so indexing it again replaces it. */
export function sourceKeyOf(source: SearchSource): string {
  return "fileId" in source ? `file:${source.fileId}` : `item:${source.collection}:${source.docId}`;
}

export const filesStore: FilesStore = {
  async createPending(space, file, limits) {
    const subject = space.ownerKey !== null && limits.subjectBytes !== null;
    const [, inserted] = await db().batch([
      db().execute(lockKey(space)),
      db().execute(sql`insert into product_files (id, product_id, namespace, scope, owner_key, name, content_type, bytes, blob_path, store, ticket_key, status)
        select ${file.id}::uuid, ${space.productId}::uuid, ${space.namespace}, ${space.scope}, ${space.ownerKey}, ${file.name}, ${file.contentType}, ${file.bytes}::bigint, ${file.blobPath}, ${file.store}, ${file.ticketKey}, 'pending'
        where (select coalesce(sum(bytes), 0) from product_files where ${inKey(space)} and ${readyRow}) + ${file.bytes}::bigint <= ${limits.productBytes}::bigint
          and (select count(*) from product_files where ${inKey(space)} and ${readyRow}) < ${limits.productFiles}::int
          and (${!subject}::boolean or (select coalesce(sum(bytes), 0) from product_files where ${inKey(space)} and owner_key = ${space.ownerKey ?? ""} and ${subjectRow}) + ${file.bytes}::bigint <= ${limits.subjectBytes ?? 0}::bigint)
          and (${file.ticketKey === null}::boolean or (select count(*) from product_files where ${inKey(space)} and ticket_key = ${file.ticketKey ?? ""} and status = 'pending' and deleted_at is null and created_at > now() - ${ms(FILES_LIMITS.pendingMaxAgeMs)}) < ${FILES_LIMITS.pendingPerAddress}::int)
        returning ${FILE_COLUMNS}`),
    ]);
    const row = rowsOf<RawFile>(inserted)[0];
    if (row) return { ok: true, file: fileOf(row) };
    // Why not: read the totals after the fact. A refusal never wrote anything.
    const [totals] = rowsOf<{ bytes: number | string; files: number; tickets: number }>(
      await db().execute(sql`select coalesce(sum(bytes) filter (where ${readyRow}), 0) as bytes, (count(*) filter (where ${readyRow}))::int as files,
          (count(*) filter (where ticket_key = ${file.ticketKey ?? ""} and status = 'pending' and deleted_at is null and created_at > now() - ${ms(FILES_LIMITS.pendingMaxAgeMs)}))::int as tickets
        from product_files where ${inKey(space)}`),
    );
    if (Number(totals?.files ?? 0) >= limits.productFiles) return { ok: false, reason: "files" };
    if (Number(totals?.bytes ?? 0) + file.bytes > limits.productBytes) return { ok: false, reason: "bytes" };
    if (file.ticketKey !== null && Number(totals?.tickets ?? 0) >= FILES_LIMITS.pendingPerAddress) return { ok: false, reason: "tickets" };
    return { ok: false, reason: "subject" };
  },

  async get(key, id) {
    const rows = rowsOf<RawFile>(
      await db().execute(sql`select ${FILE_COLUMNS} from product_files where id = ${id}::uuid and product_id = ${key.productId}::uuid and namespace = ${key.namespace} and deleted_at is null`),
    );
    return rows[0] ? fileOf(rows[0]) : null;
  },

  async markReady(key, id, facts, limits) {
    const [, updated] = await db().batch([
      db().execute(lockKey(key)),
      db().execute(sql`update product_files f set status = 'ready', bytes = ${facts.bytes}, sha256 = ${facts.sha256}, ticket_key = null
        where f.id = ${id}::uuid and f.product_id = ${key.productId}::uuid and f.namespace = ${key.namespace} and f.deleted_at is null
          and (select coalesce(sum(bytes), 0) from product_files where ${inKey(key)} and ${readyRow} and id <> ${id}::uuid) + ${facts.bytes}::bigint <= ${limits.productBytes}::bigint
          and (select count(*) from product_files where ${inKey(key)} and ${readyRow} and id <> ${id}::uuid) < ${limits.productFiles}::int
          and (${limits.subjectBytes === null}::boolean or f.owner_key is null
            or (select coalesce(sum(bytes), 0) from product_files where ${inKey(key)} and ${readyRow} and owner_key = f.owner_key and id <> ${id}::uuid) + ${facts.bytes}::bigint <= ${limits.subjectBytes ?? 0}::bigint)
        returning ${FILE_COLUMNS}`),
    ]);
    const row = rowsOf<RawFile>(updated)[0];
    if (row) return { ok: true, file: fileOf(row) };
    const file = await filesStore.get(key, id);
    if (!file) return null;
    const [totals] = rowsOf<{ bytes: number | string; files: number }>(
      await db().execute(sql`select coalesce(sum(bytes), 0) as bytes, count(*)::int as files from product_files where ${inKey(key)} and ${readyRow} and id <> ${id}::uuid`),
    );
    if (Number(totals?.files ?? 0) >= limits.productFiles) return { ok: false, reason: "files" };
    if (Number(totals?.bytes ?? 0) + facts.bytes > limits.productBytes) return { ok: false, reason: "bytes" };
    return { ok: false, reason: "subject" };
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
    // A build's row stays as `gone` (no blob, no search text) until the build ends, so the gateway's record of the build
    // still counts an upload its test deleted again. Every other read skips it: deleted_at is set.
    const build = key.namespace.startsWith("b:");
    await db().batch([
      db().delete(schema.productSearchDocs).where(and(eq(schema.productSearchDocs.productId, key.productId), eq(schema.productSearchDocs.namespace, key.namespace), eq(schema.productSearchDocs.sourceKey, `file:${id}`))),
      build
        ? db().execute(sql`update product_files set status = 'gone', deleted_at = coalesce(deleted_at, now()), ticket_key = null where id = ${id}::uuid and product_id = ${key.productId}::uuid`)
        : db().delete(schema.productFiles).where(and(eq(schema.productFiles.id, id), eq(schema.productFiles.productId, key.productId))),
    ]);
  },

  async indexDoc(space, doc, caps) {
    const values = doc.chunks.map((c, i) => sql`(${space.productId}::uuid, ${space.namespace}::text, ${space.scope}::text, ${space.ownerKey}::text, ${doc.addedBy}::text, ${JSON.stringify(doc.source)}::jsonb, ${doc.sourceKey}::text, ${doc.title}::text, ${c.body}::text, ${i}::int, ${c.offset}::int)`);
    const bytes = doc.chunks.reduce((n, c) => n + Buffer.byteLength(c.body, "utf8"), 0);
    const sameSource = sql`scope = ${space.scope} and ${ownerIs(space.ownerKey)} and source_key = ${doc.sourceKey}`;
    // Rows this call may replace: the same source in the same space, and in a shared space only the caller's own unless
    // the caller is the owner.
    const mine = caps.replaceAny ? sql`true` : doc.addedBy ? sql`added_by = ${doc.addedBy}` : sql`false`;
    const notOld = sql`id not in (select id from old)`;
    const subject = caps.subject && doc.addedBy;
    // One statement: the checks see the index as it was, without the rows being replaced, and those go only when the new
    // ones went in. A refused replacement leaves the old text as it was.
    const [, result] = await db().batch([
      db().execute(lockKey(space)),
      db().execute(sql`with old as (
          select id from product_search_docs where ${inKey(space)} and coalesce(${sameSource} and ${mine}, false)
        ), ins as (
          insert into product_search_docs (product_id, namespace, scope, owner_key, added_by, source, source_key, title, body, chunk, "offset")
          select * from (values ${sql.join(values, sql`, `)}) as v(product_id, namespace, scope, owner_key, added_by, source, source_key, title, body, chunk, "offset")
          where not exists (select 1 from product_search_docs where ${inKey(space)} and ${sameSource} and ${notOld})
            and (select count(distinct ${DOC_KEY}) from product_search_docs where ${inKey(space)} and ${notOld}) < ${caps.maxDocs}::int
            and (select coalesce(sum(octet_length(body)), 0) from product_search_docs where ${inKey(space)} and ${notOld}) + ${bytes}::bigint <= ${caps.maxBytes}::bigint
            and (${!subject}::boolean or (
              (select count(distinct source_key) from product_search_docs where ${inKey(space)} and added_by = ${doc.addedBy ?? ""} and ${notOld}) < ${caps.subject?.docs ?? 0}::int
              and (select coalesce(sum(octet_length(body)), 0) from product_search_docs where ${inKey(space)} and added_by = ${doc.addedBy ?? ""} and ${notOld}) + ${bytes}::bigint <= ${caps.subject?.bytes ?? 0}::bigint))
          returning 1
        ), del as (
          delete from product_search_docs where id in (select id from old) and exists (select 1 from ins)
        )
        select count(*)::int as n from ins`),
    ]);
    if (Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0) > 0) return { ok: true };
    const [why] = rowsOf<{ taken: boolean; docs: number; bytes: number | string; sdocs: number; sbytes: number | string }>(
      await db().execute(sql`select bool_or(coalesce(${sameSource} and not (${mine}), false)) as taken,
          count(distinct ${DOC_KEY}) filter (where not coalesce(${sameSource} and ${mine}, false))::int as docs,
          coalesce(sum(octet_length(body)) filter (where not coalesce(${sameSource} and ${mine}, false)), 0) as bytes,
          count(distinct source_key) filter (where added_by = ${doc.addedBy ?? ""} and not coalesce(${sameSource} and ${mine}, false))::int as sdocs,
          coalesce(sum(octet_length(body)) filter (where added_by = ${doc.addedBy ?? ""} and not coalesce(${sameSource} and ${mine}, false)), 0) as sbytes
        from product_search_docs where ${inKey(space)}`),
    );
    if (why?.taken) return { ok: false, reason: "taken" };
    if (Number(why?.docs ?? 0) >= caps.maxDocs) return { ok: false, reason: "docs" };
    if (Number(why?.bytes ?? 0) + bytes > caps.maxBytes) return { ok: false, reason: "bytes" };
    if (subject && Number(why?.sdocs ?? 0) >= caps.subject!.docs) return { ok: false, reason: "subject_docs" };
    return { ok: false, reason: "subject_bytes" };
  },

  async removeDoc(space, sourceKey) {
    const rows = rowsOf<{ n: number }>(
      await db().execute(sql`with gone as (delete from product_search_docs where ${inKey(space)} and scope = ${space.scope} and ${ownerIs(space.ownerKey)} and source_key = ${sourceKey} returning 1)
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
    // uploaded counts every file made ready since `since`, even one its test deleted again (a `gone` row keeps its sha256).
    await db().execute(sql`select count(*) filter (where sha256 is not null and ${sinceIs("created_at")})::int as uploaded,
        count(*) filter (where ${readyRow})::int as files, coalesce(sum(bytes) filter (where ${readyRow}), 0) as bytes
      from product_files where product_id = ${productId}::uuid and namespace = ${namespace}`),
  );
  const [docs] = rowsOf<Record<string, number | string>>(
    await db().execute(sql`select count(distinct ${DOC_KEY}) filter (where ${sinceIs("created_at")})::int as indexed, count(distinct ${DOC_KEY})::int as docs
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

/** Removes blobs grouped by the mode each was written in. */
async function removeByStore(rows: Array<{ blobPath: string; store: FilesBlobMode }>, removeBlobs: RemoveBlobs): Promise<void> {
  const byStore = new Map<FilesBlobMode, string[]>();
  for (const r of rows) byStore.set(r.store, [...(byStore.get(r.store) ?? []), r.blobPath]);
  for (const [store, paths] of byStore) for (let i = 0; i < paths.length; i += 500) await removeBlobs(store, paths.slice(i, i + 500));
}

/** Every blob in a namespace, and the namespace's rows, removed. Blobs first: a row is the only way to find one. */
export async function clearNamespace(productId: string, namespace: string, removeBlobs: RemoveBlobs): Promise<number> {
  const rows = rowsOf<{ blob_path: string; store: FilesBlobMode }>(
    await db().execute(sql`select blob_path, store from product_files where product_id = ${productId}::uuid and namespace = ${namespace} and status <> 'gone'`),
  );
  await removeByStore(rows.map((r) => ({ blobPath: r.blob_path, store: r.store })), removeBlobs);
  await db().batch([
    db().delete(schema.productFiles).where(and(eq(schema.productFiles.productId, productId), eq(schema.productFiles.namespace, namespace))),
    db().delete(schema.productSearchDocs).where(and(eq(schema.productSearchDocs.productId, productId), eq(schema.productSearchDocs.namespace, namespace))),
    db().delete(schema.productDatasetReads).where(and(eq(schema.productDatasetReads.productId, productId), eq(schema.productDatasetReads.namespace, namespace))),
  ]);
  return rows.length;
}

/** A build ended: its files, index and dataset reads go. */
export async function clearFilesBuild(buildId: string, removeBlobs: RemoveBlobs): Promise<void> {
  const { productId } = await buildRow(buildId);
  if (productId) await clearNamespace(productId, `b:${buildId}`, removeBlobs);
}

/**
 * The hourly sweep: tickets never finished (pending for over an hour), deletes that stopped half way, and the
 * namespaces of builds that crashed (nothing new for 24 hours). Returns how many files it removed.
 */
export async function sweepFiles(now: Date, removeBlobs: RemoveBlobs): Promise<number> {
  const stale = new Date(now.getTime() - FILES_LIMITS.pendingMaxAgeMs).toISOString();
  const dead = new Date(now.getTime() - FILES_LIMITS.buildNamespaceMaxAgeMs).toISOString();
  const loose = rowsOf<{ id: string; product_id: string; namespace: string; blob_path: string; store: FilesBlobMode }>(
    await db().execute(sql`select id, product_id, namespace, blob_path, store from product_files
      where (deleted_at is not null and status <> 'gone') or (status = 'pending' and deleted_at is null and created_at < ${stale}::timestamptz) limit 500`),
  );
  if (loose.length) {
    await removeByStore(loose.map((r) => ({ blobPath: r.blob_path, store: r.store })), removeBlobs);
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
export async function clearLiveFiles(productId: string, removeBlobs: RemoveBlobs): Promise<number> {
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

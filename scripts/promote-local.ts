/**
 * Puts products built on a local run (npm run dev:local) on the live site: in its database, with their files in its
 * Blob store, published to their own Vercel projects the way a live build publishes them, and in its gallery.
 *
 *   npx tsx --env-file=.env.local scripts/promote-local.ts --db .data/pglite --slug bird-count,shelf-scout
 *     --to URL          the live site (default https://muse-muse.vercel.app)
 *     --files DIR       where the local run stored its files (default .data/files)
 *     --store-id ID     the live site's Blob store (default store_8A701wVtiqVp1x3e)
 *     --republish       publish again a product the live site has with no link of its own, once its last try ended
 *     --dry-run         read everything and say what would be uploaded and sent, with no network calls at all
 *
 * It copies the PGlite folder first and reads the copy, since the dev server may hold the original. For each slug it
 * reads the product, every build of it with their events, and the muses they were built from, and skips a product
 * that isn't live or whose latest build isn't, saying why. The live site checks the bundle first
 * (POST /api/admin/import-product?check=1), so nothing is uploaded for a product it would refuse. Then each file the
 * rows point at (http://localhost:<port>/api/files/<key>) goes from <files>/data/<key>, with the content type in
 * <files>/types/<key>, to the live store at the same pathname, so paths with a build id in them stay right, and the
 * rows are rewritten to the new links. A bundle that still points at this machine is never sent. POST
 * /api/admin/import-product on the live site saves the rows under its guest account and starts publishing; this
 * script then waits up to 10 minutes for each product's live link and prints what happened. A product the live site
 * already has is reported, with nothing uploaded or sent again, unless it has no link of its own yet and --republish
 * is passed: then the live site publishes it again, once its last try has ended.
 *
 * Needs AUTOMATION_SECRET (the live site's), and VERCEL_OIDC_TOKEN (vercel env pull, good for 12 hours) for the
 * uploads, which sign in to the store --store-id names the way lib/storage.ts blobAuth() does on Vercel. Neither is
 * ever printed. A dry run needs neither.
 */
import { realpathSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import { bytes, plural } from "@/lib/format";
import { LOCAL_FILES_DIR } from "@/lib/local-files";
import type { ImportBundle } from "@/lib/promote/bundle";
import {
  blobUrlFor,
  findLocalFileUrls,
  localFileKeyOf,
  rewriteLocalUrls,
  skipReason,
  toBundle,
  whyNotSend,
  type LocalRows,
} from "@/lib/promote/local";
import { localFilePaths, putBlobAt } from "@/lib/storage";

const DEFAULT_TO = "https://muse-muse.vercel.app";
/** The live site's public Blob store. */
const DEFAULT_STORE = "store_8A701wVtiqVp1x3e";
const POLL_MS = 15_000;
const WAIT_MS = 10 * 60_000;
const UPLOADS_AT_ONCE = 4;
const USAGE =
  "Usage: npx tsx --env-file=.env.local scripts/promote-local.ts --db <pglite folder> --slug a,b [--to URL] [--files DIR] [--store-id ID] [--republish] [--dry-run]";
/** Flags that take no value. */
const SWITCHES = new Set(["dry-run", "republish"]);

export type LocalDb = PgliteDatabase<typeof schema>;

export interface Options {
  db: string;
  slugs: string[];
  to: string;
  files: string;
  storeId: string;
  republish: boolean;
  dryRun: boolean;
}

export interface Row {
  slug: string;
  status: "imported" | "already" | "dry run" | "skipped" | "failed";
  /** Files uploaded, or that a dry run would upload. */
  files: number;
  bytes: number;
  link: string | null;
  note: string;
  /** Set while the live site publishes it. */
  waitFor?: { productId: string; buildId: string };
}

/** The local file a URL in the rows names. */
interface LocalFile {
  key: string;
  file: string;
  type: string;
  size: number;
}

export function options(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(db|slug|to|files|store-id|republish|dry-run)(?:=(.*))?$/.exec(argv[i]!);
    if (!m) throw new Error(`Unknown argument ${argv[i]}.\n${USAGE}`);
    const name = m[1]!;
    if (SWITCHES.has(name)) {
      values.set(name, "");
      continue;
    }
    const value = m[2] ?? argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.\n${USAGE}`);
    values.set(name, value);
  }
  const db = values.get("db");
  const slugs = (values.get("slug") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!db || !slugs.length) throw new Error(USAGE);
  const bad = slugs.find((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s));
  if (bad) throw new Error(`${bad} isn't a product slug.`);
  let to: URL;
  try {
    to = new URL(values.get("to") ?? DEFAULT_TO);
  } catch {
    throw new Error(`--to must be the live site's URL, like ${DEFAULT_TO}.`);
  }
  // The automation secret goes in a header, so only over https.
  if (to.protocol !== "https:") throw new Error(`--to must be an https URL, like ${DEFAULT_TO}.`);
  const storeId = values.get("store-id") ?? DEFAULT_STORE;
  if (!/^store_[A-Za-z0-9]+$/.test(storeId)) throw new Error(`--store-id must be a Blob store id, like ${DEFAULT_STORE}.`);
  return {
    db,
    slugs: [...new Set(slugs)],
    to: to.origin,
    files: values.get("files") ?? LOCAL_FILES_DIR,
    storeId,
    republish: values.has("republish"),
    dryRun: values.has("dry-run"),
  };
}

/**
 * Points @vercel/blob at the live store with this machine's OIDC token, as blobAuth() signs in on Vercel: BLOB_STORE_ID
 * set and no read-write token. A BLOB_READ_WRITE_TOKEN from .env.local is dropped for this run, so no upload can go to
 * another store.
 */
function useLiveStore(storeId: string): void {
  if (!process.env.VERCEL_OIDC_TOKEN?.trim()) {
    throw new Error("VERCEL_OIDC_TOKEN isn't set, so nothing can be uploaded. Run vercel env pull .env.local (it's good for 12 hours).");
  }
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_STORE_ID = storeId;
}

function automation(): Record<string, string> {
  const secret = process.env.AUTOMATION_SECRET?.trim();
  if (!secret) throw new Error("AUTOMATION_SECRET isn't set. Put the live site's in .env.local.");
  return { authorization: `Bearer ${secret}` };
}

/** A copy of the PGlite folder to read from, so the dev server can keep the original open. */
async function copyDatabase(dir: string): Promise<string> {
  const source = path.resolve(dir);
  if (!(await stat(path.join(source, "PG_VERSION")).catch(() => null))) throw new Error(`${dir} isn't a PGlite folder: it has no PG_VERSION.`);
  const copy = await mkdtemp(path.join(tmpdir(), "musemuse-promote-"));
  await cp(source, copy, { recursive: true });
  // The copy has no server of its own, so the original's lock file means nothing in it.
  await rm(path.join(copy, "postmaster.pid"), { force: true });
  return copy;
}

async function readRows(local: LocalDb, slug: string): Promise<LocalRows | null> {
  const [product] = await local.select().from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
  if (!product) return null;
  const builds = await local.select().from(schema.builds).where(eq(schema.builds.productId, product.id)).orderBy(asc(schema.builds.startedAt));
  const buildIds = builds.map((b) => b.id);
  const events = buildIds.length
    ? await local.select().from(schema.buildEvents).where(inArray(schema.buildEvents.buildId, buildIds)).orderBy(asc(schema.buildEvents.id))
    : [];
  const museIds = [...new Set([product.inspirationId, ...builds.map((b) => b.inspirationId)])].filter((id): id is string => Boolean(id));
  const inspirations = museIds.length ? await local.select().from(schema.inspirations).where(inArray(schema.inspirations.id, museIds)) : [];
  return { product, builds, events, inspirations };
}

/** The live site's view of a product, or null when it doesn't have one with this id. */
async function liveProduct(to: string, productId: string): Promise<{ status: string; liveUrl: string | null } | null> {
  const res = await fetch(`${to}/api/admin/import-product?productId=${productId}`, { headers: automation() });
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === "not_found") return null;
    throw new Error(`${to} has no /api/admin/import-product. Deploy the branch with it first.`);
  }
  if (!res.ok) throw new Error(`${to} answered ${res.status} when asked about the product: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { status: string; liveUrl: string | null };
}

/** The live site's answer to a bundle. */
interface Answer {
  ok: boolean;
  status: number;
  reply: Record<string, unknown> | null;
}

/** POSTs the bundle to the live site's import route: to check it, to import it, or to import it and publish it again. */
async function send(to: string, bundle: ImportBundle, mode: "check" | "import" | "republish"): Promise<Answer> {
  const res = await fetch(`${to}/api/admin/import-product${mode === "import" ? "" : `?${mode}=1`}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...automation() },
    body: JSON.stringify(bundle),
  });
  const reply = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok && reply !== null, status: res.status, reply };
}

/** What the live site said when it didn't take a bundle: its status and error, with the field or slug and the reason. */
function said({ status, reply }: Answer): string {
  const where = reply?.field ?? reply?.slug;
  const detail = reply
    ? `${String(reply.error ?? "")}${where ? ` (${String(where)})` : ""}${reply.reason ? `: ${String(reply.reason)}` : ""}`
    : "";
  return `the live site answered ${status}${detail ? `: ${detail}` : ""}`;
}

/** Runs `fn` on every item, `limit` at a time. After one fails, no new item starts. */
async function eachAtOnce<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  let failed = false;
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined && !failed; item = queue.shift()) {
      await fn(item).catch((err: unknown) => {
        failed = true;
        throw err;
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** `bundle` with each local file URL in `keys` replaced by the link `linkFor` gives its key. */
function relink(bundle: ImportBundle, keys: Map<string, string>, linkFor: (key: string) => string): ImportBundle {
  return rewriteLocalUrls(bundle, new Map([...keys].map(([url, key]) => [url, linkFor(key)])));
}

export async function promote(local: LocalDb, slug: string, opts: Options): Promise<Row> {
  const row = (status: Row["status"], note: string, extra: Partial<Row> = {}): Row => ({ slug, status, files: 0, bytes: 0, link: null, note, ...extra });
  const rows = await readRows(local, slug);
  if (!rows) return row("skipped", "no product has this slug");
  const why = skipReason(rows);
  if (why) return row("skipped", why);
  const bundle = toBundle(rows);

  // Every file the rows point at, where the local run stored it. Two URLs can name one file (localhost and
  // 127.0.0.1, say), so files are kept by key and each is uploaded once.
  const keys = new Map<string, string>();
  const files = new Map<string, LocalFile>();
  for (const url of findLocalFileUrls(bundle)) {
    const key = localFileKeyOf(url);
    if (!key) return row("skipped", `${url} isn't a file the local run stored`);
    const paths = localFilePaths(key, opts.files);
    const info = await stat(paths.file).catch(() => null);
    if (!info?.isFile()) return row("skipped", `${url} has no file at ${paths.file}`);
    keys.set(url, key);
    files.set(key, { key, ...paths, size: info.size });
  }
  const counts = { files: files.size, bytes: [...files.values()].reduce((sum, f) => sum + f.size, 0) };

  // The bundle as the live site will get it, checked before anything is uploaded or sent.
  const planned = relink(bundle, keys, (key) => blobUrlFor(opts.storeId, key));
  const problem = whyNotSend(planned);
  if (problem) return row("skipped", problem, counts);
  if (opts.dryRun) {
    for (const f of files.values()) console.log(`  [${slug}] would upload ${f.key} (${bytes(f.size)})`);
    const size = Buffer.byteLength(JSON.stringify(planned));
    return row(
      "dry run",
      `${plural(bundle.builds.length, "build")}, ${plural(bundle.events.length, "event")}; would send ${bytes(size)} to ${opts.to}`,
      counts,
    );
  }

  const waitFor = { productId: bundle.product.id, buildId: bundle.product.latestBuildId };
  const there = await liveProduct(opts.to, bundle.product.id);
  if (there) {
    // Its files went up before it was imported, so nothing is uploaded again.
    if (there.liveUrl) return row("already", "nothing uploaded or sent again", { link: there.liveUrl });
    if (there.status !== "live") return row("already", `it is ${there.status} on the live site, so it isn't published again`);
    if (!opts.republish) return row("already", "it's there without a link of its own yet; --republish publishes it again");
    const again = await send(opts.to, planned, "republish");
    if (again.ok && again.reply?.publishing === true) return row("already", "publishing it again", { waitFor });
    if (again.status === 409 && again.reply?.error === "publish_running") return row("already", "the live site is publishing it now", { waitFor });
    if (again.ok) return row("already", "the live site didn't publish it again");
    return row("failed", said(again));
  }

  // Asked before any file is uploaded, so a bundle the live site refuses leaves nothing in its store.
  const check = await send(opts.to, planned, "check");
  if (!check.ok) return row(check.status >= 500 ? "failed" : "skipped", `nothing uploaded: ${said(check)}`);
  if (check.reply?.status === "already") return row("already", "the live site has it already");

  const links = new Map<string, string>();
  await eachAtOnce([...files.values()], UPLOADS_AT_ONCE, async (f) => {
    const [body, type] = await Promise.all([readFile(f.file), readFile(f.type, "utf8").catch(() => "")]);
    links.set(f.key, await putBlobAt(f.key, body, type.trim() || "application/octet-stream"));
    console.log(`  [${slug}] uploaded ${f.key} (${bytes(f.size)})`);
  });
  const out = relink(bundle, keys, (key) => links.get(key)!);
  const leftover = whyNotSend(out);
  if (leftover) return row("failed", `the files were uploaded, but the rows weren't sent: ${leftover}`, counts);

  const res = await send(opts.to, out, "import");
  if (!res.ok) return row("failed", said(res), counts);
  if (res.reply?.status === "already") return row("already", "the live site had it already", counts);
  if (res.reply?.publishing !== true) {
    return row("imported", "saved, but the live site couldn't start publishing it (its logs say why); --republish tries again", counts);
  }
  return row("imported", "publishing", { ...counts, waitFor });
}

/** Polls every product the live site is publishing until it has a link, for up to 10 minutes in all. */
async function waitForLinks(rows: Row[], opts: Options): Promise<void> {
  const waiting = () => rows.filter((r) => r.waitFor && !r.link);
  if (!waiting().length) return;
  console.log(`\nWaiting up to ${WAIT_MS / 60_000} minutes for ${plural(waiting().length, "live link")} ...`);
  const until = Date.now() + WAIT_MS;
  while (waiting().length && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    for (const r of waiting()) {
      const there = await liveProduct(opts.to, r.waitFor!.productId).catch(() => null);
      if (!there?.liveUrl) continue;
      r.link = there.liveUrl;
      r.note = "";
      console.log(`[${r.slug}] live at ${r.link}`);
    }
  }
  for (const r of waiting()) r.note = `no live link after ${WAIT_MS / 60_000} minutes: its build room says why, at ${opts.to}/b/${r.waitFor!.buildId}`;
}

function cell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

function printTable(rows: Row[]): void {
  const header = `${cell("Product", 32)}  ${cell("Status", 8)}  ${"Files".padStart(5)}  ${"Size".padStart(8)}  Live link or reason`;
  console.log(`\n${header}\n${"-".repeat(header.length + 40)}`);
  for (const r of rows) {
    const what = r.link ? (r.note ? `${r.link} (${r.note})` : r.link) : r.note;
    console.log(`${cell(r.slug, 32)}  ${cell(r.status, 8)}  ${String(r.files).padStart(5)}  ${bytes(r.bytes).padStart(8)}  ${what}`);
  }
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  if (!opts.dryRun) {
    automation();
    useLiveStore(opts.storeId);
  }
  const copy = await copyDatabase(opts.db);
  const client = new PGlite(copy);
  try {
    const local = drizzle({ client, schema });
    // Brings an older copy up to this checkout's schema. The original folder is never touched.
    await migrate(local, { migrationsFolder: path.join(import.meta.dirname, "..", "drizzle") });
    console.log(
      `${opts.dryRun ? "Dry run: " : ""}promoting ${opts.slugs.join(", ")} from a copy of ${opts.db} to ${opts.to}` +
        `${opts.dryRun ? "" : `, files to Blob store ${opts.storeId}`}`,
    );
    const rows: Row[] = [];
    for (const slug of opts.slugs) {
      const r = await promote(local, slug, opts).catch(
        (err: unknown): Row => ({ slug, status: "failed", files: 0, bytes: 0, link: null, note: (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300) }),
      );
      console.log(`[${slug}] ${r.status}${r.note ? `: ${r.note}` : ""}`);
      rows.push(r);
    }
    await waitForLinks(rows, opts);
    printTable(rows);
    const count = (status: Row["status"]) => rows.filter((r) => r.status === status).length;
    console.log(
      `\n${opts.dryRun ? `${count("dry run")} ready` : `${count("imported")} imported, ${count("already")} already there`}, ${count("skipped")} skipped, ${count("failed")} failed`,
    );
    if (count("failed")) process.exitCode = 1;
  } finally {
    await client.close().catch(() => undefined);
    await rm(copy, { recursive: true, force: true });
  }
}

/** True when node was started with this file, and not when a test imports promote() from it. */
function startedAsScript(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(import.meta.filename);
  } catch {
    return false;
  }
}

if (startedAsScript()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

/**
 * The pure parts of scripts/promote-local.ts: which local products can go to the live site, their rows as an import
 * bundle (lib/promote/bundle.ts), and finding, mapping and rewriting the links to files the local run stored. No I/O,
 * so the tests run it directly.
 */
import type { buildEvents, builds, inspirations, products } from "@/lib/db/schema";
import { bytes } from "@/lib/format";
import { isSafeFileKey, STORED_PREFIXES } from "@/lib/local-files";
import {
  IMPORT_MAX_BYTES,
  LOCAL_FILE_URL,
  linkProblems,
  localFileUrlsIn,
  parseImportBundle,
  type ImportBundle,
  type ImportInspiration,
} from "@/lib/promote/bundle";
import { TERMINAL_STATUSES } from "@/lib/types";

type ProductRow = typeof products.$inferSelect;
type BuildRow = typeof builds.$inferSelect;
type EventRow = typeof buildEvents.$inferSelect;
type InspirationRow = typeof inspirations.$inferSelect;

/** One product as the local database has it. */
export interface LocalRows {
  product: ProductRow;
  /** Every build of the product, oldest first. */
  builds: BuildRow[];
  /** Their events, in id order. */
  events: EventRow[];
  /** The muse the product was built from and its refinements' muses. */
  inspirations: InspirationRow[];
}

/** Why a local product can't go to the live site, or null when it can. */
export function skipReason(rows: LocalRows): string | null {
  const { product: p, builds: all } = rows;
  if (p.status !== "live") return `it is ${p.status}, not live`;
  if (!p.latestBuildId) return "it has no shipped build";
  const latest = all.find((b) => b.id === p.latestBuildId);
  if (!latest) return "its latest build isn't in the database";
  if (latest.status !== "live") return `its latest build is ${latest.status}, not live`;
  // A build that never finishes on the live site would block every refinement there.
  const running = all.find((b) => !TERMINAL_STATUSES.includes(b.status));
  if (running) return `build ${running.id} is still running`;
  if (!p.sandboxName) return "it has no sandbox to publish from";
  if (p.liveUrl) return `it already has its own link (${p.liveUrl})`;
  if (!p.inspirationId || !rows.inspirations.some((i) => i.id === p.inspirationId)) {
    return "the muse it was built from isn't in the database";
  }
  return null;
}

function muse(i: InspirationRow): ImportInspiration {
  return { id: i.id, note: i.note, references: i.references, createdAt: i.createdAt.toISOString() };
}

/**
 * The rows as an import bundle, ids kept. Left out: every user id (the live site gives the rows to its guest
 * account), the local workflow run, a running build's controls, the local event ids (the live table numbers them) and
 * the live link and project, which a local run never sets. Columns that are empty for a product with no targets stay
 * out of the bundle altogether, so it reads as it always did. Only for rows skipReason passed.
 */
export function toBundle(rows: LocalRows): ImportBundle {
  const { product: p } = rows;
  const own = rows.inspirations.find((i) => i.id === p.inspirationId);
  if (!own || !p.latestBuildId || !p.sandboxName) throw new Error(`${p.slug} can't be imported: ${skipReason(rows) ?? "it is incomplete"}`);
  return {
    product: {
      id: p.id,
      slug: p.slug,
      name: p.name,
      tagline: p.tagline,
      inspirationId: own.id,
      rebuildOf: p.rebuildOf,
      manifest: (p.manifest as Record<string, unknown> | null) ?? null,
      latestBuildId: p.latestBuildId,
      sandboxName: p.sandboxName,
      museSessionId: p.museSessionId,
      demoVideoUrl: p.demoVideoUrl,
      demoPosterUrl: p.demoPosterUrl,
      transcriptUrl: p.transcriptUrl,
      ...(p.extraClips.length ? { extraClips: p.extraClips } : {}),
      status: "live",
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    },
    builds: rows.builds.map((b) => ({
      id: b.id,
      inspirationId: b.inspirationId,
      kind: b.kind,
      message: b.message,
      rebuildOf: b.rebuildOf,
      productId: p.id,
      status: b.status,
      step: b.step,
      brief: b.brief ?? null,
      buildModel: b.buildModel,
      sandboxName: b.sandboxName,
      museSessionId: b.museSessionId,
      fixRounds: b.fixRounds,
      previewUrl: b.previewUrl,
      costUsd: b.costUsd,
      error: b.error,
      startedAt: b.startedAt.toISOString(),
      finishedAt: b.finishedAt ? b.finishedAt.toISOString() : null,
      ...(b.requestedTargets ? { requestedTargets: b.requestedTargets } : {}),
      ...(b.toolFixtures ? { toolFixtures: b.toolFixtures } : {}),
    })),
    events: rows.events.map((e) => ({ buildId: e.buildId, type: e.type, payload: e.payload, at: e.at.toISOString() })),
    inspiration: muse(own),
    refineInspirations: rows.inspirations.filter((i) => i.id !== own.id).map(muse),
  };
}

/** Every distinct local file URL in a JSON value: in any field at any depth, whole or inside text. */
export function findLocalFileUrls(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") for (const url of localFileUrlsIn(v)) found.add(url);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}

/** Keys the platform stores files under (lib/storage.ts BlobPrefix). */
const STORED_KEY = new RegExp(`^(?:${STORED_PREFIXES.join("|")})/`);

/**
 * The stored key behind a local file URL, which is also its Blob pathname: ".../api/files/demos/<buildId>/demo-1a2b.mp4"
 * is "demos/<buildId>/demo-1a2b.mp4", read from .data/files/data/<key>. Each segment is decoded, as lib/local-files.ts
 * encodes them. Null for anything that isn't a safe stored key.
 */
export function localFileKeyOf(url: string): string | null {
  const m = /^https?:\/\/[^/?#]+\/api\/files\/([^?#]+)/.exec(url);
  if (!m) return null;
  let key: string;
  try {
    key = m[1]!.split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  return isSafeFileKey(key) && STORED_KEY.test(key) ? key : null;
}

/** A copy of `value` with every local file URL that `links` maps replaced by its new link, wherever it appears. */
export function rewriteLocalUrls<T>(value: T, links: ReadonlyMap<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(LOCAL_FILE_URL, (url) => links.get(url) ?? url);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * Why a bundle must not be sent, or null when it can be: something in it still points at this machine (a local file
 * URL anywhere, or a link field on localhost, as linkProblems finds them), the live site's parser would refuse it, or
 * it is over the size the import takes.
 */
export function whyNotSend(bundle: ImportBundle): string | null {
  const leftover = linkProblems(bundle)[0];
  if (leftover) return leftover.message;
  const parsed = parseImportBundle(bundle);
  if (!parsed.ok) return parsed.error;
  const size = Buffer.byteLength(JSON.stringify(bundle));
  if (size > IMPORT_MAX_BYTES) return `the bundle is ${bytes(size)}, over the ${bytes(IMPORT_MAX_BYTES)} an import takes`;
  return null;
}

/**
 * The link a public Blob store gives a pathname, https://<store>.public.blob.vercel-storage.com/<pathname>, for
 * checking a bundle before anything is uploaded. The upload answers with the real one.
 */
export function blobUrlFor(storeId: string, pathname: string): string {
  const host = storeId.replace(/^store_/, "").toLowerCase();
  return `https://${host}.public.blob.vercel-storage.com/${pathname.split("/").map(encodeURIComponent).join("/")}`;
}

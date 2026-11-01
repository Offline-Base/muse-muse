/**
 * The sidebar's History: a person's builds, newest first, one row per product. While sign-in is off, every guest shares
 * one account, so a guest gets only the builds this browser has opened, never the whole account's list: other people's
 * prompts would otherwise sit in everyone's sidebar.
 */

export const HISTORY_ROWS = 20;
/** How many builds to read to fill HISTORY_ROWS, since a product's changes collapse into one row. */
export const HISTORY_READ = 60;
/** The most ids a browser remembers and sends. */
export const HISTORY_IDS = 50;
export const HISTORY_IDS_KEY = "muse-history-builds";
export const HISTORY_OPEN_KEY = "muse-history-closed";

export interface HistoryRow {
  id: string;
  title: string;
}

export interface RowSource {
  id: string;
  name: string | null;
  note: string | null;
  /** The product it belongs to, once it has one. */
  slug: string | null;
}

/** Newest first, so a product's row opens its latest build. A build with no product yet keeps its own row. */
export function historyRows(builds: readonly RowSource[], limit = HISTORY_ROWS): HistoryRow[] {
  const seen = new Set<string>();
  const rows: HistoryRow[] = [];
  for (const build of builds) {
    if (build.slug) {
      if (seen.has(build.slug)) continue;
      seen.add(build.slug);
    }
    rows.push({ id: build.id, title: build.name?.trim() || build.note?.trim() || "Untitled muse" });
    if (rows.length === limit) break;
  }
  return rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The build a path shows, from /b/<id> and the pages under it, or null. */
export function buildIdOfPath(pathname: string): string | null {
  const id = /^\/b\/([^/]+)/.exec(pathname)?.[1];
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

/** The ids from ?ids=: well-formed, unique and capped, so a long or odd list can't widen the query. */
export function parseHistoryIds(raw: string | null): string[] {
  const ids = (raw ?? "").split(",").map((id) => id.trim().toLowerCase()).filter((id) => UUID.test(id));
  return [...new Set(ids)].slice(0, HISTORY_IDS);
}

/** The remembered ids with `id` first. */
export function rememberId(ids: readonly string[], id: string): string[] {
  return [id, ...ids.filter((other) => other !== id)].slice(0, HISTORY_IDS);
}

export interface HistoryViewer {
  id: string;
  isAdmin: boolean;
  openAccess?: boolean;
}

export interface HistoryDeps {
  listUserBuilds(userId: string, limit: number): Promise<RowSource[]>;
  listBuildsByIds(userId: string, ids: string[]): Promise<RowSource[]>;
}

/** What a viewer's History holds. Nobody signed in has none; a shared guest has only the ids their browser sent. */
export async function historyFor(viewer: HistoryViewer | null, ids: string[], deps: HistoryDeps): Promise<HistoryRow[]> {
  if (!viewer) return [];
  if (viewer.openAccess && !viewer.isAdmin) {
    return ids.length ? historyRows(await deps.listBuildsByIds(viewer.id, ids)) : [];
  }
  return historyRows(await deps.listUserBuilds(viewer.id, HISTORY_READ));
}

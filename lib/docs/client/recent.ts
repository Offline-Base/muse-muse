import { idKindOf, type IdKind } from "@/lib/docs/client/endpoints";

/**
 * The ids this reader created during the visit (responses, files), so a console for GET responses/{id} or
 * DELETE files/{id} can offer them instead of Meta's example ids, which the proxy would refuse. Kept in
 * sessionStorage: one tab, gone when it closes, and the proxy only lets a visitor touch their own ids anyway.
 */

const KEY = "mm-docs-recent-ids";
const MAX_PER_KIND = 8;

export interface RecentId {
  id: string;
  kind: IdKind;
  /** A word or two to show next to it: the file name, the model. */
  label?: string;
  at: number;
}

let memory: RecentId[] = [];
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function load(): RecentId[] {
  const s = storage();
  if (!s) return memory;
  try {
    const raw = JSON.parse(s.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as RecentId[]).filter((r) => r && typeof r.id === "string" && idKindOf(r.id)) : [];
  } catch {
    return [];
  }
}

function save(list: RecentId[]) {
  memory = list;
  const s = storage();
  try {
    s?.setItem(KEY, JSON.stringify(list));
  } catch {
    // A full or blocked sessionStorage only loses the suggestions.
  }
  for (const l of listeners) l();
}

/** Newest first, optionally of one kind. */
export function recentIds(kind?: IdKind): RecentId[] {
  const list = load();
  return kind ? list.filter((r) => r.kind === kind) : list;
}

/** Remembers the response or file a reply describes (`id` at its top level). Deleted ones are forgotten. */
export function rememberReply(json: unknown, now = Date.now()) {
  if (!json || typeof json !== "object") return;
  const o = json as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : null;
  const kind = id ? idKindOf(id) : null;
  if (!id || (kind !== "response" && kind !== "file")) return;
  const rest = load().filter((r) => r.id !== id);
  if (o.deleted === true) return save(rest);
  const label = typeof o.filename === "string" ? o.filename : typeof o.model === "string" ? o.model : undefined;
  const entry: RecentId = { id, kind, at: now, ...(label ? { label } : {}) };
  const sameKind = rest.filter((r) => r.kind === kind).slice(0, MAX_PER_KIND - 1);
  save([entry, ...sameKind, ...rest.filter((r) => r.kind !== kind)]);
}

/** Forgets an id, such as one the API says no longer exists. */
export function forgetId(id: string) {
  save(load().filter((r) => r.id !== id));
}

export function subscribeRecent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

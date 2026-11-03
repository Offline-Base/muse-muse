/**
 * Saves images, audio, video and big JSON in the browser, in IndexedDB, so a product never fills localStorage. Browser
 * only, no imports. localStorage holds about 5 MB for the whole site: one photo as a data URL is half a megabyte, so a
 * product that keeps versions there crashes on its tenth save (the Nov 3 audit's room restyler lost a paid edit that way).
 *
 *   const versions = mediaStore("versions", { maxBytes: 200_000_000 });
 *   const saved = await versions.put(id, blob, { keep: [currentId] });   // never throws
 *   if (!saved.ok) setNote("This version couldn't be saved on this device. Download it to keep it.");
 *   else if (saved.evicted.length) setNote("The oldest versions were removed to make room.");
 *   const blob = await versions.get<Blob>(id);                         // undefined when it's gone
 *
 * Store Blobs, not data URLs: a Blob is stored as bytes, a data URL is a third bigger. Show one with
 * `URL.createObjectURL(blob)` and revoke it when the image goes away. Save from an event handler or an effect, never from
 * inside a React state updater, and show a note when a save fails, never an error page.
 *
 * Small state (settings, a checked list, ids) can stay in localStorage through `saveSmall` and `loadSmall`, which
 * refuse media and anything over SMALL_LIMIT and never throw.
 */

/** About how big a value may be in localStorage through saveSmall, in characters. */
export const SMALL_LIMIT = 100_000;

/** What a store knows about each saved value, without reading the value. */
export interface StoredEntry {
  key: string;
  /** About how many bytes the value takes. */
  bytes: number;
  /** When it was last saved, in ms since 1970. Oldest goes first. */
  savedAt: number;
}

export type PutResult =
  | { ok: true; evicted: string[] }
  | { ok: false; reason: "too-big" | "full" | "unavailable"; evicted: string[] };

export interface MediaStore {
  /** Saves a value under a key, removing the oldest values first when the store is over its size or the browser is full. */
  put(key: string, value: unknown, opts?: { keep?: readonly string[] }): Promise<PutResult>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  remove(key: string): Promise<void>;
  /** Every saved key with its size, oldest first. */
  list(): Promise<StoredEntry[]>;
  clear(): Promise<void>;
}

/** About how many bytes a value takes when stored: a Blob's size, two bytes a character for text, and JSON for the rest. */
export function sizeOf(value: unknown): number {
  if (value == null) return 0;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === "string") return value.length * 2;
  try {
    return (JSON.stringify(value)?.length ?? 0) * 2;
  } catch {
    return 0;
  }
}

/**
 * Which keys to remove, oldest first, so `incoming` more bytes fit under `maxBytes` and at most `maxItems` remain. The
 * incoming key's old value and the kept keys are never removed; an entry under the incoming key is replaced, so its bytes
 * don't count. Returns null when it can't fit even with every other entry gone.
 */
export function planEviction(
  entries: readonly StoredEntry[],
  incoming: { key: string; bytes: number },
  limits: { maxBytes?: number; maxItems?: number },
  keep: readonly string[] = [],
): string[] | null {
  const maxBytes = limits.maxBytes ?? Infinity;
  const maxItems = limits.maxItems ?? Infinity;
  if (incoming.bytes > maxBytes) return null;
  const others = entries.filter((e) => e.key !== incoming.key);
  const removable = others.filter((e) => !keep.includes(e.key)).sort((a, b) => a.savedAt - b.savedAt || (a.key < b.key ? -1 : 1));
  let bytes = others.reduce((sum, e) => sum + e.bytes, 0) + incoming.bytes;
  let items = others.length + 1;
  const out: string[] = [];
  for (const e of removable) {
    if (bytes <= maxBytes && items <= maxItems) break;
    out.push(e.key);
    bytes -= e.bytes;
    items -= 1;
  }
  return bytes > maxBytes || items > maxItems ? null : out;
}

/** The oldest entry that may go to make room after the browser said it is full, or null when none may. */
export function oldestRemovable(entries: readonly StoredEntry[], keep: readonly string[]): string | null {
  const next = entries.filter((e) => !keep.includes(e.key)).sort((a, b) => a.savedAt - b.savedAt || (a.key < b.key ? -1 : 1))[0];
  return next?.key ?? null;
}

/** True for the error a browser throws when storage is full, under any of its names. */
export function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; code?: number } | null;
  return !!e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014);
}

/** Why a value must not go in localStorage, or null when it may: it holds a data URL or a Blob, or it is too big. */
export function smallStateProblem(value: unknown, limit = SMALL_LIMIT): string | null {
  const seen = new Set<unknown>();
  const visit = (v: unknown): string | null => {
    if (typeof v === "string") return /^data:[\w.+-]+\/[\w.+-]+[;,]/i.test(v) ? "it holds a data URL; keep media in mediaStore" : null;
    if (typeof Blob !== "undefined" && v instanceof Blob) return "it holds a file; keep media in mediaStore";
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return "it holds binary data; keep media in mediaStore";
    if (v && typeof v === "object" && !seen.has(v)) {
      seen.add(v);
      for (const child of Array.isArray(v) ? v : Object.values(v)) {
        const problem = visit(child);
        if (problem) return problem;
      }
    }
    return null;
  };
  const problem = visit(value);
  if (problem) return problem;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return "it can't be written as JSON";
  }
  if ((text?.length ?? 0) > limit) return `it is ${text?.length} characters, over ${limit}; keep it in mediaStore`;
  return null;
}

/** Saves small state in localStorage. Never throws: false when it was refused (see smallStateProblem) or storage is full. */
export function saveSmall(key: string, value: unknown): boolean {
  const problem = smallStateProblem(value);
  if (problem) {
    console.warn(`saveSmall("${key}") refused: ${problem}.`);
    return false;
  }
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    if (!isQuotaError(err)) console.warn(`saveSmall("${key}") failed:`, err);
    return false;
  }
}

/** Reads small state saved with saveSmall, or the fallback when there is none or it can't be read. */
export function loadSmall<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text == null ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// IndexedDB

const DB_NAME = "media-store";
const META = "meta";
const DATA = "data";

function promised<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException("The save was stopped.", "AbortError"));
  });
}

const opened = new Map<string, Promise<IDBDatabase | null>>();

function openDb(name: string): Promise<IDBDatabase | null> {
  let db = opened.get(name);
  if (!db) {
    db = new Promise<IDBDatabase | null>((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      try {
        const req = indexedDB.open(`${DB_NAME}:${name}`, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(META, { keyPath: "key" });
          req.result.createObjectStore(DATA);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    opened.set(name, db);
  }
  return db;
}

/**
 * A named store in IndexedDB. `maxBytes` (default 250 MB) and `maxItems` cap what it keeps, removing the oldest first.
 * Pass the key on screen in `keep` so it never goes. Every method resolves, even where IndexedDB is missing.
 */
export function mediaStore(name: string, limits: { maxBytes?: number; maxItems?: number } = {}): MediaStore {
  const caps = { maxBytes: limits.maxBytes ?? 250_000_000, maxItems: limits.maxItems };

  const list = async (): Promise<StoredEntry[]> => {
    const db = await openDb(name);
    if (!db) return [];
    try {
      const all = (await promised(db.transaction(META).objectStore(META).getAll())) as StoredEntry[];
      return all.sort((a, b) => a.savedAt - b.savedAt);
    } catch {
      return [];
    }
  };

  const removeKeys = async (db: IDBDatabase, keys: readonly string[]) => {
    if (!keys.length) return;
    const tx = db.transaction([META, DATA], "readwrite");
    for (const key of keys) {
      tx.objectStore(META).delete(key);
      tx.objectStore(DATA).delete(key);
    }
    await done(tx);
  };

  return {
    async put(key, value, opts = {}) {
      const keep = opts.keep ?? [];
      const evicted: string[] = [];
      const db = await openDb(name);
      if (!db) return { ok: false, reason: "unavailable", evicted };
      const bytes = sizeOf(value);
      try {
        const plan = planEviction(await list(), { key, bytes }, caps, keep);
        if (!plan) return { ok: false, reason: "too-big", evicted };
        await removeKeys(db, plan);
        evicted.push(...plan);
        // The browser may still be full (other sites' data, a small quota). Remove the oldest one at a time and retry.
        for (;;) {
          try {
            const tx = db.transaction([META, DATA], "readwrite");
            tx.objectStore(DATA).put(value, key);
            tx.objectStore(META).put({ key, bytes, savedAt: Date.now() } satisfies StoredEntry);
            await done(tx);
            return { ok: true, evicted };
          } catch (err) {
            if (!isQuotaError(err)) throw err;
            const next = oldestRemovable((await list()).filter((e) => e.key !== key), keep);
            if (!next) return { ok: false, reason: "full", evicted };
            await removeKeys(db, [next]);
            evicted.push(next);
          }
        }
      } catch (err) {
        console.warn(`mediaStore("${name}").put("${key}") failed:`, err);
        return { ok: false, reason: isQuotaError(err) ? "full" : "unavailable", evicted };
      }
    },
    async get<T>(key: string) {
      const db = await openDb(name);
      if (!db) return undefined;
      try {
        return (await promised(db.transaction(DATA).objectStore(DATA).get(key))) as T | undefined;
      } catch {
        return undefined;
      }
    },
    async remove(key) {
      const db = await openDb(name);
      if (db) await removeKeys(db, [key]).catch(() => undefined);
    },
    list,
    async clear() {
      const db = await openDb(name);
      if (!db) return;
      const tx = db.transaction([META, DATA], "readwrite");
      tx.objectStore(META).clear();
      tx.objectStore(DATA).clear();
      await done(tx).catch(() => undefined);
    },
  };
}

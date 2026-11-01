/**
 * The names the data cap shares (docs/CAPABILITIES.md, section 9): scopes, who may write a shared collection, the
 * brief's sign-in choice and the shapes of a collection rule. A plain constant file with no imports, so the schema,
 * the gate and the template's helpers agree without an import cycle.
 */

/**
 * shared: anyone on the product reads them; writes need the owner unless the collection says otherwise.
 * visitor: one browser's (the mm_vid cookie). owner: the product's owner (the owner pass). user: a person who signed
 * in with a passkey through Muse Muse.
 */
export const DATA_SCOPES = ["shared", "visitor", "owner", "user"] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

/** Who may add to, change or delete from a shared collection. Private scopes are written by their own person only. */
export const DATA_WRITERS = ["owner", "signed_in", "anyone"] as const;
export type DataWriters = (typeof DATA_WRITERS)[number];

export const DATA_SIGN_IN = ["none", "optional", "required"] as const;
export type DataSignIn = (typeof DATA_SIGN_IN)[number];

/** A collection's name: lowercase, a letter first, up to 32 characters. */
export const COLLECTION_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** A document id: up to 64 URL-safe characters. The gateway makes one (a UUID) when a create doesn't name it. */
export const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A top-level field name in `where`. */
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** One collection as the brief, the manifest and the gateway see it. */
export interface DataCollectionRule {
  name: string;
  scope: DataScope;
  /** Only for shared collections. Defaults to the owner. */
  writes?: DataWriters;
}

export const isDataScope = (v: unknown): v is DataScope => typeof v === "string" && (DATA_SCOPES as readonly string[]).includes(v);
export const isDataWriters = (v: unknown): v is DataWriters => typeof v === "string" && (DATA_WRITERS as readonly string[]).includes(v);

/** The collections in a manifest's or brief's data block, each once, or null when it has none. */
export function collectionRules(block: unknown): DataCollectionRule[] | null {
  const list = (block as { collections?: unknown } | null | undefined)?.collections;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const out: DataCollectionRule[] = [];
  for (const c of list) {
    const name = (c as { name?: unknown })?.name;
    const scope = (c as { scope?: unknown })?.scope;
    if (typeof name !== "string" || !COLLECTION_NAME.test(name) || !isDataScope(scope) || seen.has(name)) continue;
    seen.add(name);
    const writes = (c as { writes?: unknown }).writes;
    out.push({ name, scope, ...(scope === "shared" && isDataWriters(writes) ? { writes } : {}) });
  }
  return out;
}

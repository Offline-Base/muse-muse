import { z } from "zod";
import { COLLECTION_NAME, DATA_SCOPES, DATA_SIGN_IN, DATA_WRITERS, isDataScope, isDataWriters } from "@/lib/caps/data/types";

/**
 * The data cap's brief block (docs/CAPABILITIES.md, section 9): the collections a product saves through the platform,
 * each with its scope, and whether people sign in. `writes` says who may add to a shared collection: the contract's
 * "writes": "anyone" on the manifest, plus "signed_in" for a list people who signed in share. Private collections ignore
 * it and always say "owner".
 */
export const MAX_COLLECTIONS = 6;

export const DataCollectionBlock = z.object({
  name: z.string().min(1).max(32),
  scope: z.enum(DATA_SCOPES),
  writes: z.enum(DATA_WRITERS),
  /** What one item is, in a plain sentence: "One grocery item: its name and whether it's bought." */
  holds: z.string().min(1).max(200),
  /** True when an item can hold personal details. Never true for a shared collection. */
  personal: z.boolean(),
});

export const DataBriefBlock = z.object({
  collections: z.array(DataCollectionBlock).min(1).max(MAX_COLLECTIONS),
  signIn: z.enum(DATA_SIGN_IN),
});

export type DataBrief = z.infer<typeof DataBriefBlock>;
export type DataCollection = z.infer<typeof DataCollectionBlock>;

/** The data block of a brief, or null, also for one that isn't in the block's shape (a stored brief isn't re-parsed). */
export function dataBlock(brief: object | null | undefined): DataBrief | null {
  const block = (brief as { data?: unknown } | null | undefined)?.data;
  return block && typeof block === "object" && Array.isArray((block as { collections?: unknown }).collections) ? (block as DataBrief) : null;
}

function snakeName(s: string): string {
  const out = s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/g, "");
  return /^[a-z]/.test(out) ? out : `c_${out || "items"}`.slice(0, 32);
}

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "").trim() || s.slice(0, max));

/**
 * The writer's raw data block, cleaned before zod (normalizeRawBrief): names in snake case and each once, at most 6,
 * text clipped. A collection with personal details never stays shared: it becomes a user collection when people sign
 * in, else a visitor one. A private collection's `writes` is "owner". A user collection, or a shared one that signed-in
 * people write, turns sign-in on ("optional") if the writer left it off. No usable collection means no data block, so
 * it becomes null. Anything else is left for zod to report.
 */
export function normalizeDataBlock(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  if (!Array.isArray(b.collections)) return b;
  const signIn = typeof b.signIn === "string" && (DATA_SIGN_IN as readonly string[]).includes(b.signIn) ? b.signIn : null;
  const seen = new Set<string>();
  const collections = b.collections
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object" && typeof (c as { name?: unknown }).name === "string")
    .map((c) => {
      const out: Record<string, unknown> = { ...c, name: snakeName(c.name as string) };
      if (typeof out.holds === "string") out.holds = clip(out.holds.trim(), 200);
      if (out.personal === true && out.scope === "shared") out.scope = signIn && signIn !== "none" ? "user" : "visitor";
      if (isDataScope(out.scope) && out.scope !== "shared") out.writes = "owner";
      else if (out.scope === "shared" && !isDataWriters(out.writes)) out.writes = "owner";
      return out;
    })
    .filter((c) => COLLECTION_NAME.test(c.name as string) && !seen.has(c.name as string) && Boolean(seen.add(c.name as string)))
    .slice(0, MAX_COLLECTIONS);
  if (!collections.length) return null;
  b.collections = collections;
  const needsSignIn = collections.some((c) => c.scope === "user" || (c.scope === "shared" && c.writes === "signed_in"));
  if (needsSignIn && (signIn === "none" || signIn === null)) b.signIn = "optional";
  return b;
}

/** The writer's rules for the block (lib/caps/brief-fields.ts, CAP_WRITER_RULES). */
export const DATA_WRITER_RULES: readonly string[] = [
  "data: fill it only when the muse needs items that survive a reload or that other people see: a shared list, posts, scores, a group's plans, saved settings that follow a person. Otherwise null. What one person keeps for themself on one device stays in the browser and needs no data block.",
  "data.collections: 1 to 6. Each has a lowercase name (letters, digits and underscores, up to 32), its scope, who writes it, what one item holds in a plain sentence, and whether an item can hold personal details.",
  "data.collections scope: shared when everyone on the product sees the items; visitor when the items stay with one browser; owner when only the product's owner keeps them; user when they follow a person who signs in, on any device.",
  "data.collections writes: for a shared collection, owner when only the product's owner adds to it, signed_in when people who signed in add to it, anyone when any visitor may add to it (a guest book, a group list). Every other scope uses owner.",
  "data.collections personal: true when an item can hold a name, contact details, health, money or anything else about one person. Personal items go only in visitor, owner or user collections, never shared.",
  "data.signIn: none, optional or required. Sign-in is a passkey through Muse Muse, with no email and no password. Use optional when signing in only adds something (a list that follows you to another phone), required only when the product can't work without knowing who someone is, and none when no collection is user and no shared one is written by signed_in.",
  "A product saves only the collections the block lists. Don't add one for what the muse doesn't need.",
];

// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// Saves and reads this product's items through the Muse Muse gateway ({GATEWAY_URL}/data). Server code only: the
// browser never calls the gateway, and GATEWAY_URL and PRODUCT_TOKEN exist on the server only. Always pass the incoming
// request (or `await headers()` in a server action), so the gateway knows who is asking:
//   shared   everyone on the product reads them; who writes is the collection's rule in musemuse.json
//   visitor  this browser's (its mm_vid cookie, set here on its first save)
//   owner    the product's owner, opened from Muse Muse
//   user     the person signed in with a passkey (lib/platform/user.ts)
// In a build every item is a real row in the build's own test space, deleted when the build ends.
import { cookies } from "next/headers";
import { clientIpHeaders, type RequestLike } from "@/lib/meta/client";
import { OWNER_HEADER, VISITOR_COOKIE, VISITOR_HEADER, newVisitorId, ownerSession, visitorId } from "@/lib/platform/identity";
import { userHeaders } from "@/lib/platform/user";

export type Scope = "shared" | "visitor" | "owner" | "user";

/** What every platform helper throws: a code, an HTTP status the route can answer with, and a plain message. */
export class CapError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "CapError";
    this.code = code;
    this.status = status;
  }
}

export interface Saved {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Item<T> extends Saved {
  data: T;
}

export interface Page<T> {
  items: Item<T>[];
  /** Pass as `after` for the next page, or null at the end. */
  next: string | null;
}

export interface Query {
  /** Top-level fields and the values they must equal: strings, numbers, true, false or null. */
  where?: Record<string, string | number | boolean | null>;
  /** newest (the default) or oldest by when an item was made, or recent by when it last changed. */
  order?: "newest" | "oldest" | "recent";
  /** 1 to 100. 50 by default. */
  limit?: number;
  after?: string | null;
}

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const YEAR_SECONDS = 365 * 24 * 60 * 60;

function settings(): { base: string; token: string } {
  const base = process.env.GATEWAY_URL?.replace(/\/+$/, "");
  const token = process.env.PRODUCT_TOKEN;
  if (!base || !token) throw new CapError("not_configured", 500, "Saving isn't set up on this server. The Muse Muse platform sets it when it deploys the product.");
  return { base, token };
}

/**
 * This browser's visitor id. With none yet, a save makes one and sets the cookie, which works in route handlers and
 * server actions. A page render can't set cookies, so a read there just has no visitor items yet.
 */
async function visitorFor(from: RequestLike | null | undefined, create: boolean): Promise<string | null> {
  const known = visitorId(from);
  if (known || !create) return known;
  const id = newVisitorId();
  try {
    (await cookies()).set(VISITOR_COOKIE, id, { path: "/", maxAge: YEAR_SECONDS, httpOnly: true, secure: true, sameSite: "lax" });
    return id;
  } catch {
    return null;
  }
}

async function call<T>(from: RequestLike | null | undefined, method: string, path: string, body: unknown, visitor: string | null): Promise<T> {
  const { base, token } = settings();
  const owner = ownerSession(from);
  const res = await fetch(`${base}/data${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...clientIpHeaders(from),
      ...(visitor ? { [VISITOR_HEADER]: visitor } : {}),
      ...(owner ? { [OWNER_HEADER]: owner } : {}),
      ...userHeaders(from),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    throw new CapError("unreachable", 502, "Saving is unreachable right now. Try again in a minute.");
  });
  const reply = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok) {
    throw new CapError(reply?.error?.code ?? "cap_failed", res.status, reply?.error?.message ?? "Saving didn't work this time. Try again.");
  }
  return reply as T;
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw new CapError("invalid_arguments", 400, `"${name}" isn't a collection name: lowercase letters, digits and underscores.`);
}

function checkId(id: string): void {
  if (!DOC_ID.test(id)) throw new CapError("invalid_arguments", 400, "An item's id is up to 64 letters, digits, dashes and underscores.");
}

/** The collections of this product, from the request's point of view. */
export function data(request?: RequestLike | null) {
  return {
    collection<T extends Record<string, unknown> = Record<string, unknown>>(name: string, opts: { scope?: Scope } = {}) {
      checkName(name);
      const scope = opts.scope ? `?scope=${opts.scope}` : "";
      const visitorScope = opts.scope === "visitor";
      return {
        /** Saves a new item and returns its id and version. */
        async create(item: T): Promise<Saved> {
          return call<Saved>(request, "POST", `/${name}${scope}`, { data: item }, await visitorFor(request, true));
        },
        /** One item, or null when there's none with that id (or it isn't this person's). */
        async get(id: string): Promise<Item<T> | null> {
          checkId(id);
          const visitor = await visitorFor(request, false);
          if (visitorScope && !visitor) return null;
          try {
            return await call<Item<T>>(request, "GET", `/${name}/${id}${scope}`, undefined, visitor);
          } catch (err) {
            if (err instanceof CapError && err.status === 404) return null;
            throw err;
          }
        },
        /** Replaces an item, or makes it with this id. With ifVersion, refuses (code version_conflict) if it changed. */
        async put(id: string, item: T, o: { ifVersion?: number } = {}): Promise<Saved> {
          checkId(id);
          return call<Saved>(request, "PUT", `/${name}/${id}${scope}`, { data: item, ...(o.ifVersion ? { ifVersion: o.ifVersion } : {}) }, await visitorFor(request, true));
        },
        /** Deletes an item. False when there was none. */
        async delete(id: string): Promise<boolean> {
          checkId(id);
          const visitor = await visitorFor(request, false);
          if (visitorScope && !visitor) return false;
          return (await call<{ deleted: boolean }>(request, "DELETE", `/${name}/${id}${scope}`, undefined, visitor)).deleted;
        },
        /** A page of items, newest first unless `order` says otherwise. */
        async query(q: Query = {}): Promise<Page<T>> {
          const visitor = await visitorFor(request, false);
          if (visitorScope && !visitor) return { items: [], next: null };
          return call<Page<T>>(request, "POST", `/${name}/query`, { ...(opts.scope ? { scope: opts.scope } : {}), ...q }, visitor);
        },
      };
    },
  };
}

/** Deletes every visitor and user item this person saved in this product. Returns how many. */
export async function deleteMine(request?: RequestLike | null): Promise<number> {
  const visitor = await visitorFor(request, false);
  return (await call<{ deleted: number }>(request, "DELETE", "/_mine", undefined, visitor)).deleted;
}

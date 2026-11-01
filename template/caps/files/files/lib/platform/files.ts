// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// Files this product keeps through the Muse Muse gateway ({GATEWAY_URL}/files), with no 24-hour limit. Server code
// only: GATEWAY_URL and PRODUCT_TOKEN exist on the server, and the browser uploads with uploadFile from
// lib/platform/files-browser.ts, which goes through this product's own /api/musemuse/files route. Always pass the
// incoming request (or `await headers()` in a server action), so the gateway knows who is asking:
//   shared   everyone on the product sees them; who adds them is the product's rule in musemuse.json
//   visitor  this browser's (its mm_vid cookie, set here on its first upload)
//   owner    the product's owner, opened from Muse Muse
//   user     the person signed in with a passkey (lib/platform/user.ts)
// A file's `url` is a link the gateway signed, good for an hour: show a picture with <img src={file.url}>, and read a
// file's bytes on the server with fetch(file.url). In a build every file is a real file in the build's own test space,
// deleted when the build ends.
import { cookies } from "next/headers";
import { clientIpHeaders, type RequestLike } from "@/lib/meta/client";
import { OWNER_HEADER, VISITOR_COOKIE, VISITOR_HEADER, newVisitorId, ownerSession, visitorId } from "@/lib/platform/identity";
import { userHeaders } from "@/lib/platform/user";

export type FileScope = "shared" | "visitor" | "owner" | "user";

/** What the files helpers throw: a code, an HTTP status the route can answer with, and a plain message. */
export class FilesError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "FilesError";
    this.code = code;
    this.status = status;
  }
}

export interface StoredFile {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string | null;
  scope: FileScope;
  createdAt: string;
  /** A link the gateway signed for this file, good until expiresAt (an hour). */
  url: string;
  expiresAt: string;
}

export interface UploadTicket {
  id: string;
  upload: { url: string; method: "PUT"; headers: Record<string, string> };
  expiresAt: string;
}

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const YEAR_SECONDS = 365 * 24 * 60 * 60;

function settings(): { base: string; token: string } {
  const base = process.env.GATEWAY_URL?.replace(/\/+$/, "");
  const token = process.env.PRODUCT_TOKEN;
  if (!base || !token) throw new FilesError("not_configured", 500, "Keeping files isn't set up on this server. The Muse Muse platform sets it when it deploys the product.");
  return { base, token };
}

/** This browser's visitor id. With none yet, an upload makes one and sets the cookie (route handlers and server actions). */
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

/** One call to the gateway with who is asking. Shared by lib/platform/search.ts and lib/platform/datasets.ts. */
export async function gatewayCall<T>(from: RequestLike | null | undefined, method: string, path: string, body?: unknown, opts: { createVisitor?: boolean } = {}): Promise<T> {
  const { base, token } = settings();
  const owner = ownerSession(from);
  const visitor = await visitorFor(from, opts.createVisitor === true);
  const res = await fetch(`${base}${path}`, {
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
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new FilesError("unreachable", 502, "The file service is unreachable right now. Try again in a minute.");
  });
  const reply = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok) throw new FilesError(reply?.error?.code ?? "cap_failed", res.status, reply?.error?.message ?? "That didn't work this time. Try again.");
  return reply as T;
}

function checkId(id: string): void {
  if (!FILE_ID.test(id)) throw new FilesError("invalid_arguments", 400, "That isn't a file id the gateway gave.");
}

const scopeQuery = (scope?: FileScope) => (scope ? `scope=${scope}` : "");

/** This product's files, from the request's point of view. */
export function files(request?: RequestLike | null) {
  return {
    /** A page of ready files, newest first. Pass the page's `next` as `after` for the one after it. */
    async list(opts: { scope?: FileScope; after?: string | null; limit?: number } = {}): Promise<{ items: StoredFile[]; next: string | null }> {
      if (opts.scope === "visitor" && !visitorId(request)) return { items: [], next: null };
      const q = [scopeQuery(opts.scope), opts.after ? `after=${encodeURIComponent(opts.after)}` : "", opts.limit ? `limit=${opts.limit}` : ""].filter(Boolean).join("&");
      return gatewayCall(request, "GET", `/files${q ? `?${q}` : ""}`);
    },
    /** One file's facts and a fresh read URL, or null when there's none with that id here (or it isn't this person's). */
    async get(id: string, opts: { scope?: FileScope } = {}): Promise<StoredFile | null> {
      checkId(id);
      try {
        return await gatewayCall<StoredFile>(request, "GET", `/files/${id}${opts.scope ? `?${scopeQuery(opts.scope)}` : ""}`);
      } catch (err) {
        if (err instanceof FilesError && err.status === 404) return null;
        throw err;
      }
    },
    /** Deletes a file and its search text. False when there was none. Only the owner deletes shared files. */
    async delete(id: string, opts: { scope?: FileScope } = {}): Promise<boolean> {
      checkId(id);
      return (await gatewayCall<{ deleted: boolean }>(request, "DELETE", `/files/${id}${opts.scope ? `?${scopeQuery(opts.scope)}` : ""}`)).deleted;
    },
    /** Step one of an upload: a ticket with where the browser puts the bytes. uploadFile calls it through the route. */
    async ticket(file: { name: string; contentType: string; bytes: number; scope?: FileScope }): Promise<UploadTicket> {
      return gatewayCall(request, "POST", "/files/ticket", file, { createVisitor: true });
    },
    /** Step two: the gateway checks what arrived and keeps it. */
    async done(id: string, opts: { scope?: FileScope } = {}): Promise<StoredFile> {
      checkId(id);
      return gatewayCall(request, "POST", `/files/${id}/done`, opts.scope ? { scope: opts.scope } : {});
    },
  };
}

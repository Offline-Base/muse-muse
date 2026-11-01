import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { FilesBlob } from "@/lib/caps/files/blob";
import { DATASET_FILE, DATASET_ID, findDatasetFile, publicDataset, type Dataset } from "@/lib/caps/files/datasets";
import { FILES_LIMITS, isFileContentType, servedInline, type FilesQuotas } from "@/lib/caps/files/limits";
import { decodeFilesCursor, sourceKeyOf, type FileLimits, type FilesStore, type OwnerSpace, type SearchChunk, type StoredFile, type TicketRefusal } from "@/lib/caps/files/store";
import { FILE_ID, isFileScope, type FileScope, type FilesRule, type SearchSource } from "@/lib/caps/files/types";
import { COLLECTION_NAME, DOC_ID } from "@/lib/caps/data/types";
import {
  capError,
  readJsonBody,
  runCapGate,
  unknownEndpoint,
  unknownKeys,
  type CapGateDeps,
  type CapLimit,
  type CapProduct,
  type CapRoute,
  type CapStage,
  type CapToken,
} from "@/lib/caps/gate";
import { subjectKey, type CapCaller } from "@/lib/caps/principal";
import { clientIpKey } from "@/lib/gateway/extract";
import { gatewayError } from "@/lib/gateway/errors";
import { mac, sameMac } from "@/lib/tools/sign";

/**
 * {GATEWAY_URL}/files, /search and /datasets (docs/CAPABILITIES.md, section 10), behind the cap gate (lib/caps/gate.ts).
 * A live token's files are in the product's `live` namespace and a build's in b:<buildId>, so a build never sees what a
 * real person kept. Two routes have no bearer, since a browser follows them: a file's read URL, signed by the gateway for
 * an hour, and (local runs only) the upload URL a ticket gives. Both carry their own signature.
 */

export interface FilesDeps extends CapGateDeps {
  store: FilesStore;
  blob: FilesBlob;
  /** FILES_PRODUCT_MB and FILES_MAX_FILE_MB, for the live namespace. */
  quotas(): FilesQuotas;
  /** FILES_SEARCH and FILES_DATASETS. */
  searchOn(): boolean;
  datasetsOn(): boolean;
  /** The product's files rule: a build's from its own brief, a live product's from the brief it shipped with. */
  rule(token: CapToken, product: CapProduct): Promise<FilesRule | null>;
  /** One file by id, whatever its product, for the signed routes. */
  fileById(id: string): Promise<(StoredFile & { productId: string; namespace: string }) | null>;
  datasets(): readonly Dataset[];
  /** A dataset file's local copy on a local run, or null on Vercel (where its mirror is used). */
  localDatasetPath?(id: string, file: string): string | null;
  /** The gateway's public base, {PLATFORM_URL}/api/gateway. */
  gatewayUrl: string;
}

const isBuild = (token: CapToken) => token.scope === "build";
const noStore = { "cache-control": "no-store" };

function baseLimits(stage: CapStage, prefix: string): CapLimit[] {
  const limits: CapLimit[] = [{ key: `${prefix}:token:${stage.token.id}`, limit: FILES_LIMITS.perTokenPerMinute, window: "minute", who: "this product" }];
  if (stage.caller.ip) limits.push({ key: `${prefix}:ip:${stage.token.productId}:${stage.caller.ip}`, limit: FILES_LIMITS.perIpPerMinute, window: "minute", who: "this user" });
  return limits;
}

/** The subject key of this caller's files in a scope, or why there is none. Shared files have no key. */
function ownerKeyFor(scope: FileScope, caller: CapCaller, productId: string): { key: string | null } | Response {
  switch (scope) {
    case "shared":
      return { key: null };
    case "visitor":
      return caller.visitor ? { key: subjectKey("visitor", productId, caller.visitor) } : capError("sign_in_required", "This browser has no visitor id yet. Reload the page and try again.");
    case "owner":
      return caller.owner ? { key: subjectKey("owner", productId, "product-owner") } : capError("sign_in_required", "Only the product's owner can use these files. Open it as the owner from Muse Muse.");
    case "user":
      return caller.user ? { key: subjectKey("user", productId, caller.user) } : capError("sign_in_required", "Sign in to use these files.");
  }
}

/** Who may add to a shared space, and whether this caller is one of them. */
function sharedAddRefusal(rule: FilesRule, caller: CapCaller): Response | null {
  if (caller.owner) return null;
  if (rule.uploads === "anyone" && (caller.visitor || caller.user)) return null;
  if (rule.uploads === "signed_in" && caller.user) return null;
  if (rule.uploads === "signed_in") return capError("sign_in_required", "Sign in to add files here.");
  if (rule.uploads === "anyone") return capError("sign_in_required", "This browser has no visitor id yet. Reload the page and try again.");
  return capError("sign_in_required", "Only the product's owner can add files here.");
}

interface Space {
  rule: FilesRule;
  space: OwnerSpace;
}

/** The product's rule and this caller's space in the scope a call names. `write` asks for the right to add. */
async function spaceFor(stage: CapStage, deps: FilesDeps, scopeParam: unknown, write: "add" | "delete" | null): Promise<Space | Response> {
  if (scopeParam !== undefined && scopeParam !== null && !isFileScope(scopeParam)) return capError("invalid_arguments", "scope is shared, visitor, owner or user.");
  const rule = await deps.rule(stage.token, stage.product);
  if (!rule) return capError("cap_not_allowed", "This product doesn't keep files.");
  const scope = (scopeParam ?? rule.scope) as FileScope;
  if (scope !== rule.scope) return capError("cap_not_allowed", `This product keeps ${rule.scope} files only.`);
  if (scope === "shared" && write === "add") {
    const refused = sharedAddRefusal(rule, stage.caller);
    if (refused) return refused;
  }
  if (scope === "shared" && write === "delete" && !stage.caller.owner) return capError("sign_in_required", "Only the product's owner can delete shared files.");
  const key = ownerKeyFor(scope, stage.caller, stage.token.productId);
  if (key instanceof Response) return key;
  return { rule, space: { productId: stage.token.productId, namespace: "", scope, ownerKey: key.key } };
}

/** The space with the call's namespace, which the gate knows only once it has passed. */
const inNamespace = (s: OwnerSpace, namespace: string): OwnerSpace => ({ ...s, namespace });

const QUOTA_WORDS: Record<TicketRefusal, (l: FileLimits) => string> = {
  bytes: (l) => `This product has stored as much as it can (${Math.round(l.productBytes / 1024 / 1024)} MB). Delete some files to add more.`,
  files: (l) => `This product has stored as many files as it can (${l.productFiles.toLocaleString("en-US")}). Delete some to add more.`,
  subject: (l) => `You've stored as much here as one person can (${Math.round((l.subjectBytes ?? 0) / 1024 / 1024)} MB). Delete some files to add more.`,
};

function fileLimits(token: CapToken, scope: FileScope, quotas: FilesQuotas): FileLimits {
  const subjectBytes = scope === "visitor" || scope === "user" ? FILES_LIMITS.subjectBytes : null;
  return isBuild(token)
    ? { productBytes: FILES_LIMITS.buildBytes, productFiles: FILES_LIMITS.buildFiles, subjectBytes }
    : { productBytes: quotas.productBytes, productFiles: FILES_LIMITS.filesPerProduct, subjectBytes };
}

/** A file's name as the product shows it: no path, no control characters, at most 120 characters. */
export function cleanFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .split(/[\\/]/)
    .at(-1)!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, FILES_LIMITS.nameMax);
  return name && name !== "." && name !== ".." ? name : null;
}

/** The Blob path of a new file. The suffix is 128 random bits, so a public store's path can't be guessed. */
export const fileBlobPath = (productId: string, namespace: string, id: string) =>
  `caps/files/${productId}/${namespace === "live" ? "live" : namespace.replace(/^b:/, "b-")}/${id}-${randomBytes(16).toString("hex")}`;

const signRead = (id: string, exp: number, download: boolean) => mac("files-read", [id, String(exp), download ? "1" : "0"]);
const signUpload = (id: string, exp: number) => mac("files-upload", [id, String(exp)]);

/** The gateway's signed read URL for a file, good for an hour. Any other type than media and PDF is downloaded. */
export function readUrlFor(gatewayUrl: string, file: Pick<StoredFile, "id" | "contentType">, now: Date): { url: string; expiresAt: string } {
  const exp = now.getTime() + FILES_LIMITS.readValidMs;
  const download = !servedInline(file.contentType);
  const url = new URL(`${gatewayUrl}/files/${file.id}/content`);
  url.searchParams.set("exp", String(exp));
  if (download) url.searchParams.set("download", "1");
  url.searchParams.set("sig", signRead(file.id, exp, download));
  return { url: url.toString(), expiresAt: new Date(exp).toISOString() };
}

/** A file as the product sees it: never its Blob path or its person's key. */
function fileFacts(file: StoredFile, gatewayUrl: string, now: Date, withUrl: boolean) {
  return {
    id: file.id,
    name: file.name,
    contentType: file.contentType,
    bytes: file.bytes,
    sha256: file.sha256,
    scope: file.scope,
    createdAt: file.createdAt,
    ...(withUrl ? readUrlFor(gatewayUrl, file, now) : {}),
  };
}

const notFound = (what = "There's no file with that id here.") =>
  Response.json({ error: { type: "not_found_error", code: "not_found", message: what, param: null } }, { status: 404, headers: { "x-should-retry": "false" } });

/** Serves everything under {GATEWAY_URL}/files. With FILES_ENABLED off, or CAP_READY false, every path answers 404. */
export async function handleFiles(req: Request, path: readonly string[], deps: FilesDeps): Promise<Response> {
  const [first, second] = path;
  const route = `${req.method} ${path.length}`;
  if (route === "POST 1" && first === "ticket") return runCapGate(req, deps, ticketRoute(deps));
  if (route === "GET 0") return runCapGate(req, deps, listRoute(deps));
  if (path.length === 2 && first && FILE_ID.test(first) && second === "done" && req.method === "POST") return runCapGate(req, deps, doneRoute(deps, first));
  if (path.length === 2 && first && FILE_ID.test(first) && second === "content" && (req.method === "GET" || req.method === "HEAD")) return handleContent(req, first, deps);
  if (path.length === 2 && first && FILE_ID.test(first) && second === "upload" && req.method === "PUT") return handleLocalUpload(req, first, deps);
  if (path.length === 1 && first && FILE_ID.test(first) && (req.method === "GET" || req.method === "DELETE")) return runCapGate(req, deps, fileRoute(deps, first, req.method));
  return unknownEndpoint("/files");
}

function ticketRoute(deps: FilesDeps): CapRoute<Space & { name: string; contentType: string; bytes: number }> {
  return {
    cap: "files",
    what: "/files",
    async args(stage) {
      const body = await readJsonBody(stage.req, 4 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["name", "contentType", "bytes", "scope"]);
      if (extra) return extra;
      const name = cleanFileName(body.name);
      if (!name) return capError("invalid_arguments", "Give the file a name.");
      if (!isFileContentType(body.contentType)) return capError("invalid_arguments", "This kind of file can't be stored. Pictures, audio, video, PDF and plain text (txt, csv, md, json) can.");
      const max = isBuild(stage.token) ? Math.min(deps.quotas().maxFileBytes, FILES_LIMITS.buildBytes) : deps.quotas().maxFileBytes;
      if (!Number.isInteger(body.bytes) || (body.bytes as number) < 1) return capError("invalid_arguments", "bytes is the file's size, a whole number.");
      if ((body.bytes as number) > max) return capError("invalid_arguments", `A file can be at most ${Math.round(max / 1024 / 1024)} MB.`);
      const space = await spaceFor(stage, deps, body.scope, "add");
      if (space instanceof Response) return space;
      return { ...space, name, contentType: body.contentType, bytes: body.bytes as number };
    },
    limits: (stage) => [
      ...baseLimits(stage, "files"),
      { key: `files:tickets:${stage.token.id}`, limit: FILES_LIMITS.ticketsPerTokenPerMinute, window: "minute", who: "this product's uploads" },
      ...(stage.caller.ip ? [{ key: `files:tickets-ip:${stage.token.productId}:${stage.caller.ip}`, limit: FILES_LIMITS.ticketsPerIpPerMinute, window: "minute" as const, who: "this user's uploads" }] : []),
    ],
    async work(ctx) {
      const space = inNamespace(ctx.args.space, ctx.namespace);
      const limits = fileLimits(ctx.token, space.scope, deps.quotas());
      const id = randomUUID();
      const blobPath = fileBlobPath(ctx.token.productId, ctx.namespace, id);
      const created = await deps.store.createPending(space, { id, name: ctx.args.name, contentType: ctx.args.contentType, bytes: ctx.args.bytes, blobPath }, limits);
      if (!created.ok) return capError("quota_exceeded", QUOTA_WORDS[created.reason](limits));
      const validUntil = ctx.now.getTime() + FILES_LIMITS.ticketValidMs;
      let upload = await deps.blob.uploadTarget(blobPath, ctx.args.contentType, ctx.args.bytes, validUntil);
      if (!upload) {
        // A local run: the gateway takes the bytes itself, at a URL it signed for this one file.
        const url = new URL(`${deps.gatewayUrl}/files/${id}/upload`);
        url.searchParams.set("exp", String(validUntil));
        url.searchParams.set("sig", signUpload(id, validUntil));
        upload = { url: url.toString(), method: "PUT", headers: { "content-type": ctx.args.contentType } };
      }
      return Response.json(
        { id, upload, expiresAt: new Date(validUntil).toISOString() },
        { status: 201, headers: noStore },
      );
    },
  };
}

function doneRoute(deps: FilesDeps, id: string): CapRoute<Space> {
  return {
    cap: "files",
    what: "/files",
    async args(stage) {
      const body = await readJsonBody(stage.req, 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["scope"]);
      if (extra) return extra;
      return spaceFor(stage, deps, body.scope, "add");
    },
    limits: (stage) => baseLimits(stage, "files"),
    async work(ctx) {
      const key = { productId: ctx.token.productId, namespace: ctx.namespace };
      const file = await deps.store.get(key, id);
      if (!file || file.scope !== ctx.args.space.scope || file.ownerKey !== ctx.args.space.ownerKey) return notFound();
      if (file.status === "ready") return Response.json(fileFacts(file, deps.gatewayUrl, ctx.now, true), { headers: noStore });
      const facts = await deps.blob.facts(file.blobPath);
      if (!facts) {
        return Response.json(
          { error: { type: "invalid_request_error", code: "not_uploaded", message: "The file hasn't arrived yet. Upload it to the ticket's URL first.", param: null } },
          { status: 409, headers: { "x-should-retry": "false" } },
        );
      }
      // The presigned upload already held the type and the size to the ticket's. This is the check after the fact.
      if (facts.bytes > file.bytes || facts.bytes < 1 || facts.contentType.split(";")[0]!.trim() !== file.contentType) {
        await deps.blob.remove([file.blobPath]);
        await deps.store.beginDelete(key, id);
        await deps.store.finishDelete(key, id);
        return capError("invalid_arguments", "The uploaded file isn't the size or type its ticket was for, so it was removed.");
      }
      const sha256 = await deps.blob.sha256(file.blobPath);
      const ready = await deps.store.markReady(key, id, { bytes: facts.bytes, sha256 });
      if (!ready) return notFound();
      return Response.json(fileFacts(ready, deps.gatewayUrl, ctx.now, true), { headers: noStore });
    },
  };
}

function listRoute(deps: FilesDeps): CapRoute<Space & { limit: number; after: string | null }> {
  return {
    cap: "files",
    what: "/files",
    async args(stage) {
      const params = new URL(stage.req.url).searchParams;
      const extra = [...params.keys()].filter((k) => !["scope", "after", "limit"].includes(k));
      if (extra.length) return capError("invalid_arguments", `Unknown parameter: ${extra[0]!.slice(0, 40)}.`);
      const limit = params.has("limit") ? Number(params.get("limit")) : FILES_LIMITS.pageDefault;
      if (!Number.isInteger(limit) || limit < 1 || limit > FILES_LIMITS.pageMax) return capError("invalid_arguments", `limit is 1 to ${FILES_LIMITS.pageMax}.`);
      const after = params.get("after");
      if (after !== null && (after.length > 200 || !decodeFilesCursor(after))) return capError("invalid_arguments", "after is the next value a page gave.");
      const space = await spaceFor(stage, deps, params.get("scope") ?? undefined, null);
      if (space instanceof Response) return space;
      return { ...space, limit, after };
    },
    limits: (stage) => baseLimits(stage, "files"),
    async work(ctx) {
      const page = await deps.store.list(inNamespace(ctx.args.space, ctx.namespace), { limit: ctx.args.limit, after: ctx.args.after });
      return Response.json({ items: page.items.map((f) => fileFacts(f, deps.gatewayUrl, ctx.now, true)), next: page.next }, { headers: noStore });
    },
  };
}

function fileRoute(deps: FilesDeps, id: string, method: "GET" | "DELETE"): CapRoute<Space> {
  return {
    cap: "files",
    what: "/files",
    async args(stage) {
      return spaceFor(stage, deps, new URL(stage.req.url).searchParams.get("scope") ?? undefined, method === "DELETE" ? "delete" : null);
    },
    limits: (stage) => baseLimits(stage, "files"),
    async work(ctx) {
      const key = { productId: ctx.token.productId, namespace: ctx.namespace };
      const file = await deps.store.get(key, id);
      const mine = file && file.scope === ctx.args.space.scope && file.ownerKey === ctx.args.space.ownerKey;
      if (method === "GET") return mine && file.status === "ready" ? Response.json(fileFacts(file, deps.gatewayUrl, ctx.now, true), { headers: noStore }) : notFound();
      if (!mine) return Response.json({ deleted: false }, { headers: noStore });
      const blobPath = await deps.store.beginDelete(key, id);
      if (!blobPath) return Response.json({ deleted: false }, { headers: noStore });
      await deps.blob.remove([blobPath]);
      await deps.store.finishDelete(key, id);
      return Response.json({ deleted: true }, { headers: noStore });
    },
  };
}

function clientKey(req: Request): string {
  return clientIpKey(req.headers.get("x-real-ip")) ?? clientIpKey(req.headers.get("x-forwarded-for")) ?? "unknown";
}

const minuteWindow = (now: Date) => new Date(Math.floor(now.getTime() / 60_000) * 60_000);
const denied = () => gatewayError(403, "permission_error", "link_expired", "This file link has expired or isn't valid. Open the file again from the product.", { retry: false });

/**
 * GET {GATEWAY_URL}/files/<id>/content?exp=&sig=: a file's bytes for whoever holds the link the gateway signed, for an
 * hour. Off with the cap. A product turned off or taken down serves nothing. On Vercel it redirects: to a presigned GET
 * on a private store, or to the blob's own URL on the public fallback. Types other than media and PDF are attachments.
 */
async function handleContent(req: Request, id: string, deps: FilesDeps): Promise<Response> {
  if (!deps.servedCaps().includes("files")) return unknownEndpoint("/files");
  try {
    const now = deps.now?.() ?? new Date();
    const params = new URL(req.url).searchParams;
    const exp = Number(params.get("exp"));
    const download = params.get("download") === "1";
    const sig = params.get("sig") ?? "";
    if (!Number.isInteger(exp) || exp <= now.getTime() || exp > now.getTime() + FILES_LIMITS.readValidMs + 60_000 || !sameMac(sig, signRead(id, exp, download))) return denied();
    const key = `files:read:${clientKey(req)}`;
    const counts = await deps.hitRateLimits([key], minuteWindow(now));
    if ((counts[key] ?? 0) > FILES_LIMITS.readsPerIpPerMinute) {
      return gatewayError(429, "rate_limit_error", "rate_limited", `Too many file requests: the limit is ${FILES_LIMITS.readsPerIpPerMinute} a minute.`, { headers: { "retry-after": "60" } });
    }
    const file = await deps.fileById(id);
    if (!file || file.status !== "ready") return notFound();
    const product = await deps.product(file.productId);
    if (!product || product.status === "disabled" || product.status === "failed" || product.takenDownAt || product.ownerBannedAt) return notFound("This file isn't available.");
    // A link made for a picture can't be turned into a page: the type decides, and anything else downloads.
    const attachment = download || !servedInline(file.contentType);
    const headers: Record<string, string> = {
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cross-origin-resource-policy": "cross-origin",
    };
    if (deps.blob.mode() === "local") {
      const local = await deps.blob.localStream?.(file.blobPath);
      if (!local) return notFound();
      const common = {
        ...headers,
        "content-type": file.contentType,
        "content-length": String(local.bytes),
        "content-disposition": `${attachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      };
      if (req.method === "HEAD") {
        await local.stream.cancel().catch(() => undefined);
        return new Response(null, { status: 200, headers: common });
      }
      return new Response(local.stream, { status: 200, headers: common });
    }
    const location = await deps.blob.readUrl(file.blobPath, { download: attachment, validUntil: now.getTime() + FILES_LIMITS.blobReadValidMs });
    if (!location) return notFound();
    return new Response(null, { status: 302, headers: { ...headers, location, "cache-control": "private, max-age=60" } });
  } catch (err) {
    console.error("[caps] files content failed:", err instanceof Error ? err.message : "unknown");
    return capError("cap_failed", "The file couldn't be read. Try again.");
  }
}

/**
 * PUT {GATEWAY_URL}/files/<id>/upload?exp=&sig=: a local run's upload, which has no Blob store to presign. The ticket
 * signed this URL for one pending file; the body must be its type and at most its size.
 */
async function handleLocalUpload(req: Request, id: string, deps: FilesDeps): Promise<Response> {
  if (!deps.servedCaps().includes("files") || deps.blob.mode() !== "local" || !deps.blob.writeLocal) return unknownEndpoint("/files");
  try {
    const now = deps.now?.() ?? new Date();
    const params = new URL(req.url).searchParams;
    const exp = Number(params.get("exp"));
    if (!Number.isInteger(exp) || exp <= now.getTime() || !sameMac(params.get("sig") ?? "", signUpload(id, exp))) return denied();
    const file = await deps.fileById(id);
    if (!file || file.status !== "pending") return notFound();
    const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (type !== file.contentType) return capError("invalid_arguments", "The file isn't the type its ticket was for.");
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > file.bytes) return capError("invalid_arguments", "The file is bigger than its ticket was for.");
    const body = Buffer.from(await req.arrayBuffer());
    if (body.length > file.bytes || !body.length) return capError("invalid_arguments", "The file is bigger than its ticket was for, or empty.");
    await deps.blob.writeLocal(file.blobPath, body, file.contentType);
    return new Response(null, { status: 200, headers: noStore });
  } catch (err) {
    console.error("[caps] files local upload failed:", err instanceof Error ? err.message : "unknown");
    return capError("cap_failed", "The upload didn't work. Try again.");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// {GATEWAY_URL}/search: the product's full-text index (FILES_SEARCH)

/** Splits text into chunks of about `size` characters at a paragraph, line or word break, with each one's offset. */
export function chunkText(text: string, size: number = FILES_LIMITS.chunkChars): SearchChunk[] {
  const chunks: SearchChunk[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length) {
      const window = text.slice(at + Math.floor(size / 2), end);
      const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf(" "));
      if (breakAt >= 0) end = at + Math.floor(size / 2) + breakAt + 1;
    }
    const body = text.slice(at, end);
    if (body.trim()) chunks.push({ body, offset: at });
    at = end;
  }
  return chunks;
}

/** The words of a query as a prefix query (`heron:* & nest:*`), letters and digits only, or null when none is long enough. */
export function prefixQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3).slice(0, 8);
  return words.length ? words.map((w) => `${w}:*`).join(" & ") : null;
}

function sourceOf(raw: unknown): SearchSource | Response {
  const s = raw as { fileId?: unknown; collection?: unknown; docId?: unknown } | null;
  if (s && typeof s === "object" && typeof s.fileId === "string" && Object.keys(s).length === 1) {
    return FILE_ID.test(s.fileId) ? { fileId: s.fileId } : capError("invalid_arguments", "source.fileId is the id the gateway gave the file.");
  }
  if (s && typeof s === "object" && typeof s.collection === "string" && typeof s.docId === "string" && Object.keys(s).length === 2) {
    return COLLECTION_NAME.test(s.collection) && DOC_ID.test(s.docId) ? { collection: s.collection, docId: s.docId } : capError("invalid_arguments", "source names a collection and an item id.");
  }
  return capError("invalid_arguments", "source is {fileId} for a stored file, or {collection, docId} for a saved item.");
}

const searchOff = (deps: FilesDeps) => () => deps.searchOn();

/** Serves everything under {GATEWAY_URL}/search. Off with FILES_SEARCH or the files cap. */
export async function handleSearch(req: Request, path: readonly string[], deps: FilesDeps): Promise<Response> {
  const [first] = path;
  if (req.method === "POST" && path.length === 1 && first === "index") return runCapGate(req, deps, indexRoute(deps));
  if (req.method === "POST" && path.length === 1 && first === "query") return runCapGate(req, deps, queryRoute(deps));
  if (req.method === "POST" && path.length === 1 && first === "remove") return runCapGate(req, deps, removeRoute(deps));
  return unknownEndpoint("/search");
}

function indexRoute(deps: FilesDeps): CapRoute<Space & { source: SearchSource; title: string; chunks: SearchChunk[] }> {
  return {
    cap: "files",
    what: "/search",
    enabled: searchOff(deps),
    async args(stage) {
      const body = await readJsonBody(stage.req, FILES_LIMITS.docMaxBytes + 16 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["source", "title", "text", "scope"]);
      if (extra) return extra;
      const source = sourceOf(body.source);
      if (source instanceof Response) return source;
      if (typeof body.text !== "string" || !body.text.trim()) return capError("invalid_arguments", "text is the words to index.");
      if (Buffer.byteLength(body.text, "utf8") > FILES_LIMITS.docMaxBytes) return capError("invalid_arguments", "A document can be at most 1 MB of text.");
      if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > FILES_LIMITS.titleMax)) return capError("invalid_arguments", "title is up to 200 characters.");
      const space = await spaceFor(stage, deps, body.scope, "add");
      if (space instanceof Response) return space;
      return { ...space, source, title: (body.title as string | undefined)?.trim() ?? "", chunks: chunkText(body.text) };
    },
    limits: (stage) => baseLimits(stage, "search"),
    async work(ctx) {
      const space = inNamespace(ctx.args.space, ctx.namespace);
      let title = ctx.args.title;
      if ("fileId" in ctx.args.source) {
        // A file's text cites that file, so it must be one of this space's own.
        const file = await deps.store.get(space, ctx.args.source.fileId);
        if (!file || file.status !== "ready" || file.scope !== space.scope || file.ownerKey !== space.ownerKey) return notFound("There's no stored file with that id here.");
        title ||= file.name;
      }
      if (!title) return capError("invalid_arguments", "Give an item's text a title, which its citation shows.");
      const max = isBuild(ctx.token) ? FILES_LIMITS.docsPerBuild : FILES_LIMITS.docsPerProduct;
      const done = await deps.store.indexDoc(space, { source: ctx.args.source, sourceKey: sourceKeyOf(ctx.args.source), title, chunks: ctx.args.chunks }, max);
      if (!done.ok) return capError("quota_exceeded", `This product's index already holds ${max.toLocaleString("en-US")} documents, the most it can. Remove some to add more.`);
      return Response.json({ indexed: true, source: ctx.args.source, chunks: ctx.args.chunks.length }, { status: 201, headers: noStore });
    },
  };
}

function removeRoute(deps: FilesDeps): CapRoute<Space & { source: SearchSource }> {
  return {
    cap: "files",
    what: "/search",
    enabled: searchOff(deps),
    async args(stage) {
      const body = await readJsonBody(stage.req, 2 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["source", "scope"]);
      if (extra) return extra;
      const source = sourceOf(body.source);
      if (source instanceof Response) return source;
      const space = await spaceFor(stage, deps, body.scope, "add");
      if (space instanceof Response) return space;
      return { ...space, source };
    },
    limits: (stage) => baseLimits(stage, "search"),
    async work(ctx) {
      const removed = await deps.store.removeDoc({ productId: ctx.token.productId, namespace: ctx.namespace }, sourceKeyOf(ctx.args.source));
      return Response.json({ removed: removed > 0 }, { headers: noStore });
    },
  };
}

/** A hit's citation: what it came from, the name to show and where in the text it starts. */
export interface Citation {
  source: SearchSource;
  name: string;
  offset: number;
}

/** The plain snippet and where its first matched word sits in the chunk, from ts_headline's << >> marks. */
export function snippetOf(marked: string, body: string): { snippet: string; at: number } {
  const first = marked.match(/<<([^>]*)>>/)?.[1] ?? "";
  const snippet = marked.replace(/<<|>>/g, "").replace(/\s+/g, " ").trim();
  const at = first ? body.toLowerCase().indexOf(first.toLowerCase()) : -1;
  return { snippet, at: Math.max(0, at) };
}

function queryRoute(deps: FilesDeps): CapRoute<Space & { q: string; limit: number }> {
  return {
    cap: "files",
    what: "/search",
    enabled: searchOff(deps),
    async args(stage) {
      const body = await readJsonBody(stage.req, 4 * 1024);
      if (body instanceof Response) return body;
      const extra = unknownKeys(body, ["q", "scope", "limit"]);
      if (extra) return extra;
      if (typeof body.q !== "string" || !body.q.trim() || body.q.length > FILES_LIMITS.queryMax) return capError("invalid_arguments", "q is what to look for, up to 200 characters.");
      const limit = body.limit === undefined ? 5 : body.limit;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > FILES_LIMITS.hitsMax) return capError("invalid_arguments", `limit is 1 to ${FILES_LIMITS.hitsMax}.`);
      const space = await spaceFor(stage, deps, body.scope, null);
      if (space instanceof Response) return space;
      return { ...space, q: body.q.trim(), limit: limit as number };
    },
    limits: (stage) => [...baseLimits(stage, "search"), { key: `search:query:${stage.token.id}`, limit: FILES_LIMITS.queriesPerMinute, window: "minute", who: "this product's searches" }],
    async work(ctx) {
      const hits = await deps.store.query(inNamespace(ctx.args.space, ctx.namespace), { text: ctx.args.q, prefix: prefixQuery(ctx.args.q), limit: ctx.args.limit });
      return Response.json(
        {
          hits: hits.map((h) => {
            const { snippet, at } = snippetOf(h.snippet, h.body);
            const citation: Citation = { source: h.source, name: h.title, offset: h.offset + at };
            return { source: h.source, title: h.title, snippet, score: Math.round(h.rank * 1000) / 1000, citation };
          }),
        },
        { headers: noStore },
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// {GATEWAY_URL}/datasets: the vetted public datasets (FILES_DATASETS)

/** Serves everything under {GATEWAY_URL}/datasets. Off with FILES_DATASETS or the files cap. */
export async function handleDatasets(req: Request, path: readonly string[], deps: FilesDeps): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return unknownEndpoint("/datasets");
  if (path.length === 0) return runCapGate(req, deps, datasetListRoute(deps));
  if (path.length === 2 && DATASET_ID.test(path[0]!) && DATASET_FILE.test(path[1]!)) return runCapGate(req, deps, datasetFileRoute(deps, path[0]!, path[1]!));
  return unknownEndpoint("/datasets");
}

function datasetLimits(stage: CapStage): CapLimit[] {
  return [
    { key: `datasets:token:${stage.token.id}`, limit: FILES_LIMITS.datasetReadsPerMinute, window: "minute", who: "this product" },
    ...(stage.caller.ip ? [{ key: `datasets:ip:${stage.token.productId}:${stage.caller.ip}`, limit: FILES_LIMITS.datasetReadsPerMinute, window: "minute" as const, who: "this user" }] : []),
  ];
}

function datasetListRoute(deps: FilesDeps): CapRoute<Record<string, never>> {
  return {
    cap: "files",
    what: "/datasets",
    enabled: () => deps.datasetsOn(),
    async args() {
      return {};
    },
    limits: datasetLimits,
    async work() {
      return Response.json({ datasets: deps.datasets().map((d) => publicDataset(d, deps.gatewayUrl)) }, { headers: { "cache-control": "private, max-age=300" } });
    },
  };
}

function datasetFileRoute(deps: FilesDeps, id: string, name: string): CapRoute<{ dataset: Dataset; file: Dataset["files"][number] }> {
  return {
    cap: "files",
    what: "/datasets",
    enabled: () => deps.datasetsOn(),
    async args() {
      const found = findDatasetFile(deps.datasets(), id, name);
      return found ?? notFound("There's no dataset file by that name on the gateway's list.");
    },
    limits: datasetLimits,
    async work(ctx) {
      const { dataset, file } = ctx.args;
      const headers = {
        "x-content-sha256": file.sha256,
        "x-dataset-license": dataset.license.spdx,
        "cache-control": "private, max-age=3600",
      };
      // A build's read goes in the gateway's record (/caps/proof), once it is really served.
      const served = async (res: Response) => {
        if (isBuild(ctx.token) && ctx.req.method === "GET") await deps.store.recordDatasetRead({ productId: ctx.token.productId, namespace: ctx.namespace }, dataset.id, file.name);
        return res;
      };
      const local = deps.localDatasetPath?.(dataset.id, file.name) ?? null;
      if (local && existsSync(local) && statSync(local).size === file.bytes) {
        const common = { ...headers, "content-type": file.contentType, "content-length": String(file.bytes) };
        if (ctx.req.method === "HEAD") return new Response(null, { status: 200, headers: common });
        return served(new Response(Readable.toWeb(createReadStream(local)) as ReadableStream, { status: 200, headers: common }));
      }
      if (!file.mirror) return gatewayError(503, "server_error", "dataset_unavailable", "This dataset isn't on the gateway's mirror yet.", { retry: false });
      return served(new Response(null, { status: 302, headers: { ...headers, location: file.mirror } }));
    },
  };
}

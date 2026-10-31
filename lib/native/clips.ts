/**
 * Clips of a product on a real device that its owner uploaded (products.extra_clips, docs/NATIVE.md), such as a Quest's own
 * recording. The file goes straight to Blob through a presigned URL, as inspo does, and a second call adds it to the product.
 */
import { issueSignedToken, type IssuedSignedToken } from "@vercel/blob";
import { handleUploadPresigned, type GeneratePresignedUrlEvent } from "@vercel/blob/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { localFileKey } from "@/lib/local-files";
import { isOwnBlobUrl } from "@/lib/native/blob-host";
import { newestBrief } from "@/lib/native/queries";
import { briefTargets } from "@/lib/native/targets";
import { INSPO_UPLOAD_TTL_MS, NO_CALLBACK_KEY } from "@/lib/pipeline/inspo-upload";
import { blobAuth } from "@/lib/storage";
import type { ProductClip } from "@/lib/types";

export const CLIP_CONTENT_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
/** A few minutes from a Quest or an iPhone screen recording. */
export const MAX_CLIP_BYTES = 500 * 1024 * 1024;
export const MAX_CLIPS_PER_PRODUCT = 12;
export const MAX_CAPTION_CHARS = 300;

export class ClipError extends Error {}

const clipFolder = (productId: string) => `clips/${productId}/`;

/** Why `pathname` can't take this product's clip, or null. */
export function checkClipPathname(pathname: unknown, productId: string): string | null {
  const folder = clipFolder(productId);
  if (
    typeof pathname !== "string" ||
    !pathname.startsWith(folder) ||
    pathname.length <= folder.length ||
    pathname.length > 300 ||
    pathname.includes("..") ||
    pathname.includes("//") ||
    pathname.includes("\\")
  ) {
    return "A clip must go under this product's clips folder.";
  }
  return null;
}

/**
 * A caption says honestly what a clip shows, so it's required: one line, spaces tidied. Null when there's nothing left.
 */
export function cleanCaption(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  return text && text.length <= MAX_CAPTION_CHARS ? text : null;
}

/** True for a file this product's clip may be: in its folder on this platform's Blob store, or in .data/files on a local run. */
export function isClipUrl(raw: unknown, productId: string): raw is string {
  if (typeof raw !== "string") return false;
  const local = localFileKey(raw);
  if (local !== null) return local.startsWith(clipFolder(productId));
  try {
    const url = new URL(raw);
    const path = decodeURIComponent(url.pathname).slice(1);
    return isOwnBlobUrl(url) && checkClipPathname(path, productId) === null;
  } catch {
    return false;
  }
}

/** handleUploadPresigned's getSignedToken for a clip: a delegation for `put` on exactly `pathname`, with a clip's limits. */
async function clipSignedToken(
  pathname: string,
  productId: string,
  now = Date.now(),
): Promise<{ token: IssuedSignedToken; urlOptions: { allowedContentTypes: string[]; maximumSizeInBytes: number; addRandomSuffix: true } }> {
  const problem = checkClipPathname(pathname, productId);
  if (problem) throw new ClipError(problem);
  const limits = { allowedContentTypes: [...CLIP_CONTENT_TYPES], maximumSizeInBytes: MAX_CLIP_BYTES };
  const token = await issueSignedToken({ pathname, operations: ["put"], validUntil: now + INSPO_UPLOAD_TTL_MS, ...limits, ...blobAuth() });
  return { token, urlOptions: { ...limits, addRandomSuffix: true } };
}

/** The route's reply to a blob.generate-presigned-url event. Throws ClipError for a pathname outside the product's folder. */
export async function presignClipUpload(body: GeneratePresignedUrlEvent, request: Request, productId: string): ReturnType<typeof handleUploadPresigned> {
  return handleUploadPresigned({
    body,
    request,
    webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || NO_CALLBACK_KEY,
    getSignedToken: (pathname) => clipSignedToken(pathname, productId),
  });
}

/** The product a clip route acts on, when it's shipped. */
export async function clipProduct(slug: string): Promise<{ id: string; ownerId: string | null } | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const [product] = await db()
    .select({ id: schema.products.id, ownerId: schema.products.ownerId })
    .from(schema.products)
    .where(and(eq(schema.products.slug, slug), inArray(schema.products.status, ["live", "partial"])))
    .limit(1);
  return product ?? null;
}

/** Clips are for a product that runs somewhere beyond the web (docs/NATIVE.md), as the page's add button says. */
export async function takesClips(productId: string): Promise<boolean> {
  return briefTargets(await newestBrief(productId)).some((t) => t !== "web");
}

/** Adds a clip, in one statement so two uploads can't go past the limit. False when the product has its limit already. */
export async function addClip(productId: string, clip: ProductClip): Promise<boolean> {
  const rows = await db()
    .update(schema.products)
    .set({ extraClips: sql`${schema.products.extraClips} || ${JSON.stringify([clip])}::jsonb` })
    .where(and(eq(schema.products.id, productId), sql`jsonb_array_length(${schema.products.extraClips}) < ${MAX_CLIPS_PER_PRODUCT}`))
    .returning({ id: schema.products.id });
  return rows.length > 0;
}

/** Takes a clip off the product's page. False when it wasn't there. */
export async function removeClip(productId: string, url: string): Promise<boolean> {
  const rows = await db()
    .update(schema.products)
    .set({ extraClips: sql`coalesce((select jsonb_agg(c) from jsonb_array_elements(${schema.products.extraClips}) c where c ->> 'url' <> ${url}), '[]'::jsonb)` })
    .where(and(eq(schema.products.id, productId), sql`${schema.products.extraClips} @> ${JSON.stringify([{ url }])}::jsonb`))
    .returning({ id: schema.products.id });
  return rows.length > 0;
}

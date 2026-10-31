import { del } from "@vercel/blob";
import { canActAsOwner, requireUser } from "@/lib/auth";
import { safeFileName } from "@/lib/client/upload";
import { env } from "@/lib/env";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { localFilesEnabled } from "@/lib/local-files";
import {
  CLIP_CONTENT_TYPES,
  ClipError,
  MAX_CLIP_BYTES,
  addClip,
  checkClipPathname,
  cleanCaption,
  clipProduct,
  isClipUrl,
  presignClipUpload,
  removeClip,
  takesClips,
} from "@/lib/native/clips";
import { isPresignedUrlEvent, storageNotSetUp } from "@/lib/pipeline/inspo-upload";
import { blobAuth, putFile } from "@/lib/storage";
import type { ProductClip } from "@/lib/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string }> };

const UPLOADS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
const FULL = "This product has as many clips as it can hold. Remove one first.";
const NO_CAPTION = "Say what the clip shows, in 300 characters or fewer.";

/** The product, for its owner or an admin. Answers instead when it isn't theirs, or nothing here is switched on. */
async function ownedProduct(slug: string): Promise<{ productId: string; userId: string } | Response> {
  if (!env.enabledTargets.length) return errorJson(404, "not_found");
  const user = await requireUser();
  const product = await clipProduct(slug);
  if (!product) return errorJson(404, "not_found");
  if (!canActAsOwner(user, product.ownerId)) return errorJson(403, "forbidden");
  return { productId: product.id, userId: user.id };
}

async function add(productId: string, url: string, caption: string): Promise<Response> {
  const clip: ProductClip = { url, posterUrl: null, caption, addedAt: new Date().toISOString() };
  if (!(await addClip(productId, clip))) return errorJson(409, FULL);
  return Response.json({ clip });
}

/** A local run has no Blob store, so the file comes to this route, as lib/client/upload.ts does for inspo. */
async function addLocal(req: Request, productId: string): Promise<Response> {
  if (!localFilesEnabled()) return errorJson(404, "not_found");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const caption = cleanCaption(form?.get("caption"));
  if (!(file instanceof File)) return errorJson(400, "Send a file.");
  if (!caption) return errorJson(400, NO_CAPTION);
  if (!(CLIP_CONTENT_TYPES as readonly string[]).includes(file.type)) return errorJson(400, "Use an MP4, MOV or WebM video.");
  if (file.size > MAX_CLIP_BYTES) return errorJson(400, "That clip is over the 500 MB limit.");
  const url = await putFile("clips", `${productId}/${safeFileName(file.name)}`, Buffer.from(await file.arrayBuffer()), file.type);
  return add(productId, url, caption);
}

/**
 * POST, for a product's owner or an admin, one of:
 * - a blob.generate-presigned-url event, for a pathname in this product's clips folder (@vercel/blob/client's uploadPresigned);
 * - {url, caption}, which adds the uploaded file to the product;
 * - multipart {file, caption} on a local run, which has no Blob store.
 *
 * 400 bad body, 401 signed out, 403 not theirs, 404 not found, nothing switched on or a web-only product, 409 too many clips,
 * 429 too many uploads, 503 {error: "uploads_unavailable"}.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const { slug } = await params;
  const owned = await ownedProduct(slug);
  if (owned instanceof Response) return owned;
  const { productId, userId } = owned;
  if (!(await takesClips(productId))) return errorJson(404, "not_found");

  if (req.headers.get("content-type")?.startsWith("multipart/form-data")) return addLocal(req, productId);

  const body = await readJson(req);
  if (isPresignedUrlEvent(body)) {
    const windowStart = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
    const key = `clips:user:${userId}`;
    const counts = await hitRateLimits([key], windowStart);
    if ((counts[key] ?? 0) > UPLOADS_PER_HOUR) return errorJson(429, "upload_limit");
    if (!env.blobConfigured) return errorJson(503, "uploads_unavailable");
    const problem = checkClipPathname(body.payload.pathname, productId);
    if (problem) return errorJson(400, problem);
    try {
      return Response.json(await presignClipUpload(body, req, productId));
    } catch (err) {
      if (err instanceof ClipError) return errorJson(400, err.message);
      if (storageNotSetUp(err)) {
        console.error("[clips]", err);
        return errorJson(503, "uploads_unavailable");
      }
      throw err;
    }
  }

  const caption = cleanCaption(body.caption);
  if (!caption) return errorJson(400, NO_CAPTION);
  if (!isClipUrl(body.url, productId)) return errorJson(400, "That isn't a clip uploaded for this product.");
  return add(productId, body.url, caption);
});

/**
 * DELETE {url}, for a product's owner or an admin: takes a clip off the product's page and deletes its file. The clip is gone
 * from the page either way, so a file that won't delete is only logged. 404 when it wasn't there.
 */
export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const { slug } = await params;
  const owned = await ownedProduct(slug);
  if (owned instanceof Response) return owned;
  const { url } = await readJson(req);
  if (!isClipUrl(url, owned.productId)) return errorJson(400, "That isn't one of this product's clips.");
  if (!(await removeClip(owned.productId, url))) return errorJson(404, "not_found");
  if (!localFilesEnabled()) {
    await del(url, blobAuth()).catch((err: unknown) => console.error("[clips] couldn't delete a file:", err instanceof Error ? err.message : err));
  }
  return Response.json({ ok: true });
});

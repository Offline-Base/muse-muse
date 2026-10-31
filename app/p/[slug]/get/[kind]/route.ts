import { reserveCounter, adjustCounter } from "@/lib/gateway/store";
import { answerDownload, type DownloadDeps } from "@/lib/native/downloads";
import { DOWNLOADS_WINDOW, downloadsKey, readProductNative, shippedProductBySlug } from "@/lib/native/queries";
import { downloadablePackage } from "@/lib/native/product-view";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string; kind: string }> };

const deps: DownloadDeps = {
  async findPackage(slug, download) {
    const product = await shippedProductBySlug(slug);
    if (!product) return null;
    return downloadablePackage(await readProductNative(product.id, product.targets), download);
  },
  reserve: (key, windowStart, limit) => reserveCounter(key, windowStart, 1, limit),
  count: (artifactId) => adjustCounter(downloadsKey(artifactId), DOWNLOADS_WINDOW, 1),
  now: () => new Date(),
};

/** GET -> 302 to a package's file on Blob, counted and rate limited. HEAD -> the same answer, not counted. */
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const { slug, kind } = await params;
  return answerDownload(req, slug, kind, deps);
}

export const HEAD = GET;

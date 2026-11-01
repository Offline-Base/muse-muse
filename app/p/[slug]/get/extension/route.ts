import { answerExtensionDownload, type ExtensionDownloadDeps } from "@/lib/caps/extension/download";
import { findExtensionZip } from "@/lib/caps/extension/store";
import { env } from "@/lib/env";
import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { newestBrief, shippedProductBySlug } from "@/lib/native/queries";

// A live product's browser extension, as a zip people install with Load unpacked (docs/CAPABILITIES.md, section 20).
// Off (NATIVE_EXTENSION, or the cap not ready): the same 404 as any download name the site doesn't know.
export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string }> };

const deps: ExtensionDownloadDeps = {
  enabled: () => env.enabledCaps.includes("extension"),
  async findProduct(slug) {
    const product = await shippedProductBySlug(slug);
    if (!product) return null;
    const brief = (await newestBrief(product.id)) as { extension?: unknown } | null;
    return { id: product.id, liveUrl: product.liveUrl, hasExtension: Boolean(brief?.extension) };
  },
  findZip: findExtensionZip,
  reserve: (key, windowStart, limit) => reserveCounter(key, windowStart, 1, limit),
  release: (key, windowStart) => adjustCounter(key, windowStart, -1),
  now: () => new Date(),
};

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const { slug } = await params;
  return answerExtensionDownload(req, slug, deps);
}

export const HEAD = GET;

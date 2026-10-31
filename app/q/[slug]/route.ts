import { env } from "@/lib/env";
import { shippedProductBySlug } from "@/lib/native/queries";
import { safeHttpUrl } from "@/lib/native/product-view";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string }> };

function notHere(): Response {
  return new Response("There's no VR product at this link.\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** GET -> 302 to a VR product's live URL: the short link people type into Quest Browser (docs/NATIVE.md). */
export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
  if (!env.vrEnabled) return notHere();
  const { slug } = await params;
  try {
    const product = await shippedProductBySlug(slug);
    if (!product || !product.targets.includes("vr") || !safeHttpUrl(product.liveUrl)) return notHere();
    return new Response(null, { status: 302, headers: { Location: product.liveUrl, "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[q]", err instanceof Error ? err.message : err);
    return new Response("This link isn't working right now. Try again soon.\n", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

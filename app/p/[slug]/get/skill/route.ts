import { outputResponse, outputRouteDeps } from "@/lib/outputs/serve";
import { platformOrigin } from "@/lib/queries";

// A generated file for this product (docs/PRODUCT_OUTPUTS.md). Built from its manifest on each request, with a short cache.
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    return await outputResponse("skill", slug, outputRouteDeps(platformOrigin));
  } catch (err) {
    console.error(`[outputs] skill for ${slug} failed:`, err);
    return new Response("Something went wrong\n", { status: 500 });
  }
}

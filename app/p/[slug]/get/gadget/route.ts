import { adjustCounter, reserveCounter } from "@/lib/gateway/store";
import { limitedOutputResponse, outputRouteDeps, type OutputLimitDeps } from "@/lib/outputs/serve";
import { platformOrigin } from "@/lib/queries";

// The Muse gadget pack for this product (docs/PRODUCT_OUTPUTS.md). Built from its manifest on each request, counted and
// rate limited like the native downloads.
export const runtime = "nodejs";

const limits: OutputLimitDeps = {
  reserve: (key, windowStart, limit) => reserveCounter(key, windowStart, 1, limit),
  release: (key, windowStart) => adjustCounter(key, windowStart, -1),
  now: () => new Date(),
};

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    return await limitedOutputResponse("gadget", req, slug, outputRouteDeps(platformOrigin), limits);
  } catch (err) {
    console.error(`[outputs] gadget for ${slug} failed:`, err);
    return new Response("Something went wrong\n", { status: 500, headers: { "cache-control": "no-store" } });
  }
}

export const HEAD = GET;

import { selfHostRouteDeps } from "@/lib/outputs/runtime-deps";
import { selfHostResponse } from "@/lib/outputs/runtime-serve";

// The product's self-host kit, for its owner (docs/CAPABILITIES.md, section 16): its live source, made to run on the
// owner's own Meta key. Cloud mode only. Read from the live deployment on each request, never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    return await selfHostResponse(slug, selfHostRouteDeps());
  } catch (err) {
    console.error(`[outputs] selfhost for ${slug} failed:`, err instanceof Error ? err.message : err);
    return new Response("Something went wrong\n", { status: 500 });
  }
}

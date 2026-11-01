import { selfHostRouteDeps } from "@/lib/outputs/runtime-deps";
import { selfHostHead, selfHostResponse } from "@/lib/outputs/runtime-serve";

// The product's self-host kit, for its owner (docs/CAPABILITIES.md, section 16): its live source, made to run on the
// owner's own Meta key. Cloud mode only. Read from the live deployment on each request, never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ slug: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { slug } = await params;
  try {
    return await selfHostResponse(slug, selfHostRouteDeps(), { fetchSite: req.headers.get("sec-fetch-site") });
  } catch (err) {
    console.error(`[outputs] selfhost for ${slug} failed:`, err instanceof Error ? err.message : err);
    return new Response("Something went wrong\n", { status: 500 });
  }
}

/** A link checker's HEAD: no kit is counted and no file is read. */
export async function HEAD(req: Request, { params }: Ctx) {
  const { slug } = await params;
  try {
    return await selfHostHead(slug, selfHostRouteDeps(), { fetchSite: req.headers.get("sec-fetch-site") });
  } catch (err) {
    console.error(`[outputs] selfhost HEAD for ${slug} failed:`, err instanceof Error ? err.message : err);
    return new Response(null, { status: 500 });
  }
}

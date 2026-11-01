import { runtimeOutputRouteDeps } from "@/lib/outputs/runtime-deps";
import { runtimeOutputResponse } from "@/lib/outputs/runtime-serve";

// The product's GitHub Action, as source (docs/CAPABILITIES.md, section 16). Made from its manifest on each request.
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    return await runtimeOutputResponse("github_action", slug, runtimeOutputRouteDeps());
  } catch (err) {
    console.error(`[outputs] github-action for ${slug} failed:`, err);
    return new Response("Something went wrong\n", { status: 500 });
  }
}

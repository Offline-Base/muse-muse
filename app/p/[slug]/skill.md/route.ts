import { outputResponse, outputRouteDeps } from "@/lib/outputs/serve";
import { platformOrigin } from "@/lib/queries";

// The skill file to read in place, at the address docs/MUSE_CODE_FULL.md names. /p/<slug>/get/skill saves the same file.
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    return await outputResponse("skill", slug, outputRouteDeps(platformOrigin), { inline: true });
  } catch (err) {
    console.error(`[outputs] skill.md for ${slug} failed:`, err);
    return new Response("Something went wrong\n", { status: 500 });
  }
}

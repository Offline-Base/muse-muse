import { notImplemented } from "@/lib/http";

// TODO(kickoff, day 7): take a refinement message, resume the product's Muse Code session in its sandbox
// (prompt 5 in docs/PROMPTS.md), then verify and redeploy.
export async function POST(_req: Request, { params }: { params: Promise<{ buildId: string }> }) {
  const { buildId } = await params;
  return notImplemented(`Refine the product from build ${buildId}`);
}

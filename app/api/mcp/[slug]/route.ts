import { notImplemented } from "@/lib/http";

// MCP over streamable HTTP for the Muse app's custom connectors. Tools come from the product's musemuse.json
// actions, and each tool call POSTs to the live product's /api/actions/<name>.
// TODO(kickoff, day 7): implement with @modelcontextprotocol/sdk.
async function handle(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return notImplemented(`MCP endpoint for ${slug}`);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

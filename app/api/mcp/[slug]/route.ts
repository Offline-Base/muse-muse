import { handleMcp } from "@/lib/mcp/server";
import { findServableProduct } from "@/lib/mcp/store";

// MCP over streamable HTTP for the Muse app's custom connectors. Tools come from the product's musemuse.json
// actions, and each tool call POSTs to the live product's /api/actions/<name>.
export const runtime = "nodejs";
export const maxDuration = 300;

async function handle(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    return await handleMcp(req, slug, { findProduct: findServableProduct, fetch: (input, init) => fetch(input, init) });
  } catch (err) {
    console.error(`[mcp] ${slug} failed:`, err);
    return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

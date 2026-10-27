import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_LIMITS } from "@/lib/gateway/policy";
import type { Manifest, ProductStatus } from "@/lib/types";

/** The product fields the connector needs. */
export interface McpProduct {
  slug: string;
  name: string;
  tagline: string;
  status: ProductStatus;
  liveUrl: string | null;
  manifest: Manifest | null;
}

export interface McpDeps {
  /** A live or partial product by slug, or null. */
  findProduct(slug: string): Promise<McpProduct | null>;
  /** Used for POST {liveUrl}/api/actions/<name>. */
  fetch: typeof fetch;
  actionTimeoutMs?: number;
}

type Action = Manifest["actions"][number];

const MAX_ERROR_TEXT = 2000;

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** MCP requires an object schema. Manifests should already have one; wrap anything else. */
export function toolInputSchema(input: Record<string, unknown> | undefined): Tool["inputSchema"] {
  const schema = isPlainObject(input) ? input : {};
  return { ...schema, type: "object" } as Tool["inputSchema"];
}

export function toolsFor(product: McpProduct): Tool[] {
  return (product.manifest?.actions ?? []).map((a) => ({
    name: a.name,
    description: a.description,
    inputSchema: toolInputSchema(a.input),
  }));
}

export function instructionsFor(product: McpProduct): string {
  const tagline = product.tagline ? ` ${product.tagline.replace(/\.?$/, ".")}` : "";
  return (
    `${product.name}.${tagline} Each tool runs one of this product's actions on its live site (${product.liveUrl}). ` +
    "This product was built with Muse Muse, a hackathon concept. It is not an official Meta product."
  );
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** POSTs the arguments to the product's action route and turns the reply into a tool result. */
export async function callAction(
  product: McpProduct,
  action: Action,
  args: Record<string, unknown>,
  deps: McpDeps,
): Promise<CallToolResult> {
  const base = (product.liveUrl ?? "").replace(/\/$/, "");
  const url = `${base}/api/actions/${encodeURIComponent(action.name)}`;
  const timeoutMs = deps.actionTimeoutMs ?? DEFAULT_LIMITS.mcpActionTimeoutMs;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "MuseMuse-MCP/1.0" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return errorResult(
      timedOut
        ? `${action.name} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`
        : `Couldn't reach ${product.name} to run ${action.name}.`,
    );
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return errorResult(`${action.name} failed with HTTP ${res.status}: ${text.slice(0, MAX_ERROR_TEXT) || "(empty body)"}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return errorResult(`${action.name} returned a reply that isn't JSON: ${text.slice(0, MAX_ERROR_TEXT)}`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    ...(isPlainObject(json) ? { structuredContent: json } : {}),
  };
}

function buildServer(product: McpProduct, deps: McpDeps): McpServer {
  const mcp = new McpServer(
    {
      name: `musemuse-${product.slug}`,
      title: `${product.name} (built with Muse Muse)`,
      version: "1.0.0",
      description: `${product.tagline || product.name}. Built with Muse Muse. Not an official Meta product.`,
      ...(product.liveUrl ? { websiteUrl: product.liveUrl } : {}),
    },
    { capabilities: { tools: {} }, instructions: instructionsFor(product) },
  );
  const actions = new Map((product.manifest?.actions ?? []).map((a) => [a.name, a]));
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(product) }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const action = actions.get(request.params.name);
    if (!action) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    return callAction(product, action, request.params.arguments ?? {}, deps);
  });
  return mcp;
}

/**
 * MCP over streamable HTTP, stateless: each POST gets a fresh server and transport, and replies are plain JSON
 * (no SSE stream), which suits serverless functions. GET (standalone stream) and DELETE (sessions) return 405.
 */
export async function handleMcp(req: Request, slug: string, deps: McpDeps): Promise<Response> {
  if (req.method !== "POST") {
    return jsonRpcError(405, ErrorCode.ConnectionClosed, "This MCP server is stateless. Send JSON-RPC over POST.", {
      allow: "POST",
    });
  }
  const product = await deps.findProduct(slug);
  if (!product || (product.status !== "live" && product.status !== "partial") || !product.liveUrl) {
    return jsonRpcError(404, ErrorCode.InvalidRequest, `No live Muse Muse product is called "${slug}".`);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(await req.text());
  } catch {
    return jsonRpcError(400, ErrorCode.ParseError, "Parse error: invalid JSON.");
  }

  // Be lenient about Accept and Content-Type: the reply is always JSON here.
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  const normalized = new Request(req.url, { method: "POST", headers });

  const mcp = buildServer(product, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  try {
    return await transport.handleRequest(normalized, { parsedBody });
  } finally {
    await transport.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
}

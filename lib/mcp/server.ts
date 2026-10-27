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
import { parseManifest } from "@/lib/format";
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
/** The most of an action's reply a tool call reads. Bigger replies are refused, not passed on. */
export const MAX_ACTION_REPLY_BYTES = 1024 * 1024;

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
  return (parseManifest(product.manifest)?.actions ?? []).map((a) => ({
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

/** {origin of liveUrl}/api/actions/<name>, or null when liveUrl isn't an https URL or the name would leave that path. */
export function actionUrl(liveUrl: string | null, name: string): URL | null {
  let base: URL;
  try {
    base = new URL(liveUrl ?? "");
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || base.username || base.password) return null;
  const path = `/api/actions/${encodeURIComponent(name)}`;
  const url = new URL(path, base.origin);
  return url.origin === base.origin && url.pathname === path ? url : null;
}

class ReplyTooLarge extends Error {}

/** Reads at most `maxBytes` of a body as text, refusing bigger ones before or while reading. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (!res.body) return "";
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new ReplyTooLarge();
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ReplyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * POSTs the arguments to the product's action route and turns the reply into a tool result. Only the product's own
 * origin is called, redirects are refused rather than followed, and replies over MAX_ACTION_REPLY_BYTES are refused,
 * so the connector can't be used to fetch other hosts or pull huge bodies through the platform.
 */
export async function callAction(
  product: McpProduct,
  action: Action,
  args: Record<string, unknown>,
  deps: McpDeps,
): Promise<CallToolResult> {
  const url = actionUrl(product.liveUrl, action.name);
  if (!url) return errorResult(`${product.name} has no usable live URL for ${action.name}.`);
  const timeoutMs = deps.actionTimeoutMs ?? DEFAULT_LIMITS.mcpActionTimeoutMs;
  const failed = (err: unknown) => {
    if (err instanceof ReplyTooLarge) {
      return errorResult(`${action.name} replied with more than ${MAX_ACTION_REPLY_BYTES / 1024 / 1024} MB, which is too much for a tool result.`);
    }
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return errorResult(
      timedOut
        ? `${action.name} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`
        : `Couldn't reach ${product.name} to run ${action.name}.`,
    );
  };
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "MuseMuse-MCP/1.0" },
      body: JSON.stringify(args),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return failed(err);
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    return errorResult(`${action.name} answered with a redirect (HTTP ${res.status}), which the connector doesn't follow.`);
  }
  let text: string;
  try {
    text = await readCapped(res, MAX_ACTION_REPLY_BYTES);
  } catch (err) {
    return failed(err);
  }
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
  const actions = new Map((parseManifest(product.manifest)?.actions ?? []).map((a) => [a.name, a]));
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

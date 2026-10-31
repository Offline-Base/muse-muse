import { createHmac, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { noEmDashes } from "@/lib/brief/normalize";
import { TERMINAL_STATUSES, type BuildStatus } from "@/lib/types";

/**
 * The build MCP server (docs/MUSE_CODE_FULL.md, "Every capability on"): what Muse Code inside a build's sandbox may ask
 * the platform, over streamable HTTP at app/api/build-mcp. Meta's developer docs (the mirror in content/meta-docs), the
 * models a product may call, and a note to the build room. Each build has its own token, an HMAC of its id, which only
 * the build's Muse Code runner exports (lib/sandbox/muse-config.ts). Stateless, like lib/mcp/server.ts: each POST gets a
 * fresh server and transport and a plain JSON reply.
 */

const TOKEN_PREFIX = "mm_build_mcp";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The most of a docs page one docs_read returns. Bigger pages say how to read them a section at a time. */
export const MAX_DOC_CHARS = 60_000;
export const MAX_NOTE_CHARS = 600;
const MAX_QUERY_CHARS = 200;

function mac(buildId: string, secret: string): string {
  return createHmac("sha256", secret).update(`build-mcp:${buildId}`).digest("hex");
}

/** A build's MCP token: its id and an HMAC of it, so it needs no storage and can't be made for another build. */
export function buildMcpToken(buildId: string, secret: string): string {
  return `${TOKEN_PREFIX}.${buildId}.${mac(buildId, secret)}`;
}

/** The build a token was made for, or null. The HMAC is compared in constant time. */
export function buildIdFromToken(token: string, secret: string): string | null {
  const [prefix, buildId = "", given = "", ...extra] = token.trim().split(".");
  if (prefix !== TOKEN_PREFIX || extra.length || !UUID.test(buildId) || !/^[0-9a-f]{64}$/.test(given)) return null;
  const want = Buffer.from(mac(buildId, secret), "hex");
  const got = Buffer.from(given, "hex");
  return got.length === want.length && timingSafeEqual(got, want) ? buildId : null;
}

export interface DocsHit {
  slug: string;
  /** The heading's anchor, for a hit on one section of a page. */
  anchor?: string;
  title: string;
  /** Where it lives: "Capabilities", or "Capabilities · Tool calling" for a heading. */
  context: string;
  description?: string;
}

export interface BuildMcpDeps {
  /** The HMAC key for build tokens. Read for each request, never logged. */
  secret(): string;
  /** The build's status, or null when there is no such build. */
  findBuild(buildId: string): Promise<{ status: BuildStatus } | null>;
  /** Adds a log line to the build room. False when the build already has as many notes as it may. */
  addNote(buildId: string, text: string): Promise<boolean>;
  searchDocs(query: string, limit: number): DocsHit[];
  /** A mirrored page's title and Markdown, or null for a slug the mirror doesn't have. */
  readDoc(slug: string): { title: string; markdown: string } | null;
  /** The models a product may call, as the brief writer sees them. */
  models(): string;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export const BUILD_MCP_TOOLS: Tool[] = [
  {
    name: "docs_search",
    title: "Search Meta's developer docs",
    description:
      "Searches the Muse Muse mirror of Meta's developer docs (dev.meta.ai): the Model API, Muse Code, the models and their guides. Returns matching pages and sections, each with the slug to pass to docs_read.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, such as tool calling, image edits or structured output." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "How many hits to return. Default 8." },
      },
      required: ["query"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "docs_read",
    title: "Read a Meta docs page",
    description: "Reads one page of Meta's developer docs as Markdown, or one section of it when you name its anchor.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The page's slug from docs_search, such as tool-calling. A /docs/ path or a dev.meta.ai docs URL works too, with an optional #anchor." },
        section: { type: "string", description: "The anchor of one section, such as parallel-tool-calls, to read only that part." },
      },
      required: ["slug"],
    },
    annotations: READ_ONLY,
  },
  {
    name: "models_list",
    title: "List the models a product may call",
    description: "The Meta models a Muse Muse product may call through the gateway: what each is for, what it takes and returns, its price, and how products run.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "build_note",
    title: "Tell the build's owner",
    description: `Adds one short line to this build's room, where its owner watches the build. Use it for milestones and decisions, not for every step. At most ${MAX_NOTE_CHARS} characters.`,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: MAX_NOTE_CHARS, description: "The note, in plain words." } },
      required: ["text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const INSTRUCTIONS =
  "The Muse Muse platform, for the Muse Code run building this product. Search and read Meta's developer docs before you guess at an API, check which models a product may call, and tell the build's owner about milestones with build_note.";

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers });
}

function text(value: string, extra: Partial<CallToolResult> = {}): CallToolResult {
  return { content: [{ type: "text", text: value }], ...extra };
}

function errorResult(value: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: value }] };
}

/** A slug from "tool-calling", "/docs/tool-calling#x" or "https://dev.meta.ai/docs/tool-calling#x", and its anchor. */
export function docsTarget(raw: string): { slug: string; anchor: string | null } {
  const [path = "", hash = ""] = raw.trim().split("#");
  const slug = path
    .replace(/^https?:\/\/dev\.meta\.ai/i, "")
    .replace(/^\/?docs\//, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/, "");
  return { slug, anchor: hash.trim() || null };
}

/** The section of `md` under the heading whose anchor is `anchor`, up to the next heading at its level or above. */
export function docsSection(md: string, anchor: string): string | null {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.includes(`{#${anchor}}`));
  if (at < 0) return null;
  const depth = /^(#+)/.exec(lines[at]!)![1]!.length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]!);
    if (m && m[1]!.length <= depth) {
      end = i;
      break;
    }
  }
  return lines.slice(at, end).join("\n").trim();
}

/** A note as the build room shows it: one plain line, without control characters or em dashes. */
export function cleanNote(raw: string): string {
  const flat = noEmDashes(raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ")).trim();
  return flat.length > MAX_NOTE_CHARS ? `${flat.slice(0, MAX_NOTE_CHARS - 1)}…` : flat;
}

async function callTool(name: string, args: Record<string, unknown>, buildId: string, status: BuildStatus, deps: BuildMcpDeps): Promise<CallToolResult> {
  switch (name) {
    case "docs_search": {
      const query = typeof args.query === "string" ? args.query.trim().slice(0, MAX_QUERY_CHARS) : "";
      if (!query) return errorResult("Say what to search for in query.");
      const limit = Math.min(20, Math.max(1, Math.floor(Number(args.limit) || 8)));
      const hits = deps.searchDocs(query, limit);
      if (!hits.length) return text(`Nothing in Meta's docs matched "${query}". Try other words.`, { structuredContent: { hits: [] } });
      const lines = hits.map((h) => `- ${h.title} (${h.context}): docs_read slug ${h.slug}${h.anchor ? `, section ${h.anchor}` : ""}${h.description ? `. ${h.description}` : ""}`);
      return text(lines.join("\n"), { structuredContent: { hits } });
    }
    case "docs_read": {
      const target = docsTarget(typeof args.slug === "string" ? args.slug : "");
      if (!target.slug) return errorResult("Name a page with slug, such as tool-calling.");
      const page = deps.readDoc(target.slug);
      if (!page) return errorResult(`Meta's docs have no page "${target.slug}". Find one with docs_search.`);
      const anchor = typeof args.section === "string" && args.section.trim() ? args.section.trim().replace(/^#/, "") : target.anchor;
      const body = anchor ? docsSection(page.markdown, anchor) : page.markdown;
      if (body === null) return errorResult(`The page "${target.slug}" has no section "${anchor}". Read the whole page, or search for the section.`);
      if (body.length <= MAX_DOC_CHARS) return text(body);
      return text(`${body.slice(0, MAX_DOC_CHARS)}\n\n[The page goes on. Read it a section at a time with section set to one of its anchors.]`);
    }
    case "models_list":
      return text(deps.models());
    case "build_note": {
      const note = cleanNote(typeof args.text === "string" ? args.text : "");
      if (!note) return errorResult("Write the note in text.");
      if (TERMINAL_STATUSES.includes(status)) return errorResult("This build has finished, so it takes no more notes.");
      if (!(await deps.addNote(buildId, note))) return errorResult("This build has all the notes it can take. Keep working.");
      return text("The build's owner can see the note now.");
    }
  }
  throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
}

function buildServer(buildId: string, status: BuildStatus, deps: BuildMcpDeps): McpServer {
  const mcp = new McpServer(
    { name: "musemuse-build", title: "Muse Muse build tools", version: "1.0.0", description: "Meta's docs, the model catalog and the build room, for a Muse Muse build." },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: BUILD_MCP_TOOLS }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}, buildId, status, deps),
  );
  return mcp;
}

/**
 * MCP over streamable HTTP for one build, stateless: POST only, with "Authorization: Bearer <the build's token>".
 * A missing or wrong token is 401, and a token for a build that no longer exists is 404.
 */
export async function handleBuildMcp(req: Request, deps: BuildMcpDeps): Promise<Response> {
  if (req.method !== "POST") {
    return jsonRpcError(405, ErrorCode.ConnectionClosed, "This MCP server is stateless. Send JSON-RPC over POST.", { allow: "POST" });
  }
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const buildId = bearer ? buildIdFromToken(bearer, deps.secret()) : null;
  if (!buildId) {
    return jsonRpcError(401, ErrorCode.InvalidRequest, "This server takes the build's own token.", { "www-authenticate": "Bearer" });
  }
  const build = await deps.findBuild(buildId);
  if (!build) return jsonRpcError(404, ErrorCode.InvalidRequest, "That build doesn't exist.");

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

  const mcp = buildServer(buildId, build.status, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  try {
    return await transport.handleRequest(normalized, { parsedBody });
  } finally {
    await transport.close().catch(() => {});
    await mcp.close().catch(() => {});
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcp, type McpDeps, type McpProduct } from "@/lib/mcp/server";
import type { Manifest } from "@/lib/types";

const manifest: Manifest = {
  name: "Shelfie",
  slug: "shelfie",
  tagline: "Turns a photo of your shelf into a reading list",
  inspiration: "A photo of a cafe bookshelf",
  models: [{ id: "muse-spark-1.3", usedFor: "reading spines" }],
  actions: [
    {
      name: "list_books",
      description: "Lists the books in a shelf photo.",
      input: { type: "object", properties: { imageUrl: { type: "string" } }, required: ["imageUrl"] },
      output: { type: "object" },
    },
    { name: "count_words", description: "Counts words.", input: { properties: { text: { type: "string" } } }, output: {} },
    { name: "slow", description: "Never answers.", input: { type: "object" }, output: {} },
    { name: "broken", description: "Fails.", input: { type: "object" }, output: {} },
  ],
  fixtures: [],
  limits: [],
  estimatedCostPerRunUsd: 0.01,
};

const product: McpProduct = {
  slug: "shelfie",
  name: "Shelfie",
  tagline: "Turns a photo of your shelf into a reading list",
  status: "live",
  liveUrl: "https://musemuse-shelfie.vercel.app",
  manifest,
};

function fakeDeps(): McpDeps & { calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  return {
    calls,
    actionTimeoutMs: 200,
    findProduct: async (slug) => (slug === "shelfie" ? product : slug === "off" ? { ...product, status: "disabled" } : null),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, body });
      if (url.endsWith("/list_books")) return Response.json({ books: ["Dune", "Emma"], count: 2 });
      if (url.endsWith("/count_words")) return Response.json([String(body.text).split(/\s+/).length]);
      if (url.endsWith("/broken")) return new Response("kaboom", { status: 500 });
      // AbortSignal.timeout's timer is unref'd, so hold the event loop open like a real server would.
      const keepAlive = setTimeout(() => {}, 10_000);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal!.reason);
        });
      });
    }) as typeof fetch,
  };
}

const URL_BASE = "https://platform.example/api/mcp";
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function rpc(deps: McpDeps, slug: string, message: unknown, headers: Record<string, string> = HEADERS) {
  const res = await handleMcp(
    new Request(`${URL_BASE}/${slug}`, { method: "POST", headers, body: JSON.stringify(message) }),
    slug,
    deps,
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

test("initialize: server info and instructions say built with Muse Muse, not an official Meta product", async () => {
  const deps = fakeDeps();
  const res = await rpc(deps, "shelfie", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("mcp-session-id"), null, "stateless");
  const result = res.body.result;
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.equal(result.serverInfo.name, "musemuse-shelfie");
  assert.match(result.serverInfo.title, /built with Muse Muse/);
  assert.ok(result.capabilities.tools);
  assert.match(result.instructions, /built with Muse Muse/);
  assert.match(result.instructions, /not an official Meta product/);
  assert.ok(!/\u2014/.test(result.instructions + result.serverInfo.title + result.serverInfo.description), "no em dashes");
});

test("notifications/initialized -> 202", async () => {
  const res = await rpc(fakeDeps(), "shelfie", { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
});

test("tools/list: one tool per manifest action with inputSchema = action.input", async () => {
  const res = await rpc(fakeDeps(), "shelfie", { jsonrpc: "2.0", id: 2, method: "tools/list" }, {
    ...HEADERS,
    "mcp-protocol-version": "2025-06-18",
  });
  const tools = res.body.result.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  assert.deepEqual(tools.map((t) => t.name), ["list_books", "count_words", "slow", "broken"]);
  assert.deepEqual(tools[0].inputSchema, manifest.actions[0].input);
  assert.equal(tools[0].description, "Lists the books in a shelf photo.");
  assert.equal(tools[1].inputSchema.type, "object", "schemas without a type get type object");
});

test("tools/call: POSTs JSON to the live product and returns text plus structuredContent", async () => {
  const deps = fakeDeps();
  const res = await rpc(deps, "shelfie", {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_books", arguments: { imageUrl: "https://x/y.jpg" } },
  });
  assert.deepEqual(deps.calls[0], { url: "https://musemuse-shelfie.vercel.app/api/actions/list_books", body: { imageUrl: "https://x/y.jpg" } });
  const result = res.body.result;
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { books: ["Dune", "Emma"], count: 2 });
  assert.deepEqual(result.structuredContent, { books: ["Dune", "Emma"], count: 2 });

  const arr = await rpc(deps, "shelfie", {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "count_words", arguments: { text: "one two three" } },
  });
  assert.equal(arr.body.result.content[0].text, "[3]");
  assert.equal(arr.body.result.structuredContent, undefined, "arrays are not structuredContent");
});

test("tools/call errors become isError results; unknown tools are JSON-RPC errors", async () => {
  const deps = fakeDeps();
  const broken = await rpc(deps, "shelfie", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "broken", arguments: {} } });
  assert.equal(broken.body.result.isError, true);
  assert.match(broken.body.result.content[0].text, /HTTP 500: kaboom/);

  const slow = await rpc(deps, "shelfie", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "slow", arguments: {} } });
  assert.equal(slow.body.result.isError, true);
  assert.match(slow.body.result.content[0].text, /longer than/);

  const unknown = await rpc(deps, "shelfie", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(unknown.body.error.code, -32602);
});

test("ping, lenient Accept, 404 for unknown or disabled products, 405 for GET", async () => {
  const deps = fakeDeps();
  const ping = await rpc(deps, "shelfie", { jsonrpc: "2.0", id: 8, method: "ping" }, { "content-type": "application/json" });
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.body.result, {});

  assert.equal((await rpc(deps, "missing", { jsonrpc: "2.0", id: 9, method: "ping" })).status, 404);
  assert.equal((await rpc(deps, "off", { jsonrpc: "2.0", id: 10, method: "ping" })).status, 404);
  const get = await handleMcp(new Request(`${URL_BASE}/shelfie`), "shelfie", deps);
  assert.equal(get.status, 405);
  assert.equal((await rpc(deps, "shelfie", "{bad" as unknown)).status, 400);
});

test("the SDK's own MCP client can connect, list and call through the handler", async () => {
  const deps = fakeDeps();
  const client = new Client({ name: "muse-app-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${URL_BASE}/shelfie`), {
    fetch: async (input, init) => handleMcp(new Request(input, init), "shelfie", deps),
  });
  await client.connect(transport);
  assert.match(client.getInstructions() ?? "", /not an official Meta product/);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 4);
  const result = await client.callTool({ name: "list_books", arguments: { imageUrl: "https://x/y.jpg" } });
  assert.deepEqual(result.structuredContent, { books: ["Dune", "Emma"], count: 2 });
  await client.close();
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_LIMITS } from "@/lib/gateway/policy";
import { actionUrl, handleMcp, MAX_ACTION_REPLY_BYTES, toolsFor, type McpDeps, type McpProduct } from "@/lib/mcp/server";
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

test("actionUrl: https liveUrl origin only, and the name can't leave /api/actions/", () => {
  assert.equal(actionUrl("https://musemuse-shelfie.vercel.app/", "list_books")?.href, "https://musemuse-shelfie.vercel.app/api/actions/list_books");
  assert.equal(actionUrl("https://musemuse-shelfie.vercel.app/some/path", "a b")?.href, "https://musemuse-shelfie.vercel.app/api/actions/a%20b");
  for (const [live, name] of [
    ["http://musemuse-shelfie.vercel.app", "x"],
    ["https://user:pw@musemuse-shelfie.vercel.app", "x"],
    ["not a url", "x"],
    [null, "x"],
    ["https://musemuse-shelfie.vercel.app", ".."],
    ["https://musemuse-shelfie.vercel.app", "."],
  ] as const) {
    assert.equal(actionUrl(live, name), null, `${live} ${name}`);
  }
});

test("tools/call: redirects aren't followed, replies over 1 MB are refused", async () => {
  const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const deps: McpDeps = {
    findProduct: async () => product,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), redirect: init?.redirect });
      const url = String(input);
      if (url.endsWith("/list_books")) {
        return new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest/meta-data" } });
      }
      if (url.endsWith("/count_words")) {
        // A big reply with no content-length, sent in chunks.
        let sent = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent++ > 40) return controller.close();
              controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
            },
          }),
        );
      }
      return new Response("x", { headers: { "content-length": String(2 * MAX_ACTION_REPLY_BYTES) } });
    }) as typeof fetch,
  };
  const call = (name: string, id: number) =>
    rpc(deps, "shelfie", { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

  const redirected = await call("list_books", 11);
  assert.equal(redirected.body.result.isError, true);
  assert.match(redirected.body.result.content[0].text, /redirect \(HTTP 307\)/);
  assert.equal(seen.length, 1, "the Location is never requested");
  assert.equal(seen[0].redirect, "manual");

  const streamed = await call("count_words", 12);
  assert.equal(streamed.body.result.isError, true);
  assert.match(streamed.body.result.content[0].text, /more than 1 MB/);
  const declared = await call("slow", 13);
  assert.match(declared.body.result.content[0].text, /more than 1 MB/);
});

test("tools/call: a product whose liveUrl isn't https gets an error, not a request", async () => {
  const deps = fakeDeps();
  const insecure: McpProduct = { ...product, liveUrl: "http://musemuse-shelfie.vercel.app" };
  const res = await handleMcp(
    new Request(`${URL_BASE}/shelfie`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "list_books", arguments: {} } }),
    }),
    "shelfie",
    { ...deps, findProduct: async () => insecure },
  );
  const body = JSON.parse(await res.text());
  assert.equal(body.result.isError, true);
  assert.equal(deps.calls.length, 0);
});

describe("agent products", () => {
  const agentProduct = (actions: Manifest["actions"]): McpProduct => ({
    slug: "scout",
    name: "Scout",
    tagline: "Finds things",
    status: "live",
    liveUrl: "https://scout.example",
    manifest: { ...manifest, actions },
  });
  const action = (name: string, extra: Partial<Manifest["actions"][number]> = {}): Manifest["actions"][number] => ({
    name,
    description: name,
    input: { type: "object" },
    output: { type: "object" },
    ...extra,
  });

  test("tools/list passes the manifest's annotations on in MCP's words", () => {
    const [both, one, none] = toolsFor(
      agentProduct([
        action("find", { annotations: { readOnly: true, openWorld: true } }),
        action("draft", { annotations: { readOnly: false } }),
        action("plain"),
      ]),
    );
    assert.deepEqual(both.annotations, { readOnlyHint: true, openWorldHint: true });
    assert.deepEqual(one.annotations, { readOnlyHint: false });
    assert.equal("annotations" in none, false, "an action without annotations keeps today's entry");
  });

  test("an owner's action is neither listed nor callable, since connector callers are anonymous", async () => {
    const product = agentProduct([action("find", { who: "anyone" }), action("send_mail", { who: "owner" })]);
    assert.deepEqual(toolsFor(product).map((t) => t.name), ["find"]);
    const deps: McpDeps = {
      findProduct: async () => product,
      fetch: (async () => assert.fail("the product should never be called")) as typeof fetch,
    };
    const res = await rpc(deps, "scout", { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "send_mail", arguments: {} } });
    assert.match(JSON.stringify(res.body), /Unknown tool: send_mail/);
  });

  test("the connector waits longer than an agent action's own 100 s budget", () => {
    assert.ok(DEFAULT_LIMITS.mcpActionTimeoutMs >= 100_000 + 15_000);
  });
});

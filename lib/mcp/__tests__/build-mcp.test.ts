/**
 * Unit tests for the build MCP server (lib/mcp/build-mcp.ts): the per-build token (lib/mcp/build-token.ts), its tools
 * over the handler with fake deps, the SDK's own client through it, and the docs tools on the real mirror.
 *   npx tsx --test lib/mcp/__tests__/build-mcp.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DOCS_PAGES, docsMarkdown, docsNav, docsPage } from "@/lib/docs/pages";
import { buildSearchIndex, searchDocs } from "@/lib/docs/search";
import { BUILD_MCP_TOOLS, cleanNote, docsSection, docsTarget, handleBuildMcp, MAX_DOC_CHARS, type BuildMcpDeps } from "@/lib/mcp/build-mcp";
import { buildIdFromToken, buildMcpToken } from "@/lib/mcp/build-token";
import type { BuildStatus } from "@/lib/types";

const SECRET = "test-pepper-0123456789";
const BUILD = "3f2a9c1e-77b0-4d2e-9f00-0123456789ab";
const OTHER = "9b1d0c3e-0000-4000-8000-000000000000";
const URL_BASE = "https://platform.example/api/build-mcp";

const PAGE = ["# Tool calling {#tool-calling}", "", "Intro.", "", "## Defining tools {#defining-tools}", "", "Use a schema.", "", "### Custom tools {#custom-tools}", "", "Custom.", "", "## Function name rules {#function-name-rules}", "", "Names."].join("\n");

function fakeDeps(status: BuildStatus = "building") {
  const notes: string[] = [];
  const deps: BuildMcpDeps & { notes: string[] } = {
    notes,
    secret: () => SECRET,
    findBuild: async (id) => (id === BUILD ? { status } : id === OTHER ? null : null),
    addNote: async (_id, text) => {
      if (notes.length >= 2) return false;
      notes.push(text);
      return true;
    },
    searchDocs: (query, limit) =>
      query.includes("tool")
        ? [
            { slug: "tool-calling", title: "Tool calling", context: "Capabilities", description: "Let models call your functions." },
            { slug: "tool-calling", anchor: "custom-tools", title: "Custom tools", context: "Capabilities · Tool calling" },
          ].slice(0, limit)
        : [],
    readDoc: (slug) => (slug === "tool-calling" ? { title: "Tool calling", markdown: PAGE } : slug === "huge" ? { title: "Huge", markdown: "x".repeat(MAX_DOC_CHARS + 10) } : null),
    models: () => "Models a product may call, all through the Muse Muse gateway (prices are estimates):\n- muse-wonder-1.0: ...",
  };
  return deps;
}

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const auth = (buildId = BUILD) => ({ ...HEADERS, authorization: `Bearer ${buildMcpToken(buildId, SECRET)}` });

async function rpc(deps: BuildMcpDeps, message: unknown, headers: Record<string, string> = auth()) {
  const res = await handleBuildMcp(new Request(URL_BASE, { method: "POST", headers, body: JSON.stringify(message) }), deps);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function callTool(deps: BuildMcpDeps, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(deps, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { ...auth(), "mcp-protocol-version": "2025-06-18" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
}

describe("the build token", () => {
  it("names its build, and only with the platform's secret", () => {
    const token = buildMcpToken(BUILD, SECRET);
    assert.match(token, /^mm_build_mcp\.3f2a9c1e-77b0-4d2e-9f00-0123456789ab\.[0-9a-f]{64}$/);
    assert.equal(buildIdFromToken(token, SECRET), BUILD);
    assert.equal(buildIdFromToken(` ${token} `, SECRET), BUILD);
    assert.equal(buildIdFromToken(token, "another-secret"), null);
    // Another build's id with this build's MAC.
    assert.equal(buildIdFromToken(token.replace(BUILD, OTHER), SECRET), null);
    for (const bad of ["", "mm_build_mcp", `mm_build_mcp.${BUILD}`, `${token}.x`, token.slice(0, -1), token.replace("mm_build_mcp", "mm_other"), `mm_build_mcp.not-a-uuid.${"0".repeat(64)}`]) {
      assert.equal(buildIdFromToken(bad, SECRET), null, bad);
    }
  });
});

describe("the build MCP endpoint", () => {
  it("refuses requests without the build's token, for another build, and anything but POST", async () => {
    const deps = fakeDeps();
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const none = await rpc(deps, ping, HEADERS);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), "Bearer");
    assert.equal((await rpc(deps, ping, { ...HEADERS, authorization: `Bearer ${buildMcpToken(BUILD, "wrong")}` })).status, 401);
    assert.equal((await rpc(deps, ping, { ...HEADERS, authorization: `Basic ${buildMcpToken(BUILD, SECRET)}` })).status, 401);
    assert.equal((await rpc(deps, ping, auth(OTHER))).status, 404);
    assert.equal((await rpc(deps, ping)).status, 200);
    assert.equal((await handleBuildMcp(new Request(URL_BASE, { headers: auth() }), deps)).status, 405);
    const bad = await handleBuildMcp(new Request(URL_BASE, { method: "POST", headers: auth(), body: "{bad" }), deps);
    assert.equal(bad.status, 400);
  });

  it("lists its four tools, the reading ones marked read-only", async () => {
    const res = await rpc(fakeDeps(), { jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...auth(), "mcp-protocol-version": "2025-06-18" });
    const tools = res.body.result.tools as typeof BUILD_MCP_TOOLS;
    assert.deepEqual(tools.map((t) => t.name), ["docs_search", "docs_read", "models_list", "build_note"]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, t.name !== "build_note", t.name);
    assert.equal(tools.find((t) => t.name === "build_note")!.annotations?.destructiveHint, false);
    const words = JSON.stringify(tools);
    assert.ok(!words.includes("—"), "no em dashes");
  });

  it("searches the docs and reads a page, or one section of it", async () => {
    const deps = fakeDeps();
    const found = await callTool(deps, "docs_search", { query: "tool calling", limit: 5 });
    assert.equal(found.content[0]!.text, "- Tool calling (Capabilities): docs_read slug tool-calling. Let models call your functions.\n- Custom tools (Capabilities · Tool calling): docs_read slug tool-calling, section custom-tools");
    assert.equal((found.structuredContent!.hits as unknown[]).length, 2);
    assert.match((await callTool(deps, "docs_search", { query: "xyz" })).content[0]!.text, /^Nothing in Meta's docs matched "xyz"/);
    assert.equal((await callTool(deps, "docs_search", { query: " " })).isError, true);

    assert.equal((await callTool(deps, "docs_read", { slug: "tool-calling" })).content[0]!.text, PAGE);
    const section = (await callTool(deps, "docs_read", { slug: "https://dev.meta.ai/docs/tool-calling#defining-tools" })).content[0]!.text;
    assert.equal(section, "## Defining tools {#defining-tools}\n\nUse a schema.\n\n### Custom tools {#custom-tools}\n\nCustom.");
    assert.equal((await callTool(deps, "docs_read", { slug: "/docs/tool-calling", section: "custom-tools" })).content[0]!.text, "### Custom tools {#custom-tools}\n\nCustom.");
    assert.equal((await callTool(deps, "docs_read", { slug: "tool-calling", section: "nope" })).isError, true);
    assert.match((await callTool(deps, "docs_read", { slug: "missing" })).content[0]!.text, /no page "missing"/);
    const huge = (await callTool(deps, "docs_read", { slug: "huge" })).content[0]!.text;
    assert.ok(huge.length < MAX_DOC_CHARS + 200);
    assert.match(huge, /Read it a section at a time/);
  });

  it("lists the models a product may call", async () => {
    assert.match((await callTool(fakeDeps(), "models_list")).content[0]!.text, /^Models a product may call/);
  });

  it("adds a plain note to the build room, until the build has finished or has its fill", async () => {
    const deps = fakeDeps();
    const ok = await callTool(deps, "build_note", { text: "Upload screen works — next: the results\nlist." });
    assert.equal(ok.isError, undefined);
    assert.deepEqual(deps.notes, ["Upload screen works, next: the results list."]);
    await callTool(deps, "build_note", { text: "Second." });
    assert.match((await callTool(deps, "build_note", { text: "Third." })).content[0]!.text, /all the notes it can take/);
    assert.equal((await callTool(deps, "build_note", { text: "  " })).isError, true);
    const done = fakeDeps("live");
    assert.match((await callTool(done, "build_note", { text: "Late." })).content[0]!.text, /has finished/);
    assert.deepEqual(done.notes, []);
    assert.equal(cleanNote("x".repeat(700)).length, 600);
  });

  it("works with the SDK's own MCP client, carrying the token", async () => {
    const deps = fakeDeps();
    const client = new Client({ name: "muse-code-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(URL_BASE), {
      requestInit: { headers: { authorization: `Bearer ${buildMcpToken(BUILD, SECRET)}` } },
      fetch: async (input, init) => handleBuildMcp(new Request(input, init), deps),
    });
    await client.connect(transport);
    assert.match(client.getInstructions() ?? "", /Muse Muse platform/);
    assert.equal((await client.listTools()).tools.length, 4);
    const result = await client.callTool({ name: "models_list", arguments: {} });
    assert.match(String((result.content as Array<{ text: string }>)[0]!.text), /Models a product may call/);
    await client.close();
  });
});

describe("the docs tools on the real mirror", () => {
  const index = buildSearchIndex({ pages: DOCS_PAGES, nav: docsNav(), markdown: docsMarkdown });

  it("finds tool calling and reads its sections by anchor", () => {
    const hits = searchDocs(index, "tool calling", 5);
    assert.ok(hits.some((h) => h.href === "/docs/tool-calling"), JSON.stringify(hits.map((h) => h.href)));
    const page = docsPage("tool-calling")!;
    const section = docsSection(docsMarkdown(page.slug), "function-name-rules");
    assert.ok(section?.startsWith("## Function name rules {#function-name-rules}"));
    assert.ok(!section?.includes("{#responses-api-tool-calling}"), "stops at the next section");
  });

  it("takes a slug in any of the forms Muse Code may have it", () => {
    assert.deepEqual(docsTarget("tool-calling"), { slug: "tool-calling", anchor: null });
    assert.deepEqual(docsTarget("/docs/muse-code/hooks#matchers"), { slug: "muse-code/hooks", anchor: "matchers" });
    assert.deepEqual(docsTarget("https://dev.meta.ai/docs/tool-calling.md"), { slug: "tool-calling", anchor: null });
  });
});

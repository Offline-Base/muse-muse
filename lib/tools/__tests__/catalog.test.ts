import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DENIED_TOOLKITS,
  denialOfSlug,
  denialOfToolkit,
  TOOL_POLICIES,
  TOOLKIT_PINS,
  type FunctionPolicy,
  type ToolPolicy,
} from "@/lib/tools/catalog.source";
import {
  buildCatalog,
  CatalogRefusal,
  clip,
  functionNameProblem,
  listPriceUsd,
  MAX_DESCRIPTION_CHARS,
  MAX_FUNCTION_CHARS,
  MAX_PARAM_DESCRIPTION_CHARS,
  stableJson,
  type Catalog,
  type JsonSchema,
  type RemoteTool,
  type SyncDeps,
} from "@/lib/tools/composio/sync";

const FILE = path.join(process.cwd(), "lib/tools/composio/catalog.json");
const text = readFileSync(FILE, "utf8");
const catalog = JSON.parse(text) as Catalog;
const allFunctions = catalog.tools.flatMap((t) => t.functions.map((f) => ({ tool: t, fn: f })));

const INSTANT_PRICE = { description: "$0.008 per web search.", discount: "37" };

/** What Composio really answers for EXA_SEARCH: Instant-supported, priced and not destructive. */
const exaSearchReply: RemoteTool = {
  slug: "EXA_SEARCH",
  version: "20261030_00",
  toolkit: { slug: "exa" },
  description: "Search the web.",
  input_parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  tags: ["important", "openWorldHint", "createHint"],
  instant: { supported: true, price: { description: "$0.007 per search", discount: "0" } },
};

const remoteTool = (slug: string, over: Partial<RemoteTool> = {}): RemoteTool => ({
  slug,
  version: "20261030_00",
  toolkit: { slug: "tavily" },
  description: "A tool.",
  input_parameters: {
    type: "object",
    title: "Request",
    properties: { query: { type: "string", title: "Query", examples: ["a"], description: "What to search for." }, secret_mode: { type: "boolean" } },
    required: ["query"],
  },
  tags: ["readOnlyHint", "openWorldHint"],
  instant: { supported: true, price: INSTANT_PRICE },
  ...over,
});

const fn = (slug: string, over: Partial<FunctionPolicy> = {}): FunctionPolicy => ({
  slug,
  description: "Searches.",
  keepParams: ["query"],
  sample: { results: [] },
  ...over,
});

const policy = (slug: string, over: Partial<ToolPolicy> = {}, fnOver: Partial<FunctionPolicy> = {}): ToolPolicy => ({
  id: "test_tool",
  label: "Test tool",
  stepTitle: "Testing",
  tier: "public",
  access: "read",
  toolkit: "tavily",
  functions: [fn(slug, fnOver)],
  ...over,
});

const PINS = { tavily: "20261030_00", exa: "20261030_00", gmail: "20261030_00" };

/** Fake Composio. It counts lookups so a test can prove a denied tool never reached it. */
const fakeDeps = (reply: (slug: string, version?: string) => RemoteTool, categories: string[] = ["web search & research"]) => {
  const calls: string[] = [];
  const deps: SyncDeps = {
    fetchTool: async (slug, version) => {
      calls.push(slug);
      return reply(slug, version);
    },
    fetchToolkit: async (slug) => ({ slug, categories }),
  };
  return { deps, calls };
};

const refused = async (policies: ToolPolicy[], pins: Record<string, string>, deps: SyncDeps, pattern: RegExp) => {
  await assert.rejects(buildCatalog(policies, pins, deps), (error: unknown) => {
    assert.ok(error instanceof CatalogRefusal, String(error));
    assert.match(error.message, pattern);
    return true;
  });
};

test("the sync refuses EXA_SEARCH although Composio lists it as Instant-supported, and never looks it up", async () => {
  const { deps, calls } = fakeDeps(() => exaSearchReply);
  await refused([policy("EXA_SEARCH", { toolkit: "exa" })], PINS, deps, /denylist/);
  assert.equal(calls.length, 0);
});

test("the sync refuses EXA_SEARCH by slug even if a policy files it under an allowed toolkit", async () => {
  const { deps, calls } = fakeDeps(() => exaSearchReply);
  await refused([policy("EXA_SEARCH")], PINS, deps, /EXA_SEARCH is on the denylist/);
  assert.equal(calls.length, 0);
});

test("the sync refuses a harmless-looking slug that turns out to live in the Exa toolkit", async () => {
  const { deps } = fakeDeps((slug) => ({ ...exaSearchReply, slug }));
  await refused([policy("WEB_LOOKUP")], PINS, deps, /belongs to exa/);
});

test("the sync refuses a tool whose description says Exa is behind it", async () => {
  const { deps } = fakeDeps((slug) => remoteTool(slug, { description: "Neural search powered by Exa." }));
  await refused([policy("WEB_LOOKUP")], PINS, deps, /mentions Exa/);
});

for (const slug of [
  "EXA_SEARCH",
  "EXA_ANSWER",
  "EXA_GET_CONTENTS_ACTION",
  "EXA_CREATE_WEBSET",
  "METAPHOR_SEARCH",
  "COMPOSIO_SEARCH_WEB",
  "COMPOSIO_SEARCH_FETCH_URL_CONTENT",
  "COMPOSIO_SEARCH_EXA_ANSWER",
  "COMPOSIO_SEARCH_EXA_SIMILARLINK",
  "COMPOSIO_SEARCH_GROQ_CHAT",
  "COMPOSIO_SEARCH_TAVILY",
  "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_SEARCH_TOOLS",
  "SOME_TOOLKIT_PROXY_EXECUTE",
  "FIRECRAWL_DEEP_RESEARCH",
  "FIRECRAWL_SEARCH_PEOPLE_APOLLO",
  "FIRECRAWL_LIST_INTERACT_SESSIONS",
  "GMAIL_SEND_DRAFT",
  "GMAIL_DELETE_DRAFT",
]) {
  test(`denied slug: ${slug}`, () => assert.ok(denialOfSlug(slug)));
}

for (const toolkit of [
  ...DENIED_TOOLKITS,
  "EXA",
  "exa_mcp",
  "openai_assistants",
  "stripe_connect",
  "browser_anything",
]) {
  test(`denied toolkit: ${toolkit}`, () => assert.ok(denialOfToolkit(toolkit)));
}

test("the denylist doesn't catch the toolkits and tools the catalog needs", () => {
  for (const { tool, fn: f } of allFunctions) {
    assert.equal(denialOfToolkit(tool.toolkit as string), null);
    assert.equal(denialOfSlug(f.name), null);
  }
  // A substring match on "exa" would catch these.
  for (const toolkit of ["texas_data", "hexagon", "examplify"]) assert.equal(denialOfToolkit(toolkit), null);
  for (const slug of ["TEXAS_SEARCH", "HEXAGON_LIST", "GET_EXAMPLES"]) assert.equal(denialOfSlug(slug), null);
});

test("the sync refuses a denied toolkit by Composio's category, for toolkits nobody listed", async () => {
  for (const category of ["Payment Processing", "payment-processing", "phone & sms", "ai models", "ai-models", "social media accounts", "social-media-marketing"]) {
    const { deps } = fakeDeps((slug) => remoteTool(slug), [category]);
    await refused([policy("TAVILY_SEARCH")], PINS, deps, /denied category/);
  }
});

test("the sync refuses destructiveHint at the latest version and at the pinned one", async () => {
  const atLatest = fakeDeps((slug, version) => remoteTool(slug, version ? {} : { tags: ["destructiveHint"] }));
  await refused([policy("TAVILY_SEARCH")], PINS, atLatest.deps, /destructiveHint at the latest/);
  const atPin = fakeDeps((slug, version) => remoteTool(slug, version ? { tags: ["destructiveHint"] } : {}));
  await refused([policy("TAVILY_SEARCH")], PINS, atPin.deps, /destructiveHint at version/);
});

test("the sync refuses a public tool without Instant support, or without a price", async () => {
  await refused([policy("TAVILY_SEARCH")], PINS, fakeDeps((s) => remoteTool(s, { instant: undefined })).deps, /isn't Instant-supported/);
  await refused([policy("TAVILY_SEARCH")], PINS, fakeDeps((s) => remoteTool(s, { instant: { supported: true } })).deps, /no usable Instant price/);
  await refused(
    [policy("TAVILY_SEARCH")],
    PINS,
    fakeDeps((s) => remoteTool(s, { instant: { supported: true, price: { description: "$0 per request", discount: "0" } } })).deps,
    /no usable Instant price/,
  );
});

test("Instant metadata is read from the latest version, because Composio leaves it off older ones", async () => {
  const { deps } = fakeDeps((slug, version) => remoteTool(slug, version ? { instant: undefined, version } : { version: "20261031_00" }));
  const { catalog: built, notes } = await buildCatalog([policy("TAVILY_SEARCH")], PINS, deps);
  assert.equal(built.tools[0].functions[0].instant, true);
  assert.equal(built.tools[0].functions[0].version, "20261030_00");
  assert.deepEqual(notes, ["TAVILY_SEARCH: pinned 20261030_00, latest 20261031_00"]);
});

test("the sync refuses a pin that the latest version has outgrown", async () => {
  const gone = fakeDeps((slug, version) =>
    remoteTool(slug, version ? { version } : { input_parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }),
  );
  await refused([policy("TAVILY_SEARCH")], PINS, gone.deps, /no longer has query/);
  const required = fakeDeps((slug, version) =>
    remoteTool(slug, version ? { version } : { input_parameters: { type: "object", properties: { query: {}, mode: {} }, required: ["query", "mode"] } }),
  );
  await refused([policy("TAVILY_SEARCH")], PINS, required.deps, /now requires mode/);
});

test("the sync refuses a deprecated tool, however Composio marks it", async () => {
  for (const over of [{ is_deprecated: true }, { deprecated: { is_deprecated: true } }, { tags: ["deprecated"] }]) {
    await refused([policy("TAVILY_SEARCH")], PINS, fakeDeps((s) => remoteTool(s, over)).deps, /deprecated/);
  }
});

test("a read tool carrying createHint needs a stated reason", async () => {
  const { deps } = fakeDeps((s) => remoteTool(s, { tags: ["createHint"] }));
  await refused([policy("TAVILY_SEARCH")], PINS, deps, /declared read/);
  const { catalog: built } = await buildCatalog([policy("TAVILY_SEARCH", {}, { readDespiteTags: "It only reads." })], PINS, deps);
  assert.deepEqual(built.tools[0].functions[0].hints, ["createHint"]);
});

test("the sync refuses bad function names and Meta's reserved names", async () => {
  const { deps } = fakeDeps((s) => remoteTool(s));
  for (const name of ["browser.search", "browser.open", "browser.find", "a.b.c", "has space", "BROWSER.OPEN"]) {
    assert.ok(functionNameProblem(name), name);
    await refused([policy(name)], PINS, deps, /pattern|dot|reserved|denylist/);
  }
});

test("the sync refuses a parameter that doesn't exist, and a required one that isn't kept", async () => {
  const { deps } = fakeDeps((s) => remoteTool(s));
  await refused([policy("TAVILY_SEARCH", {}, { keepParams: ["query", "nope"] })], PINS, deps, /no longer has nope/);
  await refused([policy("TAVILY_SEARCH", {}, { required: ["secret_mode"] })], PINS, deps, /isn't kept/);
  const needsMore = fakeDeps((s) =>
    remoteTool(s, { input_parameters: { type: "object", properties: { query: {}, mode: {} }, required: ["query", "mode"] } }),
  );
  await refused([policy("TAVILY_SEARCH")], PINS, needsMore.deps, /now requires mode/);
});

test("the sync refuses a schema too big to send, duplicates and a missing pin", async () => {
  const properties: JsonSchema = {};
  for (let i = 0; i < 60; i += 1) properties[`p${i}`] = { type: "string", description: "x".repeat(200) };
  const { deps } = fakeDeps((s) => remoteTool(s, { input_parameters: { type: "object", properties } }));
  await refused([policy("TAVILY_SEARCH", {}, { keepParams: Object.keys(properties) })], PINS, deps, /after trimming/);

  const plain = fakeDeps((s) => remoteTool(s)).deps;
  await refused([policy("TAVILY_SEARCH"), policy("TAVILY_SEARCH")], PINS, plain, /Duplicate tool id/);
  await refused([policy("TAVILY_SEARCH"), policy("TAVILY_SEARCH", { id: "other" })], PINS, plain, /appears in two tools/);
  await refused([policy("TAVILY_SEARCH")], {}, plain, /No pinned version/);
});

test("trimming drops titles, examples and other parameters, and clips long text", async () => {
  const { deps } = fakeDeps((s) =>
    remoteTool(s, {
      input_parameters: {
        type: "object",
        title: "Request",
        properties: {
          query: { type: "string", title: "Query", examples: ["a"], human_parameter_name: "Q", description: "y ".repeat(400), default: "z".repeat(100) },
          title: { type: "string", title: "A parameter called title" },
          secret_mode: { type: "boolean" },
        },
        required: ["query", "title"],
      },
    }),
  );
  const { catalog: built } = await buildCatalog([policy("TAVILY_SEARCH", {}, { keepParams: ["query", "title"] })], PINS, deps);
  const params = built.tools[0].functions[0].parameters as { properties: Record<string, JsonSchema>; additionalProperties: boolean; title?: string };
  assert.equal(params.title, undefined);
  assert.equal(params.additionalProperties, false);
  assert.deepEqual(Object.keys(params.properties).sort(), ["query", "title"]);
  assert.deepEqual(Object.keys(params.properties.query).sort(), ["description", "type"]);
  assert.ok((params.properties.query.description as string).length <= MAX_PARAM_DESCRIPTION_CHARS + 3);
  assert.deepEqual(params.properties.title, { type: "string" });
});

test("write tools say they need confirmation, and read tools don't", async () => {
  const { deps } = fakeDeps((s) => remoteTool(s, { toolkit: { slug: "gmail" }, instant: undefined, tags: ["createHint"] }));
  const { catalog: built } = await buildCatalog([policy("GMAIL_THING", { tier: "personal", access: "create", toolkit: "gmail" })], PINS, deps);
  assert.match(built.tools[0].functions[0].description, /Needs the user's confirmation before it runs\.$/);
  assert.equal(built.tools[0].functions[0].estimateUsd, 0);
  await refused(
    [policy("GMAIL_THING", { tier: "personal", access: "create", toolkit: "gmail" }, { description: "x ".repeat(300) })],
    PINS,
    deps,
    /too long to keep the confirmation/,
  );
});

test("the same inputs give the same bytes, whatever order Composio sends keys in", async () => {
  const forwards = fakeDeps((s) => remoteTool(s)).deps;
  const backwards = fakeDeps((s) => {
    const tool = remoteTool(s);
    const input = tool.input_parameters as JsonSchema;
    return Object.fromEntries(
      Object.entries({ ...tool, input_parameters: Object.fromEntries(Object.entries(input).reverse()) }).reverse(),
    ) as unknown as RemoteTool;
  }).deps;
  const a = await buildCatalog([policy("TAVILY_SEARCH")], PINS, forwards);
  const b = await buildCatalog([policy("TAVILY_SEARCH")], PINS, backwards);
  assert.equal(stableJson(a.catalog), stableJson(b.catalog));
  assert.ok(!/generated|timestamp/i.test(stableJson(a.catalog)));
});

test("price and clip helpers", () => {
  assert.equal(listPriceUsd("$0.008 per web search."), 0.008);
  assert.equal(listPriceUsd("$0.025 per successful search"), 0.025);
  assert.equal(listPriceUsd("about a cent"), null);
  assert.equal(listPriceUsd(undefined), null);
  assert.equal(clip("short — and   spaced", 100), "short - and spaced");
  assert.equal(clip(`${"a".repeat(60)}. ${"b".repeat(60)}`, 80), `${"a".repeat(60)}.`);
});

// The committed file.

test("the committed catalog is byte-stable", () => {
  assert.equal(stableJson(catalog), text);
});

test("the committed catalog has exactly the planned ids", () => {
  assert.deepEqual(
    catalog.tools.map((t) => t.id),
    ["web_search", "scholar", "places", "events", "read_page", "gmail_read", "gmail_draft", "gmail_send", "calendar_read", "calendar_add", "slack_read", "slack_search", "slack_send"],
  );
  assert.deepEqual(catalog.instantToolkits, ["firecrawl", "serpapi"]);
  assert.deepEqual(catalog.personalToolkits, ["gmail", "googlecalendar", "slack"]);
});

test("the committed catalog holds nothing from the denylist, and no trace of Exa", () => {
  for (const tool of catalog.tools) {
    if (tool.toolkit) assert.equal(denialOfToolkit(tool.toolkit), null, tool.id);
    for (const f of tool.functions) assert.equal(denialOfSlug(f.name), null, f.name);
  }
  assert.ok(!/\bexa\b/i.test(text.replace(/example/gi, "")), "Exa appears in the catalog");
  assert.ok(!/EXA_|COMPOSIO_SEARCH|COMPOSIO_REMOTE|WORKBENCH|PROXY/.test(text));
  assert.ok(!catalog.instantToolkits.includes("exa"));
});

test("no committed tool has destructiveHint, and each read tool with a write tag states why", () => {
  const policies = new Map(TOOL_POLICIES.flatMap((p) => p.functions.map((f) => [f.slug, f] as const)));
  for (const { tool, fn: f } of allFunctions) {
    assert.ok(!f.hints.includes("destructiveHint"), f.name);
    if (tool.access === "read" && (f.hints.includes("createHint") || f.hints.includes("updateHint"))) {
      assert.ok(policies.get(f.name)?.readDespiteTags, f.name);
    }
  }
});

test("every committed name passes Meta's rules and avoids the reserved names", () => {
  assert.equal(allFunctions.length, 14);
  for (const { fn: f } of allFunctions) {
    assert.equal(functionNameProblem(f.name), null, f.name);
    assert.match(f.name, /^[a-zA-Z0-9_.-]+$/);
    assert.ok(f.name.split(".").length <= 2, f.name);
    assert.ok(!["browser.search", "browser.open", "browser.find"].includes(f.name.toLowerCase()), f.name);
  }
  const names = allFunctions.map(({ fn: f }) => f.name);
  assert.equal(new Set(names).size, names.length);
});

test("every committed function is the planned shape and within the size limits", () => {
  for (const { tool, fn: f } of allFunctions) {
    assert.equal(f.type, "function");
    assert.equal(f.strict, false);
    assert.ok(f.description.length <= MAX_DESCRIPTION_CHARS, f.name);
    assert.ok(JSON.stringify({ name: f.name, description: f.description, parameters: f.parameters }).length <= MAX_FUNCTION_CHARS, f.name);
    assert.equal(f.version, catalog.toolkitVersions[tool.toolkit as string], f.name);
    assert.equal(f.parameters.additionalProperties, false, f.name);
    const body = JSON.stringify(f.parameters);
    assert.ok(!/"(title|examples|human_parameter_name|file_uploadable)":/.test(body), `${f.name} still has schema noise`);
    const props = f.parameters.properties as Record<string, JsonSchema>;
    for (const [name, prop] of Object.entries(props)) {
      assert.ok(((prop.description as string) ?? "").length <= MAX_PARAM_DESCRIPTION_CHARS + 3, `${f.name}.${name}`);
    }
    if (tool.access === "read") assert.ok(!f.description.includes("confirmation"), f.name);
    else assert.ok(f.description.endsWith("Needs the user's confirmation before it runs."), f.name);
  }
});

test("public tools are Instant with a price, and personal ones aren't charged by the catalog", () => {
  for (const { tool, fn: f } of allFunctions) {
    if (tool.tier === "public") {
      assert.equal(f.instant, true, f.name);
      assert.ok(f.estimateUsd > 0 && f.estimateUsd < 0.1, f.name);
      assert.ok(f.priceText, f.name);
    } else {
      assert.equal(f.instant, false, f.name);
      assert.equal(f.estimateUsd, 0, f.name);
    }
  }
});

test("the parameters that make a tool dangerous or dear stay out", () => {
  const paramsOf = (name: string) => {
    const found = allFunctions.find(({ fn: f }) => f.name === name);
    assert.ok(found, name);
    return Object.keys(found.fn.parameters.properties as JsonSchema);
  };
  const absent = (name: string, ...banned: string[]) => {
    for (const param of banned) assert.ok(!paramsOf(name).includes(param), `${name}.${param}`);
  };
  absent("FIRECRAWL_SCRAPE", "actions", "jsonOptions", "formats", "location");
  absent("GMAIL_SEND_EMAIL", "to", "attachment", "from_email", "user_id");
  absent("GMAIL_CREATE_EMAIL_DRAFT", "to", "attachment", "user_id");
  absent("GMAIL_FETCH_EMAILS", "user_id", "include_spam_trash");
  absent("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", "user_id");
  absent("GOOGLECALENDAR_CREATE_EVENT", "calendar_id", "extended_properties", "recurrence", "visibility");
  absent("GOOGLECALENDAR_EVENTS_LIST", "calendarId", "syncToken", "showDeleted", "showHiddenInvitations");
  absent("SLACK_SEND_MESSAGE", "blocks", "fallback_text", "reply_broadcast", "channel_id", "unfurl_links", "unfurl_media");
  absent("SLACK_SEARCH_MESSAGES", "auto_paginate", "team_id", "cursor", "highlight");
  absent("SLACK_FIND_CHANNELS", "team_id", "types");
  absent("SLACK_FETCH_CONVERSATION_HISTORY", "include_all_metadata", "inclusive");
});

test("tools that contact people name their recipient fields, and those fields are in the schema", () => {
  const expected: Record<string, string[]> = {
    gmail_draft: ["recipient_email", "extra_recipients", "cc", "bcc"],
    gmail_send: ["recipient_email", "extra_recipients", "cc", "bcc"],
    calendar_add: ["attendees"],
    slack_send: ["channel"],
  };
  for (const tool of catalog.tools) {
    assert.deepEqual(tool.recipientFields, expected[tool.id] ?? [], tool.id);
    for (const f of tool.functions) {
      const props = f.parameters.properties as Record<string, JsonSchema>;
      for (const field of tool.recipientFields) assert.ok(field in props, `${f.name}.${field}`);
    }
  }
  const attendees = allFunctions.find(({ fn: f }) => f.name === "GOOGLECALENDAR_CREATE_EVENT")?.fn.parameters.properties as Record<string, JsonSchema>;
  assert.deepEqual(attendees.attendees.items, { type: "string" });
});

test("Slack is owner-only, its one write needs confirmation and a daily cap, and nothing else is exposed", () => {
  const slack = catalog.tools.filter((t) => t.toolkit === "slack");
  assert.deepEqual(
    slack.flatMap((t) => t.functions.map((f) => f.name)).sort(),
    ["SLACK_FETCH_CONVERSATION_HISTORY", "SLACK_FIND_CHANNELS", "SLACK_SEARCH_MESSAGES", "SLACK_SEND_MESSAGE"],
  );
  for (const tool of slack) {
    assert.equal(tool.tier, "personal", tool.id);
    assert.ok(tool.functions.every((f) => !f.instant), tool.id);
  }
  const send = slack.find((t) => t.id === "slack_send");
  assert.equal(send?.access, "create");
  assert.equal(send?.perDay, 10);
  assert.match(send?.functions[0].description ?? "", /Needs the user's confirmation before it runs\.$/);
  assert.equal(slack.find((t) => t.id === "slack_read")?.access, "read");
  assert.equal(slack.find((t) => t.id === "slack_search")?.access, "read");
});

test("Slack tools that delete or change the workspace are denied by name", () => {
  for (const slug of [
    "SLACK_DELETE_A_COMMENT_ON_A_FILE",
    "SLACK_DELETES_A_MESSAGE_FROM_A_CHAT",
    "SLACK_REMOVE_A_USER_FROM_A_CONVERSATION",
    "SLACK_ARCHIVE_A_SLACK_CONVERSATION",
    "SLACK_RENAME_A_CONVERSATION",
    "SLACK_UPDATES_A_SLACK_MESSAGE",
    "SLACK_SET_THE_TOPIC_OF_A_CONVERSATION",
    "SLACK_INVITE_USERS_TO_A_SLACK_CHANNEL",
    "SLACK_ADMIN_SET_WORKSPACE_SETTINGS",
  ]) {
    assert.ok(denialOfSlug(slug), slug);
  }
});

test("both send tools have the same daily cap", () => {
  const capped = catalog.tools.filter((t) => t.perDay !== null);
  assert.deepEqual(capped.map((t) => [t.id, t.perDay]), [["gmail_send", 10], ["slack_send", 10]]);
});

test("descriptions only name tools in the catalog, and only parameters products can send", () => {
  const names = new Set(allFunctions.map(({ fn: f }) => f.name));
  for (const { fn: f } of allFunctions) {
    for (const mention of JSON.stringify([f.description, f.parameters]).match(/\b[A-Z]{3,}_[A-Z_]{3,}\b/g) ?? []) {
      assert.ok(names.has(mention), `${f.name} mentions ${mention}`);
    }
  }
  for (const policyEntry of TOOL_POLICIES) {
    assert.ok(!/browser action|LLM|attachment|include_raw_content|message_body/i.test(JSON.stringify(policyEntry.functions.map((f) => f.description))), policyEntry.id);
  }
  for (const { fn: f } of allFunctions) {
    assert.ok(!/include_raw_content|message_body|birthday|attachment/i.test(JSON.stringify(f.parameters)), f.name);
  }
});

test("samples only link to example.com, so a build's sources are obviously fake", () => {
  for (const { fn: f } of allFunctions) {
    assert.ok(f.sample && typeof f.sample === "object", f.name);
    const urls = JSON.stringify(f.sample).match(/https?:\/\/[^"\s)]+/g) ?? [];
    for (const url of urls) assert.equal(new URL(url).hostname, "example.com", `${f.name}: ${url}`);
    const emails = JSON.stringify(f.sample).match(/[\w.+-]+@[\w.-]+/g) ?? [];
    for (const email of emails) assert.ok(email.endsWith("@example.com"), `${f.name}: ${email}`);
  }
});

test("each sample fits the tool's own source and output rules", () => {
  const at = (root: unknown, dotted: string): unknown =>
    dotted.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as JsonSchema)[key] : undefined), root);
  for (const { tool, fn: f } of allFunctions) {
    for (const rule of tool.sources) {
      const found = at(f.sample, rule.path);
      assert.ok(found, `${f.name}: nothing at ${rule.path}`);
      const first = rule.single ? found : (found as unknown[])[0];
      assert.ok(at(first, rule.title), `${f.name}: no ${rule.title} at ${rule.path}`);
    }
    if (tool.output) assert.ok(tool.output.keep.some((p) => at(f.sample, p) !== undefined), `${f.name}: output keeps nothing`);
  }
});

test("output rules exist for every Composio tool, and strip SerpAPI's own links", () => {
  for (const tool of catalog.tools) {
    if (tool.builtin) continue;
    assert.ok(tool.output, tool.id);
    if (tool.toolkit === "serpapi") {
      assert.deepEqual(tool.output?.dropUrlHosts, ["serpapi.com"], tool.id);
      assert.ok(tool.output?.dropKeys.includes("serpapi_thumbnail"), tool.id);
    }
  }
  assert.ok(catalog.tools.filter((t) => t.tier === "public" && !t.builtin).every((t) => t.outputVerified));
  // Nothing personal has run, since no account is connected.
  assert.ok(catalog.tools.filter((t) => t.tier === "personal").every((t) => !t.outputVerified));
});

test("labels and descriptions have no em dashes", () => {
  assert.ok(!/[–—]/.test(text), "a dash slipped into the catalog");
});

test("the pins cover every toolkit in the policy, and the policy has no spare pins", () => {
  const used = new Set(TOOL_POLICIES.flatMap((p) => (p.toolkit ? [p.toolkit] : [])));
  assert.deepEqual([...used].sort(), Object.keys(TOOLKIT_PINS).sort());
  assert.deepEqual(catalog.toolkitVersions, Object.fromEntries(Object.entries(TOOLKIT_PINS).sort()));
});

test("web_search is the only general web search: no third-party search slipped in", () => {
  const generalSearch = /^(TAVILY_|SERPAPI_NEWS_SEARCH$|SERPAPI_SEARCH$|SERPAPI_GOOGLE_LIGHT_SEARCH$|SERPAPI_BING_|SERPAPI_DUCK_|FIRECRAWL_SEARCH|BRAVE_|PERPLEXITY)/;
  for (const { fn: f } of allFunctions) assert.ok(!generalSearch.test(f.name), f.name);
  assert.ok(!catalog.tools.some((t) => t.id === "web_results" || t.id === "news"));
  assert.ok(!catalog.instantToolkits.includes("tavily"));
  assert.ok(!("tavily" in TOOLKIT_PINS));
});

test("the third-party public tools say what they are only for", () => {
  const description = (id: string) => catalog.tools.find((t) => t.id === id)?.functions[0].description ?? "";
  for (const id of ["scholar", "places", "events"]) {
    assert.match(description(id), /^Get structured /, id);
    assert.match(description(id), /Use it only when you need those .* records\. For general questions, use web_search\./, id);
  }
  assert.match(description("read_page"), /an address the user gave you/);
  assert.match(description("read_page"), /Use it only for addresses from the user/);
});

test("web_search is built in, with no toolkit, functions or price of its own here", () => {
  const search = catalog.tools.find((t) => t.id === "web_search");
  assert.equal(search?.builtin, true);
  assert.equal(search?.toolkit, null);
  assert.deepEqual(search?.functions, []);
});

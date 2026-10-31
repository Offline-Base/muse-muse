import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderBuildPrompt, briefToMarkdown } from "@/lib/brief/render";
import { BriefSchema, newBriefSchemaFor, type Brief } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { applyTargets, targetProblems } from "@/lib/native/targets";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { briefInstructions } from "@/lib/prompts/brief";
import { catalogSummary } from "@/lib/prompts/catalog";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { PERSONAL_TOOL_IDS, PUBLIC_TOOL_IDS, TOOL_IDS } from "@/lib/tools/ids";

const FLAGS = ["AGENTS_ENABLED", "COMPOSIO_PERSONAL_ENABLED", "NATIVE_TARGETS", "VR_ENABLED", "GLASSES_ENABLED"];
const AGENT = { task: "Research a question and answer with links.", tools: [{ id: "web_search", need: "Look it up", why: "It is built in" }], connections: "none" as const, stepsPerRun: 4 };
const withAgent = (agent: unknown, targets: unknown = [{ id: "web", why: "Always" }, { id: "agent", why: "It looks things up" }]) => ({ ...BRIEF, targets, agent });
const tools = (schema: unknown) => (schema as { properties: { agent: { anyOf: Array<{ properties?: { tools: { items: { properties: { id: { enum: string[] } } } } } }> } } }).properties.agent.anyOf[0]!.properties!.tools.items.properties.id.enum;

beforeEach(() => {
  for (const f of FLAGS) delete process.env[f];
});
afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
});

describe("the agent option", () => {
  it("is something the writer can pick once AGENTS_ENABLED is on, with web search and the prices in its catalog", () => {
    process.env.AGENTS_ENABLED = "1";
    const catalog = catalogSummary();
    assert.match(catalog, /Agent tools, only for a product with the agent target/);
    assert.match(catalog, /- web_search: Meta's own web search[^\n]*\$0\.0025 per query\./);
    assert.match(catalog, /- scholar: [^\n]*\$0\.025 per call\./);
    assert.match(catalog, /- read_page: [^\n]*\$0\.003 per call\./);
    assert.match(catalog, /and the agent tools below when the brief picks the agent target/);
    assert.match(catalog, /A live run stops at 10 turns, 12 built-in tool calls or \$0\.75\./);
    assert.ok(catalog.indexOf("- web_search:") < catalog.indexOf("- scholar:"), "Meta's search comes first");
    const instructions = briefInstructions();
    assert.match(instructions, /- agent: an agent that works in several steps/);
    assert.match(instructions, /agent is null unless targets has agent/);
    assert.match(instructions, /a text fixture holding one realistic task/);
  });

  it("names no tool, and no agent, with AGENTS_ENABLED off", () => {
    assert.doesNotMatch(catalogSummary(), /web_search|agent/i);
    process.env.NATIVE_TARGETS = "phone";
    assert.doesNotMatch(catalogSummary(), /web_search/);
    assert.doesNotMatch(briefInstructions(), /agent is null/);
    assert.ok(!("agent" in strictProperties(newBriefSchemaFor({ gadgets: false, targets: ["phone"] }))));
  });

  it("offers personal tools only with their own flag, and says they're for the owner", () => {
    process.env.AGENTS_ENABLED = "1";
    assert.doesNotMatch(catalogSummary(), /gmail_read/);
    assert.deepEqual(tools(strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: ["agent"] }))), PUBLIC_TOOL_IDS);
    process.env.COMPOSIO_PERSONAL_ENABLED = "1";
    assert.match(catalogSummary(), /Personal tools work only for the product's owner for now/);
    for (const id of PERSONAL_TOOL_IDS) assert.match(catalogSummary(), new RegExp(`- ${id}: `));
    assert.deepEqual(tools(strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: ["agent"], personalTools: true }))), TOOL_IDS);
  });

  it("every tool in the list has its wording, and none of it says Exa or an em dash", () => {
    process.env.AGENTS_ENABLED = "1";
    process.env.COMPOSIO_PERSONAL_ENABLED = "1";
    const catalog = catalogSummary();
    for (const id of TOOL_IDS) assert.match(catalog, new RegExp(`- ${id}: \\S`));
    assert.doesNotMatch(catalog, /\bexa\b|—/i);
  });

  it("takes 1 to 6 tools and requires a task", () => {
    const schema = newBriefSchemaFor({ gadgets: false, targets: ["agent"] });
    assert.equal(schema.safeParse(withAgent(AGENT)).success, true);
    assert.equal(schema.safeParse(withAgent(null, [{ id: "web", why: "Always" }])).success, true);
    assert.equal(schema.safeParse(withAgent({ ...AGENT, tools: [] })).success, false);
    assert.equal(schema.safeParse(withAgent({ ...AGENT, task: "" })).success, false);
    const seven = Array.from({ length: 7 }, () => AGENT.tools[0]);
    assert.equal(schema.safeParse(withAgent({ ...AGENT, tools: seven })).success, false);
    assert.equal(schema.safeParse(withAgent({ ...AGENT, tools: [{ id: "gmail_read", need: "x", why: "y" }] })).success, false, "personal is off");
    assert.equal(schema.safeParse(withAgent({ ...AGENT, tools: [{ id: "exa_search", need: "x", why: "y" }] })).success, false);
  });

  it("a stored brief keeps a tool that later left the catalog, and an older brief has no agent", () => {
    assert.equal(BriefSchema.safeParse(withAgent({ ...AGENT, tools: [{ id: "retired_tool", need: "x", why: "y" }] })).success, true);
    assert.ok(!("agent" in BriefSchema.parse(BRIEF)));
  });

  it("removes duplicate tools before zod sees them, and cuts past six", () => {
    const raw = withAgent({ ...AGENT, tools: [...Array(3).fill(AGENT.tools[0]), ...["scholar", "places", "events", "read_page", "gmail_read", "slack_read"].map((id) => ({ id, need: "n", why: "w" }))] });
    const out = normalizeRawBrief(raw, []) as { agent: { tools: Array<{ id: string }> } };
    assert.deepEqual(out.agent.tools.map((t) => t.id), ["web_search", "scholar", "places", "events", "read_page", "gmail_read"]);
  });
});

describe("applyTargets on an agent", () => {
  const settle = (brief: Brief, personalTools = false, requested?: Brief["targets"]) =>
    applyTargets(brief, { enabled: ["agent"], personalTools, requested: requested?.map((t) => t.id) });

  it("adds Muse Wonder when the writer left it out", () => {
    const out = settle(withAgent(AGENT) as Brief);
    assert.equal(out.capabilities[0]?.model, "muse-wonder-1.0");
    assert.equal(out.capabilities.length, BRIEF.capabilities.length + 1);
    const again = settle(out);
    assert.equal(again.capabilities.length, out.capabilities.length, "only once");
  });

  it("forces owner connections when a personal tool is picked, and adds the honest limit", () => {
    const out = settle(withAgent({ ...AGENT, tools: [...AGENT.tools, { id: "gmail_read", need: "Read mail", why: "The job" }], connections: "none" }) as Brief, true);
    assert.equal(out.agent?.connections, "owner");
    assert.ok(out.limits.some((l) => l.startsWith("Only this app's owner can connect an account for now. That covers: Read Gmail.")));
    assert.equal(settle(out, true).limits.length, out.limits.length, "the limit isn't added twice");
  });

  it("doesn't add the owner limit when the writer already said it", () => {
    const said = "Only the product owner can use the Gmail tools, after connecting their own account.";
    const brief = { ...(withAgent({ ...AGENT, tools: [{ id: "gmail_read", need: "Read mail", why: "The job" }] }) as Brief), limits: [said] };
    assert.deepEqual(settle(brief, true).limits, [said]);
  });

  it("drops a tool whose flag is off, and leaves connections none with nothing to connect", () => {
    const out = settle(withAgent({ ...AGENT, tools: [...AGENT.tools, { id: "gmail_read", need: "Read mail", why: "The job" }], connections: "owner" }) as Brief, false);
    assert.deepEqual(out.agent?.tools.map((t) => t.id), ["web_search"]);
    assert.equal(out.agent?.connections, "none");
    assert.ok(!out.limits.some((l) => l.startsWith("Only this app's owner")));
  });

  it("falls back on web search when nothing usable is left", () => {
    const out = settle(withAgent({ ...AGENT, tools: [{ id: "gmail_read", need: "x", why: "y" }] }) as Brief, false);
    assert.deepEqual(out.agent?.tools.map((t) => t.id), ["web_search"]);
  });

  it("gives a person's pick an agent even if the writer wrote none", () => {
    const out = applyTargets(BRIEF, { enabled: ["agent", "phone"], requested: ["agent"] });
    assert.deepEqual(out.targets?.map((t) => t.id), ["web", "agent"]);
    assert.equal(out.agent?.task, BRIEF.tagline);
    assert.deepEqual(out.agent?.tools.map((t) => t.id), ["web_search"]);
  });

  it("drops the agent when the targets leave it out", () => {
    const out = applyTargets(withAgent(AGENT) as Brief, { enabled: ["agent", "phone"], requested: ["phone"] });
    assert.deepEqual(out.targets?.map((t) => t.id), ["web", "phone"]);
    assert.ok(!("agent" in out));
  });

  it("drops the agent when its flag is off, whatever the brief says", () => {
    const out = applyTargets(withAgent(AGENT) as Brief, { enabled: ["phone"] });
    assert.deepEqual(out.targets?.map((t) => t.id), ["web"]);
    assert.ok(!("agent" in out));
  });

  it("gives the target to a writer that wrote an agent but forgot to list it", () => {
    const out = settle(withAgent(AGENT, [{ id: "web", why: "Always" }]) as Brief);
    assert.deepEqual(out.targets?.map((t) => t.id), ["web", "agent"]);
  });

  it("asks for one repair when the agent target has no agent, and never for a refusal", () => {
    const enabled = ["agent"] as const;
    assert.equal(targetProblems(withAgent(null) as Brief, { enabled }).length, 1);
    assert.equal(targetProblems({ ...BRIEF, targets: [{ id: "web", why: "w" }], agent: null } as Brief, { enabled, requested: ["agent"] }).length, 1);
    assert.equal(targetProblems(withAgent(AGENT) as Brief, { enabled }).length, 0);
    assert.equal(targetProblems({ ...(withAgent(null) as Brief), verdict: "no" }, { enabled }).length, 0);
    assert.equal(targetProblems(BRIEF, { enabled: [] }).length, 0);
  });
});

describe("an agent's tokens and prompts", () => {
  it("carries the agent marker and one marker per tool, and nothing without an agent", () => {
    assert.deepEqual(allowedModelsFor(BRIEF), ["sam-3.1"]);
    const allowed = allowedModelsFor({
      capabilities: [{ need: "Run it", model: "muse-wonder-1.0", why: "The agent" }],
      agent: { ...AGENT, tools: [...AGENT.tools, { id: "places", need: "n", why: "w" }, { id: "retired_tool", need: "n", why: "w" }] },
    });
    assert.deepEqual(allowed, ["muse-wonder-1.0", "agent", "tool:web_search", "tool:places"]);
  });

  it("tells Muse Code the task, the tools and the test budget", () => {
    const brief = applyTargets(withAgent(AGENT) as Brief, { enabled: ["agent"] });
    const prompt = renderBuildPrompt(brief, { inspoFiles: [], fixtures: [], maxModelSteps: 40 });
    assert.match(prompt, /## Where it runs[\s\S]*### Agent[\s\S]*Skill: `\.agents\/skills\/muse-agent`/);
    assert.match(prompt, /## Agent\n\nTask for one run: Research a question and answer with links\./);
    assert.match(prompt, /- `web_search` \(Web search\): Look it up\. Why: It is built in\./);
    assert.match(prompt, /Connections: none\./);
    assert.match(prompt, /A live run stops at 10 turns, 12 built-in tool calls or \$0\.75/);
    assert.match(prompt, /A build's run stops at 6 turns, 8 built-in tool calls or \$0\.40/);
    assert.match(prompt, /at most 3 agent runs, each with `maxTurns` 3 or 4/);
    assert.doesNotMatch(prompt, /under 5 model calls/);
    assert.doesNotMatch(prompt, /—/);
  });

  it("says who can connect a personal tool", () => {
    const brief = applyTargets(withAgent({ ...AGENT, tools: [{ id: "gmail_read", need: "Read mail", why: "The job" }] }) as Brief, { enabled: ["agent"], personalTools: true });
    const prompt = renderBuildPrompt(brief, { inspoFiles: [], fixtures: [], maxModelSteps: 40 });
    assert.match(prompt, /Connections: only the product's owner can connect an account for Read Gmail for now/);
  });

  it("shows the judge the agent's job in the brief it reads", () => {
    const md = briefToMarkdown(applyTargets(withAgent(AGENT) as Brief, { enabled: ["agent"] }));
    assert.match(md, /## Agent\n\nResearch a question and answer with links\.\n\n- \*\*Web search\*\*: Look it up/);
  });
});

function strictProperties(schema: Parameters<typeof strictJsonSchema>[0]): Record<string, unknown> {
  return (strictJsonSchema(schema) as { properties: Record<string, unknown> }).properties;
}

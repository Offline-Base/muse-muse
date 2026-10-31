/**
 * An agent's canned tool outputs, with Meta faked: which tools get any, the shape check, and that no link or address in
 * them can leave example.com.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/tools/__tests__/fixtures.test.ts
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";
import { TOOL_POLICIES } from "@/lib/tools/catalog.source";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;

let calls: Array<{ model: string; input: unknown }> = [];
let reply: unknown = { tools: [] };
let mod: typeof import("../fixtures");

const agent = (...ids: string[]) => ({
  name: "Paper Finder",
  tagline: "Finds papers",
  agent: { task: "Find papers on a topic.", tools: ids.map((id) => ({ id, need: "n", why: "w" })), connections: "none" as const, stepsPerRun: 3 },
});
const sampleOf = (id: string, n = 0) => TOOL_POLICIES.find((p) => p.id === id)!.functions[n]!;

describe("tool fixtures", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(at("../../meta/platform.ts"), {
      namedExports: {
        metaPlatform: () => ({
          responses: {
            create: async (body: { model: string; input: unknown }) => {
              calls.push({ model: body.model, input: body.input });
              return { output_text: JSON.stringify(reply), usage: { input_tokens: 100, output_tokens: 100 } };
            },
          },
        }),
      },
    });
    mod = await import(at("../fixtures.ts"));
  });

  beforeEach(() => {
    calls = [];
    reply = { tools: [] };
  });

  it("makes no call with no agent or only web search, which stays live in a build", async () => {
    assert.deepEqual(await mod.prepareToolFixtures({ name: "x", tagline: "y" }), { fixtures: null, usage: [] });
    assert.deepEqual(await mod.prepareToolFixtures(agent("web_search")), { fixtures: null, usage: [] });
    assert.equal(calls.length, 0);
  });

  it("makes no call for write tools alone: their sample does", async () => {
    assert.deepEqual(await mod.prepareToolFixtures(agent("gmail_draft", "slack_send")), { fixtures: null, usage: [] });
    assert.equal(calls.length, 0);
  });

  it("asks Muse Wonder once, with the task and each read tool's sample, and files the outputs by slug", async () => {
    const f = sampleOf("scholar");
    reply = { tools: [{ slug: f.slug, outputs: [JSON.stringify(f.sample), JSON.stringify(f.sample)] }] };
    const { fixtures, usage } = await mod.prepareToolFixtures(agent("web_search", "scholar", "gmail_draft"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.model, "muse-wonder-1.0");
    const text = JSON.stringify(calls[0]?.input);
    assert.match(text, /Find papers on a topic/);
    assert.ok(text.includes(f.slug));
    assert.ok(!text.includes("GMAIL_CREATE_EMAIL_DRAFT"));
    assert.equal(fixtures?.[f.slug]?.length, 2);
    assert.deepEqual(Object.keys(fixtures ?? {}), [f.slug]);
    assert.equal(usage.length, 1);
  });

  it("covers every function of a tool that has two", async () => {
    await mod.prepareToolFixtures(agent("gmail_read"));
    const text = JSON.stringify(calls[0]?.input);
    assert.ok(text.includes("GMAIL_FETCH_EMAILS") && text.includes("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"));
  });

  it("drops what isn't JSON or isn't the sample's shape, so the catalog's sample stands in", async () => {
    const f = sampleOf("scholar");
    reply = { tools: [{ slug: f.slug, outputs: ["not json", JSON.stringify({ other: 1 })] }, { slug: "MADE_UP", outputs: ["{}"] }] };
    const { fixtures } = await mod.prepareToolFixtures(agent("scholar"));
    assert.equal(fixtures, null);
  });

  it("keeps every catalog sample valid against its own shape", () => {
    for (const p of TOOL_POLICIES) {
      for (const f of p.functions) assert.equal(mod.usableOutputs(f.sample, [JSON.stringify(f.sample)]).length, 1, f.slug);
    }
  });

  it("rewrites any link or address off example.com", () => {
    const out = mod.pinToExampleDomain({
      a: "See https://evil.test/path?q=1 and http://example.com.evil.test/x and https://example.com/fine.",
      b: ["ceo@realcompany.com", "me@example.com", "you@example.com.evil.test"],
      n: 3,
    }) as { a: string; b: string[]; n: number };
    assert.equal(out.a, "See https://example.com/path?q=1 and https://example.com/x and https://example.com/fine.");
    assert.deepEqual(out.b, ["ceo@example.com", "me@example.com", "you@example.com"]);
    assert.equal(out.n, 3);
  });

  it("removes em dashes from what the model wrote", () => {
    assert.equal(mod.pinToExampleDomain("One — two"), "One, two");
  });
});

/**
 * The copy prompt for every mirrored page (content/meta-docs/pages.json), built from the page's DemoSpec agentPrompt
 * for every coding agent and language, without and with a large recorded run: it fits PROMPT_MAX_CHARS, has no em
 * dash, names the page's Markdown URL, never names muse-spark-1.3 except as muse-spark-1.3-contributor, and its Setup
 * matches where the page's code runs (Meta's base URL and MODEL_API_KEY on hosted pages, the reader's own server on
 * the open-weight pages, the muse CLI on Muse Code's own pages). A long run gives up its own body before anything the
 * page wrote. The registry loads every group's client components, so a load hook stands in for their CSS modules.
 * Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/__tests__/agent-prompt-pages.test.ts
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { before, describe, it } from "node:test";
import type { RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import { DEMO_GROUPS } from "@/lib/docs/demos/groups";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

const EM_DASH = String.fromCharCode(0x2014);
const RETIRED = /muse-spark-1\.3(?!-contributor)/;
const OPEN_WEIGHT = new Set(DEMO_GROUPS["open-weights"]);
const MUSE_CODE_PAGE = /^muse-code(\/|$)/;

let prompt: typeof import("@/lib/docs/agent-prompt");
let registry: typeof import("@/lib/docs/demos");
let pages: typeof import("@/lib/docs/pages");

before(async () => {
  prompt = await import("@/lib/docs/agent-prompt");
  registry = await import("@/lib/docs/demos");
  pages = await import("@/lib/docs/pages");
});

/**
 * A large request as useDocsRun records it: an agent loop's turn with long instructions, a long history and eight
 * tool definitions, sent with Meta's muse-spark-1.3 as a Run button records it from a code block, and a long reply.
 */
const LARGE_RUN: RecordedRequest = {
  method: "POST",
  path: "responses",
  body: {
    model: "muse-spark-1.3",
    instructions: `You are a coding agent. ${"Follow the project's rules and explain each change. ".repeat(40)}`,
    input: Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `Turn ${i}: ${"Here is more of the conversation, quoted back to the model. ".repeat(2)}`.slice(0, 150),
    })),
    tools: Array.from({ length: 8 }, (_, i) => ({
      type: "function",
      name: `tool_${i}`,
      description: `Tool ${i} ${"does one thing in the project and reports what it did. ".repeat(2)}`.slice(0, 150),
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 6 }, (_, j) => [`arg_${j}`, { type: "string", description: `Argument ${j}: ${"what this argument means. ".repeat(5)}`.slice(0, 140) }]),
        ),
        required: ["arg_0"],
      },
    })),
    reasoning: { effort: "low" },
    max_output_tokens: 4096,
    stream: true,
  },
  model: "muse-spark-1.3-contributor",
  status: 200,
  outcome: `tool calls: tool_0(${JSON.stringify({ arg_0: "x".repeat(400) })})`,
};

/** The least room LARGE_RUN's section can be cut to: its head line, and its body and result each cut to nothing. */
const FLOOR_RUN: RecordedRequest = { method: "POST", path: "responses", model: "muse-spark-1.3-contributor", status: 200, body: "... (trimmed)", outcome: "... (trimmed)" };

/**
 * A section without blank lines of its own (Setup, Done when), from its title line to the blank line after it. Setup
 * is the first block with its title and Done when the last, so starter code can't be taken for either.
 */
function sectionOf(text: string, title: "Setup" | "Done when"): string {
  const blocks = text.split("\n\n").filter((b) => b.startsWith(`${title}\n`));
  return (title === "Setup" ? blocks[0] : blocks.at(-1)) ?? "";
}

describe("the copy prompt on every mirrored page", () => {
  it("has a page for every slug the groups list, and a DemoSpec on every page", () => {
    const slugs = pages.DOCS_PAGES.map((p) => p.slug).sort();
    assert.equal(slugs.length, 154);
    assert.deepEqual(Object.values(DEMO_GROUPS).flat().sort(), slugs);
    for (const slug of slugs) assert.ok(registry.demoFor(slug), `${slug} has a DemoSpec`);
  });

  it("fits, has no em dash, names the Markdown URL and the Contributor model only, with and without a large run", () => {
    for (const page of pages.DOCS_PAGES) {
      const spec = registry.demoFor(page.slug)?.agentPrompt ?? null;
      for (const { id: agent } of prompt.CODING_AGENTS) {
        for (const { id: language } of prompt.PROMPT_LANGUAGES) {
          for (const lastRequest of [null, LARGE_RUN]) {
            const where = `${page.slug} (${agent}, ${language}${lastRequest ? ", large run" : ""})`;
            const text = prompt.buildAgentPrompt({ page, spec, agent, language, lastRequest });
            assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${where}: ${text.length} characters`);
            assert.equal(text.includes(EM_DASH), false, `${where}: an em dash`);
            assert.ok(text.includes(page.markdownUrl), `${where}: the Markdown URL`);
            const retired = RETIRED.exec(text);
            assert.equal(retired, null, `${where}: muse-spark-1.3 alone, at "${retired ? text.slice(Math.max(0, retired.index - 60), retired.index + 30) : ""}"`);
            if (lastRequest) assert.match(text, /\n\nWhat I just ran in the docs\nPOST \/v1\/responses returned HTTP 200 on muse-spark-1\.3-contributor\./, where);
          }
        }
      }
    }
  });

  it("sets up the hosted API with its base URL and MODEL_API_KEY, except on open-weight and Muse Code CLI pages", () => {
    const seen = { hosted: 0, "self-hosted": 0, "muse-cli": 0 };
    for (const page of pages.DOCS_PAGES) {
      const spec = registry.demoFor(page.slug)?.agentPrompt ?? null;
      for (const { id: language } of prompt.PROMPT_LANGUAGES) {
        for (const lastRequest of [null, LARGE_RUN]) {
          const where = `${page.slug} (${language}${lastRequest ? ", large run" : ""})`;
          const text = prompt.buildAgentPrompt({ page, spec, agent: "claude-code", language, lastRequest });
          const setup = sectionOf(text, "Setup");
          const done = sectionOf(text, "Done when");
          assert.ok(setup && done, `${where}: Setup and Done when`);
          const kind = /^- Server: the model runs on hardware you control/m.test(setup)
            ? "self-hosted"
            : /^- Muse Code: muse on PATH/m.test(setup)
              ? "muse-cli"
              : "hosted";
          seen[kind]++;
          const expected = spec?.setup ?? (OPEN_WEIGHT.has(page.slug) ? "self-hosted" : kind === "muse-cli" && MUSE_CODE_PAGE.test(page.slug) ? "muse-cli" : "hosted");
          assert.equal(kind, expected, `${where}: the ${expected} Setup`);
          if (kind === "hosted") {
            assert.match(setup, /^- Base URL: https:\/\/api\.meta\.ai\/v1\b/m, `${where}: the base URL`);
            assert.match(setup, /^- Auth: send Authorization: Bearer \$MODEL_API_KEY, reading MODEL_API_KEY from the environment/m, `${where}: MODEL_API_KEY`);
            assert.match(setup, /^- Model: \S+/m, `${where}: the model`);
            assert.match(done, /The key comes from MODEL_API_KEY/, `${where}: the key check`);
          } else if (kind === "self-hosted") {
            assert.doesNotMatch(setup, /api\.meta\.ai|MODEL_API_KEY|^- Model:/m, `${where}: no hosted Setup`);
            assert.doesNotMatch(done, /MODEL_API_KEY/, `${where}: no MODEL_API_KEY check`);
          } else {
            assert.match(setup, /META_API_KEY/, `${where}: muse's own credential`);
            assert.doesNotMatch(setup, /Bearer \$MODEL_API_KEY|Base URL/, `${where}: no Model API setup`);
          }
        }
      }
    }
    assert.ok(seen.hosted && seen["self-hosted"] && seen["muse-cli"], `every Setup is used: ${JSON.stringify(seen)}`);
  });

  it("gives a long run's body up first: what the page wrote stays whole wherever the run's least room lets it", () => {
    let trimmedRuns = 0;
    for (const page of pages.DOCS_PAGES) {
      const spec = registry.demoFor(page.slug)?.agentPrompt ?? null;
      if (!spec) continue;
      for (const { id: language } of prompt.PROMPT_LANGUAGES) {
        const build = (lastRequest: RecordedRequest): string => prompt.buildAgentPrompt({ page, spec, agent: "claude-code", language, lastRequest });
        const snippet: string | undefined = spec.snippets?.[language]?.trim();
        // Without a snippet of the page's own, the starter code is the run's, and may be cut with it.
        const runs = (s: string): boolean => s.startsWith("What I just ran in the docs\n") || (!snippet && s.startsWith("Starter code"));
        const pageTrimmed = (text: string): boolean => text.split("\n\n").some((s): boolean => s.includes("(trimmed)") && !runs(s));
        // Where even the run cut to its head leaves no room, the facts must give way; elsewhere nothing of the page's may.
        if (pageTrimmed(build(FLOOR_RUN))) continue;
        const text: string = build(LARGE_RUN);
        const where = `${page.slug} (${language})`;
        assert.ok(text.includes(spec.task.trim()), `${where}: the task is whole`);
        for (const fact of spec.facts ?? []) assert.ok(text.includes(fact), `${where}: the fact "${fact.slice(0, 50)}" is whole`);
        if (snippet) assert.ok(text.includes(snippet), `${where}: the starter code is whole`);
        assert.equal(pageTrimmed(text), false, `${where}: only the run is trimmed`);
        const trimmed = text.split("\n\n").filter((s) => s.includes("(trimmed)"));
        if (trimmed.length) {
          trimmedRuns++;
          // The run takes the room that's left rather than a fixed share of it.
          assert.ok(text.length > prompt.PROMPT_MAX_CHARS - 250, `${where}: ${text.length} characters, room left unused`);
        }
      }
    }
    assert.ok(trimmedRuns > 100, `the large run is trimmed on most pages (${trimmedRuns})`);
  });
});

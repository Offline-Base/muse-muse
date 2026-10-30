/**
 * Every cookbook-use-cases page's DemoSpec, server-rendered the way the docs page mounts it (plain JSON props plus the
 * slug): it renders, shows its controls and the Contributor notice, and keeps em dashes and key-like strings out.
 * Each page's copy prompt is built for every agent and language: under the length cap, no em dashes, and the model it
 * names for the reader's code is never bare muse-spark-1.3. The CSS module is stubbed by a load hook, as in the
 * media kit's tests. Nothing reaches the network (effects don't run in a server render).
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-use-cases/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

const EM = String.fromCharCode(0x2014);
const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

let html: (el: ReactElement) => string;
let demos: typeof import("@/lib/docs/demos/cookbook-use-cases");
let index: typeof import("@/lib/docs/demos/groups");
let prompt: typeof import("@/lib/docs/agent-prompt");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  html = (el) => {
    const out = renderToString(el).replace(/<!-- -->/g, "");
    assert.equal(out.includes(EM), false, "no em dash in the markup");
    assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM\|\d|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/, "no key-like strings");
    return out;
  };
  demos = await import("@/lib/docs/demos/cookbook-use-cases");
  index = await import("@/lib/docs/demos/groups");
  prompt = await import("@/lib/docs/agent-prompt");
});

const el = <P extends object>(c: ComponentType<P>, props: P) => createElement(c as ComponentType<object>, props);

/** What each page's demo shows before anything runs. */
const EXPECT: Record<string, RegExp[]> = {
  "cookbook/use-cases": [/Showing 14 of 14 recipes/, />Which recipe fits my project\?</, />Pick recipes</],
  "computer-use": [/aria-label="Simulated screen: Sign-up form"/, /truncation: &quot;auto&quot;/, /Acknowledge safety checks for me/, />Start and run</],
  "cookbook/alert-fatigue-copilot": [/total alerts: 42/, /recurring: 28 \(66\.7%\)/, />Run the three tasks</],
  "cookbook/perception-chart-analysis": [/Cover the printed values/, /The recipe&#x27;s price-chart schema/, />Run steps 1 and 2</],
  "cookbook/perception-error-screenshot-fix": [/Step 0: verify image input works/, />Plan the fix</, />ok build it</, /components\/CartItems\.tsx:14/],
  "cookbook/perception-grounding": [/Points as JSON/, /One call, HTML out/, /I am pescatarian with high cholesterol/, />Pin the dots</],
  "cookbook/generating-slides": [/Research a topic/, /AI Agents in Production/, />Make the deck</],
  "cookbook/github-agent": [/sample\/model-cookbook: issues\.opened/, /opencode-triage\.yml/, /&quot;gh issue edit\*&quot;: allow/, />Fire the event</],
  "cookbook/multi-agent-orchestration": [/build me a habit tracker app/, /kanban, clarify, file, memory, todo/, />Brief the PM</],
  "cookbook/one-shot-game-dev": [/AGENTS\.md: the rules that prevent invisible bugs/, /Forward = negative Z/, />Build the game in one shot</],
  "cookbook/iterative-game-dev": [/Build the 3D car racing game with Three\.js/, />Build, check in the browser, fix</],
  "cookbook/browser-verified-web-design": [/Mesh Network Solutions/, />Build, check in the browser, fix</],
  "cookbook/rayban-openclaw": [/Hold to talk/, /What can I make with these\?/, /Speak the answer/],
  "cookbook/computer-use": [/aria-label="Simulated screen: Desktop with Mines"/, /Fresh sub-agent every 12 screenshots/, /find the Minesweeper game on that desktop/],
  "cookbook/computer-use-macos": [/aria-label="Simulated screen: Tic-tac-toe"/, /Batched actions \(--batched-actions\)/, /store: false, replay/],
  "cookbook/sandboxed-execution": [/Fix this bug in the `psf\/requests` repository/, /run \(a shell command in the container\) and write_file/, />Run the sandboxed fix</],
  "cookbook/glimmer-api-agent": [/Tax rule \(the recipe&#x27;s example\)/, /approvals\.timeout/, /\$HERMES_HOME\/egress\.jsonl/, />Run the local agent</],
};

describe("cookbook-use-cases demos", () => {
  it("covers every page in the group", () => {
    const slugs = index.DEMO_GROUPS["cookbook-use-cases"];
    assert.deepEqual([...slugs].sort(), Object.keys(demos.cookbookUseCasesDemos).sort());
    for (const slug of slugs) assert.ok(EXPECT[slug], `expectations for ${slug}`);
  });

  for (const [slug, checks] of Object.entries(EXPECT)) {
    it(`${slug} renders its demo`, () => {
      const spec = demos.cookbookUseCasesDemos[slug];
      assert.ok(spec, slug);
      assert.deepEqual(JSON.parse(JSON.stringify(spec.props)), spec.props, "props are plain JSON");
      assert.equal(spec.title.includes(EM) || (spec.blurb ?? "").includes(EM), false);
      const out = html(el(spec.Component, { ...spec.props, slug }));
      for (const re of checks) assert.match(out, re, `${slug}: ${re}`);
      if (slug !== "cookbook/use-cases") assert.match(out, NOTICE, `${slug} shows the Contributor notice`);
      assert.doesNotMatch(out, /<option value="muse-spark-1\.3"/, "never offers muse-spark-1.3");
    });
  }

  it("leaves Muse Wonder out of the computer-use menus and says why", () => {
    const spec = demos.cookbookUseCasesDemos["computer-use"];
    const out = html(el(spec.Component, { ...spec.props, slug: "computer-use" }));
    assert.doesNotMatch(out, /<option value="muse-wonder-1\.0"/);
    assert.match(out, /Unsupported tool type &#x27;computer&#x27;/);
  });

  it("builds every page's copy prompt within the cap, untrimmed, with starter code in every language", async () => {
    const { docsPage } = await import("@/lib/docs/pages");
    for (const slug of index.DEMO_GROUPS["cookbook-use-cases"]) {
      const spec = demos.cookbookUseCasesDemos[slug].agentPrompt;
      const info = docsPage(slug);
      assert.ok(info, slug);
      assert.ok(spec.task.length > 80, `${slug} has a specific task`);
      assert.ok((spec.facts ?? []).length >= 3, `${slug} has facts`);
      assert.ok((spec.checklist ?? []).length >= 2, `${slug} has checks`);
      for (const agent of prompt.CODING_AGENTS) {
        for (const lang of prompt.PROMPT_LANGUAGES) {
          const text = prompt.buildAgentPrompt({
            page: { slug, title: info.title, description: info.description, sourceUrl: info.sourceUrl, markdownUrl: info.markdownUrl },
            spec,
            agent: agent.id,
            language: lang.id,
            lastRequest: null,
          });
          assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug} ${agent.id} ${lang.id}: ${text.length} chars`);
          assert.equal(text.includes("(trimmed)"), false, `${slug} ${agent.id} ${lang.id}: nothing is trimmed`);
          assert.equal(text.includes(EM), false, `${slug}: no em dash`);
          assert.doesNotMatch(text, /"muse-spark-1\.3"|model=MODEL_NAME/, `${slug}: no bare muse-spark-1.3 model id`);
          assert.match(text, /muse-spark-1\.3-contributor/, `${slug}: names the Contributor model`);
          assert.doesNotMatch(text, /Start from the page's .* example/, `${slug} ${lang.id}: has its own starter code`);
        }
      }
      const snippets = spec.snippets ?? {};
      for (const snippet of Object.values(snippets)) {
        assert.equal(snippet.includes(EM), false);
        assert.doesNotMatch(snippet, /muse-spark-1\.3(?!-contributor)/, `${slug}: snippets use the Contributor id`);
      }
      // Each slot holds code in its own language, not a config file or a different shell tool.
      assert.match(snippets.python ?? "", /^(#.*\n)?import /, `${slug}: the Python slot is a Python script`);
      assert.match(snippets.typescript ?? "", /^(\/\/.*\n)?import /, `${slug}: the TypeScript slot is a TypeScript module`);
      assert.match(snippets.curl ?? "", /curl https:\/\/api\.meta\.ai\/v1\//, `${slug}: the curl slot calls the API with curl`);
      for (const snippet of Object.values(snippets)) assert.doesNotMatch(snippet, /^\s*("\$schema"|on:|jobs:|\{\s*$)/m, `${slug}: no config file in a language slot`);
      // Self-contained: the client is created where the code calls the API.
      if (/\.create\(/.test(snippets.python ?? "")) assert.match(snippets.python ?? "", /OpenAI\(base_url=.*api_key=os\.environ\["MODEL_API_KEY"\]\)/, `${slug}: Python creates its client`);
      if (/\.create\(/.test(snippets.typescript ?? "")) assert.match(snippets.typescript ?? "", /new OpenAI\(\{ baseURL.*apiKey: process\.env\.MODEL_API_KEY \}\)/, `${slug}: TypeScript creates its client`);
    }
  });

  it("gives the multi-agent setup the recipe's full profile descriptions and leaves the gateway to its own terminal", () => {
    const spec = demos.cookbookUseCasesDemos["cookbook/multi-agent-orchestration"].agentPrompt;
    for (const snippet of [spec.snippets?.python ?? "", spec.snippets?.typescript ?? ""]) {
      assert.match(snippet, /arbitrates trade-offs between specialists\. Does not write code\./);
      assert.match(snippet, /crisp benefit-led copy for end users\./);
      assert.doesNotMatch(snippet, /\.\.\."/, "no description cut short");
      assert.doesNotMatch(snippet, /"gateway", "start"|gateway start &&/, "the script doesn't start the gateway");
    }
  });
});

describe("timeline", () => {
  it("folds long tool arguments that the model call already shows, and keeps short ones inline", async () => {
    const { Timeline } = await import("@/components/docs/playgrounds/cookbook-use-cases/Timeline");
    const tool = (id: number, args: string) => ({ id, kind: "tool" as const, agent: "gtm", depth: 0, name: "write_file", callId: `c${id}`, args, status: "done" as const, output: "Wrote it." });
    const long = JSON.stringify({ path: "gtm/posts/a.md", content: "x".repeat(400) });
    const out = html(createElement(Timeline, { entries: [tool(1, '{"path":"runbook.md"}'), tool(2, long)], onAnswer: () => {} }));
    assert.match(out, /Arguments \(\d[\d,]* characters, shown in the call above\)/);
    assert.equal((out.match(/<summary>Arguments/g) ?? []).length, 1, "only the long call is folded");
    assert.match(out, /runbook\.md/);
  });
});

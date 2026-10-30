/**
 * The text group's demos server-rendered with their own DemoSpec props, the way the docs page mounts them: what each
 * shows before anything runs (the controls, presets and checks from the page, the Contributor notice, Run), that the
 * props are plain JSON, and that every copy prompt fits, names the Contributor model and has no em dash. The CSS module
 * is stubbed with a load hook (every class name is itself), as the media kit's tests do. Nothing reaches the network:
 * effects don't run in a server render.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/text/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const EM_DASH = String.fromCharCode(0x2014);
const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;
const SLUGS = ["tool-calling", "tool-search", "search-grounding", "reasoning", "structured-output", "prompt-caching", "token-counting"];

let html: (el: ReactElement) => string;
let demos: typeof import("@/lib/docs/demos/text");
let ctx: typeof import("@/components/docs/kit/DocsPageContext");
let prompt: typeof import("@/lib/docs/agent-prompt");
let answer: typeof import("@/components/docs/playgrounds/text/AnswerText");
let parts: typeof import("@/components/docs/playgrounds/text/parts");

interface PageRow {
  slug: string;
  title: string;
  description: string;
  sourceUrl: string;
  markdownUrl: string;
}
const PAGES: PageRow[] = JSON.parse(readFileSync(new URL("../../../../../content/meta-docs/pages.json", import.meta.url), "utf8"));
const pageOf = (slug: string) => {
  const p = PAGES.find((x) => x.slug === slug)!;
  return { slug, title: p.title, description: p.description, sourceUrl: p.sourceUrl, markdownUrl: p.markdownUrl };
};

function clean(out: string): string {
  assert.equal(out.includes(EM_DASH), false, "no em dash");
  assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/, "no key-like strings");
  return out;
}

function renderPage(slug: string): string {
  const spec = demos.textDemos[slug];
  const el = createElement(spec.Component as ComponentType<object>, { ...spec.props, slug });
  return html(createElement(ctx.DocsPageProvider, { page: pageOf(slug), children: el }));
}

before(async () => {
  const { renderToString } = await import("react-dom/server");
  html = (el) => clean(renderToString(el).replace(/<!-- -->/g, ""));
  demos = await import("@/lib/docs/demos/text");
  ctx = await import("@/components/docs/kit/DocsPageContext");
  prompt = await import("@/lib/docs/agent-prompt");
  answer = await import("@/components/docs/playgrounds/text/AnswerText");
  parts = await import("@/components/docs/playgrounds/text/parts");
});

/**
 * "What I just ran" as long as it can get: a body whose JSON runs past every budget, and a long Result line. The
 * prompt builder clips that section to 1,100 characters, then 800; a prompt whose other sections fit beside 800 never
 * needs to cut them.
 */
function longestRun() {
  return {
    method: "POST" as const,
    path: "responses",
    status: 200,
    model: "muse-spark-1.3-contributor",
    outcome: `output_text: ${"word ".repeat(80)}`,
    body: { model: "muse-spark-1.3-contributor", input: Array.from({ length: 30 }, (_, i) => ({ type: "function_call_output", call_id: `call_${i}`, output: "x".repeat(150) })) },
  };
}

/** The tool loop's second call on Responses, as the kit records it (the run the review saw trimming facts). */
function toolLoopCall2() {
  const output = JSON.stringify({ location: "Seattle", temperature_c: 14, temperature_f: 57, condition: "Light rain", humidity: 81, wind_kph: 12, note: "Sample data from a mock tool in the docs demo." });
  return {
    method: "POST" as const,
    path: "responses",
    status: 200,
    outcome: "output_text: It's 14°C (57°F) in Seattle right now with light rain, 81% humidity and wind around 12 km/h.",
    body: {
      model: "muse-spark-1.3-contributor",
      input: [{ type: "function_call_output", call_id: "call_0123456789abcdef01234567", output }],
      previous_response_id: "resp_0123456789abcdef0123456789abcdef",
      reasoning: { effort: "low" },
      parallel_tool_calls: true,
      tools: [{ type: "function", name: "get_weather", description: "Return current weather for the given location.", parameters: { type: "object", properties: { location: { type: "string", description: "City name, e.g. 'Seattle'" } }, required: ["location"], additionalProperties: false } }],
    },
  };
}

describe("the text group's demo specs", () => {
  it("covers every page in the group, with a title, a blurb and plain-JSON props", () => {
    assert.deepEqual(Object.keys(demos.textDemos).sort(), [...SLUGS].sort());
    for (const slug of SLUGS) {
      const spec = demos.textDemos[slug];
      assert.ok(spec.title && spec.blurb, slug);
      assert.deepEqual(JSON.parse(JSON.stringify(spec.props)), spec.props, `${slug} props survive JSON`);
      for (const text of [spec.title, spec.blurb ?? "", JSON.stringify(spec.props), JSON.stringify(spec.agentPrompt)]) {
        assert.equal(text.includes(EM_DASH), false, `${slug}: no em dash`);
        assert.doesNotMatch(text, /"muse-spark-1\.3"/, `${slug}: never muse-spark-1.3 itself`);
      }
    }
  });

  it("gives every page a prompt that fits, in every language, with the Contributor model and its note", () => {
    for (const slug of SLUGS) {
      const spec = demos.textDemos[slug];
      for (const language of ["python", "typescript", "curl"] as const) {
        assert.ok(spec.agentPrompt.snippets?.[language], `${slug} has a ${language} snippet`);
        const text = prompt.buildAgentPrompt({ page: pageOf(slug), spec: spec.agentPrompt, agent: "claude-code", language, lastRequest: null });
        assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug} ${language}: ${text.length} characters`);
        assert.ok(text.includes(spec.agentPrompt.task.slice(0, 60)), `${slug}: the task comes through whole`);
        assert.match(text, /muse-spark-1\.3-contributor \(Contributor mode/);
        assert.doesNotMatch(text, /\(trimmed\)/, `${slug} ${language}: nothing had to be cut`);
        assert.equal(text.includes(EM_DASH), false);
      }
    }
  });
});

describe("copy prompts with a run included", () => {
  it("keep the task, every fact, the checklist and the starter code whole for every agent and language", () => {
    for (const slug of SLUGS) {
      const spec = demos.textDemos[slug].agentPrompt;
      for (const agent of prompt.CODING_AGENTS) {
        for (const language of ["python", "typescript", "curl"] as const) {
          for (const run of [longestRun(), toolLoopCall2()]) {
            const text = prompt.buildAgentPrompt({ page: pageOf(slug), spec, agent: agent.id, language, lastRequest: run });
            const where = `${slug} ${agent.id} ${language}`;
            assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${where}: ${text.length} characters`);
            assert.ok(text.includes(spec.task.trim()), `${where}: the task`);
            for (const fact of spec.facts ?? []) assert.ok(text.includes(fact), `${where}: fact "${fact.slice(0, 40)}"`);
            for (const check of spec.checklist ?? []) assert.ok(text.includes(check), `${where}: check "${check.slice(0, 40)}"`);
            assert.ok(text.includes(spec.snippets![language]!.trim()), `${where}: the starter code`);
            assert.ok(text.includes("What I just ran in the docs"), `${where}: the run is there`);
            const trimmed = text.split("\n\n").filter((section) => section.includes("(trimmed)") && !section.startsWith("What I just ran"));
            assert.deepEqual(trimmed, [], `${where}: only the run may be trimmed`);
          }
        }
      }
    }
  });

  it("never tell the agent to switch to muse-spark-1.3", () => {
    for (const slug of SLUGS) {
      const text = JSON.stringify(demos.textDemos[slug].agentPrompt);
      assert.doesNotMatch(text, /muse-spark-1\.3(?!-contributor)/, slug);
    }
  });
});

describe("answers", () => {
  it("draw an answer's Markdown as text, with citation markers where the spans end", async () => {
    const { encodeCitations, segmentCitations, numberSources } = await import("@/components/docs/playgrounds/text/grounding");
    const text = "The most recent race was the **2026 United States Grand Prix**, won by Kimi Antonelli.\n\n* Pole: Lando Norris\n* Fastest lap: $\\frac{1}{2}$ a second faster";
    // The span covers the bold name, its closing ** included, so the marker follows the bold text.
    const annotations = [{ url: "https://www.formula1.com/en/latest", title: "F1", start: 29, end: 62 }];
    const sources = numberSources([{ annotations }]);
    const marker = (n: number) => createElement("sup", { "data-marker": n }, `[${n}]`);
    const out = html(createElement(answer.AnswerText, { text: encodeCitations(segmentCitations(text, annotations, sources)), cite: { marker, citedClass: "cited" } }));
    assert.match(out, /<strong><span class="cited">2026 United States Grand Prix<\/span><\/strong><sup data-marker="1">\[1\]<\/sup>,/);
    assert.match(out, /<ul><li><p>Pole: Lando Norris<\/p><\/li><li><p>Fastest lap: <span class="mdMath">1\/2<\/span> a second faster<\/p><\/li><\/ul>/);
    assert.doesNotMatch(out, /\*\*|[\uE000-\uF8FF]/, "no raw marks or private-use characters left");
    // A span that ends inside the bold text gets its marker there.
    const inside = html(createElement(answer.AnswerText, { text: encodeCitations(segmentCitations(text, [{ ...annotations[0], end: 60 }], sources)), cite: { marker, citedClass: "cited" } }));
    assert.match(inside, /<strong><span class="cited">2026 United States Grand Prix<\/span><sup data-marker="1">\[1\]<\/sup><\/strong>/);
  });

  it("never turn an answer into HTML", () => {
    const out = html(createElement(answer.AnswerText, { text: "<script>alert(1)</script> and [x](javascript:alert(1)) and <b>bold</b>" }));
    assert.doesNotMatch(out, /<script|<b>|href="javascript/);
    assert.match(out, /&lt;script&gt;/);
  });
});

describe("bar list", () => {
  it("puts label, bar and value in their own columns and sizes the bar on the whole track", () => {
    const out = html(
      createElement(parts.BarList, {
        label: "Input tokens up front",
        items: [
          { id: "deferred", label: "With tool search", value: 2751, display: "2,751 tokens" },
          { id: "loaded", label: "Every schema loaded", value: 5226, display: "5,226 tokens" },
        ],
      }),
    );
    assert.match(out, /<div class="barsBox"><ul class="bars" aria-label="Input tokens up front">/);
    assert.match(out, /<span class="barLabel">With tool search<\/span><span class="barTrack" aria-hidden="true"><span class="barFill" style="width:52\.6\d*%"><\/span><\/span><span class="barValue">2,751 tokens<\/span>/);
    assert.match(out, /style="width:100%"/);
    assert.doesNotMatch(out, /7\.5rem/);
  });
});

describe("tool calling", () => {
  it("starts on the page's weather example with both protocols, and offers the rule checks", () => {
    const out = renderPage("tool-calling");
    assert.match(out, /role="tablist" aria-label="Tool calling demo"/);
    assert.match(out, />Run the loop<\/button>/);
    assert.match(out, />Check the rules<span class="pg-tab-count">10<\/span>/);
    assert.match(out, /aria-pressed="true"[^>]*>Weather \(the page&#x27;s example\)<\/button>/);
    assert.match(out, />Parallel calls<\/button>.*>A chain of calls<\/button>.*>Calculations<\/button>.*>Strict schema<\/button>/);
    assert.match(out, /<textarea[^>]*>What is the weather in Seattle\?<\/textarea>/);
    assert.match(out, /aria-label="Protocol">.*>Responses<\/button>.*>Chat Completions<\/button>/);
    assert.match(out, NOTICE);
    assert.match(out, /<span>Run all<\/span>/);
    assert.match(out, /<code class="pg-toolcall-name">get_weather<\/code>/);
    assert.match(out, /Function names may contain at most one dot/);
    assert.match(out, /The page says: HTTP 400/);
    assert.match(out, /custom tools are not supported on this endpoint/);
    const custom = (demos.textDemos["tool-calling"].props.checks as Array<{ id: string; body: { tools: unknown[] } }>).find((c) => c.id === "custom-chat")!;
    assert.deepEqual(custom.body.tools[0], { type: "custom", custom: { name: "run_shell", description: "Execute a shell command supplied as freeform text." } });
    const chain = (demos.textDemos["tool-calling"].props.scenarios as Array<{ id: string; results?: Record<string, { status: string; simulated: boolean }> }>).find((x) => x.id === "chain")!;
    assert.deepEqual([chain.results?.send_email.status, chain.results?.send_email.simulated], ["sent", true]);
  });
});

describe("tool search", () => {
  it("shows the library, both modes, the page's prompt and the free token count", () => {
    const out = renderPage("tool-search");
    assert.match(out, /aria-label="Execution mode">.*aria-checked="true"[^>]*>Hosted<\/button>.*>Client-executed<\/button>/);
    assert.match(out, /7 namespaces, 37 functions, 36 deferred/);
    assert.equal((out.match(/aria-label="Namespaces in the library"/g) ?? []).length, 1);
    for (const ns of ["crm", "billing", "shipping", "calendar", "hr", "analytics", "devops"]) assert.match(out, new RegExp(`aria-pressed="true"[^>]*>${ns} <span`));
    assert.match(out, /Keep <code>crm\.get_customer_profile<\/code> loaded up front/);
    assert.match(out, /<textarea[^>]*>List open orders for customer CUST-12345\.<\/textarea>/);
    assert.match(out, />Count the tokens<\/button>/);
    assert.match(out, NOTICE);
    assert.match(out, /<option value="low" selected="">Low<\/option>/);
    assert.match(out, />Check the rules<span class="pg-tab-count">9<\/span>/);
    const messages = (demos.textDemos["tool-search"].props.checks as Array<{ id: string; replyHas?: string }>).find((c) => c.id === "messages")!;
    assert.equal(messages.replyHas, "server_tool_use", "a 200 alone doesn't pass the Messages check");
  });
});

describe("search grounding", () => {
  it("offers the page's options and examples, streaming with raw results by default", () => {
    const out = renderPage("search-grounding");
    assert.match(out, /role="switch"[^>]*aria-checked="true"[^>]*><\/button><label[^>]*>Stream<\/label>/);
    assert.match(out, /role="switch"[^>]*aria-checked="true"[^>]*><\/button><label[^>]*>Include raw results<\/label>/);
    assert.match(out, /role="switch"[^>]*aria-checked="false"[^>]*><\/button><label[^>]*>User location<\/label>/);
    assert.match(out, /aria-label="search_context_size">.*>Default<\/button>.*>Low<\/button>.*>Medium<\/button>.*>High<\/button>/);
    assert.match(out, /aria-pressed="true"[^>]*>Latest F1 race \(the page&#x27;s example\)<\/button>/);
    assert.match(out, />Coffee near me, in London<\/button>/);
    assert.match(out, /<textarea[^>]*>Who won the most recent Formula 1 race\?<\/textarea>/);
    assert.match(out, NOTICE);
    assert.doesNotMatch(out, /pg-response/, "no reply view before a run");
  });
});

describe("reasoning", () => {
  it("compares four efforts by default, with Max held back on the Contributor model and a worst case shown", () => {
    const out = renderPage("reasoning");
    for (const e of ["Minimal", "Low", "Medium", "High"]) assert.match(out, new RegExp(`aria-pressed="true"[^>]*>${e}<\\/button>`));
    assert.match(out, /aria-pressed="false"[^>]*>Default<\/button>/);
    assert.match(out, /aria-pressed="false" disabled=""[^>]*>Max<\/button>/);
    assert.match(out, /<span>Run 4 efforts<\/span>/);
    assert.match(out, /Worst case \$0\.0048 if every run uses its whole output limit/);
    assert.match(out, /<option value="auto" selected="">auto<\/option>/);
    assert.match(out, /Prove √2 is irrational/);
    assert.match(out, /Max on Muse Wonder \(costs more\)/);
    assert.match(out, NOTICE);
  });
});

describe("structured output", () => {
  it("opens on the page's Address example on Chat Completions, strict off, with the size check and the rules", () => {
    const out = renderPage("structured-output");
    assert.match(out, />Run a schema<\/button>.*>Check a schema&#x27;s size<\/button>.*>Check the rules<span class="pg-tab-count">7<\/span>/);
    assert.match(out, /aria-label="Protocol">.*aria-checked="true"[^>]*>Chat Completions<\/button>/);
    assert.match(out, /role="switch"[^>]*aria-checked="false"[^>]*><\/button><label[^>]*><code>strict<\/code><\/label>/);
    assert.match(out, /Please format this address: 1 Hacker Wy Menlo Park CA 94025/);
    assert.match(out, /Sent as response_format with strict: false/);
    assert.match(out, /Within every limit\.|limit(s)? exceeded/);
    assert.match(out, />Ten levels \(passes\)<\/button>/);
    assert.match(out, NOTICE);
  });
});

describe("prompt caching", () => {
  it("sends the same prefix twice with a cache key by default", () => {
    const out = renderPage("prompt-caching");
    assert.match(out, /aria-pressed="true"[^>]*>Same prefix twice<\/button>.*>Timestamp first<\/button>.*>Edit the middle<\/button>/);
    assert.match(out, /aria-checked="true"[^>]*>Chapters I to III \(about 8,300\)<\/button>/);
    assert.match(out, /role="switch"[^>]*aria-checked="true"[^>]*><\/button><label[^>]*><code>prompt_cache_key<\/code><\/label>/);
    assert.match(out, /value="muse-docs-prompt-caching"/);
    assert.match(out, /<option value="minimal" selected="">Minimal<\/option>/);
    assert.match(out, /<span>Send both calls<\/span>/);
    assert.match(out, /at most \$0\.0010 on Muse Spark 1\.3 Contributor when call 2 hits the cache, \$0\.0018 if it misses/);
    assert.match(out, /On by default, though the page says caching needs no key/);
    assert.match(out, NOTICE);
  });
});

describe("token counting", () => {
  it("counts the page's example on the Responses endpoint, with the Messages one a click away", () => {
    const out = renderPage("token-counting");
    assert.match(out, /aria-label="Endpoint">.*aria-checked="true"[^>]*>responses\/input_tokens<\/button>.*>messages\/count_tokens<\/button>/);
    assert.match(out, /aria-pressed="true"[^>]*>A question<\/button>.*>Tool conversation<\/button>.*>With web search<\/button>.*>An image<\/button>.*>A long document<\/button>.*>Your own body<\/button>/);
    assert.match(out, /<span>Count tokens<\/span>/);
    assert.match(out, /Counting is free/);
    assert.match(out, NOTICE);
  });
});

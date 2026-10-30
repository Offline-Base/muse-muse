/**
 * Each cookbook-fundamentals demo server-rendered with its DemoSpec's own props, the way the docs page mounts it:
 * what a reader sees before anything runs (the controls, the presets, the Contributor notice, Run), with no em dash and
 * nothing key-like in the markup. The CSS module is the only stand-in (a load hook makes every class name itself, as
 * the media kit's tests do). Effects don't run in a server render, so nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-fundamentals/__tests__/render.test.tsx
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

const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

let html: (slug: string) => string;

before(async () => {
  const { renderToString } = await import("react-dom/server");
  const { demoFor } = await import("@/lib/docs/demos");
  html = (slug: string) => {
    const spec = demoFor(slug);
    assert.ok(spec, `${slug} has a demo`);
    const props = { ...(spec.props as Record<string, unknown>), slug };
    const el = createElement(spec.Component as ComponentType<Record<string, unknown>>, props) as ReactElement;
    const out = renderToString(el).replace(/<!-- -->/g, "");
    assert.equal(out.includes(String.fromCharCode(0x2014)), false, `${slug}: no em dash`);
    assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/, `${slug}: nothing key-like`);
    return out;
  };
});

describe("recipe browsers", () => {
  it("the cookbook index opens on API fundamentals with section filters and the selected recipe's core call", () => {
    const out = html("cookbook");
    assert.match(out, /aria-pressed="false"[^>]*>All<\/button>/);
    assert.match(out, /aria-pressed="true"[^>]*>API fundamentals<\/button>/);
    assert.match(out, />Building with Muse Code<\/button>/);
    // Cards open their call in the panel, beside the model menu and its Contributor notice; only the panel sends.
    assert.equal((out.match(/>Try its core call</g) ?? []).length, 10);
    assert.doesNotMatch(out, />Run its core call</);
    assert.match(out, /<a href="\/docs\/cookbook\/quickstart-chat-completions">Quickstart: chat completions<\/a>/);
    assert.match(out, /Core call:<\/strong> Your first completion/);
    assert.match(out, NOTICE);
    assert.match(out, /<span>Run the core call<\/span>/);
    assert.match(out, /placeholder="Filter recipes"/);
  });

  it("the category pages list their own recipes without section filters", () => {
    const fundamentals = html("cookbook/api-fundamentals");
    assert.equal((fundamentals.match(/>Try its core call</g) ?? []).length, 10);
    assert.doesNotMatch(fundamentals, />All<\/button>/);
    const agents = html("cookbook/agent-patterns");
    assert.equal((agents.match(/>Try its core call</g) ?? []).length, 5);
    assert.match(agents, /Basic agent loop/);
    assert.match(agents, /Alert fatigue copilot/);
  });
});

describe("recipe browser panel", () => {
  it("shows Muse Spark Open on Mac's command and its hosted test call together", async () => {
    const { renderToString } = await import("react-dom/server");
    const { RecipeBrowser } = await import("@/components/docs/playgrounds/cookbook-fundamentals/RecipeBrowser");
    const out = renderToString(createElement(RecipeBrowser, { slug: "cookbook", start: "cookbook/muse-spark-open-mac" })).replace(/<!-- -->/g, "");
    assert.match(out, />Start with</);
    assert.match(out, /mlx\.launch --hostfile hostfile\.json --backend jaccl/);
    assert.match(out, /Core call:<\/strong> The recipe&#x27;s test prompt, on hosted Muse Spark/);
    assert.match(out, /<span>Run the core call<\/span>/);
    assert.match(out, NOTICE);
  });

  it("gives the Muse Code commands that need setup their setup lines", async () => {
    const { renderToString } = await import("react-dom/server");
    const { RecipeBrowser } = await import("@/components/docs/playgrounds/cookbook-fundamentals/RecipeBrowser");
    const replay = renderToString(createElement(RecipeBrowser, { slug: "cookbook", start: "cookbook/deterministic-replay" }));
    assert.match(replay, /SESSION_ROOT=[\s\S]*F=[\s\S]*muse trace inspect --session-log/);
    const sandbox = renderToString(createElement(RecipeBrowser, { slug: "cookbook", start: "cookbook/contained-execution" }));
    assert.match(sandbox, /mkdir -p \/tmp\/sandbox_demo &amp;&amp; cd \/tmp\/sandbox_demo &amp;&amp; git init -q/);
    assert.match(sandbox, /build_info\.sh/);
  });
});

describe("recipe demos", () => {
  it("quickstart: the chat on Chat Completions with the recipe's presets, and the statelessness tab", () => {
    const out = html("cookbook/quickstart-chat-completions");
    assert.match(out, /role="tab"[^>]*aria-selected="true"[^>]*>Chat<\/button>/);
    assert.match(out, />Stateless vs history<\/button>/);
    for (const p of ["First completion", "Developer message", "Persona: a pirate", "temperature 0.2", "temperature 1.5", "stop (HTTP 400)"]) {
      assert.match(out, new RegExp(`>${p.replace(/[().]/g, "\\$&")}</button>`));
    }
    assert.match(out, /<option value="minimal" selected="">Minimal<\/option>/);
    assert.match(out, /<span>Run both ways<\/span>/);
    assert.match(out, NOTICE);
  });

  it("streaming: include_usage on, the recipe's prompts, Stream it", () => {
    const out = html("cookbook/streaming-responses");
    assert.match(out, /role="switch"[^>]*aria-checked="true"[^>]*><\/button><label[^>]*><code>stream_options\.include_usage<\/code>/);
    assert.match(out, />Sorting algorithms<\/button>/);
    assert.match(out, /List three uses for a hash map, one line each\./);
    assert.match(out, /<span>Stream it<\/span>/);
  });

  it("tool calling: the recipe's tool and readings, tool_choice auto, the 400 switch", () => {
    const out = html("cookbook/tool-function-calling");
    assert.match(out, /aria-checked="true"[^>]*>auto<\/button>/);
    assert.match(out, /<td>Tokyo<\/td><td>24°C<\/td>/);
    assert.match(out, /without the assistant message/);
    assert.match(out, /<span>Run the loop<\/span>/);
    assert.match(out, />Call the model<\/button>/);
  });

  it("structured output: Chat first, three schemas, and the request tabs", () => {
    const out = html("cookbook/structured-output");
    assert.match(out, /aria-checked="true"[^>]*>Chat Completions<\/button>/);
    assert.match(out, />Pydantic Product<\/button>/);
    assert.match(out, />Naive vs schema<\/button>/);
    assert.match(out, />What the API rejects<\/button>/);
  });

  it("prompt caching: the three layouts and the cache key options", () => {
    const out = html("cookbook/prompt-caching");
    assert.match(out, /aria-checked="true"[^>]*>Stable prefix<\/button>/);
    assert.match(out, />Volatile first<\/button>/);
    assert.match(out, />New key per run<\/button>/);
    assert.match(out, /<span>Send 3 calls<\/span>/);
  });

  it("reasoning: the sweep, the inspection and the turns tabs", () => {
    const out = html("cookbook/reasoning-thinking-tokens");
    assert.match(out, />Effort levels<\/button>/);
    assert.match(out, />Where the reasoning is<\/button>/);
    assert.match(out, />Across turns<\/button>/);
    assert.match(out, /<span>Run every level<\/span>/);
    assert.match(out, /Try &quot;none&quot;/);
  });

  it("vision: base64 first with the recipe's test image, URL and swatches offered", () => {
    const out = html("cookbook/vision-input");
    assert.match(out, /aria-checked="true"[^>]*>Base64, inline<\/button>/);
    assert.match(out, />Several images<\/button>/);
    assert.match(out, /alt="The recipe&#x27;s test image/);
    assert.match(out, /Count the image&#x27;s tokens first \(free\)/);
  });

  it("search grounding: web search controls, the recipe's questions, and the documented example to replay", () => {
    const out = html("cookbook/search-grounding");
    assert.match(out, />search_context_size<\/span>/);
    assert.match(out, />Capital of France<\/button>/);
    assert.match(out, /<span>Search and answer<\/span>/);
    assert.match(out, /aria-expanded="false"[^>]*>Replay Meta&#x27;s documented example \(free\)<\/button>/);
  });

  it("error handling: scenarios, the 400 parameters and the breaker", () => {
    const out = html("cookbook/error-handling-retry");
    assert.match(out, />Two 429s, then OK<\/button>/);
    assert.match(out, />Retry everything \(anti-pattern\)<\/button>/);
    assert.match(out, />Parameters that 400<\/button>/);
    assert.match(out, />Circuit breaker<\/button>/);
  });

  it("basic agent loop: the four planted bugs, the guards and Run the loop", () => {
    const out = html("cookbook/basic-agent-loop");
    assert.match(out, />Fix the off-by-one<\/button>/);
    assert.match(out, />Fix the async race<\/button>/);
    assert.match(out, /tests\/test_pagination\.js is failing/);
    assert.match(out, /One tool per turn \(parallel_tool_calls: false\)/);
    assert.match(out, /<span>Run the loop<\/span>/);
  });

  it("interleaved reasoning: the migration tasks at high effort with a summary", () => {
    const out = html("cookbook/interleaved-reasoning-tool-use");
    assert.match(out, />1\. Leaf function \(retry\)<\/button>/);
    assert.match(out, /<option value="high" selected="">High<\/option>/);
    assert.match(out, /role="switch"[^>]*aria-checked="true"[^>]*><\/button><label[^>]*>Reasoning summary/);
  });

  it("context management: the four strategies, running state first", () => {
    const out = html("cookbook/multi-turn-context-management");
    assert.match(out, /aria-checked="true"[^>]*>Running state<\/button>/);
    assert.match(out, />Summarize older turns<\/button>/);
    assert.match(out, /<span>Run all turns<\/span>/);
  });

  it("search-and-replace: the six tasks and the broken edits", () => {
    const out = html("cookbook/search-and-replace-edits");
    assert.match(out, />1\. Single-line change<\/button>/);
    assert.match(out, />6\. Insert at the top<\/button>/);
    assert.match(out, />Ambiguous match<\/button>/);
    assert.match(out, /<span>Ask for the edits<\/span>/);
  });

  it("long context: the four tabs, counting before sending", () => {
    const out = html("cookbook/long-context");
    assert.match(out, />Measure, then ask<\/button>/);
    assert.match(out, />Past the window<\/button>/);
    assert.match(out, /1\. Count the tokens \(free\)/);
    assert.match(out, /<span>2\. Send it<\/span>/);
  });
});

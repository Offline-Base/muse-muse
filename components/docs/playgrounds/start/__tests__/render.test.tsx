/**
 * Every "start" DemoSpec server-rendered with its JSON props, the way the docs page mounts it (inside
 * DocsPageProvider, plus the slug), and every agentPrompt run through the copy-prompt builder: what each demo shows
 * before anything runs, that props are plain JSON, that nothing has an em dash or a key-like string, and that the
 * prompts fit and never name muse-spark-1.3 for the reader's code. CSS modules load through a hook that maps every
 * class name to itself, as the media kit's tests do. No network: effects don't run in a server render.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/start/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

/**
 * The group's slugs, as DEMO_GROUPS.start lists them (lib/docs/demos/groups.ts, which imports nothing, so no other
 * group's demos load here). A test below keeps the two in step.
 */
const START_SLUGS = [
  "overview",
  "quickstart",
  "authentication",
  "models",
  "pricing-rate-limits",
  "sdks",
  "error-handling",
  "api-reference",
  "api-reference/models",
  "api-reference/models/list-models",
  "api-reference/models/retrieve-model",
  "api-reference/models/schemas",
  "api-reference/status",
];

const EM_DASH = String.fromCharCode(0x2014);
const KEYLIKE = /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/;
const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

let html: (el: ReactElement) => string;
let demos: typeof import("@/lib/docs/demos/start");
let prompt: typeof import("@/lib/docs/agent-prompt");
let ctx: typeof import("@/components/docs/kit/DocsPageContext");
let lab: typeof import("@/components/docs/playgrounds/start/ErrorLab");
let tabs: typeof import("@/components/docs/playgrounds/start/SectionTabs");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  demos = await import("@/lib/docs/demos/start");
  prompt = await import("@/lib/docs/agent-prompt");
  ctx = await import("@/components/docs/kit/DocsPageContext");
  lab = await import("@/components/docs/playgrounds/start/ErrorLab");
  tabs = await import("@/components/docs/playgrounds/start/SectionTabs");
  html = (el) => {
    const out = renderToString(el).replace(/<!-- -->/g, "");
    assert.equal(out.includes(EM_DASH), false, "no em dash");
    assert.doesNotMatch(out, KEYLIKE, "no key-like strings");
    return out;
  };
});

function page(slug: string) {
  return {
    slug,
    title: slug,
    description: "",
    sourceUrl: `https://dev.meta.ai/docs/${slug}`,
    markdownUrl: `https://dev.meta.ai/docs/${slug}.md`,
  };
}

/** The demo as the docs page renders it. */
function render(slug: string): string {
  const spec = demos.startDemos[slug];
  assert.ok(spec, `a DemoSpec for ${slug}`);
  const demo = createElement(spec.Component as ComponentType<object>, { ...spec.props, slug });
  return html(createElement(ctx.DocsPageProvider, { page: page(slug), children: demo }));
}

describe("start DemoSpecs", () => {
  it("list the same slugs as DEMO_GROUPS.start", async () => {
    const { DEMO_GROUPS } = await import("@/lib/docs/demos/groups");
    assert.deepEqual([...DEMO_GROUPS.start], START_SLUGS);
  });

  it("cover exactly the group's slugs, with plain JSON props and complete prompts", () => {
    assert.deepEqual(Object.keys(demos.startDemos).sort(), [...START_SLUGS].sort());
    for (const [slug, spec] of Object.entries(demos.startDemos)) {
      assert.ok(spec.title && spec.blurb, slug);
      assert.deepEqual(JSON.parse(JSON.stringify(spec.props)), spec.props, `${slug} props are plain JSON`);
      const p = spec.agentPrompt;
      assert.ok(p.task.length > 80 && p.facts?.length && p.checklist?.length, slug);
      for (const lang of ["python", "typescript", "curl"] as const) {
        const snippet = p.snippets?.[lang];
        assert.ok(snippet, `${slug} has a ${lang} snippet`);
        // A price table may list muse-spark-1.3 (Standard); no call may send it.
        assert.doesNotMatch(snippet!, /\bmodel\b["']?\s*[=:]\s*["']muse-spark-1\.3["']/, `${slug} ${lang}: code calls muse-spark-1.3-contributor`);
        assert.doesNotMatch(snippet!, /["']openai\/muse-spark-1\.3["']|retrieve\(["']muse-spark-1\.3["']\)|models\/muse-spark-1\.3(?!-contributor)/, `${slug} ${lang}`);
        assert.doesNotMatch(snippet!, KEYLIKE, `${slug} ${lang}`);
      }
      const text = JSON.stringify(spec);
      assert.equal(text.includes(EM_DASH), false, `${slug}: no em dash`);
    }
  });

  it("make copy prompts that fit, for every agent language, with and without a last request", () => {
    for (const [slug, spec] of Object.entries(demos.startDemos)) {
      for (const language of ["python", "typescript", "curl"] as const) {
        for (const lastRequest of [null, { method: "POST" as const, path: "responses", body: { model: "muse-spark-1.3-contributor", input: "Hi" }, status: 200, outcome: "output_text: Hello" }]) {
          const text = prompt.buildAgentPrompt({ page: page(slug), spec: spec.agentPrompt, agent: "claude-code", language, lastRequest });
          assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug} ${language}: ${text.length} chars`);
          assert.ok(text.includes(spec.agentPrompt.task.slice(0, 60)), `${slug} ${language}: the task survives`);
          assert.equal(text.includes(EM_DASH), false);
          assert.doesNotMatch(text, /\(trimmed\)/, `${slug} ${language}: nothing is cut`);
        }
      }
    }
  });
});

describe("start demos render", () => {
  it("overview: a tab per model, Muse Spark first with the Contributor notice, open weights pointed elsewhere", () => {
    const out = render("overview");
    const tabs = [...out.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(tabs, ["Muse Spark", "Muse Wonder", "Muse Image", "Voice Transcribe", "SAM 3.1", "Muse Code"]);
    assert.match(out, /aria-selected="true"[^>]*>Muse Spark</);
    assert.match(out, NOTICE);
    assert.match(out, /In five short bullets, plan the upgrade of a Flask app/);
    assert.match(out, /href="\/docs\/muse-spark-open"/);
    assert.doesNotMatch(out, /muse-image-1\.0.*Generate/s, "media playgrounds load on first open, not on the server");
    assert.doesNotMatch(out, /<option value="muse-wonder-1\.0"/, "Muse Wonder runs capped in its own tab, not from the Muse Spark menu");
    assert.match(out, /<option value="muse-spark-1\.2"/);
  });

  it("quickstart: the page's prompt, its next steps, and the agent setup and Muse Code tabs", () => {
    const out = render("quickstart");
    assert.match(out, />First API call</);
    assert.match(out, />Coding agent</);
    assert.match(out, /<textarea[^>]*>What is the capital of France\?<\/textarea>/);
    assert.match(out, /aria-pressed="true"[^>]*>The page&#x27;s first call</);
    assert.match(out, />Wrong model id</);
    assert.match(out, /POST \/v1\/responses/);
    assert.match(out, NOTICE);
  });

  it("authentication: the browser sends no key, and the flow says where the key is added", () => {
    const out = render("authentication");
    assert.match(out, /Your browser/);
    assert.match(out, /No key, no Authorization header\./);
    assert.match(out, /Muse Muse&#x27;s server/);
    assert.match(out, />List models \(free\)</);
    assert.doesNotMatch(out, /<input[^>]*type="password"/, "never asks for a key");
  });

  it("models: the page's catalog until the live list loads", () => {
    const out = render("models");
    for (const id of ["muse-wonder-1.0", "muse-spark-1.3-contributor", "muse-image-1.0", "muse-voice-transcribe-1.0", "sam-3.1"]) {
      assert.match(out, new RegExp(`>${id.replace(/\./g, "\\.")}</code>`), id);
    }
    assert.match(out, />List models</);
    assert.match(out, /1,048,576 tokens/);
  });

  it("pricing: the calculator on a cached agent step, every token model side by side", () => {
    const out = render("pricing-rate-limits");
    assert.match(out, />Text tokens</);
    assert.match(out, /aria-pressed="true"[^>]*>Agent step on a cached prefix</);
    assert.match(out, />Not available</, "Muse Wonder Contributor");
    assert.match(out, />Cached input</);
    assert.match(out, />\$0\.0014</, "10,000 x $0.10 + 50,000 x $0.002 + 1,500 x $0.20, per 1M");
  });

  it("sdks: a pill per client, the OpenAI SDK's code first", () => {
    const out = render("sdks");
    assert.match(out, /aria-pressed="true"[^>]*>OpenAI SDK, Python</);
    for (const label of ["Anthropic SDK, Python", "LiteLLM", "LangChain", "LlamaIndex", "Vercel AI SDK"]) assert.match(out, new RegExp(`>${label}<`));
    assert.match(out, /pip install openai/);
    assert.match(out, /base_url/);
    assert.match(out, NOTICE);
    assert.doesNotMatch(out, /<option value="muse-wonder-1\.0"/, "the clients' code has no place for Muse Wonder's cap");
    assert.doesNotMatch(out, /pick Muse Spark 1\.2 or Muse Wonder 1\.0/, "so the notice doesn't point to it");
  });

  it("error-handling: the lab on top_p, with the body to fix and Send", () => {
    const out = render("error-handling");
    assert.match(out, />Error lab</);
    assert.match(out, />Retry simulator</);
    assert.match(out, /aria-pressed="true"[^>]*>top_p out of range</);
    assert.match(out, /&quot;top_p&quot;: 1\.5/);
    assert.match(out, /Meta answers/);
    assert.match(out, /<span>Send<\/span>/);
  });

  it("error-handling: the 413 is the page's recorded example, with nothing to send", () => {
    const out = html(
      createElement(ctx.DocsPageProvider, {
        page: page("error-handling"),
        children: createElement(lab.ErrorLab, { slug: "error-handling", caseId: "too-large" }),
      }),
    );
    assert.match(out, /aria-pressed="true"[^>]*>Body too large</);
    assert.match(out, /Recorded from the page/);
    assert.match(out, />413 Payload Too Large</);
    assert.match(out, /request body too large for background mode/);
    assert.match(out, /payload_too_large/);
    assert.match(out, /The page&#x27;s other 413: a store: true request too large to persist/);
    assert.doesNotMatch(out, /<span>Send<\/span>/, "never sent");
    assert.doesNotMatch(out, /MB of padding|uploads 4\.6 MB/);
  });

  it("api-reference: every endpoint listed, the console open on POST /v1/responses", () => {
    const out = render("api-reference");
    assert.equal((out.match(/aria-pressed="(true|false)"/g) ?? []).length, 20);
    assert.match(out, /aria-pressed="true"[^>]*><span class="pg-method pg-method-post">POST<\/span>/);
    assert.match(out, /pg-console/);
    assert.match(out, />Reference page</);
  });

  it("api-reference/models pages: list, retrieve, or both", () => {
    const both = render("api-reference/models");
    assert.match(both, /role="radiogroup" aria-label="Endpoint"/);
    const list = render("api-reference/models/list-models");
    assert.doesNotMatch(list, /aria-label="Endpoint"/);
    assert.match(list, /\/v1\/models<\/code>/);
    assert.match(list, />client</);
    const one = render("api-reference/models/retrieve-model");
    assert.match(one, /\/v1\/models\/muse-spark-1\.3-contributor<\/code>/);
    assert.match(one, />Another id\.\.\.</);
  });

  it("api-reference/models/schemas: both schemas with required badges", () => {
    const out = render("api-reference/models/schemas");
    assert.match(out, /List Models Response/);
    assert.match(out, />Model</);
    assert.equal((out.match(/>Required</g) ?? []).length, 6);
    assert.equal((out.match(/>Optional</g) ?? []).length, 1);
    assert.match(out, />Fetch and check</);
  });

  it("api-reference/status: one free, keyless call", () => {
    const out = render("api-reference/status");
    assert.match(out, />Check status</);
    assert.match(out, /No API key needed/);
  });
});

describe("section tabs", () => {
  it("fade only the edges that hide tabs", () => {
    assert.equal(tabs.fadeFor(0, 300, 300), null, "everything fits");
    assert.equal(tabs.fadeFor(0, 300.5, 300), null, "a subpixel overflow doesn't count");
    assert.equal(tabs.fadeFor(0, 520, 340), "end");
    assert.equal(tabs.fadeFor(90, 520, 340), "both");
    assert.equal(tabs.fadeFor(180, 520, 340), "start");
  });

  it("wrap the kit's tab row so it can fade, with every section's tab", () => {
    const out = render("quickstart");
    assert.match(out, /<div class="tabRow"><div class="pg-tabs" role="tablist" aria-label="Quickstart">/);
    assert.deepEqual([...out.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]).slice(0, 3), ["First API call", "Coding agent", "Muse Code"]);
  });
});

describe("start sources", () => {
  it("have no em dashes", () => {
    const dir = new URL("../", import.meta.url);
    const files = [
      ...readdirSync(dir).filter((f) => /\.(ts|tsx|css)$/.test(f)).map((f) => new URL(f, dir)),
      ...readdirSync(new URL("./", import.meta.url)).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => new URL(f, import.meta.url)),
      new URL("../../../../../lib/docs/demos/start.ts", import.meta.url),
    ];
    for (const f of files) assert.equal(readFileSync(f, "utf8").includes(EM_DASH), false, f.pathname);
  });
});

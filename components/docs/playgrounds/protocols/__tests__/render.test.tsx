/**
 * Every protocols DemoSpec server-rendered the way the docs page mounts it (its JSON props plus the slug, inside the
 * page context): what each demo shows before anything runs, every tab of every lab, and the schemas explorer with the
 * real Markdown of its page (the explorer fetches it in the browser; the test hands it over). The CSS module is the
 * only stand-in: a load hook turns *.module.css into class names. Nothing reaches the network; effects don't run.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/protocols/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

const ROOT = path.resolve(import.meta.dirname, "../../../../..");
const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

type Spec = import("@/lib/docs/demos/types").DemoSpec;
let html: (el: ReactElement) => string;
let demos: Record<string, Spec>;
let ctx: typeof import("@/components/docs/kit/DocsPageContext");

function clean(out: string): string {
  assert.equal(out.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/, "no key-like strings");
  return out;
}

before(async () => {
  const { renderToString } = await import("react-dom/server");
  html = (el) => clean(renderToString(el).replace(/<!-- -->/g, ""));
  ({ protocolsDemos: demos } = (await import("@/lib/docs/demos/protocols")) as unknown as { protocolsDemos: Record<string, Spec> });
  ctx = await import("@/components/docs/kit/DocsPageContext");
});

/** A page's demo as the docs page mounts it, with extra props merged in (a lab's start tab, a schema page's Markdown). */
function render(slug: string, extra: Record<string, unknown> = {}): string {
  const d = demos[slug];
  const page = { slug, title: slug, description: "", sourceUrl: `https://dev.meta.ai/docs/${slug}`, markdownUrl: `https://dev.meta.ai/docs/${slug}.md` };
  const demo = createElement(d.Component as ComponentType<Record<string, unknown>>, { ...(d.props as Record<string, unknown>), ...extra, slug });
  return html(createElement(ctx.DocsPageProvider, { page, children: demo }));
}

/** The rendered text without tags and with entities read back, for matching words split by <wbr> or escaped. */
const text = (out: string) =>
  out
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const md = (slug: string) => readFileSync(path.join(ROOT, "content/meta-docs/pages", `${slug}.md`), "utf8");

describe("protocols: one prompt, three formats", () => {
  it("offers the model, effort, presets and Send, with the static rows of the comparison", () => {
    const out = render("protocols");
    assert.match(out, NOTICE);
    assert.match(out, /<option value="low" selected="">Low<\/option>/);
    assert.match(out, />Capital of France<\/button>.*>TCP vs UDP<\/button>.*>With instructions<\/button>/);
    assert.match(out, /<span>Send to all three<\/span>/);
    for (const field of ["max_output_tokens", "max_completion_tokens", "max_tokens (required)", "instructions", "a developer message"]) {
      assert.ok(text(out).includes(field), field);
    }
    assert.match(text(out), /POST \/v1\/responses.*POST \/v1\/chat\/completions.*POST \/v1\/messages/s);
    assert.match(out, /<span>chat\/<wbr\/><\/span><span>completions<\/span>/, "the endpoint wraps after a slash, not inside a word");
    assert.match(out, /Scroll the table sideways for Chat Completions and Messages\./, "a narrow column says the table scrolls");
    assert.doesNotMatch(out, />Reply</, "rows that need a reply wait for a run");
    assert.match(out, /Request body Send will use/);
    assert.match(out, /role="tablist" aria-label="Format"/);
  });
});

describe("labs: every tab renders", () => {
  const labs = () => Object.entries(demos).filter(([, d]) => Array.isArray((d.props as { tabs?: unknown[] }).tabs));

  it("shows the tab bar, mounts only the open tab, and renders each tab on its own", () => {
    assert.ok(labs().length >= 8);
    for (const [slug, d] of labs()) {
      const tabs = (d.props as { tabs: Array<{ id: string; label: string; kind: string; props: { steps?: Array<{ title: string }> } }> }).tabs;
      const first = render(slug);
      if (tabs.length > 1) assert.match(first, /role="tablist" aria-label="Demos on this page"/, slug);
      for (const t of tabs) assert.ok(text(first).includes(t.label), `${slug}: tab ${t.label}`);
      for (const t of tabs) {
        const out = render(slug, { start: t.id });
        if (t.kind === "flow") {
          for (const step of t.props.steps ?? []) assert.ok(text(out).includes(step.title), `${slug}/${t.id}: step ${step.title}`);
          assert.match(out, /<span>(Run all steps|Run)<\/span>/, `${slug}/${t.id}: Run`);
        }
        assert.ok(out.includes("Show code") || out.includes(">Code</summary>") || out.includes("Send"), `${slug}/${t.id}: code or send`);
      }
      // Tabs that haven't opened aren't mounted, so their requests don't render yet.
      if (tabs.length > 1 && tabs[1].kind === "flow") {
        const later = tabs[1].props.steps?.[0]?.title;
        if (later && !tabs[0].props.steps?.some((s) => s.title === later)) assert.equal(text(first).includes(later), false, `${slug}: ${tabs[1].id} waits`);
      }
    }
  });

  it("shows the Responses flows' requests, stand-ins for later ids and the Contributor notice", () => {
    const out = render("protocols/responses");
    assert.match(out, NOTICE);
    assert.match(out, /For Standard mode, pick Muse Spark 1\.2, Muse Wonder 1\.0 or Muse Spark 1\.1 in the model menu\./, "the hint names the menu's Standard models");
    assert.match(out, /<label class="pg-label" for="[^"]+">Turn 2<\/label>/);
    assert.match(out, /value="What is the population of that city\?"/);
    assert.match(out, /\/v1\/responses\/resp_from_step_3</, "a step's path shows a stand-in for an id an earlier step returns");
    assert.doesNotMatch(out, /\{\{/, "no raw templates before a run");
    const bg = render("protocols/responses", { start: "background" });
    assert.match(bg, /\/v1\/responses\/resp_from_step_1\/cancel/);
    assert.doesNotMatch(bg, /<option value="muse-wonder-1\.0"/, "background flows keep to Muse Spark");
    assert.match(bg, /For Standard mode, pick Muse Spark 1\.2 or Muse Spark 1\.1 in the model menu\./);
    assert.doesNotMatch(text(bg), /pick[^.]*Muse Wonder/, "the notice doesn't offer a model the menu leaves out");
    const checks = render("protocols/responses", { start: "gotchas" });
    assert.ok(text(checks).includes('reasoning.effort "none"'));
    for (const title of ["An unknown include value", "A call_id over 64 characters", "A reasoning item right before a user message", "Answer text right before a function_call", 'truncation "auto"']) {
      assert.ok(text(checks).includes(title), title);
    }
    assert.match(text(checks), /counts toward the live demos' per-minute limit/);
  });

  it("puts the kit's playgrounds in their tabs with the page's props", () => {
    const chat = render("protocols/chat-completions");
    assert.doesNotMatch(chat, /aria-label="Protocol"/, "Chat Completions only");
    assert.match(chat, />Code review \(developer\)<\/button>/);
    const tools = render("protocols/chat-completions", { start: "tools" });
    assert.match(tools, /get_weather/);
    const json = render("protocols/chat-completions", { start: "json" });
    assert.match(json, />Extract a place<\/button>/);
    const messages = render("protocols/messages");
    assert.match(messages, /You are a concise geography tutor\./);
  });
});

describe("consoles", () => {
  it("loads the first preset into the API console and lists the rest as pills", () => {
    const out = render("api-reference/responses/create-response");
    assert.match(out, /role="group" aria-label="Request"/);
    for (const label of ["Plain text", "Function tool", "Web search", "Background", "PDF (pick one)"]) assert.ok(out.includes(`>${label}</button>`), label);
    assert.match(out, /pg-method-post">POST</);
    assert.match(out, /value="responses"/);
    assert.match(out, /muse-spark-1\.3-contributor/);
    assert.match(out, NOTICE);
  });

  it("offers the visitor's own ids on the path consoles", () => {
    const out = render("api-reference/responses/retrieve-response", { start: "console" });
    assert.match(out, /pg-method-get">GET</);
    assert.match(out, /value="responses\/\{response_id\}"/);
    assert.match(out, /Create a response first/);
  });

  it("covers Chat Completions and Messages bodies", () => {
    const chat = render("api-reference/chat-completions/create-chat-completion");
    assert.match(chat, />Tool result<\/button>/);
    assert.match(chat, /value="chat\/completions"/);
    const msg = render("api-reference/messages/create-message");
    assert.match(msg, />Count tokens<\/button>/);
    assert.match(msg, /value="messages"/);
  });
});

describe("schemas explorer", () => {
  for (const [slug, count, first] of [
    ["api-reference/responses/schemas", 146, "Create Response"],
    ["api-reference/chat-completions/schemas", 43, "Create Chat Completion Request"],
    ["api-reference/messages/schemas", 53, "Anthropic Message Request"],
  ] as const) {
    it(`lists all ${count} schemas on ${slug} and opens the first starter with its live example`, () => {
      const out = render(slug, { markdown: md(slug) });
      assert.match(out, new RegExp(`placeholder="Search ${count} schemas"`), "a placeholder short enough not to clip");
      assert.equal((out.match(/data-anchor="/g) ?? []).length, count, "one list item per schema");
      assert.match(out, new RegExp(`role="heading" aria-level="3" tabindex="-1">${first}</p>`));
      assert.match(out, /Live example: /);
      assert.match(out, /<span>Run example<\/span>/);
      // A request target is checked as written, before anything runs.
      assert.match(out, /fields? match(es)? the table/);
      assert.match(out, /role="group" aria-label="Start with"/);
      assert.match(out, NOTICE);
    });
  }

  it("renders Meta's cell Markdown as code, links and in-place schema buttons", () => {
    const out = render("api-reference/responses/schemas", { markdown: md("api-reference/responses/schemas"), initial: "response" });
    assert.match(out, /<code class="docs-code-inline">string<\/code>/);
    assert.match(out, /<button type="button" class="refButton"><code class="docs-code-inline">Metadata<\/code><\/button>/);
    assert.match(out, /Used by/);
    assert.doesNotMatch(out, /\{#/, "no raw anchors");
  });

  it("points a schema without its own example at a parent that has one", () => {
    const out = render("api-reference/responses/schemas", { markdown: md("api-reference/responses/schemas"), initial: "annotation" });
    assert.match(out, /See it live inside/);
    // Named only in code ("`array of InputTextContentParam | ...`"), it still finds the parent that runs live.
    const param = render("api-reference/responses/schemas", { markdown: md("api-reference/responses/schemas"), initial: "input-text-content-param" });
    assert.match(param, /See it live inside/);
  });

  it("says why a schema has no live example only when there is a reason", () => {
    const page = { markdown: md("api-reference/responses/schemas") };
    assert.match(render("api-reference/responses/schemas", { ...page, initial: "response-error-code" }), /don&#x27;t set out to cause a failure or a refusal/);
    assert.match(render("api-reference/responses/schemas", { ...page, initial: "response-prompt-variables" }), /don&#x27;t run prompt templates/);
    assert.match(render("api-reference/responses/schemas", { ...page, initial: "computer-tool-call-output" }), /No live example for this one\./);
  });

  it("keeps the background example on Muse Spark and fills in the code before a run", () => {
    const out = render("api-reference/responses/schemas", { markdown: md("api-reference/responses/schemas"), initial: "cancel-response-response" });
    assert.match(out, /Live example: Cancelling a background response/);
    assert.doesNotMatch(out, /<option value="muse-wonder-1\.0"/, "no Muse Wonder for a background run");
    const other = render("api-reference/responses/schemas", { markdown: md("api-reference/responses/schemas"), initial: "response" });
    assert.match(other, /<option value="muse-wonder-1\.0"/, "other examples keep the whole menu");
  });

  it("checks the Chat mixin schemas on a request that carries their fields", () => {
    const out = render("api-reference/chat-completions/schemas", { markdown: md("api-reference/chat-completions/schemas"), initial: "model-response-properties" });
    assert.match(out, /Live example: A plain chat completion/);
    assert.match(text(out), /2 fields match the table/);
  });
});

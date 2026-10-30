/**
 * The docs renderer: Meta's Markdown conventions (tabs, callouts, cards, anchors, tables), the em dash swap, raw HTML
 * kept as text, and link mapping, on small samples and over the whole mirror. Renders with react-dom/server; the
 * router and Link are stand-ins.
 *   npx tsx --test --experimental-test-module-mocks lib/docs/__tests__/markdown.test.tsx
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Block, DocsDoc } from "@/lib/docs/markdown";

mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/docs/overview" },
});
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

let md: typeof import("@/lib/docs/markdown");
let text: typeof import("@/lib/docs/markdown-text");
let render: typeof import("@/lib/docs/markdown-react");
let server: typeof import("react-dom/server");
let pages: typeof import("@/lib/docs/pages");

before(async () => {
  md = await import("@/lib/docs/markdown");
  text = await import("@/lib/docs/markdown-text");
  render = await import("@/lib/docs/markdown-react");
  server = await import("react-dom/server");
  pages = await import("@/lib/docs/pages");
});

const parse = (src: string) => md.parseDocsMarkdown(src);
const html = (blocks: Block[]) => server.renderToStaticMarkup(createElement("div", null, render.renderBlocks(blocks)));
const all = (doc: DocsDoc) => [...doc.lead, ...doc.body];

describe("code tabs", () => {
  it("turns consecutive bold-labelled fences into one tab group", () => {
    const doc = parse(
      "# T\n\n**Python (OpenAI SDK)**\n\n```python\nprint(1)\n```\n\n**curl**\n\n```shell\ncurl https://api.meta.ai/v1/models\n```\n\nAfter.\n",
    );
    const code = all(doc).filter((b) => b.k === "code");
    assert.equal(code.length, 1);
    assert.equal(code[0].k === "code" && code[0].tabs.length, 2);
    if (code[0].k !== "code") return;
    assert.deepEqual(
      code[0].tabs.map((t) => [t.label, t.lang]),
      [
        ["Python (OpenAI SDK)", "python"],
        ["curl", "shell"],
      ],
    );
    assert.equal(code[0].tabs[1].request?.path, "models");
    assert.equal(code[0].tabs[0].request, null);
    assert.ok(all(doc).some((b) => b.k === "paragraph"), "the paragraph after the group stays a paragraph");
  });

  it("keeps a lone labelled fence as one block named by its label", () => {
    const doc = parse("# T\n\n**System prompt**\n\n```text\nYou are helpful.\n```\n");
    const [code] = all(doc);
    assert.equal(code.k, "code");
    if (code.k === "code") assert.deepEqual([code.tabs.length, code.tabs[0].label], [1, "System prompt"]);
  });

  it("leaves labels that end with a colon as prose, like dev.meta.ai", () => {
    const doc = parse("# T\n\n**macOS and Linux:**\n\n```shell\nexport A=1\n```\n");
    const [p, code] = all(doc);
    assert.equal(p.k, "paragraph");
    assert.equal(code.k, "code");
    if (code.k === "code") assert.equal(code.tabs[0].label, null);
  });

  it("renders diagram fences as plain preformatted text", () => {
    const doc = parse("# T\n\n```diagram\n[a] -> [b]\n```\n");
    assert.equal(all(doc)[0].k, "diagram");
    assert.match(html(all(doc)), /<pre class="docs-diagram"[^>]*>\[a\] -&gt; \[b\]<\/pre>/);
  });
});

describe("callouts", () => {
  for (const kind of ["NOTE", "TIP", "WARNING", "IMPORTANT", "CAUTION"]) {
    it(`reads > **${kind}: Title** as a ${kind.toLowerCase()} callout`, () => {
      const doc = parse(`# T\n\n> **${kind}: Use \`tools\`, not functions**\n>\n> Body with a [link](https://dev.meta.ai/docs/tool-calling).\n`);
      const [c] = all(doc);
      assert.equal(c.k, "callout");
      if (c.k !== "callout") return;
      assert.equal(c.kind, kind.toLowerCase());
      assert.equal(md.plainText(c.title), "Use tools, not functions");
      assert.equal(c.children.length, 1);
      const out = html([c]);
      assert.match(out, new RegExp(`docs-callout docs-callout-${kind.toLowerCase()}`));
      assert.match(out, /<p class="docs-callout-title">Use <code class="docs-code-inline">tools<\/code>, not functions<\/p>/);
      assert.match(out, /href="\/docs\/tool-calling"/);
    });
  }

  it("keeps other blockquotes as quotes", () => {
    const doc = parse("# T\n\n> **Note:** this is a quote.\n\n> Plain words.\n");
    assert.deepEqual(all(doc).map((b) => b.k), ["quote", "quote"]);
  });
});

describe("cards", () => {
  it("draws a link list with capitalized descriptions as cards", () => {
    const doc = parse(
      "# T\n\n- [Quickstart](https://dev.meta.ai/docs/quickstart): Set your key and call the API.\n- [GitHub](https://github.com/meta): Code \u2014 and more.\n",
    );
    const [cards] = all(doc);
    assert.equal(cards.k, "cards");
    if (cards.k !== "cards") return;
    assert.deepEqual(
      cards.items.map((c) => [c.href, c.external, md.plainText(c.title), md.plainText(c.description)]),
      [
        ["/docs/quickstart", false, "Quickstart", "Set your key and call the API."],
        ["https://github.com/meta", true, "GitHub", "Code, and more."],
      ],
    );
    const out = html([cards]);
    assert.match(out, /<ul class="docs-cards">/);
    assert.match(out, /target="_blank" rel="noopener noreferrer"/);
  });

  it("draws the cookbook index's recipes as tinted tiles by section, and a lone outside link as a pill", () => {
    const doc = parse(
      "# Cookbook\n\n## Meta Model API {#meta-model-api}\n\n[View on GitHub](https://github.com/meta-models/meta-model-cookbook)\n\n### Agent patterns {#agent-patterns}\n\n- [Basic agent loop](https://dev.meta.ai/docs/cookbook/basic-agent-loop): Wire up the loop.\n\n### Use cases {#use-cases}\n\n- [Chart analysis](https://dev.meta.ai/docs/cookbook/perception-chart-analysis): Read charts.\n",
    );
    const out = server.renderToStaticMarkup(createElement("div", null, render.renderBlocks(doc.body, "b", { slug: "cookbook" })));
    assert.match(out, /<ul class="docs-cards docs-cards-recipe docs-recipe-purple">/);
    assert.match(out, /<ul class="docs-cards docs-cards-recipe docs-recipe-orange">/);
    assert.match(out, /<p class="docs-p docs-p-action"><a href="https:\/\/github\.com\/meta-models\/meta-model-cookbook" class="docs-btn docs-btn-secondary docs-btn-xs"[^>]*target="_blank"/);
    // Elsewhere, cards keep the overview's style, and an internal lone link stays a link.
    const elsewhere = server.renderToStaticMarkup(createElement("div", null, render.renderBlocks(doc.body, "b", { slug: "overview" })));
    assert.doesNotMatch(elsewhere, /docs-cards-recipe/);
    assert.equal(render.recipeTint({ slug: "cookbook", section: "Run locally" }), "green");
    assert.equal(render.recipeTint({ slug: "cookbook", section: "Something new" }), "blue");
    const schema = parse("# T\n\n[`Response`](https://dev.meta.ai/docs/api-reference/responses/schemas#response)\n");
    assert.doesNotMatch(html(schema.lead), /docs-btn/);
  });

  it("keeps lowercase See also lists as lists", () => {
    const doc = parse("# T\n\n- [Models](https://dev.meta.ai/docs/models): every model line\n- [Pricing](https://dev.meta.ai/docs/pricing-rate-limits): rates\n");
    assert.equal(all(doc)[0].k, "list");
  });

  it("needs every item to be a link with a description", () => {
    const doc = parse("# T\n\n- [Models](https://dev.meta.ai/docs/models): Every model.\n- Plain item\n");
    assert.equal(all(doc)[0].k, "list");
  });
});

describe("headings and anchors", () => {
  it("uses each heading's {#id}, falls back to a slug, and keeps ids unique", () => {
    const doc = parse("# Page title {#page}\n\nLead.\n\n## First {#first}\n\n### Sub one\n\n#### Deep {#deep}\n\n## Sub one\n");
    assert.equal(doc.titleId, "page");
    assert.equal(doc.titleText, "Page title");
    assert.deepEqual(doc.toc, [
      { id: "first", text: "First", depth: 2 },
      { id: "sub-one", text: "Sub one", depth: 3 },
      { id: "sub-one-1", text: "Sub one", depth: 2 },
    ]);
    const out = html(doc.body);
    assert.match(out, /<h2 id="first" class="docs-h docs-h2">First<a class="docs-anchor" href="#first"/);
    assert.match(out, /<h4 id="deep"/);
    assert.doesNotMatch(out, /\{#/);
  });

  it("puts the lead before the first H2, or the opening paragraphs when there is none", () => {
    const withH2 = parse("# T\n\nOne.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n## Next {#next}\n\nBody.\n");
    assert.deepEqual(withH2.lead.map((b) => b.k), ["paragraph", "table"]);
    assert.equal(withH2.body[0].k, "heading");
    const noH2 = parse("# T\n\nOne.\n\nTwo.\n\n- [A](https://dev.meta.ai/docs/a)\n\nEnd.\n");
    assert.deepEqual(noH2.lead.map((b) => b.k), ["paragraph", "paragraph"]);
    assert.deepEqual(noH2.body.map((b) => b.k), ["list", "paragraph"]);
  });
});

describe("em dashes", () => {
  it("swaps them in prose and headings, never in code", () => {
    const doc = parse(
      "# Step 1 \u2014 Connect {#s}\n\nSame models \u2014 same auth, and `a \u2014 b` stays.\n\n## Why\u2014now {#w}\n\n```text\nkeep \u2014 this\n```\n",
    );
    assert.equal(doc.titleText, "Step 1: Connect");
    const [p] = doc.lead;
    assert.equal(p.k === "paragraph" && md.plainText(p.children), "Same models, same auth, and a \u2014 b stays.");
    assert.equal(doc.toc[0].text, "Why: now");
    const code = doc.body.find((b) => b.k === "code");
    assert.ok(code?.k === "code" && code.tabs[0].code.includes("\u2014"));
  });

  it("reads a dash right after inline code as a colon: HTTP 200: OK", () => {
    const doc = parse("# T\n\n`HTTP 200` \u2014 OK\n\nThe `model` field \u2014 required \u2014 names it.\n");
    const [first, second] = doc.lead;
    assert.equal(first.k === "paragraph" && md.plainText(first.children), "HTTP 200: OK");
    // A dash that doesn't follow the code directly is prose as usual.
    assert.equal(second.k === "paragraph" && md.plainText(second.children), "The model field, required, names it.");
    assert.equal(text.swapEmDashesAfterCode(" \u2014 OK"), ": OK");
    assert.equal(text.swapEmDashesAfterCode(" and \u2014 more"), " and, more");
    // Copy page reads the same way.
    assert.equal(text.markdownForCopy("`HTTP 200` \u2014 OK", "x"), "`HTTP 200`: OK");
  });

  it("swapEmDashes handles spacing and doubled punctuation", () => {
    assert.equal(text.swapEmDashes("a \u2014 b"), "a, b");
    assert.equal(text.swapEmDashes("a\u2014b"), "a, b");
    assert.equal(text.swapEmDashes("end \u2014\nnext"), "end, next");
    assert.equal(text.swapEmDashes("x, \u2014 y"), "x, y");
    assert.equal(text.swapEmDashes("Title \u2014 sub", "heading"), "Title: sub");
  });
});

describe("raw HTML and links", () => {
  it("shows raw HTML as text and never injects it", () => {
    const doc = parse("# T\n\n<div onclick=\"x()\">raw</div>\n\nInline <b>bold</b> and <script>alert(1)</script> tags.\n");
    const out = html(all(doc));
    assert.doesNotMatch(out, /<div onclick/);
    assert.doesNotMatch(out, /<b>|<script>/);
    assert.match(out, /&lt;div onclick=&quot;x\(\)&quot;&gt;raw&lt;\/div&gt;/);
    assert.match(out, /Inline &lt;b&gt;bold&lt;\/b&gt; and &lt;script&gt;alert\(1\)&lt;\/script&gt; tags\./);
  });

  it("maps dev.meta.ai docs into /docs, the dashboard to /dashboard, and opens other sites in a new tab", () => {
    const doc = parse(
      "# T\n\n[a](https://dev.meta.ai/docs/tool-calling#chat-completions-tool-calling) [b](https://dev.meta.ai/platform) [c](https://huggingface.co/meta) [d](mailto:x@y.z)\n",
    );
    const out = html(doc.lead);
    assert.match(out, /<a href="\/docs\/tool-calling#chat-completions-tool-calling" class="docs-link">a<\/a>/);
    assert.match(out, /<a href="\/dashboard" class="docs-link">b<\/a>/);
    assert.match(out, /<a href="https:\/\/huggingface.co\/meta" class="docs-link" target="_blank" rel="noopener noreferrer">c/);
    assert.match(out, /<a href="mailto:x@y.z" class="docs-link">d<\/a>/);
  });

  it("hotlinks images lazily with their alt text", () => {
    const doc = parse("# T\n\n![A chart \u2014 annotated](https://dev.meta.ai/docs-assets/x.png)\n");
    const out = html(doc.lead);
    assert.match(out, /<figure class="docs-figure"><img src="https:\/\/dev.meta.ai\/docs-assets\/x.png" alt="A chart, annotated" loading="lazy"/);
  });
});

describe("tables", () => {
  it("drops the head when the header row is empty, like the At a glance tables", () => {
    const doc = parse("# T\n\n| | |\n|---|---|\n| **Base URL** | `https://api.meta.ai/v1` |\n");
    const [t] = all(doc);
    assert.equal(t.k === "table" && t.head, null);
    const out = html(all(doc));
    assert.doesNotMatch(out, /<thead>/);
    assert.match(out, /<td><strong>Base URL<\/strong><\/td><td><code class="docs-code-inline">https:\/\/api.meta.ai\/v1<\/code><\/td>/);
  });

  it("keeps a real header row", () => {
    const doc = parse("# T\n\n| Model | Input |\n|---|:-:|\n| Wonder | Text |\n");
    const out = html(all(doc));
    assert.match(out, /<thead><tr><th>Model<\/th><th style="text-align:center">Input<\/th><\/tr><\/thead>/);
  });
});

describe("copy page", () => {
  it("removes anchors, makes links absolute, and leaves code alone", () => {
    const src = "# Title {#t}\n\nSee [x](/docs/a) and [y](#here) \u2014 now `a \u2014 b`.\n\n```md\n## Kept {#kept}\n```\n";
    const out = text.markdownForCopy(src, "tool-calling");
    assert.equal(
      out,
      "# Title\n\nSee [x](https://dev.meta.ai/docs/a) and [y](https://dev.meta.ai/docs/tool-calling#here), now `a \u2014 b`.\n\n```md\n## Kept {#kept}\n```\n",
    );
  });
});

describe("the whole mirror", () => {
  it("parses every page with a title, unique ids, and no em dash outside code", () => {
    const strip = (blocks: Block[]): unknown =>
      blocks.map((b) => {
        if (b.k === "code" || b.k === "diagram") return null;
        if (b.k === "list") return b.items.map(strip);
        if (b.k === "callout") return [b.title, strip(b.children)];
        if (b.k === "quote") return strip(b.children);
        return b;
      });
    const withoutCodeSpans = (json: string) => json.replace(/\{"k":"code","text":"(?:[^"\\]|\\.)*"\}/g, "");
    for (const page of pages.DOCS_PAGES) {
      const doc = parse(pages.docsMarkdown(page.slug));
      assert.ok(doc.titleText, `${page.slug} has an H1`);
      const ids = doc.toc.map((t) => t.id);
      assert.equal(new Set(ids).size, ids.length, `${page.slug} has unique anchors`);
      const prose = withoutCodeSpans(JSON.stringify([doc.title, strip(all(doc))]));
      assert.ok(!prose.includes("\u2014"), `${page.slug} has an em dash in prose`);
    }
  });

  it("finds the overview's Explore the docs cards and callouts", () => {
    const doc = parse(pages.docsMarkdown("overview"));
    const cards = all(doc).filter((b) => b.k === "cards");
    assert.ok(cards.length >= 2);
    assert.ok(all(doc).some((b) => b.k === "callout" && b.kind === "note"));
    assert.equal(doc.toc[0].id, "muse-code");
  });
});

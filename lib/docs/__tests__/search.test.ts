/**
 * The docs search index (what /docs/search.json serves) and the palette's matcher.
 *   npx tsx --test --experimental-test-module-mocks lib/docs/__tests__/search.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSearchIndex, headingsFromMarkdown, matchScore, normalizeQuery, searchDocs } from "@/lib/docs/search";
import { DOCS_PAGES, docsMarkdown, docsNav } from "@/lib/docs/pages";

describe("building the index", () => {
  it("collects H2 and H3 anchors outside code, without Markdown and em dashes", () => {
    const md = [
      "# Title {#title}",
      "## Step 1 \u2014 Connect `tools` [here](https://x) {#step-1}",
      "```md",
      "## Not a heading {#nope}",
      "```",
      "### Use \\_underscores\\_ {#sub}",
      "#### Too deep {#deep}",
      "## No anchor",
    ].join("\n");
    assert.deepEqual(headingsFromMarkdown(md), [
      { id: "step-1", text: "Step 1: Connect tools here", depth: 2 },
      { id: "sub", text: "Use _underscores_", depth: 3 },
    ]);
  });

  it("names each page's sidebar section and label", () => {
    const index = buildSearchIndex({
      pages: [
        { slug: "protocols", title: "Choosing an API protocol", description: "Pick one \u2014 any.", listSection: "Protocols" },
        { slug: "cookbook/x", title: "Recipe", description: "R", listSection: "Cookbook" },
      ],
      nav: [{ title: "Protocols", items: [{ label: "Choosing an API", href: "/docs/protocols" }] }],
      markdown: () => "# T\n\n## A {#a}\n",
    });
    assert.deepEqual(index.pages[0], {
      slug: "protocols",
      href: "/docs/protocols",
      title: "Choosing an API protocol",
      description: "Pick one, any.",
      section: "Protocols",
      headings: [{ id: "a", text: "A", depth: 2 }],
      navLabel: "Choosing an API",
    });
    assert.equal(index.pages[1].section, "Cookbook", "pages outside the sidebar keep their llms.txt section");
    assert.equal(index.pages[1].navLabel, undefined);
  });

  it("indexes the whole mirror", () => {
    const index = buildSearchIndex({ pages: DOCS_PAGES, nav: docsNav(), markdown: docsMarkdown });
    assert.equal(index.pages.length, DOCS_PAGES.length);
    const headings = index.pages.reduce((n, p) => n + p.headings.length, 0);
    assert.ok(headings > 1000, `${headings} headings`);
    assert.ok(!JSON.stringify(index).includes("\u2014"), "no em dashes in the index");
    assert.equal(index.pages.find((p) => p.slug === "tool-calling")?.section, "Capabilities");
  });
});

describe("matching", () => {
  it("scores exact and prefix matches over word and letter matches", () => {
    assert.equal(normalizeQuery("  Tool-Calling! "), "tool calling");
    const exact = matchScore("tool calling", "Tool calling");
    const prefix = matchScore("tool", "Tool calling");
    const inside = matchScore("calling", "Tool calling");
    const words = matchScore("call tool", "Tool calling");
    const letters = matchScore("tlcl", "Tool calling");
    assert.ok(exact > prefix && prefix > inside && inside > words && words > letters && letters > 0, `${[exact, prefix, inside, words, letters]}`);
    assert.equal(matchScore("xyzzy", "Tool calling"), 0);
  });

  it("finds pages and headings across the mirror", () => {
    const index = buildSearchIndex({ pages: DOCS_PAGES, nav: docsNav(), markdown: docsMarkdown });
    const top = (q: string) => searchDocs(index, q, 5);
    assert.equal(top("tool calling")[0].href, "/docs/tool-calling");
    assert.equal(top("structured output")[0].href, "/docs/structured-output");
    assert.ok(top("prompt cachng").some((h) => h.href.startsWith("/docs/prompt-caching")), "a typo still lands");
    const heading = searchDocs(index, "function name rules", 10).find((h) => h.kind === "heading");
    assert.equal(heading?.href, "/docs/tool-calling#function-name-rules");
    assert.equal(heading?.context, "Capabilities · Tool calling");
    assert.deepEqual(searchDocs(index, "   "), []);
    const hits = searchDocs(index, "responses", 30);
    assert.equal(new Set(hits.map((h) => h.href)).size, hits.length, "no duplicate hits");
  });
});

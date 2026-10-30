/**
 * Previous and next: the sidebar's order, then the mirrored pages the sidebar doesn't list.
 *   npx tsx --test --experimental-test-module-mocks components/docs/page/__tests__/sequence.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { neighbors, pageSequence } from "@/components/docs/page/sequence";
import { DOCS_PAGES, docsNav } from "@/lib/docs/pages";

describe("page sequence", () => {
  it("follows the sidebar, groups included, then the rest in pages.json order", () => {
    const seq = pageSequence(
      [
        { title: "Start", items: [{ label: "Overview", href: "/docs/overview" }, { label: "Dashboard", href: "/dashboard" }] },
        { title: "Cookbook", items: [{ label: "Group", items: [{ label: "Overview", href: "/docs/b#x" }, { label: "Help", href: "https://dev.meta.ai/help", external: true }] }] },
      ],
      [
        { slug: "a-recipe", title: "A recipe" },
        { slug: "b", title: "Bee" },
        { slug: "overview", title: "Build with Meta" },
      ],
    );
    assert.deepEqual(seq, [
      { slug: "overview", title: "Build with Meta" },
      { slug: "b", title: "Bee" },
      { slug: "a-recipe", title: "A recipe" },
    ]);
    assert.deepEqual(neighbors(seq, "b"), { prev: seq[0], next: seq[2] });
    assert.deepEqual(neighbors(seq, "overview").prev, null);
    assert.deepEqual(neighbors(seq, "missing"), { prev: null, next: null });
  });

  it("covers every mirrored page once, starting with the overview", () => {
    const seq = pageSequence(docsNav(), DOCS_PAGES);
    assert.equal(seq.length, DOCS_PAGES.length);
    assert.equal(new Set(seq.map((e) => e.slug)).size, seq.length);
    assert.equal(seq[0].slug, "overview");
    assert.equal(neighbors(seq, "overview").next?.slug, "quickstart");
  });
});

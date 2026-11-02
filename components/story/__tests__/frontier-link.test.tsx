/**
 * The frontier section links /offline only while STORY_PAGES is on, the flag that page reads, so it never points at a 404.
 *
 *   npx tsx --test components/story/__tests__/frontier-link.test.tsx
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FrontierSection } from "@/components/story/FrontierSection";

const saved = process.env.STORY_PAGES;

describe("FrontierSection's /offline link", () => {
  afterEach(() => {
    if (saved === undefined) delete process.env.STORY_PAGES;
    else process.env.STORY_PAGES = saved;
  });

  it("is there only with STORY_PAGES on", () => {
    delete process.env.STORY_PAGES;
    assert.ok(!renderToStaticMarkup(<FrontierSection linkOffline />).includes('href="/offline"'));
    process.env.STORY_PAGES = "1";
    assert.ok(renderToStaticMarkup(<FrontierSection linkOffline />).includes('href="/offline"'));
    assert.ok(!renderToStaticMarkup(<FrontierSection />).includes('href="/offline"'));
  });
});

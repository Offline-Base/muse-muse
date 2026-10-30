/**
 * Links in the mirror: Meta's old paths land on the pages they redirect to, and every link into /docs names a page
 * and an anchor the mirror has.
 *   npx tsx --test --experimental-test-module-mocks lib/docs/__tests__/pages.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDocsMarkdown, type Block, type Inline } from "@/lib/docs/markdown";
import { htmlHeadings } from "@/lib/docs/mirror-parse";
import { DOCS_PAGES, docsHref, docsMarkdown } from "@/lib/docs/pages";

function linksIn(blocks: Block[]): string[] {
  const out: string[] = [];
  const inline = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.k === "link") out.push(n.href);
      if ("children" in n) inline(n.children);
    }
  };
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.k === "paragraph" || b.k === "inline" || b.k === "heading") inline(b.children);
      else if (b.k === "list") b.items.forEach(walk);
      else if (b.k === "callout") {
        inline(b.title);
        walk(b.children);
      } else if (b.k === "quote") walk(b.children);
      else if (b.k === "cards") for (const c of b.items) out.push(c.href);
      else if (b.k === "table") for (const row of [...(b.head ? [b.head] : []), ...b.rows]) row.forEach(inline);
    }
  };
  walk(blocks);
  return out;
}

describe("docsHref", () => {
  it("sends Meta's old paths to the pages they redirect to, keeping the link's anchor", () => {
    assert.deepEqual(docsHref("https://dev.meta.ai/docs/features/chat-completion#streaming"), {
      href: "/docs/protocols/chat-completions#streaming",
      external: false,
    });
    assert.deepEqual(docsHref("https://dev.meta.ai/docs/features/responses"), { href: "/docs/protocols/responses", external: false });
    assert.equal(docsHref("https://dev.meta.ai/docs/getting-started/pricing-rate-limits").href, "/docs/pricing-rate-limits");
    assert.equal(docsHref("/docs/features/tool-calling#guidelines").href, "/docs/tool-calling#guidelines");
    // The Glimmer serving pages became sections of the deploy page.
    assert.equal(docsHref("https://dev.meta.ai/docs/muse-glimmer/vllm").href, "/docs/muse-glimmer/deploy#vllm");
    assert.equal(docsHref("https://dev.meta.ai/docs/muse-glimmer/llama-cpp").href, "/docs/muse-glimmer/deploy#llama-cpp");
    // Paths that aren't mirrored or redirected stay on dev.meta.ai.
    assert.deepEqual(docsHref("https://dev.meta.ai/docs/features/nothing-here"), {
      href: "https://dev.meta.ai/docs/features/nothing-here",
      external: true,
    });
  });

  it("every link into /docs names a mirrored page and an anchor that page has", () => {
    const ids = new Map<string, Set<string>>();
    const docs = DOCS_PAGES.map((p) => {
      const doc = parseDocsMarkdown(docsMarkdown(p.slug));
      const set = new Set<string>([doc.titleId]);
      for (const b of [...doc.lead, ...doc.body]) if (b.k === "heading") set.add(b.id);
      ids.set(p.slug, set);
      return { slug: p.slug, doc };
    });
    const broken: string[] = [];
    let checked = 0;
    for (const { slug, doc } of docs) {
      for (const href of linksIn([...doc.lead, ...doc.body])) {
        const m = href.match(/^\/docs\/([^#]+)(?:#(.+))?$/);
        if (!m) {
          if (/^https:\/\/dev\.meta\.ai\/docs\//.test(href)) broken.push(`${slug}: ${href} stays on dev.meta.ai`);
          continue;
        }
        checked++;
        const target = ids.get(m[1]);
        if (!target) broken.push(`${slug}: ${href} (no such page)`);
        else if (m[2] && !target.has(decodeURIComponent(m[2]))) broken.push(`${slug}: ${href} (no such anchor)`);
      }
    }
    assert.ok(checked > 1000, `${checked} links checked`);
    assert.deepEqual(broken, []);
  });
});

describe("htmlHeadings", () => {
  it("reads h1 to h6 with their ids, skipping React's generated ones", () => {
    const html = '<h2 id="a">A</h2><h5 id="executorch-dflash-export">DFlash <code>export</code></h5><h6 id="z">Z</h6><h3 id="_r1">Dialog</h3>';
    assert.deepEqual(htmlHeadings(html), [
      { level: 2, id: "a", text: "A" },
      { level: 5, id: "executorch-dflash-export", text: "DFlash export" },
      { level: 6, id: "z", text: "Z" },
    ]);
  });
});

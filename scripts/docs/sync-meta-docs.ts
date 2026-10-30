/**
 * Mirrors Meta's Model API docs (https://dev.meta.ai/docs) into content/meta-docs/ for the /docs section.
 *
 *   npm run docs:sync [-- --only tool-calling,sam/overview]
 *
 * 1. The page list comes from https://dev.meta.ai/llms.txt, which links a Markdown copy of every docs page.
 * 2. The sidebar (sections, links and collapsible groups) comes from one page's server-rendered HTML.
 * 3. Each page's Markdown is saved with the live page's heading anchors added ("## Title {#id}"), read from its HTML.
 *
 * One request at a time with a short pause, like a reader clicking through. HTML is cached in .data/meta-docs/ so a
 * rerun after a failure only fetches what's missing; pass --fresh to refetch everything. No keys, no model calls.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DOCS_ORIGIN,
  htmlHeadings,
  injectHeadingIds,
  parseLlmsTxt,
  parseSideNav,
  slugOfDocsUrl,
  type NavSection,
} from "@/lib/docs/mirror-parse";

const OUT = path.join(process.cwd(), "content/meta-docs");
const PAGES_DIR = path.join(OUT, "pages");
const CACHE = path.join(process.cwd(), ".data/meta-docs");
const USER_AGENT = "MuseMuse-docs-mirror/0.1 (https://muse-muse.vercel.app/docs)";
const PAUSE_MS = 250;

const fresh = process.argv.includes("--fresh");
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > 0 ? new Set((process.argv[onlyArg + 1] ?? "").split(",").filter(Boolean)) : null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    await sleep(PAUSE_MS);
    let res: Response;
    try {
      res = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(attempt * 2_000);
      continue;
    }
    if (res.ok) return res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(Number(res.headers.get("retry-after")) * 1000 || attempt * 3_000);
      continue;
    }
    throw new Error(`${url}: HTTP ${res.status}`);
  }
}

async function cachedHtml(slug: string): Promise<string> {
  const file = path.join(CACHE, `${slug.replace(/\//g, "__")}.html`);
  if (!fresh && existsSync(file)) return readFile(file, "utf8");
  const html = await get(`${DOCS_ORIGIN}/docs/${slug}`);
  await writeFile(file, html);
  return html;
}

export interface MirrorPage {
  slug: string;
  /** The page's own H1. */
  title: string;
  /** Its title in llms.txt, often longer. */
  listTitle: string;
  description: string;
  /** The llms.txt section it's listed under. */
  listSection: string;
  sourceUrl: string;
  markdownUrl: string;
  headingsWithIds: number;
  headings: number;
}

async function main() {
  await mkdir(PAGES_DIR, { recursive: true });
  await mkdir(CACHE, { recursive: true });

  const llms = await get(`${DOCS_ORIGIN}/llms.txt`);
  const entries = parseLlmsTxt(llms).filter((e) => slugOfDocsUrl(e.url) && e.url.endsWith(".md"));
  console.log(`llms.txt lists ${entries.length} docs pages.`);

  const nav: NavSection[] = parseSideNav(await cachedHtml("overview"));
  if (!nav.length) throw new Error("Couldn't read the docs sidebar from /docs/overview.");
  console.log(`Sidebar: ${nav.map((s) => s.title).join(", ")}.`);

  const previous: MirrorPage[] = existsSync(path.join(OUT, "pages.json"))
    ? (JSON.parse(await readFile(path.join(OUT, "pages.json"), "utf8")) as MirrorPage[])
    : [];
  const pages = new Map(previous.map((p) => [p.slug, p]));
  const failed: string[] = [];
  let done = 0;
  for (const entry of entries) {
    const slug = slugOfDocsUrl(entry.url) as string;
    if (only && !only.has(slug)) continue;
    try {
      const md = await get(entry.url);
      const ids = injectHeadingIds(md, htmlHeadings(await cachedHtml(slug)));
      const title = ids.md.match(/^#\s+(.+?)(?:\s+\{#[^}]+\})?\s*$/m)?.[1] ?? entry.title;
      const file = path.join(PAGES_DIR, `${slug}.md`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, ids.md.endsWith("\n") ? ids.md : `${ids.md}\n`);
      pages.set(slug, {
        slug,
        title,
        listTitle: entry.title,
        description: entry.description,
        listSection: entry.section,
        sourceUrl: `${DOCS_ORIGIN}/docs/${slug}`,
        markdownUrl: entry.url,
        headingsWithIds: ids.matched,
        headings: ids.total,
      });
      done++;
      if (ids.matched < ids.total) console.log(`  ${slug}: ${ids.matched}/${ids.total} headings got the live anchor`);
    } catch (err) {
      failed.push(slug);
      console.error(`  ${slug} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Pages that left llms.txt leave the mirror too (a full run only).
  if (!only) {
    const listed = new Set(entries.map((e) => slugOfDocsUrl(e.url)));
    for (const slug of [...pages.keys()]) {
      if (listed.has(slug)) continue;
      pages.delete(slug);
      await rm(path.join(PAGES_DIR, `${slug}.md`), { force: true });
      console.log(`  removed ${slug} (no longer in llms.txt)`);
    }
  }

  const sorted = [...pages.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  await writeFile(path.join(OUT, "pages.json"), `${JSON.stringify(sorted, null, 2)}\n`);
  await writeFile(path.join(OUT, "nav.json"), `${JSON.stringify(nav, null, 2)}\n`);
  await writeFile(
    path.join(OUT, "source.json"),
    `${JSON.stringify({ source: `${DOCS_ORIGIN}/docs`, index: `${DOCS_ORIGIN}/llms.txt`, syncedAt: new Date().toISOString(), pages: sorted.length }, null, 2)}\n`,
  );
  console.log(`Saved ${done} pages (${sorted.length} in the mirror)${failed.length ? `, ${failed.length} failed: ${failed.join(", ")}` : ""}.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

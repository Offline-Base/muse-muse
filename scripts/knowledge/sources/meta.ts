/**
 * Collects Meta's own 2026 publications for the knowledge corpus: the developer docs that dev.meta.ai/llms.txt lists,
 * the Newsroom and engineering blog through their WordPress APIs, the PyTorch blog's feed, the model cards and the
 * open-source cookbooks. Writes .data/knowledge/sources/meta-*.jsonl. One request a second per site, cached, so a rerun
 * only fetches what's missing. Text under Meta's copyright is private (training only); Apache 2.0 text is public.
 *
 *   npx tsx scripts/knowledge/sources/meta.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KNOWLEDGE_DIR, pauseRequested } from "@/lib/knowledge/control";
import { htmlToText, markdownToText, type SourceRecord } from "@/lib/knowledge/sources";

const OUT = path.join(KNOWLEDGE_DIR, "sources");
const CACHE = path.join(OUT, "cache");
const USER_AGENT = "MuseMuse-knowledge/0.1 (https://github.com/Offline-Base/muse-muse)";
const FROM = "2026-01-04";
const TO = "2026-10-29";
const META_LICENSE = "Meta copyright, training only";

/** One fetch through the cache, waiting a second after each real request. */
async function get(url: string): Promise<string | null> {
  const file = path.join(CACHE, createHash("sha256").update(url).digest("hex").slice(0, 32));
  if (existsSync(file)) return readFile(file, "utf8");
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  await new Promise((r) => setTimeout(r, 1000));
  if (!res.ok) {
    console.warn(`${res.status} ${url}`);
    return null;
  }
  const body = await res.text();
  await writeFile(file, body);
  return body;
}

async function save(name: string, records: SourceRecord[]) {
  await writeFile(path.join(OUT, `${name}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`${name}: ${records.length} documents, ${records.reduce((n, r) => n + r.text.split(/\s+/).length, 0)} words`);
}

interface WpPost {
  id: number;
  date: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
}

async function wordpress(site: string, source: string, id: string): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (let page = 1; !pauseRequested(); page++) {
    const body = await get(`https://${site}/wp-json/wp/v2/posts?after=${FROM}T00:00:00&before=${TO}T23:59:59&per_page=50&page=${page}&_fields=id,date,link,title,content`);
    const posts = body ? (JSON.parse(body) as WpPost[]) : [];
    if (!Array.isArray(posts) || posts.length === 0) break;
    for (const p of posts) {
      records.push({ id: `${id}:${p.id}`, source, title: htmlToText(p.title.rendered), url: p.link, date: p.date.slice(0, 10), license: META_LICENSE, visibility: "private", text: htmlToText(p.content.rendered) });
    }
    if (posts.length < 50) break;
  }
  return records;
}

async function developerDocs(): Promise<SourceRecord[]> {
  const llms = await get("https://dev.meta.ai/llms.txt");
  const urls = [...new Set((llms ?? "").match(/https:\/\/dev\.meta\.ai\/[^\s)]+\.md/g) ?? [])].sort();
  const records: SourceRecord[] = [];
  for (const url of urls) {
    if (pauseRequested()) break;
    const md = await get(url);
    if (!md) continue;
    const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? url.split("/").pop()!.replace(/\.md$/, "");
    records.push({ id: `meta-docs:${url.replace("https://dev.meta.ai/", "")}`, source: "Meta developer docs", title, url: url.replace(/\.md$/, ""), date: null, license: META_LICENSE, visibility: "private", text: markdownToText(md) });
  }
  return records;
}

/** The PyTorch blog has no WordPress API open, so its RSS feed, page by page, until posts predate the window. */
async function pytorchBlog(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (let page = 1; page <= 30 && !pauseRequested(); page++) {
    const xml = await get(`https://pytorch.org/feed/?paged=${page}`);
    const items = xml?.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    if (items.length === 0) break;
    let older = false;
    for (const item of items) {
      const tag = (t: string) => item.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`))?.[1] ?? "";
      const date = new Date(tag("pubDate")).toISOString().slice(0, 10);
      if (date < FROM) older = true;
      if (date < FROM || date > TO) continue;
      const link = tag("link").trim();
      records.push({ id: `pytorch-blog:${link}`, source: "PyTorch blog", title: htmlToText(tag("title")), url: link, date, license: "PyTorch site allows AI training (Content-Signal ai-train=yes); text training only", visibility: "private", text: htmlToText(tag("content:encoded") || tag("description")) });
    }
    if (older) break;
  }
  return records;
}

const CARDS: Array<[string, SourceRecord["visibility"], string]> = [
  ["Muse-Glimmer-30B", "public", "Apache 2.0"],
  ["Muse-Glimmer-30B-GGUF", "public", "Apache 2.0"],
  ["Muse-Spark-Open-816B-A42B", "private", "Muse Model License, training only"],
  ["Muse-Spark-Open-816B-A42B-NVFP4", "private", "Muse Model License, training only"],
];

async function modelCards(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const [repo, visibility, license] of CARDS) {
    const md = await get(`https://huggingface.co/meta-models/${repo}/resolve/main/README.md`);
    if (md) records.push({ id: `meta-cards:${repo}`, source: "Hugging Face model card", title: repo, url: `https://huggingface.co/meta-models/${repo}`, date: null, license, visibility, text: markdownToText(md) });
  }
  return records;
}

/** Every Markdown file of Meta's open-source cookbooks. */
async function cookbooks(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const repo of ["meta-oss-cookbook", "meta-model-cookbook"]) {
    let tree: Array<{ path: string; type: string }>;
    let license = "See the repository";
    try {
      tree = JSON.parse(execFileSync("gh", ["api", `repos/meta-models/${repo}/git/trees/main?recursive=1`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).tree;
      license = JSON.parse(execFileSync("gh", ["api", `repos/meta-models/${repo}`], { encoding: "utf8" })).license?.spdx_id ?? license;
    } catch (err) {
      console.warn(`${repo}: ${(err as Error).message.slice(0, 200)}`);
      continue;
    }
    const open = /^(Apache-2\.0|MIT|BSD-3-Clause)$/.test(license);
    for (const f of tree.filter((t) => t.type === "blob" && t.path.endsWith(".md"))) {
      if (pauseRequested()) break;
      const md = await get(`https://raw.githubusercontent.com/meta-models/${repo}/main/${f.path}`);
      if (md) records.push({ id: `meta-cookbook:${repo}/${f.path}`, source: `Meta ${repo} on GitHub`, title: f.path, url: `https://github.com/meta-models/${repo}/blob/main/${f.path}`, date: null, license, visibility: open ? "public" : "private", text: markdownToText(md) });
    }
  }
  return records;
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  const steps: Array<[string, () => Promise<SourceRecord[]>]> = [
    ["meta-docs", developerDocs],
    ["meta-newsroom", () => wordpress("about.fb.com", "Meta Newsroom", "meta-newsroom")],
    ["meta-engineering", () => wordpress("engineering.fb.com", "Engineering at Meta", "meta-engineering")],
    ["pytorch-blog", pytorchBlog],
    ["meta-cards", modelCards],
    ["meta-cookbooks", cookbooks],
  ];
  await Promise.all(steps.map(async ([name, run]) => {
    const records = await run();
    if (pauseRequested()) console.log(`${name}: paused, file not written; run again to carry on.`);
    else await save(name, records);
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

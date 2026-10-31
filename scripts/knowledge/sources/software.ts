/**
 * Collects what happened in software and the AI industry between FROM and TO for the knowledge corpus: release dates,
 * changelogs, security advisories, package registries, model catalogs, benchmarks, standards and model cards. Structured
 * data becomes dated sentences grouped by source and month; prose stays as prose. Writes .data/knowledge/sources/<step>.jsonl.
 *
 *   npx tsx scripts/knowledge/sources/software.ts [step ...]
 *   LIMIT=5 npx tsx scripts/knowledge/sources/software.ts endoflife    (small test: a dozen requests at most per step)
 *
 * License verdicts come from docs/knowledge-research/software.md and claim-check-2026-10-30.md; the claim check wins.
 * Left out on purpose: OpenAI's website (terms ban scraping), OpenRouter, GH Archive, PyPI BigQuery, and api.deps.dev
 * (its robots.txt disallows everything, so package data comes from ecosyste.ms). GitHub calls use GITHUB_TOKEN when it is
 * set and the gh CLI when it is not; neither ever prints the token.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { longDate } from "@/lib/knowledge/passages";
import { htmlToText, markdownToText, type SourceRecord } from "@/lib/knowledge/sources";
import { CACHE, FROM, get, LIMIT, pauseRequested, runAll, TO, USER_AGENT } from "./common";

const SAMPLE = Number.isFinite(LIMIT);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------
// Dates and text
// ---------------------------------------------------------------------------------------------------------------------

const inWindow = (date: string | null | undefined): date is string => !!date && date >= FROM && date <= TO;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (yearMonth: string) => `${MONTHS[Number(yearMonth.slice(5, 7)) - 1]} ${yearMonth.slice(0, 4)}`;
const monthPattern = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3)));

/** The first date in a string, as YYYY-MM-DD: 2026-03-01, 2026.03.01, March 1, 2026, March 1st 2026, or 1 March 2026. */
function findDate(s: string): string | null {
  const iso = s.match(/\b(20\d{2})[-./](\d{2})[-./](\d{2})(?!\d)/);
  const us = s.match(new RegExp(`\\b${monthPattern} (\\d{1,2})(?:st|nd|rd|th)?,? (20\\d{2})\\b`));
  const uk = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? ${monthPattern},? (20\\d{2})\\b`));
  const pad = (n: string | number) => String(n).padStart(2, "0");
  const found = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : us ? `${us[3]}-${pad(monthIndex(us[1]) + 1)}-${pad(us[2])}` : uk ? `${uk[3]}-${pad(monthIndex(uk[2]) + 1)}-${pad(uk[1])}` : null;
  return found && !Number.isNaN(Date.parse(found)) ? found : null;
}

const oneLine = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const endSentence = (s: string) => (/[.!?:]["')]?$/.test(s) ? s : `${s}.`);

/** The start of a text, at most `max` words, cut at a sentence end when one is near. */
function clip(text: string, max: number): string {
  const words = text.split(/(\s+)/);
  if (words.length <= max * 2) return text.trim();
  const cut = words.slice(0, max * 2).join("").trim();
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  return end > cut.length / 2 ? cut.slice(0, end + 1) : `${cut}...`;
}

/** Plain text from reStructuredText: directives, code blocks, roles and heading rules go. */
function rstToText(rst: string): string {
  return rst
    .replace(/^\.\.[^\n]*(?:\n[ \t]+[^\n]*|\n[ \t]*(?=\n[ \t]+\S))*/gm, "\n")
    .replace(/::[ \t]*\n\s*\n(?:[ \t]+[^\n]*\n|[ \t]*\n)+/g, ":\n\n")
    .replace(/^([=\-~^"*#+`])\1{2,}[ \t]*$/gm, "")
    .replace(/:(rfc|pep):`(\d+)[^`]*`/gi, (_, kind: string, n: string) => `${kind.toUpperCase()} ${n}`)
    .replace(/:[a-zA-Z:]+:`[~!]?([^`<]*?)(?:\s*<[^>]*>)?`/g, "$1")
    .replace(/`([^`<]+?)\s*<[^>]+>`_{0,2}/g, "$1")
    .replace(/``([^`]+)``/g, "$1")
    .replace(/`([^`]+)`_{0,2}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\s][^*]*)\*/g, "$1")
    .replace(/^[ \t]*:[\w -]+:.*$/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s*\n\s*(\n\s*)+/g, "\n\n")
    .trim();
}

/** markdownToText, keeping the underscores inside identifiers such as budget_tokens. */
const mdText = (md: string) => markdownToText(md.replace(/(\w)_(?=\w)/g, "$1\uE000")).replace(/\uE000/g, "_");

/** Em dashes go from anything we pass on, except text that must stay unmodified (RFCs, Ecma text). */
const EM_DASH = new RegExp(`\\s*${String.fromCodePoint(0x2014)}\\s*`, "g");
const noDash = (s: string) => s.replace(EM_DASH, ", ");

// ---------------------------------------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------------------------------------

interface Fact {
  date: string;
  text: string;
}

interface DocMeta {
  id: string;
  source: string;
  title: string;
  url: string;
  license: string;
  visibility: SourceRecord["visibility"];
}

/** Small dated facts as one document per month, split when a month runs long. Each carries the date of its latest fact. */
function byMonth(meta: DocMeta, facts: Fact[], maxWords = 3000): SourceRecord[] {
  const unique = [...new Map(facts.filter((f) => inWindow(f.date)).map((f) => [f.text, f])).values()];
  unique.sort((a, b) => a.date.localeCompare(b.date));
  const records: SourceRecord[] = [];
  const months = new Map<string, Fact[]>();
  for (const f of unique) months.set(f.date.slice(0, 7), [...(months.get(f.date.slice(0, 7)) ?? []), f]);
  for (const [month, group] of months) {
    const chunks: Fact[][] = [[]];
    let words = 0;
    for (const f of group) {
      const n = wordCount(f.text);
      if (words && words + n > maxWords) {
        chunks.push([]);
        words = 0;
      }
      chunks[chunks.length - 1].push(f);
      words += n;
    }
    chunks.forEach((chunk, i) => {
      records.push({
        id: `${meta.id}:${month}${chunks.length > 1 ? `:${i + 1}` : ""}`,
        source: meta.source,
        title: `${meta.title}, ${monthName(month)}${chunks.length > 1 ? `, part ${i + 1}` : ""}`,
        url: meta.url,
        date: chunk[chunk.length - 1].date,
        license: meta.license,
        visibility: meta.visibility,
        text: chunk.map((f) => f.text).join("\n\n"),
      });
    });
  }
  return records;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fetching: JSON, binary files, GitHub
// ---------------------------------------------------------------------------------------------------------------------

async function getJson<T>(url: string, opts: Parameters<typeof get>[1] = {}): Promise<T | null> {
  const body = await get(url, opts);
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    console.warn(`not JSON: ${url}`);
    return null;
  }
}

const cacheFile = (url: string) => path.join(CACHE, createHash("sha256").update(url).digest("hex").slice(0, 32));

/** `get` reads text, which would corrupt a zip, so binary files stream to the cache here. Returns the path. */
async function download(url: string): Promise<string | null> {
  await mkdir(CACHE, { recursive: true });
  const file = `${cacheFile(url)}.bin`;
  if (existsSync(file)) return file;
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1000 * (attempt * 15 + 1));
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(4 * 3600_000) });
      if (!res.ok || !res.body) {
        console.warn(`${res.status} ${url}`);
        if (res.status !== 429 && res.status < 500) return null;
        continue;
      }
      await pipeline(Readable.fromWeb(res.body as WebReadableStream), createWriteStream(`${file}.part`));
      await rename(`${file}.part`, file);
      return file;
    } catch (err) {
      console.warn(`${url}: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  return null;
}

/** Yields the wanted files of a zip on disk, one at a time, without loading the archive. Handles zip64 (OSV's all.zip). */
async function* zipEntries(file: string, want: (name: string) => boolean): AsyncGenerator<{ name: string; data: Buffer }> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      return buffer;
    };
    const tailStart = Math.max(0, size - 70_000);
    const tail = await read(tailStart, size - tailStart);
    let end = tail.length - 22;
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < 0) throw new Error(`not a zip: ${file}`);
    let dirSize = tail.readUInt32LE(end + 12);
    let dirStart = tail.readUInt32LE(end + 16);
    if (dirStart === 0xffffffff || dirSize === 0xffffffff) {
      const locator = end - 20;
      const record = await read(Number(tail.readBigUInt64LE(locator + 8)), 56);
      dirSize = Number(record.readBigUInt64LE(40));
      dirStart = Number(record.readBigUInt64LE(48));
    }
    const dir = await read(dirStart, dirSize);
    for (let p = 0; p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50; ) {
      const method = dir.readUInt16LE(p + 10);
      let packed = dir.readUInt32LE(p + 20);
      const plain = dir.readUInt32LE(p + 24);
      const nameLength = dir.readUInt16LE(p + 28);
      const extraLength = dir.readUInt16LE(p + 30);
      const commentLength = dir.readUInt16LE(p + 32);
      let local = dir.readUInt32LE(p + 42);
      const name = dir.toString("utf8", p + 46, p + 46 + nameLength);
      for (let e = p + 46 + nameLength; e + 4 <= p + 46 + nameLength + extraLength; e += 4 + dir.readUInt16LE(e + 2)) {
        if (dir.readUInt16LE(e) !== 1) continue;
        let field = e + 4;
        if (plain === 0xffffffff) field += 8;
        if (packed === 0xffffffff) {
          packed = Number(dir.readBigUInt64LE(field));
          field += 8;
        }
        if (local === 0xffffffff) local = Number(dir.readBigUInt64LE(field));
      }
      p += 46 + nameLength + extraLength + commentLength;
      if (!want(name) || name.endsWith("/")) continue;
      const header = await read(local, 30);
      const raw = await read(local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), packed);
      yield { name, data: method === 8 ? inflateRawSync(raw) : raw };
    }
  } finally {
    await handle.close();
  }
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  const header = (rows.shift() ?? []).map((h) => h.replace(/^﻿/, ""));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

const GITHUB_API = "https://api.github.com/";
const runFile = promisify(execFile);
let ghTurn: Promise<unknown> = Promise.resolve();

/** One `gh api` call at a time, a second apart, cached like `get`. Null when the route doesn't exist. */
function ghCli(route: string, flags: string[] = []): Promise<string | null> {
  const turn = ghTurn.then(async () => {
    const file = cacheFile(GITHUB_API + route);
    if (existsSync(file)) return readFile(file, "utf8");
    await mkdir(CACHE, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(1000);
      try {
        const { stdout } = await runFile("gh", ["api", ...flags, route], { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" });
        await writeFile(file, stdout);
        return stdout;
      } catch (err) {
        const message = String((err as { stderr?: string }).stderr || (err as Error).message);
        if ((err as { code?: string }).code === "ENOENT") throw new Error("GITHUB_TOKEN is not set and the gh CLI is not installed");
        if (!/rate limit|HTTP 403|HTTP 429|HTTP 5\d\d|timeout|connection|stream error/i.test(message)) {
          if (!/HTTP 404|HTTP 409/.test(message)) console.warn(`gh api ${route}: ${message.slice(0, 200)}`);
          return null;
        }
        await sleep(60_000 * (attempt + 1));
      }
    }
    console.warn(`gave up on gh api ${route}`);
    return null;
  });
  ghTurn = turn.catch(() => undefined);
  return turn;
}

/** A GitHub API route, through the token when there is one and the gh CLI when not. */
async function github<T>(route: string): Promise<T | null> {
  const token = process.env.GITHUB_TOKEN;
  const body = token ? await get(GITHUB_API + route, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }) : await ghCli(route);
  return body ? (JSON.parse(body) as T) : null;
}

/** Every page of a GitHub list, for routes that only page by cursor. */
async function githubAll<T>(route: string): Promise<T[]> {
  const body = await ghCli(route, ["--paginate"]);
  return body ? (JSON.parse(body) as T[]) : [];
}

/** A release file, through the REST API, since robots.txt disallows github.com's download links. Not cached, being large. */
async function githubAsset(repo: string, id: number, file: string): Promise<void> {
  const child = spawn("gh", ["api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${id}`], { stdio: ["ignore", "pipe", "ignore"] });
  const exit = new Promise<number | null>((resolve, reject) => child.on("error", reject).on("close", resolve));
  await pipeline(child.stdout, createWriteStream(file));
  if ((await exit) !== 0) throw new Error(`could not download release asset ${id} of ${repo}`);
}

const raw = (repo: string, branch: string, file: string) => `https://raw.githubusercontent.com/${repo}/${branch}/${file.split("/").map(encodeURIComponent).join("/")}`;
const PERMISSIVE = /^(MIT|Apache-2\.0|BSD-[23]-Clause(-Clear)?|ISC|0BSD|Unlicense|CC0-1\.0|CC-BY-4\.0|CC-BY-SA-4\.0)$/;

// ---------------------------------------------------------------------------------------------------------------------
// Changelogs
// ---------------------------------------------------------------------------------------------------------------------

interface Section {
  heading: string;
  date: string;
  body: string;
}

const VERSION = /\bv?(\d+\.\d+(?:\.\d+)*(?:[-.]?(?:alpha|beta|rc|post|dev)\.?\d*)?)\b/i;

/**
 * The dated sections of a Markdown or reST changelog. A heading with a date in it, or a date right under it, starts a
 * section; headings without one belong to the section above, unless they name a version of their own, which ends it.
 */
function datedSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let current: { heading: string; date: string; body: string[] } | null = null;
  const close = () => {
    if (current) sections.push({ heading: current.heading, date: current.date, body: current.body.join("\n") });
    current = null;
  };
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) fenced = !fenced;
    const underlined = !fenced && i + 1 < lines.length && /^(={3,}|-{3,}|~{3,}|\^{3,})\s*$/.test(lines[i + 1]) && /\w/.test(line) && !/^\s*[-*|]/.test(line);
    const atx = fenced ? null : line.match(/^(#{1,4})\s+(.*?)\s*#*\s*$/);
    if (!underlined && !atx) {
      current?.body.push(line);
      continue;
    }
    const heading = atx ? atx[2] : line.trim();
    const major = underlined || (atx?.[1].length ?? 9) <= 2 || VERSION.test(heading);
    let date = findDate(heading);
    if (!date && major) {
      const nextLines = lines.slice(i + (underlined ? 2 : 1), i + 6).filter((l) => l.trim());
      if (nextLines[0] && nextLines[0].length <= 90) date = findDate(nextLines[0]);
    }
    if (date) {
      close();
      current = { heading, date, body: [] };
    } else if (VERSION.test(heading) && major) close();
    else current?.body.push(atx ? line : `## ${heading}`);
    if (underlined) i++;
  }
  close();
  return sections;
}

function cleanNotes(body: string, rst = false): string {
  const stripped = body
    .replace(/\{\{[<%][\s\S]*?[>%]\}\}/g, "")
    .replace(/^\s*\*{0,2}Full Changelog\*{0,2}:?.*$/gim, "")
    .replace(/\s+by @[\w-]+ in \S+/g, "")
    .replace(/^.*@[\w-]+ made (their|his|her) first contribution.*$/gim, "")
    .replace(/^#+\s*New Contributors\s*$/gim, "")
    /** GitHub handles name people; a scoped package such as @types/node and a decorator in backticks stay. */
    .replace(/(?<![\w/.`])@[A-Za-z0-9][\w-]*(?![\w/-])/g, "")
    .replace(/\(?\[`?[0-9a-f]{7,40}`?\]\([^)]*\)\)?/g, "")
    .replace(/\(?\b[0-9a-f]{40}\b\)?/g, "");
  return (rst ? rstToText(stripped) : mdText(stripped)).replace(/\\?\[\\?\]\s*-\s*/g, "").replace(/https?:\/\/\S+/g, "").replace(/[ \t]+$/gm, "").trim();
}

/** Changelog sections as facts, each opening with a dated sentence naming the product and version. */
function changelogFacts(name: string, text: string, opts: { rst?: boolean; maxWords?: number } = {}): Fact[] {
  const facts: Fact[] = [];
  for (const s of datedSections(text)) {
    if (!inWindow(s.date)) continue;
    const heading = cleanNotes(s.heading).replace(/\b(20\d{2})[-./]\d{2}[-./]\d{2}\b/, "").replace(/@[\w-]+/g, "").replace(/\.$/, "");
    const version = heading.match(VERSION)?.[1];
    const body = clip(cleanNotes(s.body, opts.rst), opts.maxWords ?? 800);
    const opening = version ? `${name} ${version} was released on ${longDate(s.date)}.` : `The ${name} changelog has this entry for ${longDate(s.date)}.`;
    facts.push({ date: s.date, text: body ? `${opening}\n\n${body}` : opening });
  }
  return facts;
}

/** Finds a repository's changelog file at its root and returns its dated sections as facts. */
async function repoChangelog(repo: string, branch: string): Promise<{ facts: Fact[]; file: string } | null> {
  const root = await github<Array<{ name: string; type: string }>>(`repos/${repo}/contents/`);
  if (!Array.isArray(root)) return null;
  const rank = (n: string) => ["change", "history", "news", "release"].findIndex((k) => n.toLowerCase().startsWith(k));
  const candidates = root.filter((f) => f.type === "file" && /^(change[-_]?log|changes|history|news|releases?)(\.(md|markdown|rst|txt))?$/i.test(f.name)).sort((a, b) => rank(a.name) - rank(b.name));
  if (!candidates.length) return null;
  const text = await get(raw(repo, branch, candidates[0].name));
  if (!text) return null;
  return { facts: changelogFacts(repo.split("/")[1], text, { rst: /\.rst$/i.test(candidates[0].name) }), file: candidates[0].name };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lifecycle, catalogs and packages
// ---------------------------------------------------------------------------------------------------------------------

interface EolProduct {
  name: string;
  label: string;
  labels?: { eol?: string | null; eoas?: string | null; eoes?: string | null };
  links?: { html?: string };
  releases: Array<{ name: string; label?: string | null; codename?: string | null; releaseDate?: string | null; isLts?: boolean; ltsFrom?: string | null; eolFrom?: string | null; eoasFrom?: string | null; eoesFrom?: string | null; latest?: { name?: string; date?: string | null } | null }>;
}

async function endoflife(): Promise<SourceRecord[]> {
  const data = await getJson<{ result: EolProduct[] }>("https://endoflife.date/api/v1/products/full");
  const facts: Fact[] = [];
  for (const p of data?.result ?? []) {
    for (const r of p.releases ?? []) {
      const label = oneLine(r.label ?? r.name);
      const brand = p.label.split(" ").pop() ?? "";
      const release = label.toLowerCase().startsWith(brand.toLowerCase()) ? label : `${p.label} ${label}`;
      const ended = (kind: string | null | undefined, fallback: string) => (kind ?? fallback).toLowerCase();
      if (inWindow(r.releaseDate)) facts.push({ date: r.releaseDate, text: `${release} was released on ${longDate(r.releaseDate)}${r.isLts ? " as a long-term support release" : ""}.` });
      if (inWindow(r.ltsFrom)) facts.push({ date: r.ltsFrom, text: `${release} became a long-term support release on ${longDate(r.ltsFrom)}.` });
      if (inWindow(r.latest?.date) && r.latest?.date !== r.releaseDate && r.latest?.name) facts.push({ date: r.latest.date, text: `${p.label} ${r.latest.name}, a patch release of ${release}, came out on ${longDate(r.latest.date)}.` });
      if (inWindow(r.eolFrom)) facts.push({ date: r.eolFrom, text: p.labels?.eol ? `${release} ended ${ended(p.labels.eol, "")} on ${longDate(r.eolFrom)}.` : `${release} reached end of life on ${longDate(r.eolFrom)}.` });
      if (inWindow(r.eoasFrom)) facts.push({ date: r.eoasFrom, text: `${release} ended ${ended(p.labels?.eoas, "active support")} on ${longDate(r.eoasFrom)}.` });
      if (inWindow(r.eoesFrom)) facts.push({ date: r.eoesFrom, text: `${release} ended ${ended(p.labels?.eoes, "extended support")} on ${longDate(r.eoesFrom)}.` });
    }
  }
  return byMonth({ id: "endoflife", source: "endoflife.date", title: "Software releases and support dates", url: "https://endoflife.date", license: "MIT (endoflife.date)", visibility: "public" }, facts);
}

interface ModelsDevProvider {
  id: string;
  name: string;
  doc?: string;
  models: Record<string, {
    name?: string;
    release_date?: string;
    knowledge?: string;
    open_weights?: boolean;
    reasoning?: boolean;
    status?: string;
    modalities?: { input?: string[]; output?: string[] };
    limit?: { context?: number; output?: number };
    cost?: { input?: number; output?: number };
  }>;
}

async function modelsDev(): Promise<SourceRecord[]> {
  const data = await getJson<Record<string, ModelsDevProvider>>("https://models.dev/api.json");
  const seen = new Map<string, { date: string; name: string; providers: string[]; base: string; price: string }>();
  for (const provider of Object.values(data ?? {})) {
    if (/openrouter/i.test(provider.id ?? "") || /openrouter/i.test(provider.name ?? "")) continue;
    for (const [id, m] of Object.entries(provider.models ?? {})) {
      const date = m.release_date?.length === 7 ? `${m.release_date}-01` : m.release_date;
      if (!inWindow(date)) continue;
      const name = m.name ?? id;
      const key = `${date}|${name.toLowerCase()}`;
      const entry = seen.get(key);
      const price = m.cost?.input !== undefined && m.cost?.output !== undefined ? `On ${provider.name} it was listed at $${m.cost.input} per million input tokens and $${m.cost.output} per million output tokens.` : "";
      if (entry) {
        entry.providers.push(provider.name);
        entry.price ||= price;
        continue;
      }
      const details = [
        m.limit?.context ? `a context window of ${m.limit.context.toLocaleString("en-US")} tokens` : "",
        m.limit?.output ? `up to ${m.limit.output.toLocaleString("en-US")} output tokens` : "",
        m.modalities?.input?.length ? `${m.modalities.input.join(", ")} input` : "",
        m.reasoning ? "reasoning support" : "",
        m.open_weights ? "open weights" : "",
      ].filter(Boolean);
      const base = `${details.length ? ` It has ${details.join(", ")}.` : ""}${m.knowledge ? ` Its knowledge cutoff is ${m.knowledge}.` : ""}`;
      seen.set(key, { date, name, providers: [provider.name], base, price });
    }
  }
  const facts = [...seen.values()].map((m) => ({
    date: m.date,
    text: `${m.name} was released on ${longDate(m.date)}. Providers listing it include ${m.providers.slice(0, 6).join(", ")}.${m.base}${m.price ? ` ${m.price}` : ""}`,
  }));
  return byMonth({ id: "models-dev", source: "models.dev", title: "AI model releases", url: "https://models.dev", license: "MIT (models.dev)", visibility: "public" }, facts);
}

interface EcoPackage {
  name: string;
  description?: string | null;
  licenses?: string | null;
  normalized_licenses?: string[];
  first_release_published_at?: string | null;
  latest_release_published_at?: string | null;
  latest_release_number?: string | null;
}

const ECO = "https://packages.ecosyste.ms/api/v1/registries";
const ECO_LICENSE = "CC BY-SA 4.0 (ecosyste.ms), share-alike";

/** formula.json has no per-formula dates, so ecosyste.ms's Homebrew registry says when each version appeared. */
async function homebrew(): Promise<SourceRecord[]> {
  const formulae = (await getJson<Array<{ name: string; desc?: string; license?: string; homepage?: string; versions?: { stable?: string }; deprecation_date?: string | null; deprecation_reason?: string | null; disable_date?: string | null; disable_reason?: string | null }>>("https://formulae.brew.sh/api/formula.json")) ?? [];
  const byName = new Map(formulae.map((f) => [f.name, f]));
  const facts: Fact[] = [];
  for (const f of formulae) {
    if (inWindow(f.deprecation_date)) facts.push({ date: f.deprecation_date, text: `Homebrew deprecated the formula ${f.name} on ${longDate(f.deprecation_date)}${f.deprecation_reason ? `, with the stated reason "${f.deprecation_reason.replace(/_/g, " ")}"` : ""}.` });
    if (inWindow(f.disable_date)) facts.push({ date: f.disable_date, text: `Homebrew disabled the formula ${f.name} on ${longDate(f.disable_date)}${f.disable_reason ? `, with the stated reason "${f.disable_reason.replace(/_/g, " ")}"` : ""}.` });
  }
  const start = SAMPLE ? 15 : 1;
  const stop = SAMPLE ? 16 : 400;
  for (let page = start; page <= stop && !pauseRequested(); page++) {
    const packages = await getJson<EcoPackage[]>(`${ECO}/formulae.brew.sh/packages?sort=latest_release_published_at&order=desc&per_page=100&page=${page}`);
    if (!packages?.length) break;
    let older = false;
    for (const p of packages) {
      const date = p.latest_release_published_at?.slice(0, 10);
      if (date && date < FROM) older = true;
      const formula = byName.get(p.name);
      if (!inWindow(date) || !formula) continue;
      const about = formula.desc ? ` (${formula.desc.replace(/\.$/, "")})` : "";
      facts.push({ date, text: `Homebrew's formula ${p.name}${about} reached version ${p.latest_release_number ?? formula.versions?.stable} by ${longDate(date)}.${formula.license ? ` Its license is ${formula.license}.` : ""}` });
    }
    if (older) break;
  }
  return byMonth({ id: "homebrew", source: "Homebrew formulae", title: "Homebrew formula updates", url: "https://formulae.brew.sh", license: `BSD-2-Clause (Homebrew formula.json); release dates ${ECO_LICENSE}`, visibility: "public" }, facts);
}

const REGISTRIES: Array<[string, string, string]> = [
  ["npmjs.org", "npm", "dependent_repos_count"],
  ["pypi.org", "PyPI", "dependent_repos_count"],
  ["crates.io", "crates.io", "dependent_repos_count"],
  ["proxy.golang.org", "Go", "dependent_repos_count"],
  ["rubygems.org", "RubyGems", "dependent_repos_count"],
  ["repo1.maven.org", "Maven Central", "dependent_repos_count"],
  ["nuget.org", "NuGet", "dependent_repos_count"],
  ["packagist.org", "Packagist", "dependent_repos_count"],
  ["hub.docker.com", "Docker Hub", "downloads"],
];

const UNSTABLE = /alpha|beta|canary|nightly|experimental|snapshot|preview|\bdev\b|[-.]dev|[-.]rc|\drc|[-.]next|[-.]pre|\d(a|b)\d|^v?0\.0\.0-/i;

/** The most depended-on packages of the big registries, and their stable releases in the window. */
async function ecosystems(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const [registry, label, sort] of SAMPLE ? REGISTRIES.slice(0, 1) : REGISTRIES) {
    const facts: Fact[] = [];
    const pages = SAMPLE ? 1 : 5;
    for (let page = 1; page <= pages && !pauseRequested(); page++) {
      const packages = await getJson<EcoPackage[]>(`${ECO}/${registry}/packages?sort=${sort}&order=desc&per_page=${SAMPLE ? Math.min(LIMIT, 8) : 100}&page=${page}`);
      for (const p of packages ?? []) {
        if (pauseRequested()) break;
        const about = p.description ? ` (${clip(oneLine(p.description), 30).replace(/\.$/, "")})` : "";
        const first = p.first_release_published_at?.slice(0, 10);
        if (inWindow(first)) facts.push({ date: first, text: `The ${label} package ${p.name}${about} was first published on ${longDate(first)}.` });
        const latest = p.latest_release_published_at?.slice(0, 10);
        if (inWindow(latest) && p.latest_release_number && !UNSTABLE.test(p.latest_release_number)) facts.push({ date: latest, text: `The ${label} package ${p.name}${about} published version ${p.latest_release_number} on ${longDate(latest)}.${p.normalized_licenses?.length ? ` Its license is ${p.normalized_licenses.join(", ")}.` : ""}` });
        if (registry === "hub.docker.com" || !latest || latest < FROM) continue;
        for (let v = 1; v <= (SAMPLE ? 1 : 3); v++) {
          const versions = await getJson<Array<{ number: string; published_at?: string | null }>>(`${ECO}/${registry}/packages/${encodeURIComponent(p.name)}/versions?sort=published_at&order=desc&per_page=100&page=${v}`);
          if (!versions?.length) break;
          for (const version of versions) {
            const date = version.published_at?.slice(0, 10);
            if (inWindow(date) && version.number !== p.latest_release_number && !UNSTABLE.test(version.number)) facts.push({ date, text: `The ${label} package ${p.name} published version ${version.number} on ${longDate(date)}.` });
          }
          const oldest = versions[versions.length - 1].published_at?.slice(0, 10);
          if (versions.length < 100 || !oldest || oldest < FROM) break;
        }
      }
    }
    records.push(...byMonth({ id: `ecosystems:${registry}`, source: "ecosyste.ms packages", title: `${label} package releases`, url: `https://packages.ecosyste.ms/registries/${registry}`, license: ECO_LICENSE, visibility: "public" }, facts));
  }
  return records;
}

// ---------------------------------------------------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------------------------------------------------

/** Licenses from OSV's data sources page. Anything not listed stays private; Chainguard and Wolfi (CC BY-NC-ND) are dropped. */
const OSV_SOURCES: Array<[RegExp, string, string]> = [
  [/^PYSEC-/, "PyPA Advisory Database", "CC BY 4.0"],
  [/^GO-/, "Go Vulnerability Database", "CC BY 4.0"],
  [/^RUSTSEC-/, "RustSec Advisory Database", "CC0 1.0"],
  [/^DRUPAL-/, "Drupal Advisory Database", "MIT"],
  [/^GSD-/, "Global Security Database", "CC0 1.0"],
  [/^OSV-/, "OSS-Fuzz", "CC BY 4.0"],
  [/^(RLSA|RXSA)-/, "Rocky Linux", "BSD"],
  [/^(ALSA|ALBA|ALEA)-/, "AlmaLinux", "MIT"],
  [/^HSEC-/, "Haskell Security Advisories", "CC0 1.0"],
  [/^RSEC-/, "RConsortium Advisory Database", "Apache 2.0"],
  [/^MAL-/, "OpenSSF Malicious Packages", "Apache 2.0"],
  [/^PSF-/, "Python Software Foundation Database", "CC BY 4.0"],
  [/^BIT-/, "Bitnami Vulnerability Database", "Apache 2.0"],
  [/^(USN|UBUNTU|LSN)-/, "Ubuntu Security Notices", "CC BY-SA 4.0, share-alike"],
  [/^OCAML-/, "opam Security Advisories", "CC0 1.0"],
  [/^EEF-/, "Erlang Ecosystem Foundation CNA", "CC BY 4.0"],
  [/^(A|ASB|PUB)-/, "Android Security Bulletins", "CC BY 4.0"],
  [/^AZL-/, "Azure Linux", "MIT"],
  [/^BELL-/, "BellSoft", "MIT"],
  [/^CLEANSTART-/, "CleanStart", "Apache 2.0"],
  [/^CURL-/, "curl", "MIT"],
  [/^JLSEC-/, "Julia Security Advisories", "CC BY 4.0"],
  [/^(RHSA|RHBA|RHEA)-/, "Red Hat Security Data", "CC BY 4.0"],
  [/^ALPINE-/, "Alpine SecDB", "CC BY-SA 4.0, share-alike"],
];

interface OsvRecord {
  id: string;
  published?: string;
  withdrawn?: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  affected?: Array<{ package?: { ecosystem?: string; name?: string } }>;
}

const OSV_BUCKET = "https://osv-vulnerabilities.storage.googleapis.com";

/**
 * Everything in OSV except GHSA and CVE records, which have their own steps, and Chainguard and Wolfi. The full run reads
 * all.zip (about 2.85 GB); a small test reads one ecosystem's zip.
 */
async function osv(): Promise<SourceRecord[]> {
  const file = await download(SAMPLE ? `${OSV_BUCKET}/PyPI/all.zip` : `${OSV_BUCKET}/all.zip`);
  if (!file) throw new Error("OSV archive not available");
  const groups = new Map<string, { source: string; license: string; open: boolean; facts: Fact[] }>();
  for await (const { data } of zipEntries(file, (name) => name.endsWith(".json") && !/^(GHSA|CVE|CGA)-/.test(path.basename(name)))) {
    if (pauseRequested()) break;
    let v: OsvRecord;
    try {
      v = JSON.parse(data.toString("utf8"));
    } catch {
      continue;
    }
    const date = v.published?.slice(0, 10);
    if (!inWindow(date) || v.withdrawn) continue;
    const ecosystems = [...new Set((v.affected ?? []).map((a) => a.package?.ecosystem ?? ""))];
    if (ecosystems.some((e) => /^(chainguard|wolfi)/i.test(e))) continue;
    const match = OSV_SOURCES.find(([re]) => re.test(v.id));
    const source = match?.[1] ?? "Other OSV sources";
    const group = groups.get(source) ?? { source, license: match?.[2] ?? "Source license not checked, training only", open: !!match, facts: [] };
    groups.set(source, group);
    const packages = [...new Set((v.affected ?? []).map((a) => (a.package?.name ? `${a.package.name} (${a.package.ecosystem})` : "")).filter(Boolean))].slice(0, 4);
    const parts = [
      `${v.id} was published on ${longDate(date)}.`,
      v.summary ? endSentence(oneLine(v.summary)) : "",
      v.details && !v.id.startsWith("MAL-") && oneLine(v.details) !== oneLine(v.summary) ? clip(oneLine(mdText(v.details)), 70) : "",
      packages.length && !v.id.startsWith("MAL-") ? `It affects ${packages.join(", ")}.` : "",
      v.aliases?.length ? `Also known as ${v.aliases.slice(0, 3).join(", ")}.` : "",
    ];
    group.facts.push({ date, text: parts.filter(Boolean).join(" ") });
  }
  const records: SourceRecord[] = [];
  for (const g of groups.values()) {
    const slug = g.source.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    records.push(...byMonth({ id: `osv:${slug}`, source: `OSV, ${g.source}`, title: `${g.source} advisories`, url: "https://osv.dev", license: g.license, visibility: g.open ? "public" : "private" }, g.facts));
  }
  return records;
}

async function kev(): Promise<SourceRecord[]> {
  const data = await getJson<{ vulnerabilities: Array<{ cveID: string; vulnerabilityName: string; dateAdded: string; shortDescription?: string; dueDate?: string; knownRansomwareCampaignUse?: string }> }>("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json");
  const facts = (data?.vulnerabilities ?? []).map((v) => ({
    date: v.dateAdded,
    text: `CISA added ${v.cveID}, ${v.vulnerabilityName}, to its Known Exploited Vulnerabilities catalog on ${inWindow(v.dateAdded) ? longDate(v.dateAdded) : v.dateAdded}. ${oneLine(v.shortDescription)}${v.dueDate ? ` US federal agencies had until ${longDate(v.dueDate)} to act.` : ""}${v.knownRansomwareCampaignUse === "Known" ? " It is known to be used in ransomware campaigns." : ""}`,
  }));
  return byMonth({ id: "cisa-kev", source: "CISA Known Exploited Vulnerabilities", title: "Vulnerabilities CISA added to its exploited list", url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog", license: "US government work (CISA)", visibility: "public" }, facts);
}

interface CveRecord {
  cveMetadata?: { cveId?: string; state?: string; datePublished?: string; assignerShortName?: string };
  containers?: {
    cna?: {
      title?: string;
      descriptions?: Array<{ lang?: string; value?: string }>;
      affected?: Array<{ vendor?: string; product?: string }>;
      metrics?: Array<Record<string, { baseScore?: number; baseSeverity?: string }>>;
    };
  };
}

/**
 * The CVE Program's nightly bulk file, one request where reading cves/2026 file by file would take 15 hours. Every record
 * is read, since a CVE numbered in an earlier year can be published in the window. A small test reads the day's delta file.
 */
async function cvelist(): Promise<SourceRecord[]> {
  const repo = "CVEProject/cvelistV5";
  const release = await github<{ assets: Array<{ id: number; name: string }> }>(`repos/${repo}/releases/latest?day=${new Date().toISOString().slice(0, 10)}`);
  const asset = release?.assets.find((a) => (SAMPLE ? /delta_CVEs/ : /all_CVEs/).test(a.name));
  if (!asset) throw new Error("no bulk file in the latest cvelistV5 release");
  const dir = await mkdtemp(path.join(tmpdir(), "cvelist-"));
  const facts: Fact[] = [];
  try {
    let file = path.join(dir, "bulk.zip");
    await githubAsset(repo, asset.id, file);
    /** The full file is a zip holding one zip. */
    for await (const { data } of zipEntries(file, (name) => name.endsWith(".zip"))) {
      file = path.join(dir, "inner.zip");
      await writeFile(file, data);
    }
    for await (const { data } of zipEntries(file, (name) => /(^|\/)CVE-\d+-\d+\.json$/.test(name))) {
      if (pauseRequested()) break;
      let r: CveRecord;
      try {
        r = JSON.parse(data.toString("utf8"));
      } catch {
        continue;
      }
      const meta = r.cveMetadata;
      const date = meta?.datePublished?.slice(0, 10);
      if (meta?.state !== "PUBLISHED" || !inWindow(date)) continue;
      const cna = r.containers?.cna;
      const description = cna?.descriptions?.find((d) => d.lang?.startsWith("en"))?.value ?? cna?.descriptions?.[0]?.value;
      const affected = [...new Set((cna?.affected ?? []).map((a) => {
        const vendor = a.vendor && a.vendor !== "n/a" ? a.vendor : "";
        const product = a.product && a.product !== "n/a" ? a.product : "";
        return oneLine(product.toLowerCase().startsWith(vendor.toLowerCase()) ? product : `${vendor} ${product}`);
      }).filter(Boolean))].slice(0, 3);
      const cvss = (cna?.metrics ?? []).flatMap((m) => Object.values(m)).find((c) => typeof c?.baseScore === "number");
      const parts = [
        `${meta?.cveId} was published on ${longDate(date)}${meta?.assignerShortName ? ` by ${meta.assignerShortName}` : ""}.`,
        affected.length ? `It affects ${affected.join(", ")}.` : "",
        description ? clip(oneLine(description), 90) : oneLine(cna?.title),
        cvss ? `Its CVSS base score is ${cvss.baseScore}${cvss.baseSeverity ? ` (${cvss.baseSeverity.toLowerCase()})` : ""}.` : "",
      ];
      facts.push({ date, text: parts.filter(Boolean).join(" ") });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return byMonth({ id: "cvelist", source: "CVE List", title: "CVE records published", url: "https://github.com/CVEProject/cvelistV5", license: "CVE Program Terms of Use (reproduction and derivative works allowed, keep the notice)", visibility: "public" }, facts);
}

/** The reviewed advisories only, through the global advisories API, 100 to a request: the unreviewed ones (about 43,000 in the window) mirror what cvelist already covers. */
async function githubAdvisories(): Promise<SourceRecord[]> {
  const facts: Fact[] = [];
  const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"];
  for (const month of SAMPLE ? ["03"] : months) {
    if (pauseRequested()) break;
    const first = `2026-${month}-01` < FROM ? FROM : `2026-${month}-01`;
    const end = new Date(Date.UTC(2026, Number(month), 0)).toISOString().slice(0, 10);
    const list = await githubAll<{ ghsa_id: string; published_at?: string; withdrawn_at?: string | null; summary?: string; description?: string; severity?: string; identifiers?: Array<{ type: string; value: string }>; vulnerabilities?: Array<{ package?: { ecosystem?: string; name?: string } }> }>(`advisories?type=reviewed&published=${first}..${end > TO ? TO : end}&per_page=100`);
    for (const a of SAMPLE ? list.slice(0, Math.min(LIMIT * 2, 9)) : list) {
      const date = a.published_at?.slice(0, 10);
      if (a.withdrawn_at || !inWindow(date)) continue;
      const packages = [...new Set((a.vulnerabilities ?? []).map((x) => (x.package?.name ? `${x.package.name} (${x.package.ecosystem})` : "")).filter(Boolean))].slice(0, 4);
      const aliases = (a.identifiers ?? []).filter((i) => i.type !== "GHSA").map((i) => i.value);
      const parts = [
        `GitHub published advisory ${a.ghsa_id} on ${longDate(date)}${a.severity ? `, rated ${a.severity.toLowerCase()} severity` : ""}.`,
        a.summary ? endSentence(oneLine(a.summary)) : "",
        packages.length ? `It affects ${packages.join(", ")}.` : "",
        aliases.length ? `Also known as ${aliases.slice(0, 3).join(", ")}.` : "",
        a.description ? clip(oneLine(mdText(a.description)), 70) : "",
      ];
      facts.push({ date, text: parts.filter(Boolean).join(" ") });
    }
  }
  return byMonth({ id: "github-advisories", source: "GitHub Advisory Database", title: "Reviewed security advisories", url: "https://github.com/github/advisory-database", license: "CC BY 4.0 (GitHub Advisory Database)", visibility: "public" }, facts);
}

// ---------------------------------------------------------------------------------------------------------------------
// AI industry data
// ---------------------------------------------------------------------------------------------------------------------

const EPOCH_LICENSE = "CC BY 4.0 (Epoch AI, credit source and authors)";

function money(value: string): string {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return "";
  if (n >= 1e9) return `$${Number((n / 1e9).toFixed(2))} billion`;
  if (n >= 1e6) return `$${Number((n / 1e6).toFixed(1))} million`;
  return `$${n.toLocaleString("en-US")}`;
}

function count(value: string): string {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return "";
  if (n >= 1e12) return `${Number((n / 1e12).toFixed(2))} trillion`;
  if (n >= 1e9) return `${Number((n / 1e9).toFixed(2))} billion`;
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(2))} million`;
  return Math.round(n).toLocaleString("en-US");
}

const score = (value: string) => (value && Number.isFinite(Number(value)) ? String(Number(Number(value).toPrecision(3))) : value);
const firstOf = (list: string) => list.split(",").slice(0, 3).join(", ");

type Row = Record<string, string>;

/** Which Epoch tables become sentences: only rows dated in the window, and never press quotes or job posting text. */
const EPOCH_TABLES: Array<{ zip: string; file: string; title: string; url: string; date: (r: Row) => string; text: (r: Row, when: string) => string; known?: (r: Row) => string }> = [
  {
    zip: "ai_models.zip",
    file: "all_ai_models.csv",
    title: "AI models",
    url: "https://epoch.ai/data/ai-models",
    date: (r) => r["Publication date"],
    text: (r, when) =>
      [
        `${r.Organization ? `${firstOf(r.Organization)} published` : "Published:"} ${r.Model} on ${when}.`,
        r.Task ? `Its tasks include ${firstOf(r.Task).toLowerCase()}.` : "",
        r.Parameters ? `It has ${count(r.Parameters)} parameters.` : "",
        r["Training compute (FLOP)"] ? `Epoch AI puts its training compute at ${score(r["Training compute (FLOP)"])} FLOP.` : "",
        r["Model accessibility"] ? `Access: ${r["Model accessibility"]}.` : "",
        r["Country (of organization)"] ? `Country: ${firstOf(r["Country (of organization)"])}.` : "",
      ].filter(Boolean).join(" "),
  },
  {
    zip: "ai_companies.zip",
    file: "ai_companies_funding_rounds.csv",
    title: "AI company funding rounds",
    url: "https://epoch.ai/data/ai-companies",
    date: (r) => r["Close date"] || r["Report date"],
    known: (r) => r["Report date"],
    text: (r, when) =>
      [
        `${r.Company} had a funding round on ${when}, status ${(r.Status || "not stated").toLowerCase()}.`,
        r["Funding (equity)"] ? `Equity raised: ${money(r["Funding (equity)"])}.` : "",
        r["Funding (debt)"] ? `Debt raised: ${money(r["Funding (debt)"])}.` : "",
        r["Valuation (post-money)"] ? `Post-money valuation: ${money(r["Valuation (post-money)"])}.` : "",
      ].filter(Boolean).join(" "),
  },
  {
    zip: "ai_companies.zip",
    file: "ai_companies_revenue_reports.csv",
    title: "AI company revenue",
    url: "https://epoch.ai/data/ai-companies",
    date: (r) => r.Date,
    known: (r) => r["Report date"],
    text: (r, when) => `${r.Company} had annualized revenue of ${money(r["Annualized revenue (USD)"]) || "an unstated amount"} as of ${when}${r.Scope ? ` (${r.Scope.toLowerCase()})` : ""}${r.Confidence ? `; Epoch AI's confidence in this figure is ${r.Confidence.toLowerCase()}` : ""}.`,
  },
  {
    zip: "ai_companies.zip",
    file: "ai_companies_staff_reports.csv",
    title: "AI company staff counts",
    url: "https://epoch.ai/data/ai-companies",
    date: (r) => r.Date,
    known: (r) => r["Report date"],
    text: (r, when) => `${r.Company} had about ${count(r["Staff count"])} staff as of ${when}${r["Division name"] ? ` in ${r["Division name"]}` : ""}.`,
  },
  {
    zip: "ai_companies.zip",
    file: "ai_companies_usage_reports.csv",
    title: "AI product usage",
    url: "https://epoch.ai/data/ai-companies",
    date: (r) => r.Date,
    known: (r) => r["Report date"],
    text: (r, when) =>
      [
        `As of ${when}, ${r.Product || r.Company}${r.Product && r.Company ? ` from ${r.Company}` : ""} was reported to have`,
        [r["Active users"] ? `${count(r["Active users"])} ${(r["Active users time period"] || "").toLowerCase()} active users` : "", r["Daily tokens"] ? `${count(r["Daily tokens"])} tokens a day` : "", r["Daily messages"] ? `${count(r["Daily messages"])} messages a day` : ""].filter(Boolean).join(" and ") + ".",
      ].join(" "),
  },
  {
    zip: "ai_companies.zip",
    file: "ai_companies_compute_spend.csv",
    title: "AI company compute spending",
    url: "https://epoch.ai/data/ai-companies",
    date: (r) => r.Date,
    known: (r) => r["Report date"],
    text: (r, when) => `${r.Company} spent an annualized ${money(r.Amount) || "unstated amount"} on ${(r.Category || "compute").replace(/,/g, " and ")} in the ${(r["Period type"] || "period").toLowerCase()} ending ${when}.`,
  },
  {
    zip: "data_centers/data_centers.zip",
    file: "data_center_timelines.csv",
    title: "AI data center timelines",
    url: "https://epoch.ai/data/ai-data-centers",
    date: (r) => r.Date,
    text: (r, when) =>
      [
        `As of ${when}, Epoch AI's timeline for the ${r["Data center"]} data center shows`,
        ([Number(r["Power (MW)"]) ? `${count(r["Power (MW)"])} MW of power` : "", Number(r["H100 equivalents"]) ? `${count(r["H100 equivalents"])} H100 equivalents of compute` : "", Number(r["Total capital cost (2025 USD billions)"]) ? `a total capital cost of $${score(r["Total capital cost (2025 USD billions)"])} billion in 2025 dollars` : ""].filter(Boolean).join(", ") || "no power online yet") + ".",
        r["Construction status"] ? clip(oneLine(r["Construction status"]), 50) : "",
      ].filter(Boolean).join(" "),
  },
  {
    zip: "ai_chip_sales.zip",
    file: "timelines_by_chip.csv",
    title: "AI chip sales",
    url: "https://epoch.ai/data/ai-chip-sales",
    date: (r) => r["End date"],
    text: (r, when) => `Epoch AI estimates that ${r["Chip manufacturer"]} sold about ${count(r["Number of Units"])} ${r["Chip type"] || "AI chip"} units in the period ending ${when}, equal to ${count(r["Compute estimate in H100e (median)"])} H100 equivalents.${r.Incomplete === "True" ? " The figure is incomplete." : ""}`,
  },
  {
    zip: "benchmark_data.zip",
    file: "eci_scores.csv",
    title: "Epoch Capabilities Index scores",
    url: "https://epoch.ai/benchmarks",
    date: (r) => r.date,
    text: (r, when) => `${r["Display name"] || r.Model}${r.Organization ? ` from ${firstOf(r.Organization)}` : ""}, released on ${when}, has an Epoch Capabilities Index score of ${score(r.eci)} (95% interval ${score(r.eci_ci_low)} to ${score(r.eci_ci_high)}).`,
  },
];

async function epoch(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  const zips = new Map<string, Awaited<ReturnType<typeof download>>>();
  for (const zip of new Set(EPOCH_TABLES.map((t) => t.zip))) zips.set(zip, await download(`https://epoch.ai/data/${zip}`));
  for (const table of EPOCH_TABLES) {
    const file = zips.get(table.zip);
    if (!file) continue;
    const facts: Fact[] = [];
    for await (const { data } of zipEntries(file, (name) => path.basename(name) === table.file)) {
      for (const row of parseCsv(data.toString("utf8"))) {
        const date = (table.date(row) ?? "").slice(0, 10);
        const known = table.known?.(row)?.slice(0, 10);
        if (inWindow(date) && !(known && known > TO)) facts.push({ date, text: table.text(row, longDate(date)) });
      }
    }
    records.push(...byMonth({ id: `epoch:${table.file.replace(".csv", "")}`, source: "Epoch AI", title: table.title, url: table.url, license: EPOCH_LICENSE, visibility: "public" }, facts));
  }
  const benchmarks = zips.get("benchmark_data.zip");
  if (benchmarks) {
    const facts: Fact[] = [];
    for await (const { name, data } of zipEntries(benchmarks, (n) => n.endsWith(".csv") && !n.endsWith("_external.csv"))) {
      const rows = parseCsv(data.toString("utf8"));
      if (!rows.length || !("Model version" in rows[0]) || !("mean_score" in rows[0])) continue;
      const label = path.basename(name, ".csv").replace(/_/g, " ");
      for (const r of rows) {
        const date = (r["Started at"] || r["Release date"] || "").slice(0, 10);
        if (inWindow(date)) facts.push({ date, text: `In a run started on ${longDate(date)}, ${r["Model version"]}${r.Organization ? ` from ${firstOf(r.Organization)}` : ""} scored ${score(r.mean_score)} on the ${label} benchmark in Epoch AI's data.` });
      }
    }
    records.push(...byMonth({ id: "epoch:benchmarks", source: "Epoch AI", title: "Benchmark results", url: "https://epoch.ai/benchmarks", license: EPOCH_LICENSE, visibility: "public" }, facts));
  }
  return records;
}

const ARENA_BOARDS = ["text", "vision", "webdev", "search", "agent", "document", "text_to_image", "image_edit", "text_to_video", "image_to_video", "video_edit"];

/** The top 10 of each leaderboard, through the Hugging Face dataset viewer. A snapshot with the same order as the last is skipped. */
async function lmarena(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const board of SAMPLE ? ["text"] : ARENA_BOARDS) {
    const rows: Array<Record<string, string | number | null>> = [];
    const where = encodeURIComponent(`"category"='overall' AND "rank"<=10 AND "leaderboard_publish_date">='${FROM}' AND "leaderboard_publish_date"<='${TO}'`);
    const order = encodeURIComponent(`"leaderboard_publish_date"`);
    for (let offset = 0; !pauseRequested() && offset < (SAMPLE ? 100 : 5000); offset += 100) {
      const page = await getJson<{ rows?: Array<{ row: Record<string, string | number | null> }> }>(`https://datasets-server.huggingface.co/filter?dataset=lmarena-ai/leaderboard-dataset&config=${board}&split=full&where=${where}&orderby=${order}&offset=${offset}&length=100`);
      rows.push(...(page?.rows ?? []).map((r) => r.row));
      if ((page?.rows ?? []).length < 100) break;
    }
    const snapshots = new Map<string, typeof rows>();
    for (const r of rows) snapshots.set(String(r.leaderboard_publish_date), [...(snapshots.get(String(r.leaderboard_publish_date)) ?? []), r]);
    const facts: Fact[] = [];
    let previous = "";
    for (const [date, group] of [...snapshots].sort(([a], [b]) => a.localeCompare(b))) {
      const ranked = [...group].sort((a, b) => Number(a.rank) - Number(b.rank));
      const order = ranked.map((r) => r.model_name).join("|");
      if (order === previous) continue;
      previous = order;
      const entries = ranked.map((r) => {
        const value = r.rating ?? r.score;
        return `${Number(r.rank)}. ${r.model_name}${r.organization ? ` (${r.organization})` : ""}${value !== null && value !== undefined ? `, ${r.rating !== undefined ? `rating ${Math.round(Number(value))}` : `score ${score(String(value))}`}` : ""}`;
      });
      facts.push({ date, text: `The LMArena ${board.replace(/_/g, " ")} leaderboard published on ${longDate(date)} ranked these models overall: ${entries.join("; ")}.` });
    }
    records.push(...byMonth({ id: `lmarena:${board}`, source: "LMArena leaderboard-dataset", title: `LMArena ${board.replace(/_/g, " ")} leaderboard`, url: "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset", license: "CC BY 4.0 (LMArena)", visibility: "public" }, facts));
  }
  return records;
}

const HF_LICENSES = ["apache-2.0", "mit", "bsd-3-clause", "bsd-2-clause", "bsd"];
const HF_LICENSE_NAMES: Record<string, string> = { "apache-2.0": "Apache 2.0", mit: "MIT", "bsd-3-clause": "BSD-3-Clause", "bsd-2-clause": "BSD-2-Clause", bsd: "BSD" };
const HF_LABS = ["deepseek-ai", "Qwen", "mistralai", "google", "meta-models", "microsoft", "nvidia", "openai", "ibm-granite", "LiquidAI", "MiniMaxAI", "moonshotai", "zai-org", "tencent", "ByteDance-Seed", "allenai", "stepfun-ai", "XiaomiMiMo", "baidu", "huggingface", "HuggingFaceTB", "unsloth", "black-forest-labs", "stabilityai", "Nanbeige", "arcee-ai", "nomic-ai", "BAAI", "OpenGVLab", "Snowflake"];
/** Hugging Face tags these MIT or Apache at times, but the claim check found restrictive licenses behind them. */
const HF_NOT_OPEN = /Mistral-Medium|Timestral|Mistral-Large-4|Qwen3\.8-2\.4T|Qwen3\.8-Flash-Next/i;
const HF_COPY = /gguf|mlx|onnx|nvfp4|awq|gptq|exl2|openvino|[-_](\d)bit|quant/i;

interface HfModel {
  id: string;
  gated?: boolean | string;
  private?: boolean;
  likes?: number;
  downloads?: number;
  tags?: string[];
  pipeline_tag?: string;
  createdAt?: string;
}

/** Model cards of notable models created in the window, for Apache, MIT and BSD licenses only; gated and repacked copies skipped. */
async function huggingFaceCards(): Promise<SourceRecord[]> {
  const queries = SAMPLE
    ? [`author=deepseek-ai&sort=createdAt&direction=-1&limit=30`]
    : [...HF_LICENSES.flatMap((l) => [`filter=license:${l}&sort=likes&direction=-1&limit=1000`, `filter=license:${l}&sort=trendingScore&direction=-1&limit=1000`]), ...HF_LABS.map((a) => `author=${a}&sort=createdAt&direction=-1&limit=300`)];
  const models = new Map<string, HfModel>();
  for (const q of queries) {
    if (pauseRequested()) break;
    for (const m of (await getJson<HfModel[]>(`https://huggingface.co/api/models?${q}&full=true`)) ?? []) models.set(m.id, m);
  }
  const labs = new Set(HF_LABS.map((l) => l.toLowerCase()));
  const chosen = [...models.values()].filter((m) => {
    const license = m.tags?.find((t) => t.startsWith("license:"))?.slice(8) ?? "";
    if (!HF_LICENSES.includes(license) || m.gated || m.private || !inWindow(m.createdAt?.slice(0, 10))) return false;
    if (HF_NOT_OPEN.test(m.id) || HF_COPY.test(m.id) || m.tags?.some((t) => t === "gguf" || t.startsWith("base_model:quantized:"))) return false;
    return (m.likes ?? 0) >= (labs.has(m.id.split("/")[0].toLowerCase()) ? 25 : 100);
  }).sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
  const records: SourceRecord[] = [];
  for (const m of SAMPLE ? chosen.slice(0, Math.min(LIMIT, 8)) : chosen) {
    if (pauseRequested()) break;
    const md = await get(`https://huggingface.co/${m.id}/resolve/main/README.md`);
    if (!md) continue;
    const declared = md.match(/^---\n[\s\S]*?\n---/)?.[0] ?? "";
    const license = m.tags?.find((t) => t.startsWith("license:"))?.slice(8) ?? "";
    if (/license_name|modified/i.test(declared) || /modified mit/i.test(md.slice(0, 4000))) continue;
    const text = mdText(md).replace(/https?:\/\/\S+/g, "");
    if (wordCount(text) < 100) continue;
    const date = m.createdAt!.slice(0, 10);
    records.push({
      id: `hf-card:${m.id}`,
      source: "Hugging Face model card",
      title: m.id,
      url: `https://huggingface.co/${m.id}`,
      date,
      license: HF_LICENSE_NAMES[license] ?? license,
      visibility: "public",
      text: `${m.id} was published on Hugging Face on ${longDate(date)} under the ${HF_LICENSE_NAMES[license] ?? license} license.\n\n${text}`,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------------------------------------------------
// Changelogs of AI labs
// ---------------------------------------------------------------------------------------------------------------------

async function googleChangelog(): Promise<SourceRecord[]> {
  const md = await get("https://ai.google.dev/gemini-api/docs/changelog.md.txt");
  const facts = changelogFacts("Gemini API", md ?? "", { maxWords: 600 });
  return byMonth({ id: "google-ai-changelog", source: "Google AI for Developers changelog", title: "Gemini API changes", url: "https://ai.google.dev/gemini-api/docs/changelog", license: "CC BY 4.0 (ai.google.dev)", visibility: "public" }, facts);
}

async function anthropicNotes(): Promise<SourceRecord[]> {
  const md = await get("https://platform.claude.com/docs/en/release-notes/overview.md");
  const facts = changelogFacts("Claude Developer Platform", md ?? "", { maxWords: 600 });
  return byMonth({ id: "anthropic-release-notes", source: "Anthropic release notes", title: "Claude Developer Platform release notes", url: "https://platform.claude.com/docs/en/release-notes/overview", license: "Anthropic copyright, training only", visibility: "private" }, facts);
}

const SDK_REPOS = [
  "anthropics/anthropic-sdk-python",
  "anthropics/anthropic-sdk-typescript",
  "openai/openai-python",
  "openai/openai-node",
  "openai/openai-go",
  "openai/openai-java",
  "googleapis/python-genai",
  "googleapis/js-genai",
  "mistralai/client-python",
  "mistralai/client-ts",
  "cohere-ai/cohere-python",
  "meta-llama/llama-stack",
  "xai-org/xai-sdk-python",
];

/** Only repositories whose license GitHub reports as MIT, Apache or BSD are read. */
async function sdkChangelogs(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const repo of SAMPLE ? SDK_REPOS.slice(0, 3) : SDK_REPOS) {
    if (pauseRequested()) break;
    const info = await github<{ default_branch: string; license?: { spdx_id?: string } | null }>(`repos/${repo}`);
    const license = info?.license?.spdx_id ?? "";
    if (!info || !/^(MIT|Apache-2\.0|BSD-[23]-Clause)$/.test(license)) {
      console.warn(`${repo}: skipped, license ${license || "unknown"}`);
      continue;
    }
    const log = await repoChangelog(repo, info.default_branch);
    if (log) records.push(...byMonth({ id: `sdk-changelog:${repo}`, source: "AI lab SDK changelogs", title: `${repo} changelog`, url: `https://github.com/${repo}/blob/${info.default_branch}/${log.file}`, license, visibility: "public" }, log.facts));
  }
  return records;
}

// ---------------------------------------------------------------------------------------------------------------------
// Surveys and standards
// ---------------------------------------------------------------------------------------------------------------------

/** The survey's Markdown summaries, overview and chapters, under ODbL. Date is null because the site states no publish date. */
async function stackOverflow(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const page of ["", "/work", "/ai", "/technology", "/community", "/knowledge"]) {
    const md = await get(`https://survey.stackoverflow.co/2026${page}.md`);
    if (!md) continue;
    const name = page ? page.slice(1) : "overview";
    const text = mdText(md.replace(/\[all data\]\([^)]*\)/g, "")).replace(/\s*·\s*/g, " ").replace(/https?:\/\/\S+/g, "");
    records.push({ id: `stackoverflow-2026:${name}`, source: "Stack Overflow Developer Survey 2026", title: `Stack Overflow Developer Survey 2026, ${name}`, url: `https://survey.stackoverflow.co/2026${page}`, date: null, license: "ODbL 1.0 (Stack Overflow survey data), share-alike", visibility: "public", text: `These are results of the Stack Overflow Developer Survey 2026, which ran in the summer of 2026.\n\n${text}` });
  }
  return records;
}

interface RfcEntry {
  number: string;
  title: string;
  authors: string[];
  month: string;
  status: string;
  stream: string;
  group: string;
  pages: string;
}

/** RFCs of 2026 from the index, with the exact date from Datatracker, falling back to the end of the stated month. */
async function rfcsOf2026(): Promise<Array<RfcEntry & { date: string }>> {
  const xml = (await get("https://www.rfc-editor.org/rfc-index.xml")) ?? "";
  const entries = (xml.match(/<rfc-entry>[\s\S]*?<\/rfc-entry>/g) ?? []).filter((e) => /<year>2026<\/year>/.test(e));
  const tag = (entry: string, name: string) => htmlToText(entry.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? "");
  const chosen = SAMPLE ? entries.slice(-Math.min(LIMIT, 5)) : entries;
  const rfcs: Array<RfcEntry & { date: string }> = [];
  for (const e of chosen) {
    if (pauseRequested()) break;
    const number = (e.match(/<doc-id>RFC0*(\d+)<\/doc-id>/) ?? [])[1];
    if (!number) continue;
    const month = tag(e, "month");
    const monthNumber = String(MONTHS.indexOf(month) + 1).padStart(2, "0");
    const doc = await getJson<{ time?: string }>(`https://datatracker.ietf.org/doc/rfc${number}/doc.json`);
    const exact = doc?.time?.slice(0, 10);
    const lastDay = new Date(Date.UTC(2026, Number(monthNumber), 0)).toISOString().slice(0, 10);
    const date = exact?.startsWith(`2026-${monthNumber}`) ? exact : lastDay < TO ? lastDay : TO;
    if (!inWindow(date)) continue;
    rfcs.push({
      number,
      title: tag(e, "title"),
      authors: (e.match(/<author>\s*<name>([^<]+)<\/name>/g) ?? []).map((a) => htmlToText(a)),
      month,
      status: tag(e, "current-status").toLowerCase(),
      stream: tag(e, "stream"),
      group: tag(e, "wg_acronym"),
      pages: tag(e, "page-count"),
      date,
    });
  }
  return rfcs;
}

/** Facts only, so these can be public: titles, authors, status and dates. RFC text cannot be paraphrased in public (TLP 5.0). */
async function rfcIndex(): Promise<SourceRecord[]> {
  const facts = (await rfcsOf2026()).map((r) => ({
    date: r.date,
    text: `RFC ${r.number}, "${r.title}", by ${r.authors.join(", ")}, was published on ${longDate(r.date)} with status ${r.status}, in the ${r.stream} stream${r.group && r.group !== "none" ? ` by the ${r.group} working group` : ""}, ${r.pages} pages long.`,
  }));
  return byMonth({ id: "rfc-index", source: "RFC Index", title: "RFCs published", url: "https://www.rfc-editor.org/rfc-index.html", license: "Facts from the RFC Editor's index", visibility: "public" }, facts);
}

/** Whole RFCs, byte for byte. Private because anything downstream rewrites them, and TLP 5.0 allows no modified text. */
async function rfcText(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const r of await rfcsOf2026()) {
    if (pauseRequested()) break;
    const text = await get(`https://www.rfc-editor.org/rfc/rfc${r.number}.txt`);
    if (text) records.push({ id: `rfc:${r.number}`, source: "IETF RFC", title: `RFC ${r.number}: ${r.title}`, url: `https://www.rfc-editor.org/rfc/rfc${r.number}`, date: r.date, license: "IETF Trust TLP 5.0, unmodified copies only, training only", visibility: "private", text });
  }
  return records;
}

const ECMA_LICENSE = "Ecma alternative copyright notice (changes allowed if the notice is kept and changes are flagged)";

/** The edition's introduction and copyright notice, plus the normative changes merged into the specification this year. */
async function ecmascript(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  const html = await get("https://tc39.es/ecma262/2026/");
  const section = (id: string) => html?.match(new RegExp(`<(emu-intro|emu-annex|emu-clause)[^>]*id="${id}"[\\s\\S]*?</\\1>`))?.[0] ?? "";
  const intro = htmlToText(section("sec-intro"));
  const notice = htmlToText(section("sec-copyright-and-software-license"));
  if (intro) {
    records.push({
      id: "ecmascript-2026:introduction",
      source: "ECMA-262",
      title: "ECMAScript 2026 Language Specification, introduction",
      url: "https://tc39.es/ecma262/2026/",
      date: "2026-06-30",
      license: ECMA_LICENSE,
      visibility: "public",
      text: `ECMAScript 2026, the seventeenth edition of ECMA-262, was published in June 2026. What follows is an extract: the specification's introduction with its markup removed.\n\n${intro}${notice ? `\n\n${notice}` : ""}`,
    });
  }
  const facts: Fact[] = [];
  for (let page = 1; page <= (SAMPLE ? 1 : 20) && !pauseRequested(); page++) {
    const commits = await github<Array<{ commit: { message: string; committer?: { date?: string } } }>>(`repos/tc39/ecma262/commits?since=${FROM}T00:00:00Z&until=${TO}T23:59:59Z&per_page=100&page=${page}`);
    for (const c of commits ?? []) {
      const subject = oneLine(c.commit.message.split("\n")[0]);
      const date = c.commit.committer?.date?.slice(0, 10);
      if (inWindow(date) && /^(normative|layering)/i.test(subject)) facts.push({ date, text: `On ${longDate(date)}, this change was merged into the ECMAScript specification draft: ${subject.replace(/^normative:\s*/i, "").replace(/\s*\(#\d+\)$/, "")}.` });
    }
    if ((commits ?? []).length < 100) break;
  }
  records.push(...byMonth({ id: "ecma262-changes", source: "ECMA-262", title: "Normative changes to the ECMAScript specification", url: "https://github.com/tc39/ecma262", license: ECMA_LICENSE, visibility: "public" }, facts));
  return records;
}

const WHATWG_SPECS: Array<[string, string]> = [
  ["html", "HTML"],
  ["dom", "DOM"],
  ["fetch", "Fetch"],
  ["url", "URL"],
  ["streams", "Streams"],
  ["encoding", "Encoding"],
  ["infra", "Infra"],
  ["mimesniff", "MIME Sniffing"],
  ["storage", "Storage"],
  ["xhr", "XMLHttpRequest"],
  ["notifications", "Notifications API"],
  ["compat", "Compatibility"],
  ["fullscreen", "Fullscreen API"],
  ["console", "Console"],
  ["webidl", "Web IDL"],
  ["websockets", "WebSockets"],
  ["urlpattern", "URL Pattern"],
];

/** What changed in each Living Standard, from its commit log. Editorial and housekeeping commits are left out. */
async function whatwg(): Promise<SourceRecord[]> {
  const facts: Fact[] = [];
  for (const [repo, name] of SAMPLE ? WHATWG_SPECS.slice(0, 2) : WHATWG_SPECS) {
    for (let page = 1; page <= (SAMPLE ? 1 : 20) && !pauseRequested(); page++) {
      const commits = await github<Array<{ commit: { message: string; committer?: { date?: string } } }>>(`repos/whatwg/${repo}/commits?since=${FROM}T00:00:00Z&until=${TO}T23:59:59Z&per_page=100&page=${page}`);
      for (const c of commits ?? []) {
        const [subject, ...rest] = c.commit.message.split("\n");
        const date = c.commit.committer?.date?.slice(0, 10);
        if (!inWindow(date) || /^(editorial|meta)\b/i.test(subject)) continue;
        const detail = oneLine(rest.join("\n").split(/\n\s*\n/).find((p) => p.trim() && !/^\s*(fixes|closes|tests|co-authored|signed-off|see|follow-?up|part of|helps)\b/i.test(p.trim())) ?? "");
        facts.push({ date, text: `On ${longDate(date)}, the WHATWG ${name} Standard changed: ${endSentence(oneLine(subject).replace(/\s*\(#\d+\)$/, ""))}${detail ? ` ${clip(detail, 60)}` : ""}` });
      }
      if ((commits ?? []).length < 100) break;
    }
  }
  return byMonth({ id: "whatwg-changes", source: "WHATWG Living Standards", title: "Changes to WHATWG standards", url: "https://spec.whatwg.org", license: "CC BY 4.0 (WHATWG)", visibility: "public" }, facts);
}

/** PEPs created in the window. PEP 1 asks new PEPs to be public domain and CC0, and each file's own copyright section is checked. */
async function peps(): Promise<SourceRecord[]> {
  const all = await getJson<Record<string, { number: number; title: string; authors: string; status: string; type: string; created: string; python_version?: string | null; url: string }>>("https://peps.python.org/api/peps.json");
  const records: SourceRecord[] = [];
  const created = Object.values(all ?? {}).map((p) => ({ ...p, date: findDate(p.created.replace(/-/g, " ")) })).filter((p) => inWindow(p.date)).sort((a, b) => b.number - a.number);
  for (const p of SAMPLE ? created.slice(0, Math.min(LIMIT, 6)) : created) {
    if (pauseRequested()) break;
    const number = String(p.number).padStart(4, "0");
    const rst = await get(raw("python/peps", "main", `peps/pep-${number}.rst`));
    if (!rst) continue;
    const open = /public domain|CC0/i.test(rst.slice(-1500));
    const body = rstToText(rst.slice(rst.search(/\n\s*\n/)));
    const facts = `PEP ${p.number}, "${p.title}", by ${p.authors}, was created on ${longDate(p.date!)}. It is a ${p.type} PEP with status ${p.status}${p.python_version ? `, targeting Python ${p.python_version}` : ""}.`;
    records.push({ id: `pep:${p.number}`, source: "Python Enhancement Proposals", title: `PEP ${p.number}: ${p.title}`, url: p.url, date: p.date, license: open ? "Public domain or CC0 1.0 (PEP 1)" : "PEP without a stated open license, training only", visibility: open ? "public" : "private", text: `${facts}\n\n${body}` });
  }
  return records;
}

// ---------------------------------------------------------------------------------------------------------------------
// Release notes of languages and platforms
// ---------------------------------------------------------------------------------------------------------------------

async function pythonReleases(): Promise<SourceRecord[]> {
  const releases = (await getJson<Array<{ name: string; release_date: string; pre_release: boolean }>>("https://www.python.org/api/v2/downloads/release/?is_published=true")) ?? [];
  const facts = releases.filter((r) => inWindow(r.release_date?.slice(0, 10))).map((r) => ({ date: r.release_date.slice(0, 10), text: `${r.name} was released on ${longDate(r.release_date.slice(0, 10))}${r.pre_release ? " as a pre-release" : ""}.` }));
  const records = byMonth({ id: "python-releases", source: "Python releases", title: "Python releases", url: "https://www.python.org/downloads/", license: "PSF-2.0 (Python)", visibility: "public" }, facts);
  const final = releases.find((r) => r.name === "Python 3.15.0");
  const whatsNew = (await get(raw("python/cpython", "main", "Doc/whatsnew/3.15.rst"))) ?? "";
  const date = final?.release_date?.slice(0, 10);
  if (whatsNew && inWindow(date)) {
    records.push({ id: "python-whatsnew:3.15", source: "Python documentation", title: "What's new in Python 3.15", url: "https://docs.python.org/3.15/whatsnew/3.15.html", date, license: "PSF-2.0 (Python documentation)", visibility: "public", text: `Python 3.15.0 was released on ${longDate(date)}. This is what the documentation lists as new in it.\n\n${rstToText(whatsNew)}` });
  }
  return records;
}

async function nodeReleases(): Promise<SourceRecord[]> {
  const facts: Fact[] = [];
  for (const line of SAMPLE ? ["26"] : ["26", "25", "24", "22", "20"]) {
    if (pauseRequested()) break;
    const md = await get(raw("nodejs/node", "main", `doc/changelogs/CHANGELOG_V${line}.md`));
    facts.push(...changelogFacts("Node.js", (md ?? "").replace(/^[\s\S]*?(?=<a id=")/, "")));
  }
  return byMonth({ id: "node-releases", source: "Node.js changelog", title: "Node.js releases", url: "https://github.com/nodejs/node/tree/main/doc/changelogs", license: "MIT (Node.js)", visibility: "public" }, facts);
}

const GO_LICENSE = "BSD-3-Clause (Go project)";

async function goReleases(): Promise<SourceRecord[]> {
  const page = await get("https://go.dev/doc/devel/release");
  const text = oneLine(htmlToText(page ?? ""));
  const facts: Fact[] = [];
  const majors = new Map<string, string>();
  for (const m of text.matchAll(/\bgo(\d+\.\d+(?:\.\d+)?)\s*\(released (\d{4}-\d{2}-\d{2})\)\s*([\s\S]*?)(?=\bgo\d+\.\d+(?:\.\d+)?\s*\(released|$)/g)) {
    const [, version, date, rest] = m;
    if (!inWindow(date)) continue;
    if (/^\d+\.\d+\.0$|^\d+\.\d+$/.test(version)) majors.set(version.replace(/\.0$/, ""), date);
    const detail = rest.split(/\bSee the\b|\bRead the\b|Minor revisions/)[0].trim().replace(/\s+,/g, ",");
    facts.push({ date, text: `Go ${version} was released on ${longDate(date)}.${detail ? ` This release ${detail.replace(/^(Go \S+ is)/, "is")}` : ""}`.replace(/This release is a major release of Go\.?/, "It is a major release of Go.") });
  }
  const records = byMonth({ id: "go-releases", source: "Go release history", title: "Go releases", url: "https://go.dev/doc/devel/release", license: GO_LICENSE, visibility: "public" }, facts);
  for (const [version, date] of SAMPLE ? [...majors].slice(0, 1) : majors) {
    const html = await get(`https://go.dev/doc/go${version}`);
    const article = html?.match(/<article[\s\S]*?<\/article>/)?.[0] ?? html ?? "";
    const notes = htmlToText(article.replace(/<pre[\s\S]*?<\/pre>/g, " "));
    if (notes) records.push({ id: `go-notes:${version}`, source: "Go release notes", title: `Go ${version} release notes`, url: `https://go.dev/doc/go${version}`, date, license: GO_LICENSE, visibility: "public", text: `Go ${version} was released on ${longDate(date)}.\n\n${notes}` });
  }
  return records;
}

async function rustReleases(): Promise<SourceRecord[]> {
  const md = await get(raw("rust-lang/rust", "main", "RELEASES.md"));
  return byMonth({ id: "rust-releases", source: "Rust release notes", title: "Rust releases", url: "https://github.com/rust-lang/rust/blob/main/RELEASES.md", license: "MIT OR Apache-2.0 (Rust)", visibility: "public" }, changelogFacts("Rust", md ?? ""));
}

/** One document per blog post stored as Markdown in a repository, dated by front matter or by a /MM/DD/ path. */
async function repoBlog(opts: { repo: string; branch: string; dir: string; source: string; license: string; url: (file: string, date: string, slug: string | null) => string }): Promise<SourceRecord[]> {
  const listing = await github<{ tree: Array<{ path: string; type: string }> }>(`repos/${opts.repo}/git/trees/${opts.branch}:${opts.dir}?recursive=1`);
  const files = (listing?.tree ?? []).filter((t) => t.type === "blob" && /\.mdx?$/.test(t.path)).map((t) => t.path);
  const records: SourceRecord[] = [];
  for (const file of SAMPLE ? files.slice(0, Math.min(LIMIT + 2, 8)) : files) {
    if (pauseRequested()) break;
    const md = await get(raw(opts.repo, opts.branch, `${opts.dir}/${file}`));
    if (!md) continue;
    const front = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const field = (name: string) => front.match(new RegExp(`^${name}:\\s*["']?(.*?)["']?\\s*$`, "m"))?.[1];
    const pathDate = file.match(/^(\d{2})\/(\d{2})\//);
    const date = findDate(field("date") ?? "") ?? (pathDate ? `2026-${pathDate[1]}-${pathDate[2]}` : null);
    if (!inWindow(date) || /^true$/i.test(field("draft") ?? "")) continue;
    const title = field("title") ?? file;
    const text = mdText(md.replace(/\{\{[<%][\s\S]*?[>%]\}\}/g, "")).replace(/https?:\/\/\S+/g, "");
    records.push({ id: `${opts.source.toLowerCase().replace(/[^a-z]+/g, "-")}:${file}`, source: opts.source, title, url: opts.url(file, date, field("slug") ?? null), date, license: opts.license, visibility: "public", text: `${opts.source} published "${title}" on ${longDate(date)}.\n\n${text}` });
  }
  return records;
}

const kubernetesBlog = () =>
  repoBlog({
    repo: "kubernetes/website",
    branch: "main",
    dir: "content/en/blog/_posts/2026",
    source: "Kubernetes blog",
    license: "CC BY 4.0 (Kubernetes documentation)",
    url: (file, date, slug) => `https://kubernetes.io/blog/${date.replace(/-/g, "/")}/${slug ?? path.basename(file, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "")}/`,
  });

const reactBlog = () =>
  repoBlog({
    repo: "reactjs/react.dev",
    branch: "main",
    dir: "src/content/blog/2026",
    source: "React blog",
    license: "CC BY 4.0 (react.dev)",
    url: (file) => `https://react.dev/blog/2026/${file.replace(/\.mdx?$/, "")}`,
  });

async function djangoReleases(): Promise<SourceRecord[]> {
  const listing = await github<{ tree: Array<{ path: string }> }>("repos/django/django/git/trees/main:docs/releases");
  const files = (listing?.tree ?? []).map((t) => t.path).filter((p) => /^(5\.2|6\.\d)(\.\d+)?\.txt$/.test(p)).sort().reverse();
  const records: SourceRecord[] = [];
  for (const file of SAMPLE ? files.slice(0, Math.min(LIMIT + 4, 9)) : files) {
    if (pauseRequested()) break;
    const rst = await get(raw("django/django", "main", `docs/releases/${file}`));
    const date = findDate((rst ?? "").split("\n").slice(0, 10).join("\n"));
    if (!rst || !inWindow(date)) continue;
    const version = file.replace(".txt", "");
    const body = rstToText(rst).replace(/^\*?(Django .*release notes)\*?\s*/, "");
    records.push({ id: `django-release:${version}`, source: "Django release notes", title: `Django ${version} release notes`, url: `https://docs.djangoproject.com/en/stable/releases/${version}/`, date, license: "BSD-3-Clause (Django)", visibility: "public", text: `Django ${version} was released on ${longDate(date)}.\n\n${body}` });
  }
  return records;
}

async function dockerDesktop(): Promise<SourceRecord[]> {
  const md = await get(raw("docker/docs", "main", "content/manuals/desktop/release-notes.md"));
  return byMonth({ id: "docker-desktop", source: "Docker Desktop release notes", title: "Docker Desktop releases", url: "https://docs.docker.com/desktop/release-notes/", license: "Apache-2.0 (docker/docs)", visibility: "public" }, changelogFacts("Docker Desktop", md ?? "", { maxWords: 500 }));
}

// ---------------------------------------------------------------------------------------------------------------------
// The most-starred repositories on GitHub
// ---------------------------------------------------------------------------------------------------------------------

interface GhRepo {
  full_name: string;
  default_branch: string;
  archived?: boolean;
  license?: { spdx_id?: string } | null;
}

/** A repository's stable releases in the window: a bare dated sentence for each, and the same with its notes where it has any. */
async function repoReleases(fullName: string): Promise<{ dated: Fact[]; notes: Fact[] }> {
  const dated: Fact[] = [];
  const notes: Fact[] = [];
  for (let page = 1; page <= (SAMPLE ? 1 : 5); page++) {
    const releases = await github<Array<{ tag_name: string; name?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean; published_at?: string | null }>>(`repos/${fullName}/releases?per_page=100&page=${page}`);
    for (const r of releases ?? []) {
      const date = r.published_at?.slice(0, 10);
      if (!inWindow(date) || r.draft || r.prerelease || UNSTABLE.test(r.tag_name)) continue;
      const opening = `${fullName} released ${r.tag_name} on ${longDate(date)}.`;
      dated.push({ date, text: opening });
      const body = clip(cleanNotes(r.body ?? ""), 800);
      if (body) notes.push({ date, text: `${opening}\n\n${body}` });
    }
    const oldest = releases?.[releases.length - 1]?.published_at?.slice(0, 10);
    if ((releases ?? []).length < 100 || !oldest || oldest < FROM) break;
  }
  return { dated, notes };
}

const releaseNotesMeta = (fullName: string, license: string, source: string): DocMeta => ({ id: `github-release-notes:${fullName}`, source, title: `${fullName} release notes`, url: `https://github.com/${fullName}/releases`, license: `${license || "No license"} repository; GitHub release notes, training only`, visibility: "private" });

/**
 * Stable releases and CHANGELOG files of the top 500 repositories by stars. Changelogs follow the repository's license,
 * so they are public when it is an open one. Release notes on GitHub are not files in the repository, so their text is
 * private (software.md); only the bare dates of releases from openly licensed repositories go public.
 */
async function githubTop(): Promise<SourceRecord[]> {
  const repos: GhRepo[] = [];
  for (let page = 1; page <= (SAMPLE ? 1 : 5); page++) {
    const found = await github<{ items: GhRepo[] }>(`search/repositories?q=stars:%3E5000&sort=stars&order=desc&per_page=100&page=${page}`);
    repos.push(...(found?.items ?? []));
  }
  const usable = repos.filter((r) => !r.archived && !/openrouter/i.test(r.full_name));
  const chosen = SAMPLE ? usable.filter((_, i) => i % 20 === 3).slice(0, Math.min(LIMIT, 4)) : usable;
  const dates: Fact[] = [];
  const records: SourceRecord[] = [];
  for (const repo of chosen) {
    if (pauseRequested()) break;
    const license = repo.license?.spdx_id ?? "";
    const open = PERMISSIVE.test(license);
    const { dated, notes } = await repoReleases(repo.full_name);
    if (open) dates.push(...dated);
    const url = `https://github.com/${repo.full_name}`;
    records.push(...byMonth(releaseNotesMeta(repo.full_name, license, "GitHub release notes"), notes));
    const log = await repoChangelog(repo.full_name, repo.default_branch);
    if (log) records.push(...byMonth({ id: `github-changelog:${repo.full_name}`, source: "GitHub repository changelogs", title: `${repo.full_name} changelog`, url: `${url}/blob/${repo.default_branch}/${log.file}`, license: open ? license : `${license || "No license"} repository, training only`, visibility: open ? "public" : "private" }, log.facts));
  }
  records.unshift(...byMonth({ id: "github-release-dates", source: "GitHub release dates", title: "Releases of popular open-source projects", url: "https://github.com", license: "Facts from openly licensed repositories", visibility: "public" }, dates));
  return records;
}

const META_ORGS = ["facebookresearch", "facebookincubator"];

/**
 * 2026 release notes from Meta's two big research organizations, on the same terms as githubTop. Listed newest push first,
 * so only repositories pushed to in the window are asked about, which is about 450 of the 1,576.
 */
async function githubMetaOrgs(): Promise<SourceRecord[]> {
  const dates: Fact[] = [];
  const records: SourceRecord[] = [];
  for (const org of META_ORGS) {
    const repos: GhRepo[] = [];
    for (let page = 1; page <= (SAMPLE ? 1 : 30) && !pauseRequested(); page++) {
      const found = (await github<Array<GhRepo & { pushed_at?: string | null; fork?: boolean }>>(`orgs/${org}/repos?type=public&sort=pushed&direction=desc&per_page=100&page=${page}`)) ?? [];
      const active = found.filter((r) => (r.pushed_at ?? "") >= FROM);
      repos.push(...active.filter((r) => !r.fork));
      if (active.length < 100) break;
    }
    for (const repo of SAMPLE ? repos.slice(0, Math.min(LIMIT, 4)) : repos) {
      if (pauseRequested()) break;
      const license = repo.license?.spdx_id ?? "";
      const { dated, notes } = await repoReleases(repo.full_name);
      if (PERMISSIVE.test(license)) dates.push(...dated);
      records.push(...byMonth(releaseNotesMeta(repo.full_name, license, "Meta open-source release notes on GitHub"), notes));
    }
  }
  records.unshift(...byMonth({ id: "github-meta-release-dates", source: "Meta open-source release dates on GitHub", title: "Releases from facebookresearch and facebookincubator", url: "https://github.com/facebookresearch", license: "Facts from openly licensed repositories", visibility: "public" }, dates));
  return records;
}

// ---------------------------------------------------------------------------------------------------------------------

type Step = [string, () => Promise<SourceRecord[]>];

/** Takes em dashes out of what a step returns; in a small test, also says how big the whole step came out before LIMIT. */
function step(name: string, run: () => Promise<SourceRecord[]>, keepExact = false): Step {
  return [
    name,
    async () => {
      const records = await run();
      if (SAMPLE) console.log(`${name}: built ${records.length} documents, ${records.reduce((n, r) => n + wordCount(r.text), 0)} words, before LIMIT`);
      return keepExact ? records : records.map((r) => ({ ...r, title: noDash(r.title), text: noDash(r.text) }));
    },
  ];
}

runAll([
  step("endoflife", endoflife),
  step("models-dev", modelsDev),
  step("homebrew", homebrew),
  step("ecosystems", ecosystems),
  step("osv", osv),
  step("cisa-kev", kev),
  step("cvelist", cvelist),
  step("github-advisories", githubAdvisories),
  step("epoch", epoch),
  step("lmarena", lmarena),
  step("huggingface-cards", huggingFaceCards),
  step("google-ai-changelog", googleChangelog),
  step("anthropic-release-notes", anthropicNotes),
  step("sdk-changelogs", sdkChangelogs),
  step("stackoverflow-survey", stackOverflow),
  step("ietf-rfc-index", rfcIndex),
  step("ietf-rfc-text", rfcText, true),
  step("ecmascript", ecmascript, true),
  step("whatwg", whatwg),
  step("peps", peps),
  step("python-releases", pythonReleases),
  step("node-releases", nodeReleases),
  step("go-releases", goReleases),
  step("rust-releases", rustReleases),
  step("kubernetes-blog", kubernetesBlog),
  step("react-blog", reactBlog),
  step("django-releases", djangoReleases),
  step("docker-desktop", dockerDesktop),
  step("github-top-500", githubTop),
  step("github-meta-orgs", githubMetaOrgs),
]).catch((err) => {
  console.error(err);
  process.exit(1);
});

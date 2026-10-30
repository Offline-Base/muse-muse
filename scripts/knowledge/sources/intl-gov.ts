/**
 * Collects non-US government, central bank and statistics sources for the knowledge corpus, January 4 to October 29, 2026.
 * Each source is its own step and writes .data/knowledge/sources/<step>.jsonl. Everything is keyless and cached, so a
 * rerun only fetches what's missing. Statistics become dated sentences, grouped into one document per source and month.
 * License verdicts come from docs/knowledge-research/claim-check-2026-10-30.md, then government.md where the claim check
 * says nothing. PDFs need `pdftotext` (poppler-utils) on the machine; without it those records fall back to their titles.
 *
 *   npx tsx scripts/knowledge/sources/intl-gov.ts [step ...]
 *   LIMIT=5 npx tsx scripts/knowledge/sources/intl-gov.ts ecb
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createGunzip, inflateRawSync } from "node:zlib";
import { htmlToText as baseHtmlToText, type SourceRecord } from "@/lib/knowledge/sources";
import { longDate } from "@/lib/knowledge/passages";
import { CACHE, FROM, get, LIMIT, pauseRequested, runAll, TO, USER_AGENT } from "./common";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OGL = "Open Government Licence v3.0. Contains public sector information licensed under the Open Government Licence v3.0.";
const OPEN_PARLIAMENT = "Open Parliament Licence v3.0. Contains Parliamentary information licensed under the Open Parliament Licence v3.0.";
const EU_CC_BY = (who: string) => `CC BY 4.0. Source: ${who}, (c) European Union, 2026.`;
const WORLD_BANK_DATA = "CC BY 4.0. Source: World Bank Commodity Price Data (The Pink Sheet). Prices originate with the third-party sources the file credits.";
const WORLD_BANK_DOCS = "World Bank Documents and Reports, training only: the claim check confirms CC BY only for Data Catalog datasets, and general World Bank terms are non-commercial.";
const BIS = "BIS statistics, reusable with citation. Source: BIS central bank policy rate statistics. No endorsement by the BIS is implied, and no extra charge may be made for these statistics.";
const OECD = "CC BY 4.0. Source: OECD Data Explorer.";
const STATCAN = "Statistics Canada Open Licence. Source: Statistics Canada. Adapted from Statistics Canada; this does not constitute an endorsement by Statistics Canada.";
const BANK_OF_CANADA = "Bank of Canada terms: use, copying and distribution allowed. Source: Bank of Canada, changed to plain text. Freely available at bankofcanada.ca; paid products must say so.";
const LEGIFRANCE = "Licence Ouverte / Etalab 2.0. Source: Legifrance, DILA open data (LEGI), with the date of last update of the delta file. Personal data rules of CRPA art. L322-2 apply.";
const PDL = (who: string) => `Public Data License v1.0 (PDL1.0), CC BY 4.0 compatible. Source: ${who}. Edited by converting to plain text; not a government publication.`;
const INEGI = "INEGI free-use terms: copying, adapting and commercial use allowed with credit. Fuente: INEGI, Instituto Nacional de Estadistica y Geografia.";
const GASTAT = "GASTAT Use Policy 1.2.2: any reuse including commercial with acknowledgment. Source: General Authority for Statistics, Saudi Arabia; changed to plain text.";
const BANXICO = "Banco de Mexico, training only: the claim check gives no republishing verdict for its site terms.";
const au = () => `CC BY 4.0. Based on content from the Federal Register of Legislation at ${new Date().toISOString().slice(0, 10)}. For the latest information on Australian Government law please go to https://www.legislation.gov.au.`;

const NAMED: Record<string, string> = { euro: "\u20AC", pound: "\u00A3", middot: "\u00B7", sect: "\u00A7", deg: "\u00B0", times: "\u00D7", laquo: "\u00AB", raquo: "\u00BB", szlig: "\u00DF", oelig: "\u0153" };
const ACCENT: Record<string, string> = { acute: "\u0301", grave: "\u0300", circ: "\u0302", uml: "\u0308", tilde: "\u0303", cedil: "\u0327", ring: "\u030A", caron: "\u030C" };

/** The shared htmlToText, plus the named entities it leaves behind: currency signs and accented letters in European text. */
function htmlToText(html: string): string {
  return baseHtmlToText(html).replace(/&([a-zA-Z]+);/g, (whole, name: string) => {
    if (NAMED[name]) return NAMED[name];
    const accented = name.match(/^([a-zA-Z])(acute|grave|circ|uml|tilde|cedil|ring|caron)$/);
    return accented ? (accented[1] + ACCENT[accented[2]]).normalize("NFC") : whole;
  });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const monthEnd = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
const inWindow = (d?: string | null): d is string => !!d && d >= FROM && d <= TO;
const enough = (n: number) => n >= LIMIT || pauseRequested();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const number = (v: unknown) => String(Number(Number(v).toFixed(2)));
/** In a LIMIT test, gives up after this many fruitless lookups, so a broken parser can't walk a whole source. */
const overTestBudget = (tried: number) => LIMIT !== Infinity && tried > LIMIT * 8;
/** Text from a fixed-layout dump: runs of spaces collapse and lines join into paragraphs. */
const reflow = (s: string) => s.replace(/\r/g, "").split(/\n[ \t]*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p && !/^(?:Official Use Only|Page \d+ of \d+|\d+)$/.test(p)).join("\n\n");

/** Every day of the window, newest first, so a small test sees the most recent records. */
function windowDays(): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${TO}T00:00:00Z`); t >= Date.parse(`${FROM}T00:00:00Z`); t -= 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/** The body of a page without its navigation, or the whole page if the tag isn't there. */
function section(html: string, tag: string): string {
  const open = html.search(new RegExp(`<${tag}\\b`, "i"));
  const close = html.toLowerCase().lastIndexOf(`</${tag}>`);
  return open >= 0 && close > open ? html.slice(open, close) : html;
}

const tagText = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}\\b[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`))?.[1]?.trim() ?? "";

function parseCsv(body: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n") row.push(cell.replace(/\r$/, "")), rows.push(row), (row = []), (cell = "");
    else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [head, ...rest] = rows;
  return (rest ?? []).map((r) => Object.fromEntries((head ?? []).map((h, i) => [h.replace(/^﻿/, ""), r[i] ?? ""])));
}

/** Small facts by month. Levels count only for months finished inside the window; events count by their own date. */
class MonthFacts {
  private by = new Map<string, string[]>();
  level(ym: string, sentence: string) {
    if (ym >= FROM.slice(0, 7) && monthEnd(ym) <= TO) this.add(ym, sentence);
  }
  event(date: string, sentence: string) {
    if (inWindow(date)) this.add(date.slice(0, 7), sentence);
  }
  private add(ym: string, sentence: string) {
    this.by.set(ym, [...(this.by.get(ym) ?? []), sentence]);
  }
  records(o: { id: string; source: string; title: string; url: string; license: string; visibility?: SourceRecord["visibility"] }): SourceRecord[] {
    return [...this.by.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([ym, sentences]) => ({
      id: `${o.id}:${ym}`,
      source: o.source,
      title: `${o.title}, ${monthLabel(ym)}`,
      url: o.url,
      date: monthEnd(ym) < TO ? monthEnd(ym) : TO,
      license: o.license,
      visibility: o.visibility ?? "public",
      text: sentences.join("\n\n"),
    }));
  }
}

const cacheFile = (key: string) => path.join(CACHE, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.bin`);

/**
 * `get` decodes every body as UTF-8 and only does GET, which would break binary files and INEGI's search. This is the same
 * polite cached fetch for those: it waits `gapMs` before and after a real request so it can alternate with `get` on one host.
 */
async function fetchBytes(url: string, opts: { gapMs?: number; init?: RequestInit; key?: string } = {}): Promise<Buffer | null> {
  await mkdir(CACHE, { recursive: true });
  const file = cacheFile(opts.key ?? url);
  if (existsSync(file)) return readFile(file);
  const gap = opts.gapMs ?? 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(gap);
    let res: Response;
    try {
      res = await fetch(url, { ...opts.init, headers: { "User-Agent": USER_AGENT, ...opts.init?.headers }, signal: AbortSignal.timeout(300_000) });
    } catch {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (res.ok) {
      const body = Buffer.from(await res.arrayBuffer());
      await writeFile(file, body);
      await sleep(gap);
      return body;
    }
    if (res.status !== 429 && res.status < 500) {
      console.warn(`${res.status} ${url}`);
      return null;
    }
    await sleep(Number(res.headers.get("retry-after") ?? 0) * 1000 || 15_000 * (attempt + 1));
  }
  console.warn(`gave up on ${url}`);
  return null;
}

let noPdftotext = false;

/** Plain text from a PDF through pdftotext, with lines joined into paragraphs. Empty when the tool isn't installed. */
async function pdfText(url: string, gapMs = 1000): Promise<string> {
  const bytes = await fetchBytes(url, { gapMs });
  if (!bytes || noPdftotext) return "";
  try {
    const { stdout } = await promisify(execFile)("pdftotext", ["-q", "-enc", "UTF-8", cacheFile(url), "-"], { maxBuffer: 256 * 1024 * 1024 });
    return stdout.replace(/\f/g, "\n\n").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).join("\n\n");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      noPdftotext = true;
      console.warn("pdftotext is not installed: PDF sources fall back to their titles. Install poppler-utils.");
    }
    return "";
  }
}

/** Reads the wanted files out of a ZIP (docx, hwpx, xlsx) from its central directory. */
function unzip(zip: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) return files;
  let at = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    if (want(name)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(start, start + size);
      files.set(name, method === 0 ? raw : inflateRawSync(raw));
    }
    at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

function docxText(zip: Buffer): string {
  const xml = unzip(zip, (n) => n === "word/document.xml").get("word/document.xml")?.toString("utf8");
  if (!xml) return "";
  return htmlToText(xml.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, "").replace(/<w:tab\/>/g, " ").replace(/<\/w:p>/g, "</p>"));
}

function hwpxText(zip: Buffer): string {
  const sections = [...unzip(zip, (n) => /^Contents\/section\d+\.xml$/.test(n)).entries()].sort(([a], [b]) => a.localeCompare(b));
  return sections.map(([, xml]) => htmlToText(xml.toString("utf8").replace(/<\/hp:p>/g, "</p>"))).join("\n\n").trim();
}

/** A worksheet of an xlsx as rows of cell text by column letter. */
function xlsxSheet(zip: Buffer, sheetName: string): Array<Record<string, string>> {
  const files = unzip(zip, (n) => /^xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(n));
  const text = (n: string) => files.get(n)?.toString("utf8") ?? "";
  const rid = text("xl/workbook.xml").match(new RegExp(`<sheet\\b[^>]*name="${sheetName}"[^>]*r:id="([^"]+)"`))?.[1];
  const target = rid && text("xl/_rels/workbook.xml.rels").match(new RegExp(`<Relationship\\b[^>]*(?:Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}")`));
  if (!target) return [];
  const shared = (text("xl/sharedStrings.xml").match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) => htmlToText(si));
  const sheet = text(`xl/${(target[1] ?? target[2]).replace(/^\/?xl\//, "")}`);
  return (sheet.match(/<row\b[\s\S]*?<\/row>/g) ?? []).map((row) => {
    const cells: Record<string, string> = {};
    for (const m of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = m[1].match(/r="([A-Z]+)\d+"/)?.[1];
      const value = m[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (col && value !== undefined) cells[col] = /t="s"/.test(m[1]) ? (shared[Number(value)] ?? "") : value;
    }
    return cells;
  });
}

/** Turns a Eurostat JSON-stat response into one callback per observation. */
function eachObservation(stat: Json, visit: (labels: Record<string, string>, codes: Record<string, string>, value: number) => void) {
  const ids: string[] = stat.id;
  const sizes: number[] = stat.size;
  const positions = ids.map((id) => {
    const index: Record<string, number> = stat.dimension[id].category.index;
    return Object.fromEntries(Object.entries(index).map(([code, i]) => [i, code])) as Record<number, string>;
  });
  for (const [key, value] of Object.entries(stat.value as Record<string, number>)) {
    let rest = Number(key);
    const codes: Record<string, string> = {};
    const labels: Record<string, string> = {};
    for (let d = ids.length - 1; d >= 0; d--) {
      const code = positions[d][rest % sizes[d]];
      rest = Math.floor(rest / sizes[d]);
      codes[ids[d]] = code;
      labels[ids[d]] = String(stat.dimension[ids[d]].category.label[code] ?? code).replace(/\s+–\s+/g, ", ");
    }
    visit(labels, codes, value);
  }
}

const REGIONS = new Intl.DisplayNames(["en"], { type: "region" });
const regionName = (code: string) => {
  if (code === "XM") return "the euro area";
  try {
    return REGIONS.of(code) ?? code;
  } catch {
    return code;
  }
};

// ---- United Kingdom ----

const GOVUK_TYPES = [
  "press_release", "news_story", "world_news_story", "speech", "oral_statement", "written_statement", "authored_article", "government_response",
  "correspondence", "policy_paper", "independent_report", "research", "corporate_report", "open_consultation", "closed_consultation", "consultation_outcome",
  "open_call_for_evidence", "closed_call_for_evidence", "call_for_evidence_outcome", "national_statistics", "official_statistics", "statistics", "statutory_guidance",
  "guidance", "detailed_guide", "notice", "impact_assessment", "international_treaty", "cma_case", "drug_safety_update", "medical_safety_alert", "aaib_report",
  "maib_report", "raib_report", "sfo_case", "regulation", "case_study",
];

function govukHtml(details: Json): string {
  const body = details.body;
  const parts: string[] = [];
  if (typeof body === "string") parts.push(body);
  else if (Array.isArray(body)) parts.push(body.find((b: Json) => b.content_type === "text/html")?.content ?? "");
  for (const part of details.parts ?? []) parts.push(`<h2>${part.title ?? ""}</h2>${typeof part.body === "string" ? part.body : (part.body?.find?.((b: Json) => b.content_type === "text/html")?.content ?? "")}`);
  return parts.join("\n");
}

/** Press, speeches, policy, research, statistics and guidance first published in the window. Tribunal decisions name private people, so they stay out. */
async function govuk(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  const types = GOVUK_TYPES.map((t) => `filter_content_store_document_type=${t}`).join("&");
  let tried = 0;
  for (const day of windowDays()) {
    if (enough(records.length) || overTestBudget(tried)) break;
    for (let start = 0; !enough(records.length) && !overTestBudget(tried); start += 1000) {
      const list = await get(`https://www.gov.uk/api/search.json?filter_public_timestamp=from:${day},to:${day}&${types}&count=1000&start=${start}&fields=link,title`);
      const results: Json[] = list ? JSON.parse(list).results : [];
      for (const r of results) {
        if (enough(records.length) || overTestBudget(++tried)) break;
        if (typeof r.link !== "string" || !r.link.startsWith("/")) continue;
        const page = await get(`https://www.gov.uk/api/content${r.link}`);
        if (!page) continue;
        const c: Json = JSON.parse(page);
        const date = String(c.first_published_at ?? "").slice(0, 10);
        if (!inWindow(date)) continue;
        const html = [govukHtml(c.details ?? {})];
        for (const a of (c.details?.attachments ?? []).filter((x: Json) => x.attachment_type === "html" && String(x.url).startsWith("/")).slice(0, 3)) {
          const sub = await get(`https://www.gov.uk/api/content${a.url}`);
          if (sub) html.push(`<h2>${a.title ?? ""}</h2>${govukHtml(JSON.parse(sub).details ?? {})}`);
        }
        // Attachment lines such as "PDF, 138 KB, 3 pages" say nothing.
        const text = [c.description ?? "", htmlToText(html.join("\n"))].filter(Boolean).join("\n\n").replace(/^(?:PDF|HTML|CSV|ODS|ODT|ZIP|MS \w+|\w+ Spreadsheet),? [^\n]*\b\d+(?:\.\d+)? ?(?:KB|MB)[^\n]*\n*/gm, "");
        if (wordCount(text) < 30) continue;
        records.push({ id: `govuk:${c.content_id ?? r.link}`, source: "GOV.UK", title: c.title ?? r.title, url: `https://www.gov.uk${r.link}`, date, license: OGL, visibility: "public", text });
      }
      if (results.length < 1000) break;
    }
  }
  return records;
}

/** Acts and instruments of 2026. legislation.gov.uk asks for 5 seconds between requests and bars its PDFs and Word files. */
async function legislationUk(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const type of ["ukpga", "asp", "asc", "nia", "ukla", "uksi", "wsi", "ssi", "nisr"]) {
    for (let page = 1; !enough(records.length); page++) {
      const feed = await get(`https://www.legislation.gov.uk/${type}/2026/data.feed?page=${page}`, { gapMs: 5000 });
      const entries = feed?.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
      for (const entry of entries) {
        if (enough(records.length)) break;
        const date = entry.match(/<ukm:CreationDate Date="([\d-]+)"/)?.[1] ?? tagText(entry, "published").slice(0, 10);
        if (!inWindow(date)) continue;
        const snippet = entry.match(/href="([^"]+)"\s+title="HTML snippet"/)?.[1]?.replace(/^http:/, "https:");
        const id = tagText(entry, "id").replace(/^https?:\/\/www\.legislation\.gov\.uk\/id\//, "");
        const body = snippet ? await get(`${snippet}?view=snippet`, { gapMs: 5000 }) : null;
        const text = body ? htmlToText(section(body, "body")).replace(/(\p{Ll})(?:U\.K\.|E\+W(?:\+S)?(?:\+N\.I\.)?|S|N\.I\.)$/gmu, "$1") : htmlToText(tagText(entry, "summary"));
        records.push({ id: `legislation-uk:${id}`, source: "legislation.gov.uk", title: htmlToText(tagText(entry, "title")), url: `https://www.legislation.gov.uk/${id}`, date, license: OGL, visibility: "public", text });
      }
      if (entries.length === 0 || page >= Number(feed?.match(/<leg:morePages>(\d+)/)?.[1] ?? 1)) break;
    }
  }
  return records;
}

const slug = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 80);

/** Debates of both Houses, one document per debate, from each sitting day's section trees. */
async function hansard(): Promise<SourceRecord[]> {
  const API = "https://hansard-api.parliament.uk";
  const records: SourceRecord[] = [];
  const walk = (node: Json, house: string, date: string) => {
    const lines = (node.Items ?? []).map((item: Json) => {
      const said = htmlToText(item.Value ?? "");
      return said && item.AttributedTo ? `${String(item.AttributedTo).trim()}: ${said}` : said;
    }).filter(Boolean);
    const text = lines.join("\n\n");
    const o: Json = node.Overview ?? {};
    if (wordCount(text) >= 30) records.push({ id: `hansard-uk:${o.ExtId}`, source: `UK Hansard, House of ${house}`, title: o.Title, url: `https://hansard.parliament.uk/${house}/${date}/debates/${o.ExtId}/${slug(String(o.Title ?? ""))}`, date, license: OPEN_PARLIAMENT, visibility: "public", text });
    for (const child of node.ChildDebates ?? []) walk(child, house, date);
  };
  for (const house of ["Commons", "Lords"]) {
    for (let month = 10; month >= 1 && !enough(records.length); month--) {
      const calendar = await get(`${API}/overview/calendar.json?house=${house}&year=2026&month=${month}`);
      const days = [...new Set((calendar ? (JSON.parse(calendar) as Json[]) : []).map((d) => String(d.ItemDate).slice(0, 10)))].filter(inWindow).sort().reverse();
      for (const date of days) {
        if (enough(records.length)) break;
        const sections = await get(`${API}/overview/sectionsforday.json?house=${house}&date=${date}`);
        for (const name of (sections ? (JSON.parse(sections) as string[]) : []).filter((s) => s !== "Correction")) {
          const trees = await get(`${API}/overview/sectiontrees.json?house=${house}&date=${date}&section=${name}`);
          for (const tree of trees ? (JSON.parse(trees) as Json[]) : []) {
            for (const root of (tree.SectionTreeItems ?? []).filter((i: Json) => i.ParentId === null && i.ExternalId)) {
              if (enough(records.length)) break;
              const debate = await get(`${API}/debates/debate/${root.ExternalId}.json`);
              if (debate) walk(JSON.parse(debate), house, date);
            }
          }
        }
      }
    }
  }
  return records;
}

/** Bulletins and articles. ONS closed its /data JSON on Feb 2, 2026, so the text comes from the published pages. */
async function ons(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (let offset = 0; !enough(records.length); offset += 100) {
    const body = await get(`https://api.beta.ons.gov.uk/v1/search?content_type=bulletin,article&limit=100&offset=${offset}&sort=release_date&fromDate=${FROM}&toDate=${TO}`);
    const items: Json[] = body ? JSON.parse(body).items ?? [] : [];
    for (const item of items) {
      if (enough(records.length)) break;
      const date = String(item.release_date ?? "").slice(0, 10);
      if (!inWindow(date) || !item.uri) continue;
      const page = await get(`https://www.ons.gov.uk${item.uri}`);
      if (!page) continue;
      const text = htmlToText(section(page, "article")).split(/\n\n(?:\d+\.\s*)?Cite this (?:statistical bulletin|article)\b/)[0].replace(/\n*Back to table of contents/g, "").trim();
      records.push({ id: `ons:${item.uri}`, source: "Office for National Statistics", title: [item.title, item.edition].filter(Boolean).join(": "), url: `https://www.ons.gov.uk${item.uri}`, date, license: `${OGL} Source: Office for National Statistics.`, visibility: "public", text });
    }
    if (items.length < 100) break;
  }
  return records;
}

// ---- European Union ----

/** Press releases, speeches, statements and daily news from the press corner's own API, leaving out machine translations. */
async function ecPress(): Promise<SourceRecord[]> {
  const API = "https://ec.europa.eu/commission/presscorner/api";
  const dmy = (d: string) => `${d.slice(8)}${d.slice(5, 7)}${d.slice(0, 4)}`;
  // The API answers 200 with an empty body unless the client asks for JSON and gives the reference with its slashes.
  const opts = { headers: { Accept: "application/json, text/plain, */*" } };
  const records: SourceRecord[] = [];
  let empty = 0;
  for (let page = 1; !enough(records.length); page++) {
    const list = await get(`${API}/search?language=en&pagesize=100&pagenumber=${page}&datefrom=${dmy(FROM)}&dateto=${dmy(TO)}`);
    const items: Json[] = list ? JSON.parse(list).docuLanguageListResources ?? [] : [];
    for (const item of items) {
      if (enough(records.length)) break;
      if (!inWindow(item.eventDate) || item.isETranslated || !item.refCode) continue;
      const ref = String(item.refCode).replace(/\//g, "_");
      const doc = await get(`${API}/documents?reference=${item.refCode}&language=en`, opts);
      if (!doc) {
        if (++empty >= 10 && records.length === 0) throw new Error("the documents endpoint keeps answering with nothing");
        continue;
      }
      const res: Json = JSON.parse(doc).docuLanguageResource ?? {};
      const body = htmlToText(String(res.htmlContent ?? ""));
      const lead = item.leadText ? htmlToText(item.leadText) : "";
      const text = lead && !body.startsWith(lead.slice(0, 40)) ? `${lead}\n\n${body}` : body;
      records.push({ id: `ec-press:${ref}`, source: `European Commission press corner, ${item.docutype?.description ?? "item"}`, title: htmlToText(item.title ?? ref), url: `https://ec.europa.eu/commission/presscorner/detail/en/${ref.toLowerCase()}`, date: item.eventDate, license: EU_CC_BY("European Commission"), visibility: "public", text });
    }
    if (items.length < 100) break;
  }
  return records;
}

/** Adopted texts, plenary verbatim reports (speakers' own languages) and final roll-call votes. The site asks for 2 seconds between requests. */
async function europarl(): Promise<SourceRecord[]> {
  const API = "https://data.europarl.europa.eu/api/v2";
  const DIST = "https://data.europarl.europa.eu/distribution/doc";
  const FORMAT = "format=application%2Fld%2Bjson";
  const opts = { gapMs: 2000 };
  const license = EU_CC_BY("European Parliament");
  const records: SourceRecord[] = [];
  const quota = (n: number) => (LIMIT === Infinity ? Infinity : records.length + n);

  const adoptedStop = quota(LIMIT);
  for (let offset = 0; !pauseRequested() && records.length < adoptedStop; offset += 100) {
    const body = await get(`${API}/adopted-texts?year=2026&${FORMAT}&offset=${offset}&limit=100`, opts);
    const items: Json[] = body ? JSON.parse(body).data ?? [] : [];
    for (const item of items) {
      if (records.length >= adoptedStop || pauseRequested()) break;
      if (!inWindow(item.document_date)) continue;
      const xml = await get(`${DIST}/${item.identifier}_en.xml`, opts);
      if (!xml) continue;
      const text = htmlToText(xml.replace(/<HIDDEN\b[\s\S]*?<\/HIDDEN>/g, "").replace(/<\/(?:IDENT|NP|TI|SUBTITLE|P|PARA|ARTICLE|DOCAMEND|CONSID|CITA)>/g, "</p>"));
      records.push({ id: `europarl:text:${item.identifier}`, source: "European Parliament, adopted text", title: item.title_dcterms?.en ?? item.identifier, url: `https://www.europarl.europa.eu/doceo/document/${item.identifier}_EN.html`, date: item.document_date, license, visibility: "public", text });
    }
    if (items.length < 100) break;
  }

  const sittings: Json[] = [];
  for (let offset = 0; !pauseRequested(); offset += 100) {
    const body = await get(`${API}/meetings?year=2026&${FORMAT}&offset=${offset}&limit=100`, opts);
    const items: Json[] = body ? JSON.parse(body).data ?? [] : [];
    sittings.push(...items.filter((m) => inWindow(m.activity_date)));
    if (items.length < 100) break;
  }
  sittings.sort((a, b) => String(b.activity_date).localeCompare(String(a.activity_date)));

  const facts = new MonthFacts();
  let debateCount = 0;
  let voteDays = 0;
  for (const sitting of sittings) {
    if (pauseRequested() || (LIMIT !== Infinity && debateCount >= 1 && voteDays >= 1)) break;
    const date: string = sitting.activity_date;
    const cre = (sitting.recorded_in_a_realization_of ?? []).map((d: string) => d.split("/").pop()).find((d: string) => d.startsWith("CRE-"));
    if (cre) {
      const docx = await fetchBytes(`${DIST}/${cre}_mul.docx`, opts);
      if (docx) {
        debateCount++;
        records.unshift({ id: `europarl:debate:${cre}`, source: "European Parliament, verbatim report of proceedings", title: `Plenary debates of ${longDate(date)}`, url: `https://www.europarl.europa.eu/doceo/document/${cre}_EN.html`, date, license, visibility: "public", text: docxText(docx) });
      }
    }
    for (let offset = 0; !pauseRequested(); offset += 500) {
      const body = await get(`${API}/meetings/${sitting.activity_id}/decisions?${FORMAT}&offset=${offset}&limit=500`, opts);
      const votes: Json[] = body ? JSON.parse(body).data ?? [] : [];
      for (const v of votes) {
        // Amendments and split votes carry a number or paragraph mark in decisionAboutId; final votes on a whole text don't.
        if (v.number_of_votes_favor === undefined || v.decisionAboutId !== undefined) continue;
        const label = v.activity_label?.en ?? v.activity_label?.mul ?? "";
        const outcome = String(v.decision_outcome ?? "").split("/").pop()?.toLowerCase().replace(/_/g, " ");
        if (label) facts.event(date, `On ${longDate(date)}, the European Parliament voted on "${label}"${outcome ? `; the result was ${outcome}` : ""}, with ${v.number_of_votes_favor} in favour, ${v.number_of_votes_against ?? 0} against and ${v.number_of_votes_abstention ?? 0} abstentions.`);
      }
      if (votes.length < 500) break;
    }
    voteDays++;
  }
  return [...facts.records({ id: "europarl:votes", source: "European Parliament, roll-call votes", title: "European Parliament plenary votes", url: "https://data.europarl.europa.eu/en/developer-corner", license }), ...records];
}

/** Judgments and decisions through the Cellar SPARQL endpoint. Procurement notices are a different resource type, so they never appear. */
async function eurlex(): Promise<SourceRecord[]> {
  const SPARQL = "https://publications.europa.eu/webapi/rdf/sparql";
  const CELEX = "https://publications.europa.eu/resource/celex";
  const AUTH = "http://publications.europa.eu/resource/authority";
  const records: SourceRecord[] = [];
  for (const [type, label] of [["JUDG", "Judgment"], ["DEC", "Decision"]]) {
    const start = records.length;
    const stop = () => (LIMIT === Infinity ? pauseRequested() : records.length - start >= LIMIT || pauseRequested());
    for (let offset = 0; !stop(); offset += 500) {
      const query = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#> PREFIX xsd: <http://www.w3.org/2001/XMLSchema#> SELECT DISTINCT ?celex ?d ?t WHERE { ?w cdm:work_has_resource-type <${AUTH}/resource-type/${type}>; cdm:work_date_document ?d; cdm:resource_legal_id_celex ?celex . FILTER(?d >= "${FROM}"^^xsd:date && ?d <= "${TO}"^^xsd:date) OPTIONAL { ?e cdm:expression_belongs_to_work ?w; cdm:expression_uses_language <${AUTH}/language/ENG>; cdm:expression_title ?t } } ORDER BY DESC(?d) ?celex LIMIT 500 OFFSET ${offset}`;
      const body = await get(`${SPARQL}?query=${encodeURIComponent(query)}`, { headers: { Accept: "application/sparql-results+json" } });
      const rows: Json[] = body ? JSON.parse(body).results?.bindings ?? [] : [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (stop()) break;
        const celex: string = row.celex.value;
        const date: string = String(row.d.value).slice(0, 10);
        // Corrigenda repeat the act, and merger decisions (type M) are notices with no text in Cellar.
        if (seen.has(celex) || !inWindow(date) || /R\(/.test(celex) || /^3\d{4}M/.test(celex)) continue;
        seen.add(celex);
        const accept = "application/xhtml+xml, text/html";
        // English where it exists; otherwise the French text the Court always publishes, under its own cache key.
        const english = row.t ? await get(`${CELEX}/${celex}`, { headers: { Accept: accept, "Accept-Language": "eng" } }) : null;
        const html = english ?? (celex.startsWith("6") ? await get(`${CELEX}/${celex}?lang=fra`, { headers: { Accept: accept, "Accept-Language": "fra" } }) : null);
        if (!html) continue;
        const title = row.t ? String(row.t.value).split("#").map((s) => s.trim()).filter(Boolean).join(" ") : `${label} ${celex}`;
        records.push({ id: `eurlex:${celex}`, source: `EUR-Lex, ${label}`, title: title.slice(0, 400), url: `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${celex}`, date, license: EU_CC_BY("EUR-Lex"), visibility: "public", text: htmlToText(section(html, "body")) });
      }
      if (rows.length < 500) break;
    }
  }
  return records;
}

const EUROSTAT: Array<{ code: string; query: string; say: (geo: string, value: string, when: string) => string }> = [
  { code: "prc_hicp_minr", query: "unit=RCH_A&coicop18=TOTAL", say: (geo, v, when) => `In ${when}, annual consumer price inflation (HICP) in ${geo} was ${v}%.` },
  { code: "une_rt_m", query: "s_adj=SA&age=TOTAL&sex=T&unit=PC_ACT", say: (geo, v, when) => `In ${when}, the seasonally adjusted unemployment rate in ${geo} was ${v}%.` },
  { code: "sts_inpr_m", query: "s_adj=SCA&nace_r2=B-D&unit=PCH_PRE&indic_bt=PRD", say: (geo, v, when) => `In ${when}, industrial production in ${geo} changed by ${v}% from the previous month, seasonally and calendar adjusted.` },
  { code: "sts_trtu_m", query: "s_adj=SCA&nace_r2=G47&unit=PCH_PRE&indic_bt=VOL_SLS", say: (geo, v, when) => `In ${when}, the volume of retail sales in ${geo} changed by ${v}% from the previous month, seasonally and calendar adjusted.` },
  { code: "namq_10_gdp", query: "unit=CLV_PCH_PRE&s_adj=SCA&na_item=B1GQ", say: (geo, v, when) => `In ${when}, GDP in ${geo} changed by ${v}% from the previous quarter, in chain-linked volumes, seasonally and calendar adjusted.` },
];

async function eurostat(): Promise<SourceRecord[]> {
  const facts = new MonthFacts();
  for (const { code, query, say } of EUROSTAT) {
    const since = code === "namq_10_gdp" ? "2026-Q1" : "2026-01";
    const body = await get(`https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${code}?${query}&sinceTimePeriod=${since}&lang=en&format=JSON`);
    if (!body) continue;
    eachObservation(JSON.parse(body), (labels, codes, value) => {
      // "EU" and "EA" are the changing-membership aggregates; the fixed compositions such as EU27_2020 say the same thing clearly.
      if (codes.geo === "EU" || codes.geo === "EA") return;
      const time = codes.time;
      const quarter = time.match(/^(\d{4})-Q(\d)$/);
      const ym = quarter ? `${quarter[1]}-${String(Number(quarter[2]) * 3).padStart(2, "0")}` : time;
      facts.level(ym, say(labels.geo, number(value), quarter ? `the ${["first", "second", "third", "fourth"][Number(quarter[2]) - 1]} quarter of ${quarter[1]}` : monthLabel(ym)));
    });
  }
  return facts.records({ id: "eurostat", source: "Eurostat", title: "Eurostat headline statistics", url: "https://ec.europa.eu/eurostat/databrowser/", license: "Eurostat reuse policy, free with attribution. Source: Eurostat." });
}

/** Key rates (with their change dates), euro exchange rates, HICP, and the monetary policy statements. The site asks for 5 seconds between requests. */
async function ecb(): Promise<SourceRecord[]> {
  const license = "ECB statistics and press material, free reuse with attribution. Source: European Central Bank.";
  const DATA = "https://data-api.ecb.europa.eu/service/data";
  const facts = new MonthFacts();
  for (const [key, name] of [["MRR_FR", "main refinancing operations rate"], ["DFR", "deposit facility rate"], ["MLFR", "marginal lending facility rate"]]) {
    const body = await get(`${DATA}/FM/B.U2.EUR.4F.KR.${key}.LEV?startPeriod=2025-01-01&format=csvdata`);
    const rows = parseCsv(body ?? "").sort((a, b) => a.TIME_PERIOD.localeCompare(b.TIME_PERIOD));
    rows.forEach((row, i) => {
      const before = rows[i - 1]?.OBS_VALUE;
      if (before !== undefined && Number(before) !== Number(row.OBS_VALUE)) facts.event(row.TIME_PERIOD, `With effect from ${longDate(row.TIME_PERIOD)}, the ECB ${name} moved from ${number(before)}% to ${number(row.OBS_VALUE)}%.`);
    });
    for (let m = 1; m <= 10; m++) {
      const ym = `2026-${String(m).padStart(2, "0")}`;
      const current = rows.filter((r) => r.TIME_PERIOD <= monthEnd(ym)).at(-1);
      if (current) facts.level(ym, `At the end of ${monthLabel(ym)}, the ECB ${name} was ${number(current.OBS_VALUE)}%.`);
    }
  }
  for (const row of parseCsv((await get(`${DATA}/ICP/M.U2.N.000000.4.ANR?startPeriod=2026-01&format=csvdata`)) ?? "")) {
    facts.level(row.TIME_PERIOD, `In ${monthLabel(row.TIME_PERIOD)}, annual HICP inflation in the euro area was ${number(row.OBS_VALUE)}%, according to the ECB.`);
  }
  for (const row of parseCsv((await get(`${DATA}/EXR/M.USD+JPY+GBP+CHF+CNY.EUR.SP00.A?startPeriod=2026-01&format=csvdata`)) ?? "")) {
    facts.level(row.TIME_PERIOD, `In ${monthLabel(row.TIME_PERIOD)}, one euro averaged ${Number(row.OBS_VALUE).toFixed(4)} ${row.CURRENCY} on the ECB reference rate.`);
  }
  const records = facts.records({ id: "ecb:stats", source: "European Central Bank", title: "ECB rates, inflation and exchange rates", url: "https://data.ecb.europa.eu/", license });

  const WWW = "https://www.ecb.europa.eu";
  const links = new Set<string>();
  const statements = await get(`${WWW}/press/press_conference/monetary-policy-statement/2026/html/index_include.en.html`, { gapMs: 5000 });
  for (const m of statements?.matchAll(/href="(\/press\/[^"]+\.en\.html)"/g) ?? []) links.add(m[1]);
  const rss = await get(`${WWW}/rss/press.html`, { gapMs: 5000 });
  for (const item of rss?.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const link = tagText(item, "link").replace(/^https:\/\/www\.ecb\.europa\.eu\/+/, "/");
    if (link.endsWith(".en.html")) links.add(link);
  }
  let pages = 0;
  for (const link of links) {
    if (enough(pages)) break;
    const stamp = link.match(/ecb\.[a-z]+(\d{2})(\d{2})(\d{2})/);
    const date = stamp ? `20${stamp[1]}-${stamp[2]}-${stamp[3]}` : null;
    if (!inWindow(date)) continue;
    const html = await get(`${WWW}${link}`, { gapMs: 5000 });
    if (!html) continue;
    pages++;
    const title = htmlToText(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? link);
    const text = htmlToText(section(html, "main")).split(/\n\n(?:CONTACT|Reproduction is permitted|European Central Bank\n\nDirectorate General)/)[0].replace(/Jump to the transcript of the questions and answers/, "");
    records.push({ id: `ecb:${link}`, source: "European Central Bank", title, url: `${WWW}${link}`, date, license, visibility: "public", text });
  }
  return records;
}

/** Policy rates: month-end levels plus each change on its day, for the economies BIS still reports. */
async function bis(): Promise<SourceRecord[]> {
  const API = "https://stats.bis.org/api/v1/data/WS_CBPOL";
  const facts = new MonthFacts();
  const hasValue = (row: Record<string, string>) => row.OBS_VALUE !== "" && Number.isFinite(Number(row.OBS_VALUE));
  for (const row of parseCsv((await get(`${API}/M./all?startPeriod=2026-01&format=csv`)) ?? "")) {
    if (hasValue(row)) facts.level(row.TIME_PERIOD, `At the end of ${monthLabel(row.TIME_PERIOD)}, the central bank policy rate of ${regionName(row.REF_AREA)} was ${number(row.OBS_VALUE)}%.`);
  }
  const daily = parseCsv((await get(`${API}/D./all?startPeriod=2025-12-01&format=csv`)) ?? "");
  const byArea = new Map<string, Array<Record<string, string>>>();
  for (const row of daily) if (hasValue(row)) byArea.set(row.REF_AREA, [...(byArea.get(row.REF_AREA) ?? []), row]);
  for (const [area, rows] of byArea) {
    rows.sort((a, b) => a.TIME_PERIOD.localeCompare(b.TIME_PERIOD));
    rows.forEach((row, i) => {
      const before = rows[i - 1]?.OBS_VALUE;
      if (before !== undefined && Number(before) !== Number(row.OBS_VALUE)) facts.event(row.TIME_PERIOD, `With effect from ${longDate(row.TIME_PERIOD)}, the central bank policy rate of ${regionName(area)} moved from ${number(before)}% to ${number(row.OBS_VALUE)}%.`);
    });
  }
  return facts.records({ id: "bis", source: "Bank for International Settlements", title: "Central bank policy rates", url: "https://data.bis.org/topics/CBPOL", license: BIS });
}

// ---- World Bank and OECD ----

/** Documents and Reports full text. Procurement plans and audits are left out, as procurement notices are for EUR-Lex. */
async function worldbankDocs(): Promise<SourceRecord[]> {
  const SKIP = new Set(["Procurement Plan", "Auditing Document"]);
  const records: SourceRecord[] = [];
  for (let os = 0; !enough(records.length); os += 500) {
    const body = await get(`https://search.worldbank.org/api/v3/wds?format=json&rows=500&os=${os}&strdate=${FROM}&enddate=${TO}&srt=docdt&order=desc&fl=docdt,docty,display_title,url,txturl,count,seccl,abstracts`);
    const documents: Json = body ? JSON.parse(body).documents ?? {} : {};
    const docs = Object.values(documents).filter((d: Json) => d?.id) as Json[];
    for (const d of docs) {
      if (enough(records.length)) break;
      const date = String(d.docdt ?? "").slice(0, 10);
      if (!inWindow(date) || SKIP.has(d.docty) || (d.seccl && d.seccl !== "Public")) continue;
      const abstract = htmlToText(String(d.abstracts?.["cdata!"] ?? ""));
      const full = d.txturl ? await get(String(d.txturl).replace(/^http:/, "https:")) : null;
      const text = [abstract, reflow((full ?? "").replace(/@#&OPS~\S*/g, ""))].filter(Boolean).join("\n\n");
      if (wordCount(text) < 30) continue;
      records.push({ id: `worldbank-docs:${d.id}`, source: `World Bank, ${d.docty ?? "document"}`, title: [d.display_title, d.count].filter(Boolean).join(", "), url: String(d.url).replace(/^http:/, "https:"), date, license: WORLD_BANK_DOCS, visibility: "private", text });
    }
    if (docs.length < 500) break;
  }
  return records;
}

/** The Pink Sheet's monthly price file. Its link changes with each edition, so it's read from the commodity markets page. */
async function worldbankPink(): Promise<SourceRecord[]> {
  const page = await get("https://www.worldbank.org/en/research/commodity-markets");
  const url = page?.match(/https:\/\/thedocs\.worldbank\.org\/[^"]+CMO-Historical-Data-Monthly\.xlsx/)?.[0];
  const file = url ? await fetchBytes(url) : null;
  if (!file) throw new Error("the monthly price file was not found");
  const rows = xlsxSheet(file, "Monthly Prices");
  const header = rows.find((r) => r.A === undefined && Object.keys(r).length > 20 && Object.values(r).some((v) => /Crude oil/.test(v)));
  const units = header && rows[rows.indexOf(header) + 1];
  if (!header || !units) throw new Error("the Monthly Prices sheet has changed shape");
  const facts = new MonthFacts();
  for (const row of rows) {
    const period = row.A?.match(/^(\d{4})M(\d{2})$/);
    if (!period) continue;
    const ym = `${period[1]}-${period[2]}`;
    for (const [col, name] of Object.entries(header)) {
      const value = Number(row[col]);
      if (col === "A" || row[col] === undefined || !Number.isFinite(value)) continue;
      const unit = (units[col] ?? "").replace(/[()]/g, "").trim();
      const price = unit.startsWith("$/") ? `$${number(value)} per ${unit.slice(2)}` : `${number(value)} ${unit}`;
      facts.level(ym, `In ${monthLabel(ym)}, the World Bank's monthly average price for ${name.replace(/\s*\*+\s*$/, "").trim()} was ${price}.`);
    }
  }
  return facts.records({ id: "worldbank-pink", source: "World Bank Pink Sheet", title: "World Bank commodity prices", url: "https://www.worldbank.org/en/research/commodity-markets", license: WORLD_BANK_DATA });
}

const OECD_AREAS: Record<string, string> = {
  ...Object.fromEntries(Object.entries({ AUS: "AU", AUT: "AT", BEL: "BE", CAN: "CA", CHL: "CL", COL: "CO", CRI: "CR", CZE: "CZ", DNK: "DK", EST: "EE", FIN: "FI", FRA: "FR", DEU: "DE", GRC: "GR", HUN: "HU", ISL: "IS", IRL: "IE", ISR: "IL", ITA: "IT", JPN: "JP", KOR: "KR", LVA: "LV", LTU: "LT", LUX: "LU", MEX: "MX", NLD: "NL", NZL: "NZ", NOR: "NO", POL: "PL", PRT: "PT", SVK: "SK", SVN: "SI", ESP: "ES", SWE: "SE", CHE: "CH", TUR: "TR", GBR: "GB", USA: "US", ARG: "AR", BRA: "BR", CHN: "CN", IND: "IN", IDN: "ID", RUS: "RU", SAU: "SA", ZAF: "ZA" }).map(([a3, a2]) => [a3, regionName(a2)])),
  OECD: "the OECD area",
  G7: "the G7",
  G20: "the G20",
  EA20: "the euro area",
  EA21: "the euro area",
  EU27_2020: "the European Union",
};

/** Comparable headline series. OECD limits downloads per hour, so a few whole-dataset queries, spaced well apart. */
async function oecd(): Promise<SourceRecord[]> {
  const API = "https://sdmx.oecd.org/public/rest/data";
  const facts = new MonthFacts();
  const series: Array<[string, (area: string, v: string, when: string) => string]> = [
    ["OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0/.M.N.CPI.PA._T.N.GY?startPeriod=2026-01", (a, v, w) => `In ${w}, annual consumer price inflation in ${a} was ${v}%, according to the OECD.`],
    ["OECD.SDD.TPS,DSD_LFS@DF_IALFS_UNE_M,1.0/..._Z.Y._T.Y_GE15..M?startPeriod=2026-01", (a, v, w) => `In ${w}, the seasonally adjusted unemployment rate in ${a} was ${v}%, according to the OECD.`],
  ];
  for (const [query, say] of series) {
    const body = await get(`${API}/${query}`, { gapMs: 5000, headers: { Accept: "application/vnd.sdmx.data+csv" } });
    for (const row of parseCsv(body ?? "")) {
      const area = OECD_AREAS[row.REF_AREA];
      if (area && /^\d{4}-\d{2}$/.test(row.TIME_PERIOD) && row.OBS_VALUE) facts.level(row.TIME_PERIOD, say(area, number(row.OBS_VALUE), monthLabel(row.TIME_PERIOD)));
    }
  }
  return facts.records({ id: "oecd", source: "OECD", title: "OECD inflation and unemployment", url: "https://data-explorer.oecd.org/", license: OECD });
}

// ---- Commonwealth ----

/** Acts and instruments made in the window, each as-made Word document through the Register's API. */
async function legislationAu(): Promise<SourceRecord[]> {
  const API = "https://api.prod.legislation.gov.au/v1";
  const opts = { gapMs: 1500 };
  const records: SourceRecord[] = [];
  const filter = encodeURIComponent(`makingDate ge ${FROM}T00:00:00 and makingDate le ${TO}T23:59:59`);
  for (let skip = 0; !enough(records.length); skip += 200) {
    const list = await get(`${API}/titles?$filter=${filter}&$orderby=makingDate%20desc&$top=200&$skip=${skip}&$select=id,name,makingDate,collection`, opts);
    const titles: Json[] = list ? JSON.parse(list).value ?? [] : [];
    for (const t of titles) {
      if (enough(records.length)) break;
      const date = String(t.makingDate).slice(0, 10);
      if (!inWindow(date)) continue;
      const docs = await get(`${API}/documents?$filter=${encodeURIComponent(`titleId eq '${t.id}'`)}&$top=30`, opts);
      const word = (docs ? (JSON.parse(docs).value as Json[]) : []).filter((d) => d.type === "Primary" && d.format === "Word").sort((a, b) => String(a.start).localeCompare(String(b.start)))[0];
      if (!word) continue;
      const key = `titleId='${word.titleId}',start=${word.start},retrospectiveStart=${word.retrospectiveStart},rectificationVersionNumber=${word.rectificationVersionNumber},type='Primary',uniqueTypeNumber=${word.uniqueTypeNumber},volumeNumber=${word.volumeNumber},format='Word'`;
      const file = await fetchBytes(`${API}/documents(${key})`, opts);
      if (!file) continue;
      records.push({ id: `legislation-au:${t.id}`, source: `Federal Register of Legislation, ${t.collection}`, title: t.name, url: `https://www.legislation.gov.au/${t.id}/asmade/text`, date, license: au(), visibility: "public", text: docxText(file) });
    }
    if (titles.length < 200) break;
  }
  return records;
}

/** The Daily, Statistics Canada's own write-up of each release. Items run a, b, c... per day; the first gap ends the day. */
async function statcan(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const day of windowDays()) {
    if (enough(records.length)) break;
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const stamp = day.slice(2).replace(/-/g, "");
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      if (enough(records.length)) break;
      const url = `https://www150.statcan.gc.ca/n1/daily-quotidien/${stamp}/dq${stamp}${letter}-eng.htm`;
      const html = await get(url, { gapMs: 2000 });
      if (!html) break;
      const title = htmlToText(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/^The Daily\W+/, "");
      // The release runs from its "Released" line to the standing contact paragraph.
      const body = htmlToText(section(html, "main")).replace(/^[\s\S]*?Released:\s*\d{4}-\d{2}-\d{2}\s*/, "").split(/\n\n(?:For more information, or to enquire|Date modified|Report a problem)/)[0].replace(/^Tab \d+\n\n/gm, "");
      records.push({ id: `statcan:${stamp}${letter}`, source: "Statistics Canada, The Daily", title, url, date: day, license: STATCAN, visibility: "public", text: body });
    }
  }
  return records;
}

/** The policy rate from Valet, monthly exchange rates, and press releases from the Bank's feed (its JSON API needs a login). */
async function bankOfCanada(): Promise<SourceRecord[]> {
  const VALET = "https://www.bankofcanada.ca/valet";
  const facts = new MonthFacts();
  const rate = await get(`${VALET}/observations/V39079/json?start_date=2025-12-01&end_date=${TO}`);
  const obs: Json[] = rate ? JSON.parse(rate).observations ?? [] : [];
  obs.forEach((o, i) => {
    const before = obs[i - 1]?.V39079?.v;
    if (before !== undefined && Number(before) !== Number(o.V39079?.v)) facts.event(o.d, `With effect from ${longDate(o.d)}, the Bank of Canada's target for the overnight rate moved from ${number(before)}% to ${number(o.V39079.v)}%.`);
  });
  for (let m = 1; m <= 10; m++) {
    const ym = `2026-${String(m).padStart(2, "0")}`;
    const current = obs.filter((o) => o.d <= monthEnd(ym)).at(-1);
    if (current) facts.level(ym, `At the end of ${monthLabel(ym)}, the Bank of Canada's target for the overnight rate was ${number(current.V39079.v)}%.`);
  }
  const fx = await get(`${VALET}/observations/group/FX_RATES_MONTHLY/json?start_date=2026-01-01&end_date=${TO}`);
  if (fx) {
    const { seriesDetail, observations } = JSON.parse(fx) as Json;
    for (const o of observations ?? []) {
      for (const [series, cell] of Object.entries(o as Json)) {
        const label = seriesDetail?.[series]?.label;
        if (series !== "d" && label && (cell as Json)?.v) facts.level(String(o.d).slice(0, 7), `In ${monthLabel(String(o.d).slice(0, 7))}, the monthly average ${label} rate was ${(cell as Json).v}, according to the Bank of Canada.`);
      }
    }
  }
  const records = facts.records({ id: "bank-of-canada:stats", source: "Bank of Canada", title: "Bank of Canada policy rate and exchange rates", url: "https://www.bankofcanada.ca/rates/", license: BANK_OF_CANADA });
  let pages = 0;
  for (let page = 1; page <= 20 && !enough(pages); page++) {
    const feed = await get(`https://www.bankofcanada.ca/content_type/press-releases/feed/?paged=${page}`);
    const items = feed?.match(/<item\b[\s\S]*?<\/item>/g) ?? [];
    if (items.length === 0) break;
    let older = false;
    for (const item of items) {
      if (enough(pages)) break;
      const date = (tagText(item, "dc:date") || new Date(tagText(item, "pubDate")).toISOString()).slice(0, 10);
      if (date < FROM) older = true;
      if (!inWindow(date)) continue;
      const link = tagText(item, "link");
      const html = await get(link);
      const text = html ? htmlToText(section(html, "main")).replace(/^Share this page[^\n]*\n*/gm, "").split(/\n\nContent Type\(s\)/)[0] : htmlToText(tagText(item, "description"));
      pages++;
      records.push({ id: `bank-of-canada:${link}`, source: "Bank of Canada, press release", title: htmlToText(tagText(item, "title")), url: link, date, license: BANK_OF_CANADA, visibility: "public", text });
    }
    if (older || items.length < 5) break;
  }
  return records;
}

// ---- France ----

/** Walks a gzipped tar without loading it, handing each regular file under `wanted` to `visit`. */
async function eachTarFile(file: string, wanted: RegExp, visit: (name: string, body: Buffer) => void) {
  let buffer: Buffer = Buffer.alloc(0);
  let longName = "";
  for await (const chunk of createReadStream(file).pipe(createGunzip())) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : (chunk as Buffer);
    while (buffer.length >= 512) {
      const name = longName || buffer.toString("utf8", 0, 100).replace(/\0.*$/s, "");
      const size = parseInt(buffer.toString("ascii", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8);
      const type = String.fromCharCode(buffer[156]);
      const total = 512 + Math.ceil(size / 512) * 512;
      if (buffer.length < total) break;
      if (type === "L") longName = buffer.toString("utf8", 512, 512 + size).replace(/\0.*$/s, "");
      else {
        longName = "";
        if (name && (type === "0" || type === "\0") && wanted.test(name)) visit(name, buffer.subarray(512, 512 + size));
      }
      buffer = buffer.subarray(total);
    }
  }
}

/**
 * Daily LEGI deltas: article versions that entered into force in the window, grouped by text and start date. Most of a
 * delta restates older versions, so anything starting before the window is dropped.
 */
async function legifrance(): Promise<SourceRecord[]> {
  const ROOT = "https://echanges.dila.gouv.fr/OPENDATA/LEGI";
  const listing = await get(`${ROOT}/`);
  const tars = [...new Set(listing?.match(/LEGI_\d{8}-\d+\.tar\.gz/g) ?? [])].filter((f) => {
    const d = f.slice(5, 13);
    return inWindow(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
  }).sort().reverse();
  const groups = new Map<string, { cid: string; title: string; date: string; articles: Map<string, string> }>();
  for (const tar of tars) {
    if (enough(groups.size)) break;
    const url = `${ROOT}/${tar}`;
    if (!(await fetchBytes(url))) continue;
    await eachTarFile(cacheFile(url), /\/LEGIARTI\d+\.xml$/, (_name, body) => {
      const xml = body.toString("utf8");
      const date = tagText(xml, "DATE_DEBUT");
      if (!inWindow(date)) return;
      const content = tagText(xml, "CONTENU");
      const text = htmlToText(content);
      if (!text) return;
      const cid = xml.match(/<TEXTE\b[^>]*\bcid="([^"]+)"/)?.[1] ?? "";
      const title = htmlToText(xml.match(/<TITRE_TXT\b[^>]*>([\s\S]*?)<\/TITRE_TXT>/)?.[1] ?? "") || cid;
      const key = `${cid}:${date}`;
      const group = groups.get(key) ?? { cid, title, date, articles: new Map() };
      group.articles.set(tagText(xml, "ID"), `Article ${tagText(xml, "NUM") || "unique"}: ${text}`);
      groups.set(key, group);
    });
  }
  return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date)).map((g) => ({
    id: `legifrance:${g.cid}:${g.date}`,
    source: "Legifrance, LEGI",
    title: `${g.title}: articles en vigueur le ${g.date}`,
    url: `https://www.legifrance.gouv.fr/loda/id/${g.cid}/${g.date}`,
    date: g.date,
    license: LEGIFRANCE,
    visibility: "public" as const,
    text: [...g.articles.values()].join("\n\n"),
  }));
}

// ---- Japan ----

/** Flattens e-Gov's law tree to text, one paragraph per article, paragraph or item. */
function lawTreeText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const { tag, children } = node as Json;
  if (tag === "Rt") return "";
  const inner = ((children ?? []) as unknown[]).map(lawTreeText).join("");
  return /^(LawTitle|LawNum|ArticleCaption|ArticleTitle|ParagraphSentence|ItemSentence|Subitem\d?Sentence|ChapterTitle|SectionTitle|PartTitle|SupplProvisionLabel|TableRow)$/.test(tag) ? `\n\n${inner}` : inner;
}

const japaneseDate = (d: string) => `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月${Number(d.slice(8))}日`;

/** Laws promulgated in the window in full, and each month's amendments to existing laws as dated sentences. */
async function egovJapan(): Promise<SourceRecord[]> {
  const API = "https://laws.e-gov.go.jp/api/2";
  const license = PDL("e-Gov Law Search (https://laws.e-gov.go.jp/), Digital Agency of Japan");
  const records: SourceRecord[] = [];
  for (let offset = 0; !enough(records.length); offset += 100) {
    const body = await get(`${API}/laws?promulgation_date_from=${FROM}&promulgation_date_to=${TO}&limit=100&offset=${offset}&response_format=json`);
    const laws: Json[] = body ? JSON.parse(body).laws ?? [] : [];
    for (const law of laws) {
      if (enough(records.length)) break;
      const date: string = law.law_info?.promulgation_date;
      const revision: string = law.revision_info?.law_revision_id;
      if (!inWindow(date) || !revision) continue;
      const data = await get(`${API}/law_data/${revision}?response_format=json`);
      if (!data) continue;
      const text = lawTreeText(JSON.parse(data).law_full_text).replace(/\n{3,}/g, "\n\n").trim();
      records.push({ id: `egov-japan:${revision}`, source: "e-Gov Law Search, Japan", title: law.revision_info.law_title, url: `https://laws.e-gov.go.jp/law/${revision}`, date, license, visibility: "public", text });
    }
    if (laws.length < 100) break;
  }
  const facts = new MonthFacts();
  const seen = new Set<string>();
  for (let offset = 0; !pauseRequested() && (LIMIT === Infinity || offset < 100); offset += 100) {
    const body = await get(`${API}/laws?amendment_promulgation_date_from=${FROM}&amendment_promulgation_date_to=${TO}&limit=100&offset=${offset}&response_format=json`);
    const laws: Json[] = body ? JSON.parse(body).laws ?? [] : [];
    for (const law of laws) {
      const r: Json = law.revision_info ?? {};
      const date: string = r.amendment_promulgate_date;
      const key = `${law.law_info?.law_id}:${date}:${r.amendment_law_num}`;
      if (!inWindow(date) || seen.has(key) || !r.amendment_law_title || law.law_info?.promulgation_date === date) continue;
      seen.add(key);
      facts.event(date, `${japaneseDate(date)}公布の${r.amendment_law_title}（${r.amendment_law_num ?? ""}）により、${r.law_title}が改正された。`);
    }
    if (laws.length < 100) break;
  }
  return [...facts.records({ id: "egov-japan:amendments", source: "e-Gov Law Search, Japan", title: "Amendments to Japanese laws", url: "https://laws.e-gov.go.jp/", license }), ...records];
}

/** JMA press releases of Reiwa 8, from the list its press page loads, and the recent shaking reports it still serves. */
async function jma(): Promise<SourceRecord[]> {
  const WWW = "https://www.jma.go.jp";
  const license = PDL("Japan Meteorological Agency (https://www.jma.go.jp/)");
  const list = await get(`${WWW}/jma/press_list.js`);
  const entries = [...(list ?? "").matchAll(/\['1','([^']+)','8','(\d+)','(\d+)','([^']*)'\]/g)];
  const records: SourceRecord[] = [];
  for (const [, link, month, day, title] of entries) {
    if (enough(records.length)) break;
    const date = `2026-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    if (!inWindow(date)) continue;
    const url = link.startsWith("http") ? link : `${WWW}${link}`;
    let text = "";
    if (/\.pdf$/i.test(url)) text = await pdfText(url);
    else {
      const html = await get(url);
      text = html ? htmlToText(section(html, "body")) : "";
    }
    if (text.includes("�")) {
      const bytes = await fetchBytes(`${url}#sjis`, { key: `${url}#sjis` });
      if (bytes) text = htmlToText(section(new TextDecoder("shift_jis").decode(bytes), "body"));
    }
    // Past the site menu, up to the staff contact block.
    const from = text.indexOf("報道発表日");
    if (from > 0) text = text.slice(from).split(/\n\n(?:問合せ先|問い合わせ先|資料全文)/)[0];
    records.push({ id: `jma:${link}`, source: "Japan Meteorological Agency, press release", title, url, date, license, visibility: "public", text: text || title });
  }
  const facts = new MonthFacts();
  const quakes = await get(`${WWW}/bosai/quake/data/list.json`);
  const events = new Set<string>();
  for (const q of quakes ? (JSON.parse(quakes) as Json[]) : []) {
    const date = String(q.at ?? "").slice(0, 10);
    if (!q.maxi || !/^[3-7]/.test(String(q.maxi)) || events.has(q.eid) || !q.anm) continue;
    events.add(q.eid);
    facts.event(date, `${japaneseDate(date)}${String(q.at).slice(11, 16)}頃、${q.anm}を震源とする地震があり、最大震度は${q.maxi}${q.mag ? `、マグニチュードは${q.mag}` : ""}だった。`);
  }
  return [...facts.records({ id: "jma:quakes", source: "Japan Meteorological Agency, earthquake reports", title: "Earthquakes with maximum intensity 3 or more in Japan", url: "https://www.jma.go.jp/bosai/map.html#contents=earthquake_map", license }), ...records];
}

// ---- Korea ----

/**
 * Press releases on korea.kr. Each item's own KOGL mark decides: Type 1 is public with credit, the AI type alone is
 * training only, and anything else is left out. Text is the PDF or HWPX attachment, else the list's summary.
 */
async function koreaPress(): Promise<SourceRecord[]> {
  const WWW = "https://www.korea.kr";
  const records: SourceRecord[] = [];
  let dropped = 0;
  let tried = 0;
  for (let page = 1; page <= 3000 && !enough(records.length) && !overTestBudget(tried); page++) {
    const list = await get(`${WWW}/briefing/pressReleaseList.do?pageIndex=${page}&startDate=${FROM}&endDate=${TO}&period=direct&srchWord=`);
    const items = list?.match(/<li>\s*<a href="\/briefing\/pressReleaseView\.do\?newsId=\d+[\s\S]*?<\/li>/g) ?? [];
    if (items.length === 0) break;
    for (const item of items) {
      if (enough(records.length) || overTestBudget(++tried)) break;
      const newsId = item.match(/newsId=(\d+)/)![1];
      const [y, m, d] = (item.match(/<span>(\d{4})\.(\d{2})\.(\d{2})<\/span>/) ?? []).slice(1);
      const date = `${y}-${m}-${d}`;
      if (!inWindow(date)) continue;
      const url = `${WWW}/briefing/pressReleaseView.do?newsId=${newsId}`;
      const view = await get(url);
      if (!view) continue;
      const mark = htmlToText(view.slice(view.indexOf('class="kogl_wrap"'), view.indexOf('class="kogl_wrap"') + 6000));
      const type1 = /제\s*1\s*유형/.test(mark);
      const aiType = /AI\s*유형/.test(mark);
      if (view.indexOf('class="kogl_wrap"') < 0 || (!type1 && !aiType) || /제\s*[234]\s*유형/.test(mark)) {
        dropped++;
        continue;
      }
      const ministry = item.match(/<span>\d{4}\.\d{2}\.\d{2}<\/span>\s*<span>([^<]+)<\/span>/)?.[1]?.trim() ?? "";
      const files = [...view.matchAll(/<a href="\/common\/download\.do\?fileId=(\d+)&amp;tblKey=(\w+)">[\s\S]*?alt="[^"]*"\s*\/?>\s*([^<]+?)\s*<\/a>/g)];
      const pdf = files.find((f) => /\.pdf$/i.test(f[3]));
      const hwpx = files.find((f) => /\.hwpx$/i.test(f[3]));
      let text = "";
      if (pdf) text = await pdfText(`${WWW}/common/download.do?fileId=${pdf[1]}&tblKey=${pdf[2]}`);
      if (!text && hwpx) {
        const bytes = await fetchBytes(`${WWW}/common/download.do?fileId=${hwpx[1]}&tblKey=${hwpx[2]}`);
        if (bytes && bytes.readUInt32LE(0) === 0x04034b50) text = hwpxText(bytes);
      }
      const lead = htmlToText(item.match(/<span class="lead">([\s\S]*?)<\/span>/)?.[1] ?? "");
      if (!text && /첨부파일을 참고/.test(lead)) continue;
      const credit = `Source: ${ministry || "Korean government"}, via korea.kr (대한민국 정책브리핑).`;
      const aiTerms = "KOGL AI type: outputs must not copy the work, direct quotes must cite it, and reselling training data made from it is banned.";
      records.push({
        id: `korea-press:${newsId}`,
        source: `Korea policy briefing, press release${ministry ? `, ${ministry}` : ""}`,
        title: htmlToText((item.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] ?? newsId).replace(/&middot;/g, "\u00B7")),
        url,
        date,
        license: type1 ? `KOGL Type 1 (text only). ${credit}${aiType ? ` ${aiTerms}` : ""}` : `Training only. ${aiTerms} ${credit}`,
        visibility: type1 ? "public" : "private",
        // Staff names and phone numbers close most releases, and they aren't news.
        text: (text || lead).split(/\n\n(?:담당 부서|담당부서)/)[0].trim(),
      });
    }
  }
  if (dropped) console.log(`korea-press: left out ${dropped} items without KOGL Type 1 or the AI type`);
  return records;
}

// ---- Mexico ----

/** Monetary policy announcements. Banxico's series API needs a registered token, so the statements themselves stand in for it. */
async function banxico(): Promise<SourceRecord[]> {
  const WWW = "https://www.banxico.org.mx";
  const page = await fetchBytes(`${WWW}/publicaciones-y-prensa/anuncios-de-las-decisiones-de-politica-monetaria/anuncios-politica-monetaria-t.html`);
  if (!page) throw new Error("the announcements page did not load");
  const html = new TextDecoder("latin1").decode(page);
  const records: SourceRecord[] = [];
  for (const row of html.match(/<TR>\s*<TD[^>]*referenceDate[\s\S]*?<\/TR>/gi) ?? []) {
    if (enough(records.length)) break;
    const stamp = row.match(/>\s*(\d{2})\/(\d{2})\/(\d{2})\s*</);
    const date = stamp ? `20${stamp[3]}-${stamp[2]}-${stamp[1]}` : null;
    const href = row.match(/HREF="([^"]+\.pdf)"/i)?.[1];
    if (!inWindow(date) || !href) continue;
    const title = htmlToText(row.match(/bm:linkText"[^>]*>([\s\S]*?)<br/i)?.[1] ?? "");
    const url = `${WWW}${encodeURI(href)}`;
    const text = await pdfText(url);
    records.push({ id: `banxico:${href}`, source: "Banco de Mexico, monetary policy announcement", title, url, date, license: BANXICO, visibility: "private", text: text || `${longDate(date)}: ${title}.` });
  }
  return records;
}

/** INEGI's press room: its own list endpoint is a POST, and each bulletin is a PDF under /contenidos. */
async function inegi(): Promise<SourceRecord[]> {
  const WWW = "https://www.inegi.org.mx";
  const records: SourceRecord[] = [];
  for (let from = 0; !enough(records.length); from += 100) {
    const form = new URLSearchParams({ fechaDesde: FROM, fechaHasta: TO, ambito: "-1", token: "", tipoNoticia: "-1", ordenarPor: "publicacion", ordenAsc: "0", desde: String(from), tomar: "100", ingles: "0", idPrograma: "-1", idTematica: "-1" }).toString();
    const body = await fetchBytes(`${WWW}/app/api/saladeprensa/api/saladeprensa/ObtenerNoticiasTabla/v3`, { key: `inegi-list:${form}`, init: { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } } });
    const items: Json[] = body ? JSON.parse(body.toString("utf8")) : [];
    for (const item of items) {
      if (enough(records.length)) break;
      const [day, month, year] = String(item.fecha ?? "").split("/");
      const date = `${year}-${month}-${day}`;
      const pdf: string = item.comunicadoEsUrlPdf || item.comunicadoEnUrlPdf || item.reporteEsUrlPdf;
      if (!inWindow(date) || !pdf) continue;
      const url = `${WWW}/contenidos${pdf}`;
      const title = [item.titulo, item.ambito && item.ambito !== "Nacional" ? item.ambito : ""].filter(Boolean).join(", ");
      const text = await pdfText(url);
      if (text) records.push({ id: `inegi:${item.idNoticia}`, source: `INEGI, ${item.tipoNoticia ?? "sala de prensa"}`, title, url, date, license: INEGI, visibility: "public", text: [item.subtitulo, text].filter(Boolean).join("\n\n") });
    }
    if (items.length < 100) break;
  }
  return records;
}

// ---- Saudi Arabia ----

/** GASTAT news, walking back from the newest article number. Pages can answer in Arabic, which stays as is. */
async function gastat(): Promise<SourceRecord[]> {
  const WWW = "https://www.stats.gov.sa";
  const index = await get(`${WWW}/en/news`);
  const newest = Math.max(0, ...[...(index ?? "").matchAll(/\/w\/news\/(\d+)/g)].map((m) => Number(m[1])));
  const records: SourceRecord[] = [];
  let older = 0;
  for (let id = newest; id > 0 && older < 5 && !enough(records.length); id--) {
    const url = `${WWW}/en/w/news/${id}`;
    const html = await get(url);
    if (!html) continue;
    const start = html.search(/<h1\b[^>]*page-title/);
    const stamp = start < 0 ? null : html.slice(start).match(/(\d{2})-(\d{2})-(\d{4})/);
    const date = stamp ? `${stamp[3]}-${stamp[2]}-${stamp[1]}` : null;
    if (!date) continue;
    if (date < FROM) {
      older++;
      continue;
    }
    older = 0;
    if (!inWindow(date)) continue;
    const title = htmlToText(html.slice(start).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
    // The article runs from the date to the related-news carousel.
    const rest = html.slice(start + (stamp?.index ?? 0) + 10);
    const cut = rest.search(/class="(?:carousel|card h-100)/);
    const text = htmlToText(`<div>${(cut > 0 ? rest.slice(0, cut) : rest).replace(/^[^<]*<\/[^>]+>/, "")}`).replace(/^[^\p{L}]+/u, "").replace(/\n\n(?:Infographic|Read More)[\s\S]*$/, "");
    if (wordCount(text) < 20) continue;
    records.push({ id: `gastat:${id}`, source: "General Authority for Statistics, Saudi Arabia", title, url, date, license: GASTAT, visibility: "public", text });
  }
  return records;
}

runAll([
  ["govuk", govuk],
  ["legislation-uk", legislationUk],
  ["hansard-uk", hansard],
  ["ons", ons],
  ["ec-press", ecPress],
  ["europarl", europarl],
  ["eurlex", eurlex],
  ["eurostat", eurostat],
  ["ecb", ecb],
  ["bis", bis],
  ["worldbank-docs", worldbankDocs],
  ["worldbank-pink", worldbankPink],
  ["oecd", oecd],
  ["legislation-au", legislationAu],
  ["statcan", statcan],
  ["bank-of-canada", bankOfCanada],
  ["legifrance", legifrance],
  ["egov-japan", egovJapan],
  ["jma", jma],
  ["korea-press", koreaPress],
  ["banxico", banxico],
  ["inegi", inegi],
  ["gastat", gastat],
]).catch((err) => {
  console.error(err);
  process.exit(1);
});

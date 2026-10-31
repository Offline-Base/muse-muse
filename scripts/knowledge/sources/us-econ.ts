/**
 * Collects US corporate and economic records from the window for the knowledge corpus: SEC EDGAR, BLS, EIA and BEA.
 * Writes .data/knowledge/sources/us-*.jsonl. None of it needs a key.
 *
 * SEC EDGAR: at most 5 requests a second across every sec.gov host (their limit is 10). The quarterly form index lists
 * the filings. Each filing is read once from its full submission file, which holds every document in one request, and
 * only the main document and Exhibit 99s are kept, as plain text, in the cache. Forms 3, 4, 5, 144, Schedule 13D/G and
 * shareholder exempt solicitations are never read, since they are about individuals. Contact lines, emails, phone numbers
 * and ages are taken out. Filing text is private: the SEC claims no copyright, but filers can hold it in their exhibits
 * (docs/knowledge-research/government.md). A 403 from the SEC stops every SEC step at once; nothing retries around it.
 *
 * BLS: release pages on www.bls.gov and flat files on download.bls.gov. api.bls.gov is not used, because its robots.txt
 * disallows everything. EIA: the keyless bulk zips. Series whose copyright field names a third party (Thomson-Reuters,
 * now LSEG) stay private and appear only as weekly and monthly prices, never the daily series. BEA: news release pages;
 * its API needs a key. Census is not collected: api.census.gov rejects even a request for its robots.txt, and
 * www.census.gov keeps only the current indicator on its pages.
 *
 * With LIMIT set, each step stops at a few requests and us-sec-raw uploads nothing, for a small test.
 *
 *   npx tsx scripts/knowledge/sources/us-econ.ts [step ...]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { createInflateRaw } from "node:zlib";
import { longDate } from "@/lib/knowledge/passages";
import { htmlToText, type SourceRecord } from "@/lib/knowledge/sources";
import { CACHE, FROM, get, LIMIT, pauseRequested, runAll, save, TO } from "./common";

const SAMPLING = LIMIT !== Infinity;
const CONTACT_UA = "OfflineBase MuseMuse-knowledge team@offlinebase.com";
const HEADERS = { "User-Agent": CONTACT_UA };
const BUCKET = process.env.KNOWLEDGE_BUCKET ?? "muse-knowledge-916979311153";
const RETRIEVED = new Date().toISOString().slice(0, 10);
const MAX_DOC_WORDS = 4000;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const inWindow = (date: string | null | undefined): date is string => !!date && date >= FROM && date <= TO;
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

interface Fact {
  date: string;
  text: string;
}

/** Small facts as documents by month, oldest first, split when a month runs long. */
function monthly(facts: Fact[], o: { id: string; source: string; subject: string; url: string; license: string; visibility: "public" | "private" }): SourceRecord[] {
  const byMonth = new Map<string, Fact[]>();
  for (const f of facts) {
    if (!inWindow(f.date)) continue;
    const month = f.date.slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), f]);
  }
  const records: SourceRecord[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    const sorted = byMonth.get(month)!.sort((a, b) => a.date.localeCompare(b.date));
    const parts: Fact[][] = [[]];
    let words = 0;
    for (const f of sorted) {
      const n = countWords(f.text);
      if (words && words + n > MAX_DOC_WORDS) {
        parts.push([]);
        words = 0;
      }
      parts[parts.length - 1].push(f);
      words += n;
    }
    parts.forEach((part, i) => {
      records.push({
        id: `${o.id}:${month}${parts.length > 1 ? `:${i + 1}` : ""}`,
        source: o.source,
        title: `${o.subject}, ${monthName(month)}${parts.length > 1 ? `, part ${i + 1}` : ""}`,
        url: o.url,
        date: part[part.length - 1].date,
        license: o.license,
        visibility: o.visibility,
        text: part.map((f) => f.text).join("\n"),
      });
    });
  }
  return records;
}

// SEC EDGAR

const SEC = "https://www.sec.gov";
const SEC_LICENSE = "Public record (SEC EDGAR filing). The SEC claims no copyright; text and exhibits may belong to the filer, so full text stays private";
const SEC_GAP_MS = 210;
const SEC_WORKERS = 4;
const SEC_COMPANIES = 1000;
const META_CIK = "1326801";
/** About individuals, by the people filing them, or both. */
const SEC_NEVER = /^(3|4|5|144|SC 13|SCHEDULE 13|PX14A6|13F)/;
const SEC_QUARTERS = ["QTR1", "QTR2", "QTR3", "QTR4"];
/** How many filings a test reads per step. */
const SAMPLE_FILINGS = 12;
/** Partial results reach S3 by writing the file this often. */
const CHECKPOINT_FILINGS = 1500;

let secNext = 0;
let secBlocked = false;

/** One turn at the shared rate. Every sec.gov request takes one, so all hosts and steps together stay under 5 a second. */
async function secTurn() {
  const now = Date.now();
  const at = Math.max(now, secNext);
  secNext = at + SEC_GAP_MS;
  if (at > now) await sleep(at - now);
}

const cacheFile = (key: string) => path.join(CACHE, createHash("sha256").update(key).digest("hex").slice(0, 32));

async function secGet(url: string): Promise<string | null> {
  if (!existsSync(cacheFile(url))) await secTurn();
  return get(url, { gapMs: 0, headers: HEADERS });
}

interface IndexRow {
  form: string;
  company: string;
  cik: string;
  filed: string;
  file: string;
}

async function formIndex(): Promise<IndexRow[]> {
  const rows: IndexRow[] = [];
  for (const quarter of SEC_QUARTERS) {
    const body = await secGet(`${SEC}/Archives/edgar/full-index/2026/${quarter}/form.idx`);
    if (!body) {
      console.warn(`form index ${quarter} not read`);
      continue;
    }
    for (const line of body.split("\n")) {
      const m = line.match(/^(\S.*?)\s{2,}(.*?)\s{2,}(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(edgar\/\S+)\s*$/);
      if (m && inWindow(m[4])) rows.push({ form: m[1], company: m[2].trim(), cik: m[3], filed: m[4], file: m[5] });
    }
  }
  return rows;
}

let rowsOnce: Promise<IndexRow[]> | null = null;
const secRows = () => (rowsOnce ??= formIndex());

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
const CONTACT_HEAD = /^(\W*)((investor|media|press|analyst|shareholder|company|financial|ir|pr)\s+)*(relations\s+)?(contacts?|inquiries)\b[^.]{0,40}:?\s*$/i;

/** Takes out what identifies people rather than the company: contact blocks, emails, phone numbers, ages. */
function scrub(text: string): string {
  const out: string[] = [];
  let inContacts = false;
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.replace(/\s+/g, " ").trim();
    if (!p) continue;
    const words = countWords(p);
    if (CONTACT_HEAD.test(p) || /^(\W*)((investor|media|press|analyst)\s+)?(relations\s+)?contacts?\s*:/i.test(p)) {
      inContacts = true;
      continue;
    }
    /** A contact block is short lines; the first real sentence ends it. */
    if (inContacts && words <= 12) continue;
    inContacts = false;
    if (EMAIL.test(p) || PHONE.test(p)) {
      if (words <= 40) continue;
      const kept = p.split(/(?<=[.!?])\s+/).filter((s) => !EMAIL.test(s) && !PHONE.test(s)).join(" ");
      if (kept) out.push(kept);
      continue;
    }
    out.push(p);
  }
  return out
    .join("\n\n")
    .replace(/,\s*age\s+\d{2}\b(?:\s+years old)?/gi, "")
    .replace(/\b(age|aged)\s+\d{2}\b/gi, "")
    .replace(/([A-Z][\w'.-]+),\s*\d{2},(?=\s+(?:has|will|is|was|who|served|serves|joined|currently|most|previously|brings|holds)\b)/g, "$1,");
}

/** Plain text of one filing document: inline XBRL's hidden facts go, and table cells keep a space between them. */
function secDocText(raw: string): string {
  const body = raw
    .replace(/<head\b[\s\S]*?<\/head>/i, " ")
    .replace(/<ix:header\b[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<ix:hidden\b[\s\S]*?<\/ix:hidden>/gi, " ")
    .replace(/<\/(td|th)>/gi, " </td>")
    .replace(/<\/?XBRL>/g, "");
  return htmlToText(body).replace(/ /g, " ").replace(/​/g, "");
}

/** The item text of an 8-K: no cover page, no signature, and no Item 9.01, which only lists exhibits. */
function eightKItems(text: string): string {
  const start = text.search(/\bItem\s*\d{1,2}\.\d{2}\b/i);
  let body = start >= 0 ? text.slice(start) : text;
  const signature = body.search(/\n\s*SIGNATURES?\b|Pursuant to the requirements of the Securities Exchange Act/i);
  if (signature >= 0) body = body.slice(0, signature);
  const exhibits = body.search(/\bItem\s*9\.01\b/i);
  if (exhibits >= 0) body = body.slice(0, exhibits);
  return body.trim();
}

interface SecDoc {
  type: string;
  file: string;
  description: string;
  text: string;
}

interface SecFiling {
  period: string;
  items: string[];
  docs: SecDoc[];
}

const secDate = (s: string | undefined) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "");

function parseSubmission(raw: string): SecFiling {
  const header = raw.slice(0, Math.max(raw.indexOf("</SEC-HEADER>"), 0));
  const period = secDate(header.match(/CONFORMED PERIOD OF REPORT:\s*(\d{8})/)?.[1]);
  const items = [...header.matchAll(/ITEM INFORMATION:\s*(.+)/g)].map((m) => m[1].trim());
  const docs: SecDoc[] = [];
  raw.split("<DOCUMENT>").slice(1).forEach((part, i) => {
    const type = part.match(/<TYPE>([^\n<]+)/)?.[1]?.trim() ?? "";
    /** The first document is the filing itself; of the rest, only press releases and the like. */
    if (i > 0 && !/^EX-99/.test(type)) return;
    const start = part.indexOf("<TEXT>");
    const end = part.indexOf("</TEXT>");
    if (start < 0) return;
    const inner = part.slice(start + 6, end > 0 ? end : undefined);
    if (/^\s*<PDF>|^begin \d{3}/.test(inner)) return;
    const text = scrub(secDocText(inner));
    docs.push({ type, file: part.match(/<FILENAME>([^\n<]+)/)?.[1]?.trim() ?? "", description: part.match(/<DESCRIPTION>([^\n<]+)/)?.[1]?.trim() ?? "", text: i === 0 && /^8-K/.test(type) ? eightKItems(text) : text });
  });
  return { period, items, docs };
}

/** The filing's kept documents, from the cache or read once from the full submission file. Null if it can't be read. */
async function secFiling(file: string): Promise<SecFiling | null> {
  const url = `${SEC}/Archives/${file}`;
  const cached = cacheFile(`${url}#kept`);
  if (existsSync(cached)) return JSON.parse(await readFile(cached, "utf8")) as SecFiling;
  for (let attempt = 0; attempt < 4 && !secBlocked; attempt++) {
    await secTurn();
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(300_000) });
      if (res.status === 403) {
        secBlocked = true;
        console.warn(`SEC returned 403 on ${url}; stopping every SEC step.`);
        return null;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(Number(res.headers.get("retry-after") ?? 0) * 1000 || 15_000 * (attempt + 1));
        continue;
      }
      if (!res.ok || !res.body) {
        console.warn(`${res.status} ${url}`);
        return null;
      }
      /** XBRL and data files come last and aren't kept, so the read ends there; leaving the loop cancels the download. */
      const decoder = new TextDecoder();
      let raw = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        raw += text;
        if (/\n<TYPE>(EX-101|XML|ZIP|EXCEL|JSON)/.test(text)) break;
      }
      const filing = parseSubmission(raw);
      await mkdir(CACHE, { recursive: true });
      await writeFile(cached, JSON.stringify(filing));
      return filing;
    } catch (err) {
      console.warn(`${url}: ${(err as Error).message.slice(0, 120)}`);
      await sleep(5000 * (attempt + 1));
    }
  }
  if (!secBlocked) console.warn(`gave up on ${url}`);
  return null;
}

const accession = (file: string) => file.split("/").pop()!.replace(/\.txt$/, "");

function filingRecords(row: IndexRow, filing: SecFiling, o: { id: string; source: string; name: string }): SourceRecord[] {
  const acc = accession(row.file);
  const base = `${SEC}/Archives/edgar/data/${row.cik}/${acc.replace(/-/g, "")}`;
  const when = longDate(row.filed);
  const records: SourceRecord[] = [];
  for (const doc of filing.docs) {
    if (countWords(doc.text) < 12) continue;
    const exhibit = /^EX-99/.test(doc.type);
    const label = exhibit ? doc.type.replace("EX-", "Exhibit ") : `Form ${row.form}`;
    const covers = !exhibit && filing.items.length ? ` It reports on: ${filing.items.join("; ")}.` : "";
    const event = !exhibit && filing.period && /^8-K/.test(row.form) ? `, for an event dated ${longDate(filing.period)}` : "";
    const lead = exhibit
      ? `This is ${label}${doc.description && !/^EX-99/i.test(doc.description) ? ` (${doc.description})` : ""} to the Form ${row.form} that ${o.name} filed with the US Securities and Exchange Commission on ${when}.`
      : `On ${when}, ${o.name} filed a Form ${row.form} with the US Securities and Exchange Commission${event}.${covers}`;
    records.push({
      id: `${o.id}:${acc}${exhibit ? `:${doc.type.toLowerCase()}:${doc.file}` : ""}`,
      source: o.source,
      title: `${o.name}, ${label}, filed ${when}`,
      url: doc.file ? `${base}/${doc.file}` : `${SEC}/Archives/${row.file}`,
      date: row.filed,
      license: SEC_LICENSE,
      visibility: "private",
      text: `${lead}\n\n${doc.text}`,
    });
  }
  return records;
}

/** Several workers sharing the SEC rate, so slow downloads don't drag the rate far below it. */
async function readFilings(name: string, rows: IndexRow[], o: { id: string; source: string; nameOf: (r: IndexRow) => string }): Promise<SourceRecord[]> {
  const chosen = SAMPLING ? rows.slice(0, SAMPLE_FILINGS) : rows;
  const records: SourceRecord[] = [];
  let next = 0;
  let done = 0;
  let failed = 0;
  console.log(`${name}: ${chosen.length} filings to read`);
  await Promise.all(Array.from({ length: SEC_WORKERS }, async () => {
    while (next < chosen.length && !secBlocked && !pauseRequested()) {
      const row = chosen[next++];
      const filing = await secFiling(row.file);
      if (filing) records.push(...filingRecords(row, filing, { id: o.id, source: o.source, name: o.nameOf(row) }));
      else failed++;
      done++;
      if (done % CHECKPOINT_FILINGS === 0 && !SAMPLING) {
        console.log(`${name}: ${done} of ${chosen.length} filings read, ${failed} failed, ${records.length} documents`);
        await save(name, records);
      }
    }
  }));
  console.log(`${name}: read ${done} of ${chosen.length} filings, ${failed} failed${secBlocked ? ", stopped by a 403" : ""}`);
  return records;
}

interface Company {
  cik_str: number;
  ticker: string;
  title: string;
}

async function sec8k(): Promise<SourceRecord[]> {
  const body = await secGet(`${SEC}/files/company_tickers.json`);
  if (!body) throw new Error("company_tickers.json not read");
  /** The file is in rough market-value order, with a line for each ticker. */
  const companies = new Map<string, { rank: number; ticker: string }>();
  for (const c of Object.values(JSON.parse(body) as Record<string, Company>)) {
    const cik = String(c.cik_str);
    if (!companies.has(cik) && companies.size < SEC_COMPANIES) companies.set(cik, { rank: companies.size, ticker: c.ticker });
  }
  const rows = (await secRows())
    .filter((r) => /^8-K(\/A)?$/.test(r.form) && companies.has(r.cik) && r.cik !== META_CIK)
    .sort((a, b) => companies.get(a.cik)!.rank - companies.get(b.cik)!.rank || b.filed.localeCompare(a.filed));
  console.log(`us-sec-8k: ${companies.size} companies, ${new Set(rows.map((r) => r.cik)).size} of them filed an 8-K in the window`);
  return readFilings("us-sec-8k", rows, { id: "us-sec-8k", source: "SEC EDGAR Form 8-K filings", nameOf: (r) => `${r.company} (${companies.get(r.cik)!.ticker})` });
}

async function secMeta(): Promise<SourceRecord[]> {
  const all = (await secRows()).filter((r) => r.cik === META_CIK);
  const rows = all.filter((r) => !SEC_NEVER.test(r.form)).sort((a, b) => a.filed.localeCompare(b.filed));
  console.log(`us-sec-meta: ${all.length} filings listed, ${rows.length} kept after leaving out forms about individuals`);
  return readFilings("us-sec-meta", rows, { id: "us-sec-meta", source: "SEC EDGAR filings of Meta Platforms", nameOf: () => "Meta Platforms, Inc." });
}

/** Streams one file into the bucket under knowledge/raw/sec/, unless the same size is already there. */
async function toS3(url: string, name: string): Promise<void> {
  await secTurn();
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok || !res.body) {
    console.warn(`${res.status} ${url}`);
    if (res.status === 403) secBlocked = true;
    return;
  }
  const size = res.headers.get("content-length") ?? "";
  const key = `knowledge/raw/sec/${name}`;
  const head = spawnSync("aws", ["s3api", "head-object", "--bucket", BUCKET, "--key", key, "--query", "ContentLength", "--output", "text"], { encoding: "utf8" });
  if (size && head.status === 0 && head.stdout.trim() === size) {
    await res.body.cancel();
    console.log(`us-sec-raw: ${name} already there, ${size} bytes`);
    return;
  }
  const upload = spawn("aws", ["s3", "cp", "-", `s3://${BUCKET}/${key}`, "--only-show-errors", ...(size ? ["--expected-size", size] : [])], { stdio: ["pipe", "inherit", "inherit"] });
  const closed = new Promise<number | null>((resolve) => upload.on("close", resolve));
  await pipeline(Readable.fromWeb(res.body as unknown as NodeWebStream), upload.stdin);
  const code = await closed;
  console.log(`us-sec-raw: ${name} ${code === 0 ? `uploaded, ${size} bytes` : `failed, aws exit ${code}`}`);
}

/** No documents: this step only saves the bulk company facts and the form indexes, for facts work later. */
async function secRaw(): Promise<SourceRecord[]> {
  if (SAMPLING) return [];
  await toS3(`${SEC}/files/company_tickers.json`, "company_tickers.json");
  for (const quarter of SEC_QUARTERS) await toS3(`${SEC}/Archives/edgar/full-index/2026/${quarter}/form.idx`, `form-2026-${quarter}.idx`);
  await toS3(`${SEC}/Archives/edgar/daily-index/xbrl/companyfacts.zip`, "companyfacts.zip");
  return [];
}

// BLS

const BLS = "https://www.bls.gov";
const BLS_FILES = "https://download.bls.gov/pub/time.series";
const BLS_LICENSE = "Public domain (US government work), US Bureau of Labor Statistics";

type Series = Map<string, number>;
type Flat = Map<string, Series>;

/** The named series from a BLS flat file, as month to value. */
function parseFlat(body: string, wanted: Set<string>, into: Flat) {
  for (const line of body.split("\n")) {
    const [id, year, period, value] = line.trim().split(/\s+/);
    addFlat(id, year, period, value, wanted, into);
  }
}

function addFlat(id: string | undefined, year: string | undefined, period: string | undefined, value: string | undefined, wanted: Set<string>, into: Flat) {
  if (!id || !wanted.has(id) || !/^M(0[1-9]|1[0-2])$/.test(period ?? "") || !Number.isFinite(Number(value)) || value === "") return;
  if (!into.has(id)) into.set(id, new Map());
  into.get(id)!.set(`${year}-${period!.slice(1)}`, Number(value));
}

/** ln.data.1.AllData is 390 MB and sorted by series, and the headline series come early, so reading stops once past them. */
async function streamLabor(wanted: Set<string>, into: Flat) {
  const last = [...wanted].sort().pop()!;
  const stop = new AbortController();
  const res = await fetch(`${BLS_FILES}/ln/ln.data.1.AllData`, { headers: HEADERS, signal: stop.signal });
  if (!res.ok || !res.body) {
    console.warn(`${res.status} ln.data.1.AllData`);
    return;
  }
  const input = Readable.fromWeb(res.body as unknown as NodeWebStream);
  /** Stopping early aborts the download on purpose, which both streams then report as an error. */
  input.on("error", () => {});
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("error", () => {});
  try {
    for await (const line of lines) {
      const [id, year, period, value] = line.trim().split(/\s+/);
      if (id === "series_id") continue;
      if (id > last) break;
      addFlat(id, year, period, value, wanted, into);
    }
  } finally {
    lines.close();
    stop.abort();
  }
}

function priorMonth(ym: string, back: number): string {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 - back, 1));
  return d.toISOString().slice(0, 7);
}

function change(flat: Flat, id: string, ym: string, back: number): number | null {
  const now = flat.get(id)?.get(ym);
  const then = flat.get(id)?.get(priorMonth(ym, back));
  return now === undefined || then === undefined || then === 0 ? null : ((now - then) / then) * 100;
}

function moved(pct: number | null, since: string): string {
  if (pct === null) return "";
  const r = Math.abs(pct).toFixed(1);
  return r === "0.0" ? `was unchanged from ${since}` : `${pct > 0 ? "rose" : "fell"} ${r} percent from ${since}`;
}

/** "the CPI ... was X, and rose Y from Z", for what the file holds; empty if the month isn't in it. */
function indexSentence(flat: Flat, ym: string, what: string, nsa: string, sa: string, base: string): string {
  const level = flat.get(nsa)?.get(ym);
  if (level === undefined) return "";
  const year = moved(change(flat, nsa, ym, 12), monthName(priorMonth(ym, 12)));
  const month = moved(change(flat, sa, ym, 1), monthName(priorMonth(ym, 1)));
  return `For ${monthName(ym)}, ${what} stood at ${level} (${base}, not seasonally adjusted)${year ? ` and ${year}` : ""}${month ? `; seasonally adjusted, it ${month}` : ""}.`;
}

function blsNumbers(slug: string, flat: Flat, ym: string): string[] {
  if (slug === "cpi") {
    return [
      indexSentence(flat, ym, "the Consumer Price Index for All Urban Consumers (CPI-U), all items", "CUUR0000SA0", "CUSR0000SA0", "1982-84=100"),
      indexSentence(flat, ym, "the CPI-U for all items less food and energy", "CUUR0000SA0L1E", "CUSR0000SA0L1E", "1982-84=100"),
      indexSentence(flat, ym, "the CPI-U for food", "CUUR0000SAF1", "CUSR0000SAF1", "1982-84=100"),
      indexSentence(flat, ym, "the CPI-U for energy", "CUUR0000SA0E", "CUSR0000SA0E", "1982-84=100"),
    ];
  }
  if (slug === "ppi") {
    return [
      indexSentence(flat, ym, "the Producer Price Index for final demand", "WPUFD4", "WPSFD4", "November 2009=100"),
      indexSentence(flat, ym, "the Producer Price Index for final demand less foods, energy and trade services", "WPUFD49116", "WPSFD49116", "August 2013=100"),
    ];
  }
  const out: string[] = [];
  const at = (id: string) => flat.get(id)?.get(ym);
  const when = monthName(ym);
  const payrolls = at("CES0000000001");
  const before = flat.get("CES0000000001")?.get(priorMonth(ym, 1));
  if (payrolls !== undefined) {
    const diff = before === undefined ? null : Math.round((payrolls - before) * 1000);
    out.push(`For ${when}, total nonfarm payroll employment was ${(payrolls / 1000).toFixed(1)} million, seasonally adjusted${diff === null ? "" : `, ${diff >= 0 ? "up" : "down"} ${Math.abs(diff).toLocaleString("en-US")} from ${monthName(priorMonth(ym, 1))}`}.`);
  }
  if (at("LNS14000000") !== undefined) out.push(`For ${when}, the US unemployment rate was ${at("LNS14000000")!.toFixed(1)} percent, seasonally adjusted.`);
  if (at("LNS13000000") !== undefined) out.push(`For ${when}, ${(at("LNS13000000")! / 1000).toFixed(1)} million people in the US were unemployed, seasonally adjusted.`);
  if (at("LNS11300000") !== undefined) out.push(`For ${when}, the labor force participation rate was ${at("LNS11300000")!.toFixed(1)} percent.`);
  if (at("LNS12300000") !== undefined) out.push(`For ${when}, the employment-population ratio was ${at("LNS12300000")!.toFixed(1)} percent.`);
  if (at("CES0500000003") !== undefined) {
    const year = moved(change(flat, "CES0500000003", ym, 12), monthName(priorMonth(ym, 12)));
    out.push(`For ${when}, average hourly earnings of all private employees were $${at("CES0500000003")!.toFixed(2)}${year ? ` and ${year}` : ""}.`);
  }
  return out;
}

const BLS_RELEASES: Array<{ slug: string; name: string; heading: RegExp }> = [
  { slug: "cpi", name: "Consumer Price Index", heading: /CONSUMER PRICE INDEX\s*[-–—]+\s*([A-Z]+)\s+(\d{4})/ },
  { slug: "empsit", name: "Employment Situation", heading: /THE EMPLOYMENT SITUATION\s*[-–—]+\s*([A-Z]+)\s+(\d{4})/ },
  { slug: "ppi", name: "Producer Price Index", heading: /PRODUCER PRICE INDEXES\s*[-–—]+\s*([A-Z]+)\s+(\d{4})/ },
];

/** The release's own words: from its heading to the Technical Note, without the tables. */
function blsNarrative(html: string, heading: RegExp): { ym: string; text: string } | null {
  const m = html.match(heading);
  if (!m || m.index === undefined) return null;
  const month = MONTHS.findIndex((name) => name.toUpperCase() === m[1]);
  if (month < 0) return null;
  const rest = html.slice(m.index + m[0].length).replace(/<table\b[\s\S]*?<\/table>/gi, "\n\n");
  const text = htmlToText(rest);
  const end = text.search(/\n\s*Technical Note\s*\n/);
  const paragraphs = (end > 0 ? text.slice(0, end) : text).split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  return { ym: `${m[2]}-${String(month + 1).padStart(2, "0")}`, text: scrub(paragraphs.join("\n\n")) };
}

async function bls(): Promise<SourceRecord[]> {
  const flat: Flat = new Map();
  const files: Array<[string, string[]]> = [
    ["cu/cu.data.0.Current", ["CUUR0000SA0", "CUSR0000SA0", "CUUR0000SA0L1E", "CUSR0000SA0L1E", "CUUR0000SAF1", "CUSR0000SAF1", "CUUR0000SA0E", "CUSR0000SA0E"]],
    ["wp/wp.data.22.FD-ID", ["WPUFD4", "WPSFD4", "WPUFD49116", "WPSFD49116"]],
    ["ce/ce.data.00a.TotalNonfarm.Employment", ["CES0000000001"]],
    ["ce/ce.data.05b.TotalPrivate.AllEmployeeHoursAndEarnings", ["CES0500000003"]],
  ];
  for (const [file, ids] of files) {
    const body = await get(`${BLS_FILES}/${file}`, { headers: HEADERS });
    if (body) parseFlat(body, new Set(ids), flat);
    else console.warn(`us-bls: ${file} not read; its numbers are left out`);
  }
  try {
    await streamLabor(new Set(["LNS11300000", "LNS12300000", "LNS13000000", "LNS14000000"]), flat);
  } catch (err) {
    if ((err as Error).name !== "AbortError") console.warn(`us-bls: labor file ${(err as Error).message.slice(0, 200)}`);
  }
  console.log(`us-bls: series read: ${[...flat.keys()].join(", ")}`);

  const records: SourceRecord[] = [];
  for (const { slug, name, heading } of BLS_RELEASES) {
    const listing = await get(`${BLS}/bls/news-release/${slug}.htm`, { headers: HEADERS });
    if (!listing) {
      console.warn(`us-bls: no release list for ${slug}`);
      continue;
    }
    const pages = [...new Set([...listing.matchAll(new RegExp(`/news\\.release/archives/${slug}_(\\d{2})(\\d{2})(\\d{4})\\.htm`, "g"))].map((m) => ({ path: m[0], date: `${m[3]}-${m[1]}-${m[2]}` })).filter((p) => inWindow(p.date)).map((p) => JSON.stringify(p)))].map((s) => JSON.parse(s) as { path: string; date: string });
    for (const page of SAMPLING ? pages.slice(0, 2) : pages) {
      if (pauseRequested()) break;
      const url = `${BLS}${page.path}`;
      const html = await get(url, { headers: HEADERS });
      const narrative = html ? blsNarrative(html, heading) : null;
      if (!narrative) {
        console.warn(`us-bls: no release text in ${url}`);
        continue;
      }
      const numbers = blsNumbers(slug, flat, narrative.ym).filter(Boolean);
      const lead = `On ${longDate(page.date)}, the US Bureau of Labor Statistics released the ${name} report for ${monthName(narrative.ym)}.`;
      const data = numbers.length ? `In BLS's published series as of ${longDate(RETRIEVED)}, which can include later revisions: ${numbers.join(" ")}` : "";
      records.push({ id: `us-bls-${slug}:${page.date}`, source: "US Bureau of Labor Statistics news releases", title: `${name}, ${monthName(narrative.ym)}, released ${longDate(page.date)}`, url, date: page.date, license: BLS_LICENSE, visibility: "public", text: [lead, data, narrative.text].filter(Boolean).join("\n\n") });
    }
  }
  return records;
}

// EIA

const EIA = "https://www.eia.gov/opendata/bulk";
const eiaCredit = `Source: U.S. Energy Information Administration (${MONTHS[Number(RETRIEVED.slice(5, 7)) - 1].slice(0, 3)} ${RETRIEVED.slice(0, 4)})`;
const EIA_LICENSE = `Public domain (US government work), US Energy Information Administration. ${eiaCredit}`;
/** EIA's own credit plus the data's owner. EIA excludes third-party material from its public-domain statement. */
const EIA_THIRD_PARTY = `Third-party data (Refinitiv, an LSEG business) published by EIA, not public domain; single dated prices only, never republished as a series. ${eiaCredit}`;

interface EiaSeries {
  /** What the price is, to follow "the" in a sentence. */
  what: string;
  /** Per what, with the currency: "$X per barrel" or "X cents per kilowatthour". */
  unit: (v: number) => string;
  group: "retail-fuel" | "spot" | "natural-gas" | "electricity";
}

const perBarrel = (v: number) => `$${v.toFixed(2)} per barrel`;
const perGallon = (v: number) => `$${v.toFixed(3)} per gallon`;
const perMmbtu = (v: number) => `$${v.toFixed(2)} per million Btu`;
const perMcf = (v: number) => `$${v.toFixed(2)} per thousand cubic feet`;
const perKwh = (v: number) => `${v.toFixed(2)} cents per kilowatthour`;

const EIA_SERIES: Record<string, EiaSeries> = {
  "PET.EMM_EPMR_PTE_NUS_DPG.W": { what: "US retail price of regular gasoline, all formulations", unit: perGallon, group: "retail-fuel" },
  "PET.EMM_EPMR_PTE_NUS_DPG.M": { what: "US retail price of regular gasoline, all formulations", unit: perGallon, group: "retail-fuel" },
  "PET.EMM_EPM0_PTE_NUS_DPG.W": { what: "US retail price of gasoline, all grades and formulations", unit: perGallon, group: "retail-fuel" },
  "PET.EMD_EPD2D_PTE_NUS_DPG.W": { what: "US retail price of No. 2 diesel", unit: perGallon, group: "retail-fuel" },
  "PET.EMD_EPD2D_PTE_NUS_DPG.M": { what: "US retail price of No. 2 diesel", unit: perGallon, group: "retail-fuel" },
  "PET.RBRTE.W": { what: "Europe Brent spot price FOB", unit: perBarrel, group: "spot" },
  "PET.RBRTE.M": { what: "Europe Brent spot price FOB", unit: perBarrel, group: "spot" },
  "PET.RWTC.W": { what: "Cushing, Oklahoma WTI spot price FOB", unit: perBarrel, group: "spot" },
  "PET.RWTC.M": { what: "Cushing, Oklahoma WTI spot price FOB", unit: perBarrel, group: "spot" },
  "NG.RNGWHHD.W": { what: "Henry Hub natural gas spot price", unit: perMmbtu, group: "spot" },
  "NG.RNGWHHD.M": { what: "Henry Hub natural gas spot price", unit: perMmbtu, group: "spot" },
  "NG.N3010US3.M": { what: "US price of natural gas delivered to residential consumers", unit: perMcf, group: "natural-gas" },
  "NG.N3020US3.M": { what: "US price of natural gas sold to commercial consumers", unit: perMcf, group: "natural-gas" },
  "NG.N3035US3.M": { what: "US industrial price of natural gas", unit: perMcf, group: "natural-gas" },
  "NG.N3045US3.M": { what: "US price of natural gas for electric power", unit: perMcf, group: "natural-gas" },
  "NG.N3050US3.M": { what: "US natural gas citygate price", unit: perMcf, group: "natural-gas" },
  "ELEC.PRICE.US-ALL.M": { what: "US average retail price of electricity, all sectors", unit: perKwh, group: "electricity" },
  "ELEC.PRICE.US-RES.M": { what: "US average retail price of electricity for residential customers", unit: perKwh, group: "electricity" },
  "ELEC.PRICE.US-COM.M": { what: "US average retail price of electricity for commercial customers", unit: perKwh, group: "electricity" },
  "ELEC.PRICE.US-IND.M": { what: "US average retail price of electricity for industrial customers", unit: perKwh, group: "electricity" },
};

const EIA_GROUPS: Record<EiaSeries["group"], { subject: string; url: string }> = {
  "retail-fuel": { subject: "US retail gasoline and diesel prices", url: "https://www.eia.gov/petroleum/gasdiesel/" },
  spot: { subject: "Weekly and monthly crude oil and natural gas spot prices", url: "https://www.eia.gov/dnav/pet/pet_pri_spt_s1_w.htm" },
  "natural-gas": { subject: "US natural gas prices by consumer", url: "https://www.eia.gov/naturalgas/" },
  electricity: { subject: "US retail electricity prices", url: "https://www.eia.gov/electricity/monthly/" },
};

/** Each line of a one-file zip, inflated as it's read so the whole file (up to several GB) never sits in memory. */
async function zipLines(url: string): Promise<AsyncIterable<string>> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.readUInt32LE(0) !== 0x04034b50 || zip.readUInt16LE(8) !== 8) throw new Error(`${url} is not a deflated zip`);
  const start = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
  const input = Readable.from([zip.subarray(start)]).pipe(createInflateRaw());
  return createInterface({ input, crlfDelay: Infinity });
}

/** The date a value belongs to. A month still under way when the window closes falls outside it; the weekly prices cover it. */
function eiaDate(period: string): { date: string; when: string; kind: "week" | "month" } | null {
  if (/^\d{8}$/.test(period)) {
    const date = `${period.slice(0, 4)}-${period.slice(4, 6)}-${period.slice(6, 8)}`;
    return { date, when: longDate(date), kind: "week" };
  }
  if (/^\d{6}$/.test(period)) {
    const y = Number(period.slice(0, 4));
    const m = Number(period.slice(4, 6));
    const date = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { date, when: monthName(`${period.slice(0, 4)}-${period.slice(4, 6)}`), kind: "month" };
  }
  return null;
}

async function eia(): Promise<SourceRecord[]> {
  const facts: Record<string, Fact[]> = {};
  const seen = new Set<string>();
  const copyrights = new Map<string, string>();
  for (const file of ["PET", "NG", "ELEC"]) {
    const prefix = `${file}.`;
    const wanted = new Set(Object.keys(EIA_SERIES).filter((id) => id.startsWith(prefix)));
    /** State residential electricity prices, a line a month for each state. */
    const stateResidential = file === "ELEC" ? /^ELEC\.PRICE\.([A-Z]{2})-RES\.M$/ : null;
    const lines = await zipLines(`${EIA}/${file}.zip`);
    let hits = 0;
    for await (const line of lines) {
      if (pauseRequested()) break;
      const id = line.slice(0, 200).match(/"series_id":"([^"]+)"/)?.[1];
      if (!id) continue;
      const state = stateResidential ? id.match(stateResidential)?.[1] : undefined;
      if (!wanted.has(id) && (!state || state === "US")) continue;
      const row = JSON.parse(line) as { series_id: string; name: string; copyright?: string; data: Array<[string, number | null]> };
      const def: EiaSeries = EIA_SERIES[id] ?? { what: `average retail price of electricity for residential customers in ${row.name.split(":")[1]?.trim() ?? state}`, unit: perKwh, group: "electricity" };
      hits++;
      const thirdParty = !!row.copyright && row.copyright !== "None";
      const key = `${def.group}|${thirdParty ? "tp" : "own"}`;
      if (row.copyright) copyrights.set(id, row.copyright);
      seen.add(id);
      for (const [period, value] of row.data) {
        if (value === null || typeof value !== "number") continue;
        const parsed = eiaDate(period);
        if (!parsed || !inWindow(parsed.date)) continue;
        /** Weekly spot prices are averages dated the Friday; weekly retail prices are a Monday survey. */
        const when = parsed.kind === "month" ? `For ${parsed.when}, the${def.group === "spot" || def.group === "retail-fuel" ? " monthly average" : ""}` : def.group === "spot" ? `For the week ending ${parsed.when}, the average` : `On ${parsed.when}, the`;
        (facts[key] ??= []).push({ date: parsed.date, text: `${when} ${def.what} was ${def.unit(value)}, according to the US Energy Information Administration.` });
      }
    }
    console.log(`us-eia: ${file}: ${hits} series matched`);
  }
  const missing = Object.keys(EIA_SERIES).filter((id) => !seen.has(id));
  if (missing.length) console.warn(`us-eia: series not found: ${missing.join(", ")}`);
  const records: SourceRecord[] = [];
  for (const [key, list] of Object.entries(facts)) {
    const [group, kind] = key.split("|") as [EiaSeries["group"], string];
    const thirdParty = kind === "tp";
    records.push(...monthly(list, { id: `us-eia-${group}${thirdParty ? "-lseg" : ""}`, source: "US Energy Information Administration", subject: EIA_GROUPS[group].subject, url: EIA_GROUPS[group].url, license: thirdParty ? EIA_THIRD_PARTY : EIA_LICENSE, visibility: thirdParty ? "private" : "public" }));
  }
  return records;
}

// BEA

const BEA = "https://www.bea.gov";
const BEA_LICENSE = "Public domain (US government work), US Bureau of Economic Analysis. Cite as: U.S. Bureau of Economic Analysis, title, news release (date), URL";
const BEA_ARCHIVE = `${BEA}/news/archive?field_related_product_target_id=All&created_1=All&title=`;
const BEA_MAX_PAGES = 12;

/** The body of a release: no tables, staff contact lines or furniture, ending at the notes after its summary. */
function beaBody(html: string): { title: string; text: string } {
  const at = html.indexOf("field--name-body");
  const article = at > 0 ? html.slice(html.indexOf(">", at) + 1) : "";
  const title = htmlToText(html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").split("|")[0].trim();
  const text = htmlToText(article.replace(/<table\b[\s\S]*?<\/table>/gi, "\n\n"));
  const end = text.search(/\n\s*(Technical Notes?|Next release|Next Release|Additional Information|Upcoming|Related Materials|Download Acrobat)\b/);
  return { title, text: scrub(end > 0 ? text.slice(0, end) : text) };
}

async function bea(): Promise<SourceRecord[]> {
  const paths = new Set<string>();
  for (let page = 0; page < (SAMPLING ? 1 : BEA_MAX_PAGES) && !pauseRequested(); page++) {
    const html = await get(`${BEA_ARCHIVE}&page=${page}`, { headers: HEADERS, gapMs: 1500 });
    const found = [...(html ?? "").matchAll(/href="(\/news\/2026\/[^"]+)"/g)].map((m) => m[1]);
    const fresh = found.filter((p) => !paths.has(p));
    fresh.forEach((p) => paths.add(p));
    if (fresh.length === 0) break;
  }
  /** The archive leaves out the newest release of each kind; these two pages list them. */
  for (const page of ["/news/current-releases", "/news/glance"]) {
    const html = await get(`${BEA}${page}`, { headers: HEADERS, gapMs: 1500 });
    for (const m of (html ?? "").matchAll(/href="(\/news\/2026\/[^"]+)"/g)) paths.add(m[1]);
  }
  const records: SourceRecord[] = [];
  for (const p of SAMPLING ? [...paths].slice(0, 3) : paths) {
    if (pauseRequested()) break;
    const url = `${BEA}${p}`;
    const html = await get(url, { headers: HEADERS, gapMs: 1500 });
    if (!html) continue;
    const stamp = html.match(/field--name-field-release-date[^>]*>\s*([\s\S]*?)<\/div>/)?.[1] ?? "";
    const named = htmlToText(stamp).match(/(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/)?.[0] ?? html.match(/EMBARGOED UNTIL[^<]*?((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})/)?.[1];
    if (!named) {
      console.warn(`us-bea: no date in ${url}`);
      continue;
    }
    const date = new Date(`${named} UTC`).toISOString().slice(0, 10);
    if (!inWindow(date)) continue;
    const { title, text } = beaBody(html);
    if (countWords(text) < 20) {
      console.warn(`us-bea: no body in ${url}`);
      continue;
    }
    records.push({ id: `us-bea:${p.split("/").pop()}`, source: "US Bureau of Economic Analysis news releases", title, url, date, license: BEA_LICENSE, visibility: "public", text: `On ${longDate(date)}, the US Bureau of Economic Analysis released "${title}".\n\n${text}` });
  }
  return records;
}

runAll([
  ["us-sec-8k", sec8k],
  ["us-sec-meta", secMeta],
  ["us-sec-raw", secRaw],
  ["us-bls", bls],
  ["us-eia", eia],
  ["us-bea", bea],
]).catch((err) => {
  console.error(err);
  process.exit(1);
});

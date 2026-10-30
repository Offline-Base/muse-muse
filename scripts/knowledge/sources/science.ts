/**
 * Collects research, health, weather and space records dated in the window for the knowledge corpus. Keyless sources
 * only. Writes .data/knowledge/sources/<step>.jsonl, or <step>-2026-MM.jsonl for the sets too big for one file (save
 * joins a file into one string, and V8 strings stop near 512 MB). Licenses follow docs/knowledge-research/science.md and
 * claim-check-2026-10-30.md; the claim check wins where they differ. Everything is cached, so a rerun carries on.
 *
 *   npx tsx scripts/knowledge/sources/science.ts [step ...]
 *   LIMIT=5 npx tsx scripts/knowledge/sources/science.ts <step>     small test: last month only, two pages at most
 *
 * The full run belongs on the AWS machine. pmc-fulltext reads the public bucket over HTTPS, one object a second, so it
 * needs about 2 weeks there; see its comment. Semantic Scholar and OpenReview need accounts, so they are not here.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { longDate } from "@/lib/knowledge/passages";
import { htmlToText, type SourceRecord } from "@/lib/knowledge/sources";
import { CACHE, FROM, get, LIMIT, pauseRequested, runAll, save, TO, USER_AGENT } from "./common";

type Visibility = SourceRecord["visibility"];
interface Span {
  key: string;
  from: string;
  to: string;
}
interface Fact {
  date: string;
  sentence: string;
}

const SMALL = Number.isFinite(LIMIT);
/** Pages to read per slice: unlimited in a full run, two in a small test. */
const PAGES = SMALL ? 2 : Infinity;
/** Page size: smaller in a small test, to go easy on the servers. */
const size = (n: number) => (SMALL ? Math.min(n, 50) : n);

const MONTHS: Span[] = Array.from({ length: 10 }, (_, i) => {
  const key = `2026-${String(i + 1).padStart(2, "0")}`;
  return { key, from: i === 0 ? FROM : `${key}-01`, to: i === 9 ? TO : new Date(Date.UTC(2026, i + 1, 0)).toISOString().slice(0, 10) };
});
const SPANS = SMALL ? MONTHS.slice(-1) : MONTHS;

const inWindow = (date: string | null | undefined): date is string => !!date && date >= FROM && date <= TO;
const compact = (date: string) => date.replaceAll("-", "");
const clean = (s: unknown) => htmlToText(String(s ?? "")).replace(/\s+/g, " ").trim();
const dot = (s: string) => (/[.!?]["')]?$/.test(s) ? s : `${s}.`);
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}...`);
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const monthName = (key: string) => longDate(`${key}-01`).replace(/ 1,/, "");
/** "NORTHWESTERN UNIVERSITY" as "Northwestern University"; mixed-case names stay as they are. */
const nameCase = (s: string) => (/\p{Ll}/u.test(s) ? s : s.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()));
const names = (list: string[], max = 10) => (list.length > max ? `${list.slice(0, max).join(", ")} and ${list.length - max} others` : list.join(", "));
/** A date such as "Oct 29, 2026" as YYYY-MM-DD, or null. */
function isoDate(s: string): string | null {
  const t = Date.parse(`${s} UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
const dayOf = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

async function getJson<T>(url: string, opts?: { gapMs?: number; headers?: Record<string, string> }): Promise<T | null> {
  const body = await get(url, opts);
  return body ? (JSON.parse(body) as T) : null;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
/** Drops a cached page, so an error the server sent with a 200 doesn't stick. */
const forget = (url: string) => rm(path.join(CACHE, hash(url)), { force: true });

let lastRaw = 0;
/** For what `get` can't do (POST bodies and binary files): the same cache, one request a second, the same retries. */
async function fetchBytes(url: string, init: RequestInit = {}): Promise<Buffer | null> {
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, hash(`${init.method ?? "GET"} ${url} ${String(init.body ?? "")}`));
  if (existsSync(file)) return readFile(file);
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastRaw + 1000 - Date.now();
    lastRaw = Date.now() + Math.max(wait, 0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...init.headers }, signal: AbortSignal.timeout(300_000) });
    } catch {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if (res.ok) {
      const body = Buffer.from(await res.arrayBuffer());
      await writeFile(file, body);
      return body;
    }
    if (res.status !== 429 && res.status < 500) {
      console.warn(`${res.status} ${url}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)));
  }
  console.warn(`gave up on ${url}`);
  return null;
}

/** Source titles and text can hold em dashes. They become commas, as htmlToText already does for the entity. */
const noEmDash = (r: SourceRecord): SourceRecord => ({ ...r, title: r.title.replace(/\s*\u2014\s*/g, ", "), text: r.text.replace(/\s*\u2014\s*/g, ", ") });
const write = (name: string, records: SourceRecord[]) => save(name, records.map(noEmDash));

/** Small facts as documents by month, cut every `perDoc` sentences. A document's date is its last fact's date. */
function monthly(name: string, source: string, url: string, license: string, visibility: Visibility, facts: Fact[], perDoc = 200): SourceRecord[] {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    if (!inWindow(f.date)) continue;
    const key = f.date.slice(0, 7);
    const group = groups.get(key);
    if (group) group.push(f);
    else groups.set(key, [f]);
  }
  const records: SourceRecord[] = [];
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!.sort((a, b) => a.date.localeCompare(b.date));
    const parts = Math.ceil(list.length / perDoc);
    for (let i = 0; i < parts; i++) {
      const chunk = list.slice(i * perDoc, (i + 1) * perDoc);
      records.push({ id: `${name}:${key}:${i}`, source, title: `${source}, ${monthName(key)}${parts > 1 ? `, part ${i + 1} of ${parts}` : ""}`, url, date: chunk[chunk.length - 1].date, license, visibility, text: chunk.map((f) => f.sentence).join("\n\n") });
    }
  }
  return records;
}

/** Writes one file per month for the sets too big for one; the step's own file stays empty. */
async function byMonth(name: string, collect: (span: Span) => Promise<SourceRecord[]>): Promise<SourceRecord[]> {
  let total = 0;
  for (const span of SPANS) {
    if (pauseRequested() || total >= LIMIT) break;
    const records = await collect(span);
    total += records.length;
    await write(`${name}-${span.key}`, records);
  }
  return [];
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

// ---- Papers ----

/** arXiv metadata and abstracts are CC0 whatever the paper's own license, which each record keeps. Harvested by datestamp (last update). arXivRaw lists every version's date, so a paper counts if its v1 is in the window; the plain arXiv format's `created` isn't always v1. */
async function arxivMonth(span: Span): Promise<SourceRecord[]> {
  const until = span.to === TO ? new Date().toISOString().slice(0, 10) : span.to;
  const base = "https://oaipmh.arxiv.org/oai?verb=ListRecords";
  let url = `${base}&metadataPrefix=arXivRaw&from=${span.from}&until=${until}`;
  const records: SourceRecord[] = [];
  for (let page = 0; page < PAGES && !pauseRequested(); page++) {
    const xml = await get(url, { gapMs: 3100 });
    if (!xml) throw new Error(`no response for ${url}`);
    const error = xml.match(/<error code="([^"]+)"/)?.[1];
    if (error === "noRecordsMatch") break;
    if (error) {
      await forget(url);
      throw new Error(`OAI error ${error} for ${url}`);
    }
    for (const rec of xml.split("<record>").slice(1)) {
      const tag = (t: string) => rec.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? "";
      const v1 = rec.match(/<version version="v1">\s*<date>([^<]+)</)?.[1];
      const created = v1 ? new Date(v1).toISOString().slice(0, 10) : null;
      if (!inWindow(created)) continue;
      const id = tag("id");
      const authors = cut(clean(tag("authors")), 400);
      const title = clean(tag("title"));
      const paperLicense = clean(tag("license")) || "not stated";
      const doi = clean(tag("doi"));
      const facts = [`Posted to arXiv on ${longDate(created)} as ${id} in ${clean(tag("categories")).replaceAll(" ", ", ")}`, authors ? `Authors: ${authors}` : "", doi ? `DOI: ${doi}` : ""].filter(Boolean).map(dot).join(" ");
      records.push({ id: `arxiv:${id}`, source: "arXiv", title, url: `https://arxiv.org/abs/${id}`, date: created, license: `arXiv metadata and abstract CC0 1.0; the paper itself: ${paperLicense}`, visibility: "public", text: `${dot(title)}\n\n${facts}\n\n${clean(tag("abstract"))}` });
    }
    const token = xml.match(/<resumptionToken[^>]*>([^<]+)</)?.[1];
    if (!token) break;
    url = `${base}&resumptionToken=${token}`;
  }
  return records;
}

/** Notices only; abstracts stay out. Publisher-deposited links name the retracted paper. Links that Crossref copied from Retraction Watch are left out, since that data stays private until its license is confirmed. */
async function crossrefRetractions(): Promise<SourceRecord[]> {
  interface Work {
    DOI: string;
    title?: string[];
    publisher?: string;
    "container-title"?: string[];
    issued?: { "date-parts": number[][] };
    created?: { "date-time": string };
    "update-to"?: Array<{ DOI: string; type: string; source?: string; updated?: { "date-time": string } }>;
  }
  const facts: Fact[] = [];
  let cursor = "*";
  for (let page = 0; page < PAGES && !pauseRequested(); page++) {
    const body = await getJson<{ message: { items: Work[]; "next-cursor"?: string } }>(`https://api.crossref.org/works?filter=update-type:retraction,from-issued-date:${FROM},until-issued-date:${TO}&rows=${size(1000)}&select=DOI,title,publisher,container-title,issued,created,update-to&cursor=${encodeURIComponent(cursor)}`);
    const items = body?.message.items ?? [];
    if (items.length === 0) break;
    for (const w of items) {
      const notices = (w["update-to"] ?? []).filter((u) => u.type === "retraction");
      const own = notices.filter((u) => u.source !== "retraction-watch");
      const title = clean(w.title?.[0]);
      if (own.length === 0 && !/retract/i.test(title)) continue;
      const parts = w.issued?.["date-parts"]?.[0] ?? [];
      const issued = parts.length === 3 ? `${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}` : null;
      const date = [own[0]?.updated?.["date-time"]?.slice(0, 10), issued, w.created?.["date-time"]?.slice(0, 10)].find(inWindow);
      if (!date) continue;
      const where = clean(w["container-title"]?.[0]);
      facts.push({ date, sentence: dot(`On ${longDate(date)}, ${clean(w.publisher) || "a publisher"} published a retraction notice${where ? ` in ${where}` : ""}: "${title}" (DOI ${w.DOI})${own[0] ? `, retracting the article with DOI ${own[0].DOI}` : ""}`) });
    }
    if (!body?.message["next-cursor"] || items.length < size(1000)) break;
    cursor = body.message["next-cursor"];
  }
  return monthly("crossref-retractions", "Crossref retraction notices", "https://api.crossref.org", "Crossref metadata, no known restrictions; credit Crossref", "public", facts);
}

const NLM_CREDIT = "Courtesy of the U.S. National Library of Medicine; NLM does not endorse this product; may not reflect the most current data from NLM";
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

/** PMIDs added on one day, splitting by PMID range when a day passes esearch's 9,999 cap. */
async function pubmedIds(day: string, low = 1, high = 99_999_999): Promise<string[]> {
  const term = `"${day.replaceAll("-", "/")}"[edat]${low > 1 || high < 99_999_999 ? ` AND ${low}:${high}[uid]` : ""}`;
  const body = await getJson<{ esearchresult: { count: string; idlist: string[] } }>(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=9999&tool=MuseMuse-knowledge&term=${encodeURIComponent(term)}`);
  if (!body) throw new Error(`esearch failed for ${day}`);
  if (Number(body.esearchresult.count) <= 9999 || low >= high) return body.esearchresult.idlist;
  const mid = Math.floor((low + high) / 2);
  return [...(await pubmedIds(day, low, mid)), ...(await pubmedIds(day, mid + 1, high))];
}

/** E-utilities rather than the baseline files, whose gzip `get` can't read. Each month writes two sets: metadata and MeSH (public, NLM credit) and abstracts (private). */
async function pubmed(): Promise<SourceRecord[]> {
  let total = 0;
  for (const span of SPANS) {
    if (pauseRequested() || total >= LIMIT) break;
    const facts: Fact[] = [];
    const abstracts: SourceRecord[] = [];
    const days: string[] = [];
    for (let d = new Date(`${span.to}T00:00:00Z`); d >= new Date(`${span.from}T00:00:00Z`); d = new Date(d.getTime() - 86_400_000)) days.push(d.toISOString().slice(0, 10));
    for (const day of SMALL ? days.slice(0, 1) : days.reverse()) {
      if (pauseRequested()) break;
      const ids = await pubmedIds(day);
      const batch = size(200);
      for (let i = 0; i < ids.length && !pauseRequested(); i += batch) {
        if (SMALL && i > 0) break;
        const xml = await get(`${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&tool=MuseMuse-knowledge&id=${ids.slice(i, i + batch).join(",")}`);
        if (!xml) throw new Error(`efetch failed for ${day}`);
        for (const art of xml.split("<PubmedArticle>").slice(1)) {
          const pmid = art.match(/<PMID[^>]*>(\d+)</)?.[1];
          if (!pmid) continue;
          const title = clean(art.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1]);
          const journal = clean(art.match(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/)?.[1]);
          const pubDate = clean((art.match(/<PubDate>([\s\S]*?)<\/PubDate>/)?.[1] ?? "").replace(/<\/[^>]+>/g, " "));
          const authors = [...art.matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/g)].map((a) => clean(`${a[1].match(/<ForeName>([^<]*)/)?.[1] ?? ""} ${a[1].match(/<LastName>([^<]*)/)?.[1] ?? ""}`) || clean(a[1].match(/<CollectiveName>([\s\S]*?)<\/CollectiveName>/)?.[1])).filter(Boolean);
          const mesh = [...art.matchAll(/<DescriptorName[^>]*>([\s\S]*?)<\/DescriptorName>/g)].map((m) => clean(m[1]));
          facts.push({ date: day, sentence: dot(`Added to PubMed on ${longDate(day)} as PMID ${pmid}: "${title.replace(/\.$/, "")}"${authors.length ? `, by ${names(authors, 3)}` : ""}${journal ? `, in ${journal}` : ""}${pubDate ? ` (${pubDate})` : ""}${mesh.length ? `. MeSH terms: ${mesh.join("; ")}` : ""}`) });
          const abstract = [...art.matchAll(/<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map((a) => {
            const label = a[1].match(/Label="([^"]+)"/)?.[1];
            return `${label ? `${clean(label)}: ` : ""}${clean(a[2])}`;
          });
          if (abstract.length) abstracts.push({ id: `pubmed-abstract:${pmid}`, source: "PubMed abstract", title, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`, date: day, license: `Copyright stays with the publishers, training only. ${NLM_CREDIT}`, visibility: "private", text: `${dot(title)}\n\n${abstract.join("\n\n")}` });
        }
      }
    }
    const meta = monthly("pubmed-metadata", "PubMed metadata and MeSH", "https://pubmed.ncbi.nlm.nih.gov/", NLM_CREDIT, "public", facts);
    total += meta.length;
    await write(`pubmed-metadata-${span.key}`, meta);
    await write(`pubmed-abstracts-${span.key}`, abstracts);
  }
  return [];
}

/** Abstract-level records. Full text comes through pmc-fulltext, which these overlap. */
async function europePmcMonth(span: Span): Promise<SourceRecord[]> {
  interface Hit {
    id: string;
    source: string;
    title?: string;
    authorString?: string;
    doi?: string;
    license?: string;
    abstractText?: string;
    firstPublicationDate?: string;
    journalInfo?: { journal?: { title?: string } };
  }
  const query = encodeURIComponent(`FIRST_PDATE:[${span.from} TO ${span.to}] AND OPEN_ACCESS:y AND (LICENSE:"cc by" OR LICENSE:"cc0")`);
  const records: SourceRecord[] = [];
  let cursor = "*";
  for (let page = 0; page < PAGES && !pauseRequested(); page++) {
    const body = await getJson<{ nextCursorMark?: string; resultList: { result: Hit[] } }>(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${query}&resultType=core&format=json&pageSize=${size(1000)}&cursorMark=${encodeURIComponent(cursor)}`);
    if (!body) throw new Error(`Europe PMC failed for ${span.key}`);
    const hits = body.resultList.result;
    if (hits.length === 0) break;
    for (const h of hits) {
      const license = (h.license ?? "").toLowerCase();
      if ((license !== "cc by" && license !== "cc0") || !inWindow(h.firstPublicationDate) || !h.abstractText) continue;
      const title = clean(h.title);
      const journal = clean(h.journalInfo?.journal?.title);
      const facts = [`First published on ${longDate(h.firstPublicationDate)}${journal ? ` in ${journal}` : ""}`, h.authorString ? `Authors: ${cut(clean(h.authorString), 300)}` : "", h.doi ? `DOI: ${h.doi}` : ""].filter(Boolean).map(dot).join(" ");
      records.push({ id: `europepmc:${h.source}:${h.id}`, source: "Europe PMC", title, url: `https://europepmc.org/article/${h.source}/${h.id}`, date: h.firstPublicationDate, license: `${license === "cc0" ? "CC0" : "CC BY"} per Europe PMC; credit the authors and journal`, visibility: "public", text: `${dot(title)}\n\n${facts}\n\n${htmlToText(h.abstractText)}` });
    }
    if (!body.nextCursorMark || body.nextCursorMark === cursor) break;
    cursor = body.nextCursorMark;
  }
  return records;
}

/** Only cc_by and cc0 are public; other licenses stay private. A paper's latest version in the window supplies the text. */
async function preprints(server: "biorxiv" | "medrxiv", source: string): Promise<SourceRecord[]> {
  interface Paper {
    doi: string;
    title: string;
    authors: string;
    date: string;
    version: string;
    license: string;
    category: string;
    abstract: string;
  }
  const papers = new Map<string, Paper & { first: string }>();
  let cursor = 0;
  for (let page = 0; page < PAGES && !pauseRequested(); page++) {
    const body = await getJson<{ messages: Array<{ count?: number; total?: string | number }>; collection: Paper[] }>(`https://api.biorxiv.org/details/${server}/${FROM}/${TO}/${cursor}/json`);
    if (!body) throw new Error(`${server} API failed at cursor ${cursor}`);
    if (body.collection.length === 0) break;
    for (const p of body.collection) {
      if (!inWindow(p.date)) continue;
      const seen = papers.get(p.doi);
      const first = seen && seen.first < p.date ? seen.first : p.date;
      papers.set(p.doi, !seen || Number(p.version) >= Number(seen.version) ? { ...p, first } : { ...seen, first });
    }
    cursor += body.collection.length;
    if (cursor >= Number(body.messages[0]?.total ?? 0)) break;
  }
  return [...papers.values()].map((p) => {
    const open = p.license === "cc_by" || p.license === "cc0";
    const title = clean(p.title);
    const abstract = clean(p.abstract).replace(/\{([A-Za-z]+)\}/g, "$1");
    const posted = p.version === "1" ? `Posted to ${source} on ${longDate(p.first)}` : `Version ${p.version} posted to ${source} on ${longDate(p.date)}`;
    return { id: `${server}:${p.doi}`, source, title, url: `https://doi.org/${p.doi}`, date: p.first, license: open ? `${p.license === "cc0" ? "CC0" : "CC BY"} (${source} license field ${p.license}); credit the authors` : `${source} license field ${p.license || "none"}, training only`, visibility: open ? "public" : "private", text: `${dot(title)}\n\n${dot(posted)} Category: ${clean(p.category)}. Authors: ${cut(clean(p.authors), 300)}\n\n${abstract}` } satisfies SourceRecord;
  });
}

/** Papers in the Anthology's 2026 XML. A volume's date is its ingest date, since the XML gives only a month for the event. */
async function aclAnthology(): Promise<SourceRecord[]> {
  const api = "https://api.github.com/repos/acl-org/acl-anthology/git/trees";
  const child = async (sha: string, name: string) => {
    const body = await getJson<{ tree: Array<{ path: string; sha: string }> }>(`${api}/${sha}`);
    return body?.tree.find((t) => t.path === name)?.sha ?? null;
  };
  const data = await child("master", "data");
  const xmlDir = data && (await child(data, "xml"));
  const listing = xmlDir ? await getJson<{ tree: Array<{ path: string }> }>(`${api}/${xmlDir}`) : null;
  if (!listing) throw new Error("could not list the Anthology's XML files");
  const files = listing.tree.map((t) => t.path).filter((p) => /^2026\..+\.xml$/.test(p));
  const records: SourceRecord[] = [];
  for (const file of SMALL ? files.filter((f) => f === "2026.eacl.xml") : files) {
    if (pauseRequested()) break;
    const xml = await get(`https://raw.githubusercontent.com/acl-org/acl-anthology/master/data/xml/${file}`);
    if (!xml) continue;
    const collection = file.replace(/\.xml$/, "");
    for (const vol of xml.split(/<volume\b/).slice(1)) {
      const volId = vol.match(/\bid="([^"]+)"/)?.[1];
      const date = vol.match(/ingest-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
      if (!volId || !inWindow(date)) continue;
      const meta = vol.match(/<meta>([\s\S]*?)<\/meta>/)?.[1] ?? "";
      const book = clean(meta.match(/<booktitle>([\s\S]*?)<\/booktitle>/)?.[1]);
      const place = clean(meta.match(/<address>([\s\S]*?)<\/address>/)?.[1]);
      const when = clean(`${meta.match(/<month>([^<]*)/)?.[1] ?? ""} ${meta.match(/<year>([^<]*)/)?.[1] ?? ""}`);
      for (const paper of vol.matchAll(/<paper id="([^"]+)">([\s\S]*?)<\/paper>/g)) {
        const body = paper[2];
        const title = clean(body.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
        const authors = [...body.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)].map((a) => clean(`${a[1].match(/<first>([^<]*)/)?.[1] ?? ""} ${a[1].match(/<last>([^<]*)/)?.[1] ?? ""}`));
        const abstract = clean(body.match(/<abstract>([\s\S]*?)<\/abstract>/)?.[1]);
        const id = `${collection}-${volId}.${paper[1]}`;
        records.push({ id: `acl:${id}`, source: "ACL Anthology", title, url: `https://aclanthology.org/${id}/`, date, license: "CC BY 4.0; credit the authors and the ACL Anthology", visibility: "public", text: `${dot(title)}\n\nPublished in ${book}${place ? `, ${place}` : ""}${when ? `, ${when}` : ""}. Added to the ACL Anthology on ${longDate(date)}. Authors: ${names(authors)}.${abstract ? `\n\n${abstract}` : ""}` });
      }
    }
  }
  return records;
}

/** DOAJ caps a query at 1,000 results, so a range over the cap splits in two until it fits. Metadata including abstracts is CC0. */
async function doajMonth(span: Span): Promise<SourceRecord[]> {
  interface Doaj {
    id: string;
    created_date: string;
    bibjson: { title?: string; abstract?: string; author?: Array<{ name?: string }>; journal?: { title?: string; publisher?: string }; identifier?: Array<{ type?: string; id?: string }> };
  }
  const records: SourceRecord[] = [];
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const read = async (from: number, to: number): Promise<void> => {
    if (pauseRequested() || records.length >= LIMIT) return;
    const q = encodeURIComponent(`bibjson.year:2026 AND created_date:[${iso(from)} TO ${iso(to)}]`);
    const url = (page: number) => `https://doaj.org/api/search/articles/${q}?page=${page}&pageSize=100`;
    const first = await getJson<{ total: number; results: Doaj[] }>(url(1));
    if (!first) throw new Error(`DOAJ API gave no data for ${iso(from)}`);
    if (first.total > 1000 && to - from > 1000) {
      const mid = Math.floor((from + to) / 2);
      await read(from, mid);
      await read(mid + 1000, to);
      return;
    }
    const pages = Math.min(10, PAGES, Math.ceil(first.total / 100));
    for (let page = 1; page <= pages && !pauseRequested(); page++) {
      const body = page === 1 ? first : await getJson<{ results: Doaj[] }>(url(page));
      for (const a of body?.results ?? []) {
        const date = a.created_date.slice(0, 10);
        if (!inWindow(date)) continue;
        const b = a.bibjson;
        const title = clean(b.title);
        const doi = b.identifier?.find((i) => i.type?.toLowerCase() === "doi")?.id;
        const authors = (b.author ?? []).map((x) => clean(x.name)).filter(Boolean);
        const facts = [`Added to the Directory of Open Access Journals on ${longDate(date)}`, b.journal?.title ? `Journal: ${clean(b.journal.title)}` : "", authors.length ? `Authors: ${names(authors)}` : "", doi ? `DOI: ${doi}` : ""].filter(Boolean).map(dot).join(" ");
        records.push({ id: `doaj:${a.id}`, source: "DOAJ", title, url: `https://doaj.org/article/${a.id}`, date, license: "DOAJ metadata CC0", visibility: "public", text: `${dot(title)}\n\n${facts}${b.abstract ? `\n\n${clean(b.abstract)}` : ""}` });
      }
    }
  };
  await read(Date.parse(`${span.from}T00:00:00Z`), Date.parse(`${span.to}T23:59:59Z`));
  return records;
}

/**
 * Full text from the public PMC bucket over HTTPS, keyless. Each article version's metadata JSON says what we may do:
 * CC BY, BY-SA and CC0 are public; NC, ND, manuscripts ("TDM") and a null code are private; retracted versions are
 * skipped. One object a second means about 2 weeks for 1M metadata files plus 700k texts, so run this on the AWS machine,
 * or point it at an S3 sync there. Only IDs from PMC12700000 (December 2025) up can be new. The citation gives the date;
 * citations with only a year are skipped and counted, since they can't be placed in the window.
 */
const pmcBody = (text: string) => text.replace(/^[\s\S]*?ARTICLE INFORMATION\s*=+\s*/, "").replace(/\n=+\n/g, "\n");

async function pmcFulltext(): Promise<SourceRecord[]> {
  interface PmcMeta {
    pmcid: string;
    version: number;
    title?: string;
    citation?: string;
    doi?: string;
    is_pmc_openaccess?: boolean;
    is_retracted?: boolean;
    license_code?: string | null;
    text_url?: string;
  }
  const BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com";
  let after = SMALL ? "metadata/PMC13700000" : "metadata/PMC12700000";
  let batch: SourceRecord[] = [];
  let shard = 0;
  let kept = 0;
  let seen = 0;
  let yearOnly = 0;
  const flush = async () => {
    await write(`pmc-fulltext-${String(shard++).padStart(4, "0")}`, batch);
    batch = [];
  };
  for (let page = 0; page < PAGES && !pauseRequested() && kept < LIMIT; page++) {
    const list = await get(`${BUCKET}/?list-type=2&max-keys=${size(1000)}&prefix=metadata/PMC&start-after=${after}`);
    if (!list) throw new Error("could not list the PMC bucket");
    const keys = [...list.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    if (keys.length === 0) break;
    for (const key of keys) {
      if (pauseRequested() || kept >= LIMIT || (SMALL && seen >= 12)) break;
      if (Number(key.match(/PMC(\d+)\./)?.[1]) < 12_700_000) continue;
      seen++;
      const meta = await getJson<PmcMeta>(`${BUCKET}/${key}`);
      if (!meta || meta.is_retracted || !meta.text_url) continue;
      const full = meta.citation?.match(/\b(20\d\d) ([A-Z][a-z]{2})(?: (\d{1,2}))?/);
      if (!full) {
        if (meta.citation?.includes("2026")) yearOnly++;
        continue;
      }
      const date = isoDate(`${full[2]} ${full[3] ?? "1"}, ${full[1]}`);
      if (!inWindow(date)) continue;
      const text = await get(meta.text_url.replace("s3://pmc-oa-opendata", BUCKET).replace(/\?.*$/, ""));
      if (!text) continue;
      const code = meta.license_code ?? null;
      const open = meta.is_pmc_openaccess === true && code !== null && /^CC[ _-]?(BY|BY[ _-]SA|0)([ _-]?\d(\.\d)?)?$/i.test(code);
      batch.push({ id: `pmc:${meta.pmcid}.${meta.version}`, source: "PubMed Central", title: clean(meta.title), url: `https://pmc.ncbi.nlm.nih.gov/articles/${meta.pmcid}/`, date, license: open ? `${code}; credit the authors and journal. ${NLM_CREDIT}` : `PMC license code ${code ?? "unknown"}, training only. ${NLM_CREDIT}`, visibility: open ? "public" : "private", text: `${meta.citation}\n\n${pmcBody(text)}` });
      kept++;
      if (batch.length >= 2000) await flush();
    }
    after = keys[keys.length - 1];
    if (after > "metadata/PMC14" || (SMALL && seen >= 12)) break;
  }
  if (batch.length) await flush();
  if (yearOnly) console.log(`pmc-fulltext: ${yearOnly} citations gave only the year 2026 and were skipped`);
  return [];
}

// ---- Health and medicine ----

async function clinicalTrials(): Promise<SourceRecord[]> {
  interface Study {
    protocolSection: {
      identificationModule: { nctId: string; briefTitle?: string };
      statusModule: { overallStatus?: string; studyFirstPostDateStruct?: { date?: string }; resultsFirstPostDateStruct?: { date?: string } };
      sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
      conditionsModule?: { conditions?: string[] };
      armsInterventionsModule?: { interventions?: Array<{ name?: string }> };
      designModule?: { studyType?: string; phases?: string[]; enrollmentInfo?: { count?: number } };
      descriptionModule?: { briefSummary?: string };
    };
  }
  const fields = "NCTId,BriefTitle,OverallStatus,StudyFirstPostDate,ResultsFirstPostDate,LeadSponsorName,Condition,InterventionName,StudyType,Phase,EnrollmentCount,BriefSummary";
  const studies = new Map<string, Study>();
  for (const field of ["StudyFirstPostDate", "ResultsFirstPostDate"]) {
    let token = "";
    for (let page = 0; page < PAGES && !pauseRequested(); page++) {
      const body = await getJson<{ studies: Study[]; nextPageToken?: string }>(`https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(`AREA[${field}]RANGE[${FROM},${TO}]`)}&fields=${fields}&pageSize=${size(1000)}${token ? `&pageToken=${token}` : ""}`);
      if (!body) throw new Error(`ClinicalTrials.gov failed on ${field}`);
      for (const s of body.studies) studies.set(s.protocolSection.identificationModule.nctId, s);
      if (!body.nextPageToken) break;
      token = body.nextPageToken;
    }
  }
  const records: SourceRecord[] = [];
  for (const [nct, { protocolSection: p }] of studies) {
    const posted = p.statusModule.studyFirstPostDateStruct?.date;
    const results = p.statusModule.resultsFirstPostDateStruct?.date;
    const date = [posted, results].find(inWindow);
    if (!date) continue;
    const title = clean(p.identificationModule.briefTitle);
    const interventions = (p.armsInterventionsModule?.interventions ?? []).map((i) => clean(i.name)).filter(Boolean);
    const phases = (p.designModule?.phases ?? []).filter((x) => x !== "NA");
    const sentences = [
      inWindow(posted) ? `Study ${nct} was first posted on ClinicalTrials.gov on ${longDate(posted)}` : "",
      inWindow(results) ? `Results for study ${nct} were first posted on ${longDate(results)}` : "",
      p.sponsorCollaboratorsModule?.leadSponsor?.name ? `The lead sponsor is ${clean(p.sponsorCollaboratorsModule.leadSponsor.name)}` : "",
      p.designModule?.studyType ? `It is ${/^[aeiou]/i.test(p.designModule.studyType) ? "an" : "a"} ${p.designModule.studyType.toLowerCase().replaceAll("_", " ")} study${phases.length ? `, ${phases.join(" and ").toLowerCase().replace(/phase(\d)/g, "phase $1")}` : ""}${p.designModule.enrollmentInfo?.count ? `, with enrollment of ${p.designModule.enrollmentInfo.count}` : ""}` : "",
      p.conditionsModule?.conditions?.length ? `Conditions: ${names(p.conditionsModule.conditions.map(clean))}` : "",
      interventions.length ? `Interventions: ${names(interventions)}` : "",
      p.statusModule.overallStatus ? `Status: ${p.statusModule.overallStatus.toLowerCase().replaceAll("_", " ")}` : "",
    ].filter(Boolean).map(dot).join(" ");
    records.push({ id: `clinicaltrials:${nct}`, source: "ClinicalTrials.gov", title, url: `https://clinicaltrials.gov/study/${nct}`, date, license: "U.S. government database, publishable; credit ClinicalTrials.gov, U.S. National Library of Medicine; no endorsement implied", visibility: "public", text: `${dot(title)}\n\n${sentences}${p.descriptionModule?.briefSummary ? `\n\n${clean(p.descriptionModule.briefSummary)}` : ""}` });
  }
  return records;
}

/** Approvals and recalls. Only the fields named here are read: no `openfda` block and no UDI records, so no GMDN terms. */
async function openFda(): Promise<SourceRecord[]> {
  interface Enforcement {
    report_date?: string;
    classification?: string;
    product_description?: string;
    recalling_firm?: string;
    city?: string;
    state?: string;
    country?: string;
    reason_for_recall?: string;
    status?: string;
    recall_number?: string;
    product_type?: string;
  }
  interface DrugApp {
    application_number?: string;
    sponsor_name?: string;
    products?: Array<{ brand_name?: string; active_ingredients?: Array<{ name?: string }> }>;
    submissions?: Array<{ submission_type?: string; submission_number?: string; submission_status?: string; submission_status_date?: string }>;
  }
  interface Device {
    k_number?: string;
    pma_number?: string;
    supplement_number?: string;
    applicant?: string;
    device_name?: string;
    trade_name?: string;
    generic_name?: string;
    decision_date?: string;
    decision_description?: string;
  }
  const facts: Fact[] = [];
  const read = async <T>(endpoint: string, field: string, span: Span, each: (r: T) => void) => {
    for (let page = 0, skip = 0; page < PAGES && skip < 25_000 && !pauseRequested(); page++) {
      const limit = size(1000);
      const body = await getJson<{ results: T[] }>(`https://api.fda.gov/${endpoint}.json?search=${field}:[${compact(span.from)}+TO+${compact(span.to)}]&limit=${limit}&skip=${skip}`);
      for (const r of body?.results ?? []) each(r);
      if (!body || body.results.length < limit) break;
      skip += limit;
    }
  };
  for (const span of SPANS) {
    for (const endpoint of ["drug/enforcement", "device/enforcement", "food/enforcement"]) {
      await read<Enforcement>(endpoint, "report_date", span, (r) => {
        if (!r.report_date) return;
        const date = dayOf(r.report_date);
        facts.push({ date, sentence: dot(`On ${longDate(date)}, an FDA enforcement report listed a ${r.classification ?? "recall"} ${(r.product_type ?? "product").toLowerCase()} recall by ${clean(r.recalling_firm)} (${[r.city, r.state || r.country].filter(Boolean).join(", ")}): ${cut(clean(r.product_description), 300).replace(/\.$/, "")}. Reason: ${cut(clean(r.reason_for_recall), 300).replace(/\.$/, "")}. Status: ${(r.status ?? "unknown").toLowerCase()}. Recall number ${r.recall_number}`) });
      });
    }
    await read<DrugApp>("drug/drugsfda", "submissions.submission_status_date", span, (r) => {
      const brands = [...new Set((r.products ?? []).map((p) => clean(p.brand_name)).filter(Boolean))];
      const ingredients = [...new Set((r.products ?? []).flatMap((p) => p.active_ingredients ?? []).map((i) => nameCase(clean(i.name))).filter(Boolean))];
      for (const s of r.submissions ?? []) {
        if (s.submission_status !== "AP" || !s.submission_status_date) continue;
        const date = dayOf(s.submission_status_date);
        if (date < span.from || date > span.to) continue;
        const kind = s.submission_type === "ORIG" ? "the original application" : `${s.submission_type === "SUPPL" ? "supplement" : (s.submission_type ?? "submission").toLowerCase()} ${s.submission_number ?? ""}`.trim();
        facts.push({ date, sentence: dot(`On ${longDate(date)}, FDA approved ${kind} of ${r.application_number} for ${brands.join(", ") || "a drug product"}${ingredients.length ? ` (${names(ingredients, 5)})` : ""}${r.sponsor_name ? `, from ${nameCase(clean(r.sponsor_name))}` : ""}`) });
      }
    });
    await read<Device>("device/510k", "decision_date", span, (r) => {
      if (!r.decision_date) return;
      facts.push({ date: r.decision_date, sentence: dot(`On ${longDate(r.decision_date)}, FDA issued a 510(k) decision (${clean(r.decision_description).toLowerCase() || "no description"}) on ${r.k_number}, ${nameCase(clean(r.device_name))}, from ${nameCase(clean(r.applicant))}`) });
    });
    await read<Device>("device/pma", "decision_date", span, (r) => {
      if (!r.decision_date) return;
      facts.push({ date: r.decision_date, sentence: dot(`On ${longDate(r.decision_date)}, FDA issued a premarket approval decision on ${r.pma_number}${r.supplement_number ? ` supplement ${r.supplement_number}` : ""}, ${nameCase(clean(r.trade_name || r.generic_name))}, from ${nameCase(clean(r.applicant))}`) });
    });
  }
  return monthly("openfda", "openFDA approvals and recalls", "https://open.fda.gov/", "CC0 per openFDA (GMDN device terms excluded); data is unvalidated; no FDA endorsement implied", "public", facts);
}

/** Which labels were published when, from the listing. The labels' full text is 34k files of mostly repeated boilerplate, so it stays out. */
async function dailyMed(): Promise<SourceRecord[]> {
  interface Spl {
    setid: string;
    title: string;
    spl_version: number;
    published_date: string;
  }
  const facts: Fact[] = [];
  for (let page = 1; page <= PAGES && !pauseRequested(); page++) {
    const body = await getJson<{ data: Spl[]; metadata: { total_pages: number } }>(`https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?published_date=${FROM}&published_date_comparison=gte&pagesize=${size(100)}&page=${page}`);
    if (!body) throw new Error(`DailyMed failed on page ${page}`);
    for (const s of body.data) {
      const date = isoDate(s.published_date);
      if (date) facts.push({ date, sentence: dot(`On ${longDate(date)}, DailyMed published version ${s.spl_version} of the drug label for ${clean(s.title)}`) });
    }
    if (page >= body.metadata.total_pages) break;
  }
  return monthly("dailymed", "DailyMed drug labels", "https://dailymed.nlm.nih.gov/", "Public domain; courtesy of the U.S. National Library of Medicine", "public", facts);
}

async function mmwr(): Promise<SourceRecord[]> {
  const urls = new Set<string>();
  for (const index of ["index2026.html", "indrr_2026.html", "indss_2026.html"]) {
    const html = await get(`https://www.cdc.gov/mmwr/${index}`);
    for (const m of (html ?? "").matchAll(/\/mmwr\/volumes\/75\/(wr|rr|ss)\/((?:mm|rr|ss)\d+a\d+)\.htm/g)) urls.add(`https://www.cdc.gov/mmwr/volumes/75/${m[1]}/${m[2]}.htm`);
  }
  const records: SourceRecord[] = [];
  for (const url of [...urls].sort().reverse().slice(0, SMALL ? 5 : undefined)) {
    if (pauseRequested()) break;
    const html = await get(url);
    if (!html) continue;
    const date = html.match(/<meta name="DC\.date" content="(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!inWindow(date)) continue;
    const start = html.indexOf('class="syndicate"');
    const end = html.indexOf("Suggested citation", start);
    const body = html.slice(html.indexOf(">", start) + 1, end > start ? end : undefined).replace(/<h[1-6][^>]*>\s*(<[^>]+>\s*)*References[\s\S]*$/i, "");
    const title = clean(html.match(/<meta name="citation_title" content="([^"]*)"/)?.[1]);
    records.push({ id: `mmwr:${url.split("/").pop()!.replace(".htm", "")}`, source: "CDC MMWR", title, url, date, license: "Public domain (CDC); credit CDC MMWR; no endorsement implied", visibility: "public", text: `${dot(title)}\n\nPublished in CDC's Morbidity and Mortality Weekly Report, volume 75, on ${longDate(date)}.\n\n${htmlToText(body).replace(/^(View suggested citation|Article Metrics|Altmetric:|Related Materials|Article PDF|Full Issue PDF|Top)\s*$/gm, "").replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n").trim()}` });
  }
  return records;
}

/** ECDC news and publications, found through its sitemap (lastmod in the window), dated by each page's own date. The sitemap can lag a few days behind the site. */
async function ecdc(): Promise<SourceRecord[]> {
  const index = await get("https://www.ecdc.europa.eu/sitemap.xml");
  const pages = [...(index ?? "").matchAll(/<loc>([^<]+sitemap\.xml\?page=\d+)<\/loc>/g)].map((m) => m[1].replaceAll("&amp;", "&"));
  const found: Array<[string, string]> = [];
  for (const page of SMALL ? pages.filter((p) => p.endsWith("page=4")) : pages) {
    // Their CDN answers a compressed request for a sitemap page with the index, so ask for it uncompressed.
    const uncompressed = { headers: { "Accept-Encoding": "identity" } };
    let xml = await get(page, uncompressed);
    if (xml?.includes("<sitemapindex")) {
      await forget(page);
      xml = await get(page, uncompressed);
    }
    for (const m of (xml ?? "").matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:(?!<\/url>)[\s\S])*?<lastmod>(\d{4}-\d{2}-\d{2})/g)) {
      if (/\/en\/(news-events|publications-data)\//.test(m[1]) && m[2] >= FROM) found.push([m[2], m[1]]);
    }
  }
  const urls = found.sort((a, b) => b[0].localeCompare(a[0])).map(([, url]) => url);
  const records: SourceRecord[] = [];
  for (const url of SMALL ? urls.slice(0, 8) : urls) {
    if (pauseRequested() || records.length >= LIMIT) break;
    const html = await get(url);
    if (!html) continue;
    const date = html.match(/<time datetime="(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!inWindow(date)) continue;
    const start = html.indexOf("<h1");
    const end = html.indexOf("<footer", start);
    const title = clean(html.match(/<meta property="og:title" content="([^"]*)"/)?.[1]) || clean(html.slice(start, html.indexOf("</h1>", start)));
    const text = htmlToText(html.slice(start, end > start ? end : undefined)).replace(/\n\n(Further reading|Related content)[\s\S]*$/, "");
    records.push({ id: `ecdc:${url.split("/").pop()}`, source: "ECDC", title, url, date, license: "CC BY 4.0; credit the European Centre for Disease Prevention and Control", visibility: "public", text: `Published by the European Centre for Disease Prevention and Control on ${longDate(date)}.\n\n${text}` });
  }
  return records;
}

/** EMA's own JSON reports: news with each article's text, and what happened to each medicine. Reuse needs credit. */
async function ema(): Promise<SourceRecord[]> {
  const LICENSE = "Reproduction authorised with credit to the European Medicines Agency; third-party content excluded";
  const euDate = (s?: string) => (/^\d{2}\/\d{2}\/\d{4}$/.test(s ?? "") ? `${s!.slice(6)}-${s!.slice(3, 5)}-${s!.slice(0, 2)}` : null);
  const records: SourceRecord[] = [];
  const news = await getJson<{ data: Array<{ title: string; news_summary?: string; first_published_date?: string; news_url: string }> }>("https://www.ema.europa.eu/en/documents/report/news-json-report_en.json");
  const items = (news?.data ?? []).filter((n) => inWindow(euDate(n.first_published_date)));
  for (const n of SMALL ? items.slice(0, 3) : items) {
    if (pauseRequested()) break;
    const date = euDate(n.first_published_date)!;
    const html = await get(n.news_url);
    const main = html?.match(/<main\b[\s\S]*?<\/main>/)?.[0];
    const text = main ? htmlToText(main).replace(/^[\s\S]*?(?=\n\n[^\n]{80,})/, "").replace(/\n\n(Related content|Share this page|How useful)[\s\S]*$/i, "").replace(/^News[A-Z]\w*\s*$/m, "") : clean(n.news_summary);
    records.push({ id: `ema-news:${n.news_url.split("/").pop()}`, source: "European Medicines Agency news", title: clean(n.title), url: n.news_url, date, license: LICENSE, visibility: "public", text: `${dot(clean(n.title))}\n\nPublished by the European Medicines Agency on ${longDate(date)}.\n\n${text.trim()}` });
  }
  const medicines = await getJson<{ data: Array<Record<string, string>> }>("https://www.ema.europa.eu/en/documents/report/medicines-output-medicines_json-report_en.json");
  const facts: Fact[] = [];
  const events: Array<[string, string]> = [
    ["marketing_authorisation_date", "received EU marketing authorisation"],
    ["opinion_adopted_date", "received an opinion from EMA's committee"],
    ["refusal_of_marketing_authorisation_date", "was refused EU marketing authorisation"],
    ["withdrawal_of_application_date", "had its application withdrawn"],
    ["withdrawal_expiry_revocation_lapse_of_marketing_authorisation_date", "had its EU marketing authorisation withdrawn, expired, revoked or lapsed"],
    ["suspension_of_marketing_authorisation_date", "had its EU marketing authorisation suspended"],
  ];
  for (const m of medicines?.data ?? []) {
    for (const [field, what] of events) {
      const date = euDate(m[field]);
      if (inWindow(date)) facts.push({ date, sentence: dot(`On ${longDate(date)}, the ${m.category?.toLowerCase() === "veterinary" ? "veterinary" : "human"} medicine ${clean(m.name_of_medicine)}${m.active_substance ? ` (${clean(m.active_substance)})` : ""} ${what}${m.marketing_authorisation_developer_applicant_holder ? `; holder or applicant: ${clean(m.marketing_authorisation_developer_applicant_holder)}` : ""}${m.therapeutic_area_mesh ? `; therapeutic area: ${clean(m.therapeutic_area_mesh)}` : ""}`) });
    }
  }
  return [...records, ...monthly("ema-medicines", "European Medicines Agency medicines", "https://www.ema.europa.eu/en/medicines", LICENSE, "public", facts)];
}

// ---- Funding ----

/** RePORTER searches are POST only, and a query stops at 15,000 results, so a week at a time. */
async function nihReporter(): Promise<SourceRecord[]> {
  interface Project {
    project_num?: string;
    project_title?: string;
    award_amount?: number;
    award_notice_date?: string;
    contact_pi_name?: string;
    organization?: { org_name?: string; org_city?: string; org_state?: string };
    agency_ic_admin?: { abbreviation?: string; name?: string };
  }
  const facts: Fact[] = [];
  for (const span of SPANS) {
    const start = Date.parse(`${span.from}T00:00:00Z`);
    const stop = Date.parse(`${span.to}T00:00:00Z`);
    for (let t = start; t <= stop && !pauseRequested(); t += 7 * 86_400_000) {
      const from = new Date(t).toISOString().slice(0, 10);
      const to = new Date(Math.min(t + 6 * 86_400_000, stop)).toISOString().slice(0, 10);
      const limit = size(500);
      for (let page = 0, offset = 0; page < PAGES && offset < 15_000 && !pauseRequested(); page++, offset += limit) {
        const raw = await fetchBytes("https://api.reporter.nih.gov/v2/projects/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ criteria: { award_notice_date: { from_date: from, to_date: to } }, include_fields: ["ProjectNum", "ProjectTitle", "AwardAmount", "AwardNoticeDate", "ContactPiName", "Organization", "AgencyIcAdmin"], offset, limit, sort_field: "appl_id", sort_order: "asc" }),
        });
        if (!raw) throw new Error(`RePORTER failed for ${from}`);
        const body = JSON.parse(raw.toString("utf8")) as { meta: { total: number }; results: Project[] };
        if (body.meta.total > 15_000) console.warn(`nih-reporter: ${body.meta.total} projects in the week of ${from}, past the 15,000 cap`);
        for (const p of body.results) {
          const date = p.award_notice_date?.slice(0, 10);
          if (!date) continue;
          const pi = p.contact_pi_name ? nameCase(clean(p.contact_pi_name).split(",").reverse().join(" ")).trim() : "";
          const org = p.organization;
          const agency = p.agency_ic_admin;
          facts.push({ date, sentence: dot(`On ${longDate(date)}, ${agency?.name ? `the ${clean(agency.name)}${agency.abbreviation ? ` (${agency.abbreviation})` : ""}` : "a federal agency"} issued a notice of award${p.award_amount ? ` of ${usd(p.award_amount)}` : ""} to ${nameCase(clean(org?.org_name))}${org?.org_city ? ` in ${nameCase(clean(org.org_city))}${org.org_state ? `, ${org.org_state}` : ""}` : ""} for project ${p.project_num}, "${clean(p.project_title)}"${pi ? `, led by ${pi}` : ""}`) });
        }
        if (body.results.length < limit) break;
      }
      if (SMALL) break;
    }
  }
  return monthly("nih-reporter", "NIH RePORTER awards", "https://reporter.nih.gov/", "Public domain (U.S. government); credit NIH RePORTER", "public", facts);
}

async function nsfAwards(): Promise<SourceRecord[]> {
  interface Award {
    id: string;
    date: string;
    title?: string;
    awardeeName?: string;
    awardeeCity?: string;
    awardeeStateCode?: string;
    fundsObligatedAmt?: string;
    estimatedTotalAmt?: string;
    pdPIName?: string;
    fundProgramName?: string;
  }
  const us = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
  const facts: Fact[] = [];
  for (const span of SPANS) {
    for (let page = 0, offset = 0; page < PAGES && !pauseRequested(); page++, offset += 25) {
      const body = await getJson<{ response: { award?: Award[] } }>(`https://api.nsf.gov/services/v1/awards.json?dateStart=${us(span.from)}&dateEnd=${us(span.to)}&rpp=25&offset=${offset}&printFields=id,date,title,awardeeName,awardeeCity,awardeeStateCode,fundsObligatedAmt,estimatedTotalAmt,pdPIName,fundProgramName`);
      const awards = body?.response.award ?? [];
      for (const a of awards) {
        const [m, d, y] = a.date.split("/");
        const date = `${y}-${m}-${d}`;
        const amount = Number(a.estimatedTotalAmt || a.fundsObligatedAmt);
        facts.push({ date, sentence: dot(`On ${longDate(date)}, NSF made award ${a.id}${amount ? ` of ${usd(amount)}` : ""} to ${nameCase(clean(a.awardeeName))}${a.awardeeCity ? ` in ${nameCase(clean(a.awardeeCity))}${a.awardeeStateCode ? `, ${a.awardeeStateCode}` : ""}` : ""} for "${clean(a.title)}"${a.pdPIName ? `, led by ${clean(a.pdPIName)}` : ""}${a.fundProgramName ? `, under the ${clean(a.fundProgramName)} program` : ""}`) });
      }
      if (awards.length < 25) break;
    }
  }
  return monthly("nsf-awards", "NSF awards", "https://www.nsf.gov/awardsearch/", "Public domain (U.S. government); credit the U.S. National Science Foundation", "public", facts);
}

// ---- Space ----

/** NASA's terms bar AI products from a certain attribution phrase, so any sentence holding it is dropped, and no images are kept. */
const withoutAttributionPhrase = (text: string) => text.replace(/[^.!?\n]*\baccording to NASA\b[^.!?\n]*[.!?]?\s*/gi, "");

async function nasaNews(): Promise<SourceRecord[]> {
  interface Post {
    id: number;
    date: string;
    link: string;
    title: { rendered: string };
    content: { rendered: string };
  }
  const records: SourceRecord[] = [];
  for (const [type, source] of [["press-release", "NASA news release"], ["nasa-blog", "NASA blog"]]) {
    for (let page = 1; page <= PAGES && !pauseRequested(); page++) {
      const perPage = size(100);
      const posts = await getJson<Post[]>(`https://www.nasa.gov/wp-json/wp/v2/${type}?after=${FROM}T00:00:00&before=${TO}T23:59:59&per_page=${perPage}&page=${page}&_fields=id,date,link,title,content`);
      for (const p of posts ?? []) {
        const date = p.date.slice(0, 10);
        if (!inWindow(date)) continue;
        records.push({ id: `nasa-${type}:${p.id}`, source, title: clean(p.title.rendered), url: p.link, date, license: "U.S. government work, generally not copyrighted (NASA media guidelines); no NASA endorsement implied, no insignia used", visibility: "public", text: withoutAttributionPhrase(htmlToText(p.content.rendered)) });
      }
      if (!posts || posts.length < perPage) break;
    }
  }
  return records;
}

async function exoplanets(): Promise<SourceRecord[]> {
  interface Planet {
    pl_name: string;
    hostname: string;
    discoverymethod?: string;
    disc_facility?: string;
    disc_pubdate?: string;
    releasedate?: string;
    pl_orbper?: number | null;
    pl_rade?: number | null;
    pl_bmasse?: number | null;
    sy_dist?: number | null;
  }
  const query = "select pl_name,hostname,discoverymethod,disc_facility,disc_pubdate,releasedate,pl_orbper,pl_rade,pl_bmasse,sy_dist from ps where default_flag=1 and disc_year=2026";
  const rows = await getJson<Planet[]>(`https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=${encodeURIComponent(query).replaceAll("%20", "+")}&format=json`);
  const num = (n: number) => Number(n.toPrecision(4)).toString();
  const facts: Fact[] = (rows ?? []).flatMap((p) => {
    if (!inWindow(p.releasedate)) return [];
    const details = [p.pl_orbper != null ? `its orbital period is ${num(p.pl_orbper)} days` : "", p.pl_rade != null ? `its radius is ${num(p.pl_rade)} Earth radii` : "", p.pl_bmasse != null ? `its mass is ${num(p.pl_bmasse)} Earth masses` : ""].filter(Boolean).join(", ");
    const published = p.disc_pubdate && /^\d{4}-\d{2}$/.test(p.disc_pubdate) ? `, in a paper dated ${monthName(p.disc_pubdate)}` : "";
    return [{ date: p.releasedate, sentence: dot(`On ${longDate(p.releasedate)}, the NASA Exoplanet Archive listed the newly discovered planet ${p.pl_name}, orbiting ${p.hostname}${p.sy_dist != null ? ` about ${num(p.sy_dist)} parsecs away` : ""}, found by ${(p.discoverymethod ?? "an unstated method").toLowerCase()} with ${p.disc_facility ?? "an unstated facility"}${published}${details ? `; ${details}` : ""}`) }];
  });
  return monthly("exoplanets", "NASA Exoplanet Archive", "https://exoplanetarchive.ipac.caltech.edu/", "Public; research made use of the NASA Exoplanet Archive, operated by Caltech under contract with NASA; no endorsement implied", "public", facts);
}

async function gcatLaunches(): Promise<SourceRecord[]> {
  const tsv = await get("https://planet4589.org/space/gcat/tsv/derived/launchlog.tsv");
  if (!tsv) throw new Error("could not read GCAT");
  const lines = tsv.split("\n");
  const head = lines[0].replace(/^#/, "").split("\t").map((h) => h.trim());
  const launches = new Map<string, { date: string; time: string; vehicle: string; flight: string; site: string; pad: string; agency: string; code: string; payloads: string[] }>();
  for (const line of lines) {
    if (line.startsWith("#") || !line.startsWith("2026")) continue;
    const cell = line.split("\t").map((c) => c.trim());
    const r = Object.fromEntries(head.map((h, i) => [h, cell[i] ?? ""]));
    const m = r.Launch_Date.match(/^(\d{4}) (\w{3})\s+(\d{1,2})(?: (\d{2})(\d{2}))?/);
    const date = m && isoDate(`${m[2]} ${m[3]}, ${m[1]}`);
    if (!date) continue;
    const launch = launches.get(r.Launch_Tag) ?? { date, time: m![4] ? `${m![4]}:${m![5]} UTC` : "", vehicle: r.LV_Type, flight: r.Flight_ID, site: r.Launch_Site, pad: r.Launch_Pad, agency: r.Agency, code: r.Launch_Code, payloads: [] };
    if (r.Type.startsWith("P") && r.Name) launch.payloads.push(r.Name);
    launches.set(r.Launch_Tag, launch);
  }
  const facts: Fact[] = [...launches].map(([tag, l]) => {
    const failed = l.code[1] === "F";
    const count = l.payloads.length;
    const cargo = count === 0 ? "" : count === 1 ? `, carrying ${l.payloads[0]}` : `, carrying ${count} payloads including ${l.payloads[0]}`;
    return { date: l.date, sentence: dot(`On ${longDate(l.date)}${l.time ? ` at ${l.time}` : ""}, a ${l.vehicle} launched from ${l.site}${l.pad && l.pad !== "-" ? ` pad ${l.pad}` : ""}${l.agency && l.agency !== "-" ? ` for ${l.agency}` : ""}${cargo} (GCAT launch ${tag}). ${failed ? "The launch failed to reach orbit" : "The launch reached orbit"}`) };
  });
  return monthly("gcat-launches", "GCAT launch log", "https://planet4589.org/space/gcat/", "CC BY 4.0; Jonathan C. McDowell, General Catalog of Artificial Space Objects, https://planet4589.org/space/gcat", "public", facts);
}

/** The free tier allows 15 calls an hour, hence the gap. Private: the claim check found no attribution rule but a request not to forward the data without adding value, and GCAT is the public launch set. */
async function launchLibrary(): Promise<SourceRecord[]> {
  interface Launch {
    id: string;
    name: string;
    net: string;
    launch_designator?: string;
    status?: { name?: string };
    launch_service_provider?: { name?: string };
    mission?: { name?: string; description?: string; type?: string; orbit?: { name?: string } };
    pad?: { name?: string; location?: { name?: string } };
  }
  const facts: Fact[] = [];
  let url: string | null = `https://ll.thespacedevs.com/2.3.0/launches/previous/?net__gte=${FROM}T00:00:00Z&net__lte=${TO}T23:59:59Z&limit=${size(100)}&mode=normal&ordering=net`;
  for (let page = 0; url && page < (SMALL ? 1 : Infinity) && !pauseRequested(); page++) {
    const body: { next: string | null; results: Launch[] } | null = await getJson(url, { gapMs: 245_000 });
    if (!body) throw new Error(`Launch Library failed at ${url}`);
    for (const l of body.results) {
      const date = l.net.slice(0, 10);
      const place = [l.pad?.name, l.pad?.location?.name].filter(Boolean).join(", ");
      const sentence = [`On ${longDate(date)}, ${l.name} launched${l.launch_service_provider?.name ? `, operated by ${l.launch_service_provider.name}` : ""}${place ? `, from ${place}` : ""}`, l.status?.name ? `Status: ${l.status.name}` : "", l.mission?.orbit?.name ? `Orbit: ${l.mission.orbit.name}` : "", l.mission?.description ? clean(l.mission.description) : ""].filter(Boolean).map(dot).join(" ");
      facts.push({ date, sentence });
    }
    url = body.next;
  }
  return monthly("launch-library", "Launch Library 2", "https://thespacedevs.com/llapi", "The Space Devs Launch Library 2, attribution not required; asks not to forward without adding value; training only until cleared", "private", facts);
}

// ---- Earth ----

async function usgsEarthquakes(): Promise<SourceRecord[]> {
  interface Quake {
    id: string;
    properties: { mag: number; place?: string; time: number; tsunami?: number; alert?: string | null; felt?: number | null };
    geometry: { coordinates: number[] };
  }
  const body = await getJson<{ features: Quake[] }>(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${FROM}&endtime=2026-10-30&minmagnitude=5&orderby=time-asc&limit=20000`);
  if (!body) throw new Error("USGS gave no data");
  const facts: Fact[] = body.features.map((q) => {
    const when = new Date(q.properties.time).toISOString();
    const date = when.slice(0, 10);
    const extras = [q.geometry.coordinates[2] != null ? `at a depth of ${Math.round(q.geometry.coordinates[2])} km` : "", q.properties.alert ? `PAGER alert level ${q.properties.alert}` : "", q.properties.tsunami ? "with a tsunami flag" : "", q.properties.felt ? `with ${q.properties.felt} felt reports` : ""].filter(Boolean).join(", ");
    return { date, sentence: dot(`On ${longDate(date)} at ${when.slice(11, 16)} UTC, a magnitude ${q.properties.mag} earthquake struck ${q.properties.place ?? "an unnamed location"}${extras ? `, ${extras}` : ""}`) };
  });
  return monthly("usgs-earthquakes", "USGS earthquakes M5+", "https://earthquake.usgs.gov/", "Public domain (U.S. Geological Survey); credit USGS", "public", facts);
}

async function noaaStormEvents(): Promise<SourceRecord[]> {
  const dir = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/";
  const listing = await get(dir);
  const file = [...new Set((listing ?? "").match(/StormEvents_details-ftp_v1\.0_d2026_c\d+\.csv\.gz/g) ?? [])].sort().pop();
  if (!file) throw new Error("no 2026 Storm Events file listed");
  const gz = await fetchBytes(dir + file);
  if (!gz) throw new Error(`could not download ${file}`);
  const rows = parseCsv(gunzipSync(gz).toString("utf8"));
  const facts: Fact[] = rows.flatMap((r) => {
    const date = `${r.BEGIN_YEARMONTH.slice(0, 4)}-${r.BEGIN_YEARMONTH.slice(4, 6)}-${r.BEGIN_DAY.padStart(2, "0")}`;
    if (!inWindow(date)) return [];
    const deaths = Number(r.DEATHS_DIRECT) + Number(r.DEATHS_INDIRECT);
    const injuries = Number(r.INJURIES_DIRECT) + Number(r.INJURIES_INDIRECT);
    const toll = [deaths ? `${deaths} deaths` : "", injuries ? `${injuries} injuries` : "", r.DAMAGE_PROPERTY && !/^0(\.00)?[KMB]?$/.test(r.DAMAGE_PROPERTY) ? `${r.DAMAGE_PROPERTY} in property damage` : "", r.TOR_F_SCALE ? `rated ${r.TOR_F_SCALE}` : ""].filter(Boolean).join(", ");
    const narrative = cut(clean(r.EVENT_NARRATIVE || r.EPISODE_NARRATIVE), 600);
    return [{ date, sentence: `${dot(`On ${longDate(date)}, NOAA recorded a ${r.EVENT_TYPE.toLowerCase()} event in ${nameCase(r.CZ_NAME)}, ${nameCase(r.STATE)}${toll ? `, with ${toll}` : ""}`)}${narrative ? ` ${dot(narrative)}` : ""}` }];
  });
  return monthly("noaa-storm-events", "NOAA Storm Events", "https://www.ncdc.noaa.gov/stormevents/", "Public domain (NOAA NCEI); credit NOAA; not an official NOAA product", "public", facts, 100);
}

/** Public advisories, the season tables and any Tropical Cyclone Reports (PDFs, read with pdftotext when it's installed). */
async function hurricaneCenter(): Promise<SourceRecord[]> {
  const LICENSE = "Public domain (NOAA NHC); unofficial copy, reformatted, not an official NHC product; no endorsement implied";
  const NHC = "https://www.nhc.noaa.gov";
  const records: SourceRecord[] = [];
  const facts: Fact[] = [];
  const months: Record<string, string> = { Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June", Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December" };
  const types: Record<string, string> = { TS: "Tropical storm", HU: "Hurricane", MH: "Major hurricane", TD: "Tropical depression", SS: "Subtropical storm", SD: "Subtropical depression" };
  for (const [basin, label] of [["atl", "Atlantic"], ["epac", "eastern Pacific"], ["cpac", "central Pacific"]]) {
    const page = await get(`${NHC}/data/tcr/index.php?season=2026&basin=${basin}`);
    for (const row of (page ?? "").matchAll(/<tr><td>(\d+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>(\d{1,2}) (\w{3})[–-](\d{1,2})? ?(\w{3})?<\/td><td>(\d*)<\/td><td>(\d*)<\/td><td>([\d.]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td>/g)) {
      const [, , name, type, d1, m1, d2, m2, wind, pressure, ace, deaths, damage] = row;
      const date = isoDate(`${m1} ${d1}, 2026`);
      if (!date) continue;
      const details = [wind ? `peak winds of ${wind} knots` : "", pressure ? `minimum pressure of ${pressure} mb` : "", ace ? `accumulated cyclone energy of ${ace}` : "", deaths ? `${deaths} direct deaths` : "", damage ? `$${damage} million in U.S. damage` : ""].filter(Boolean).join(", ");
      facts.push({ date, sentence: dot(`${types[type] ?? type} ${name} of the 2026 ${label} season lasted from ${months[m1]} ${Number(d1)} to ${months[m2 ?? m1]} ${Number(d2 ?? d1)}, 2026${details ? `, with ${details}` : ""}`) });
    }
    for (const pdf of [...new Set((page ?? "").match(/\/data\/tcr\/[A-Z]{2}\d{6}_\w+\.pdf/g) ?? [])].slice(0, SMALL ? 1 : undefined)) {
      const bytes = await fetchBytes(NHC + pdf);
      if (!bytes) continue;
      const tmp = path.join(CACHE, `${hash(pdf)}.pdf`);
      await writeFile(tmp, bytes);
      let text = "";
      try {
        text = execFileSync("pdftotext", ["-layout", tmp, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      } catch (err) {
        console.warn(`nhc: could not read ${pdf}: ${(err as Error).message.slice(0, 100)}`);
      }
      await rm(tmp, { force: true });
      const cover = text.replace(/\s+/g, " ").slice(0, 600).match(/\b(\d{1,2}) ([A-Z][a-z]+) (2026)\b(?![\s\S]*\b\d{1,2} [A-Z][a-z]+ 2026\b)/);
      const date = cover && isoDate(`${cover[2]} ${cover[1]}, ${cover[3]}`);
      if (!text.trim() || !inWindow(date)) continue;
      const storm = pdf.match(/_(\w+)\.pdf$/)![1];
      records.push({ id: `nhc-tcr:${pdf.split("/").pop()}`, source: "National Hurricane Center report", title: `Tropical Cyclone Report: ${storm}`, url: NHC + pdf, date, license: LICENSE, visibility: "public", text: text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n") });
    }
  }
  const index = await get(`${NHC}/archive/2026/`);
  const storms = [...(index ?? "").matchAll(/atcf_index=((?:al|ep|cp)\d\d) --><a href="([^".]+)\.shtml\?">/g)];
  for (const storm of SMALL ? storms.slice(0, 1) : storms) {
    if (pauseRequested()) break;
    const page = await get(`${NHC}/archive/2026/${storm[2]}.shtml?`);
    const links = [...new Set((page ?? "").match(/\/archive\/2026\/[a-z0-9]+\/[a-z0-9]+\.public(?:_[a-z])?\.\d+\.shtml/g) ?? [])];
    for (const link of SMALL ? links.slice(0, 3) : links) {
      if (pauseRequested()) break;
      const html = await get(`${NHC}${link}?`);
      const pre = html?.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1];
      if (!pre) continue;
      const when = pre.match(/\b(\d{3,4} [AP]M \w{2,4}) \w{3} (\w{3}) (\d{1,2}) (2026)\b/);
      const date = when && isoDate(`${when[2]} ${when[3]}, ${when[4]}`);
      if (!inWindow(date)) continue;
      const body = htmlToText(pre.replace(/\n[ \t]*(?=\n)/g, "\n"));
      const start = body.indexOf("BULLETIN");
      const lines = (start >= 0 ? body.slice(start + 8) : body).trim();
      const heading = lines.split("\n")[0].replace(/\s+/g, " ").trim();
      const paragraphs = lines.split(/\n\s*\n/).map((p) => p.replace(/-{3,}/g, " ").replace(/\s+/g, " ").trim()).filter((p) => p && p !== "$$" && p !== "NNNN");
      records.push({ id: `nhc:${link.split("/").pop()!.replace(".shtml", "")}`, source: "National Hurricane Center public advisory", title: heading, url: NHC + link, date, license: LICENSE, visibility: "public", text: `The National Hurricane Center issued this advisory at ${when![1]} on ${longDate(date)}.\n\n${paragraphs.join("\n\n")}` });
    }
  }
  return [...records, ...monthly("nhc-seasons", "National Hurricane Center season tables", `${NHC}/data/tcr/index.php?season=2026`, LICENSE, "public", facts)];
}

/** Alerts are automatic and unreviewed, and the terms state no reuse license, so facts for training only (claim check S8). */
async function gdacs(): Promise<SourceRecord[]> {
  interface Event {
    properties: { eventtype: string; eventid: number; name?: string; htmldescription?: string; alertlevel?: string; fromdate?: string; todate?: string; country?: string; severitydata?: { severitytext?: string } };
  }
  const events = new Map<string, Fact>();
  for (const span of SPANS) {
    for (let page = 1; page <= PAGES && !pauseRequested(); page++) {
      const body = await getJson<{ features?: Event[] }>(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?fromDate=${span.from}&toDate=${span.to}&alertlevel=Green;Orange;Red&eventlist=EQ;TC;FL;VO;WF;DR&pagenumber=${page}&pagesize=${size(100)}`);
      const list = body?.features ?? [];
      for (const { properties: e } of list) {
        const date = e.fromdate?.slice(0, 10);
        if (!date || !inWindow(date)) continue;
        const to = e.todate?.slice(0, 10);
        events.set(`${e.eventtype}:${e.eventid}`, { date, sentence: dot(`On ${longDate(date)}, GDACS's automatic system opened a ${e.alertlevel ?? "unrated"} alert for ${clean(e.name)}${e.country && !clean(e.name).includes(clean(e.country)) ? ` affecting ${clean(e.country)}` : ""}${to && inWindow(to) && to !== date ? `, running to ${longDate(to)}` : ""}${e.severitydata?.severitytext ? `; severity: ${clean(e.severitydata.severitytext)}` : ""}`) });
      }
      if (list.length < size(100)) break;
    }
  }
  return monthly("gdacs", "GDACS disaster alerts", "https://www.gdacs.org/", "No reuse license stated; automatic alerts not reviewed by humans; facts for training only", "private", [...events.values()]);
}

async function nobel(): Promise<SourceRecord[]> {
  interface Prize {
    awardYear: string;
    categoryFullName?: { en?: string };
    dateAwarded?: string;
    prizeAmount?: number;
    laureates?: Array<{ knownName?: { en?: string }; orgName?: { en?: string }; portion?: string; motivation?: { en?: string } }>;
  }
  const body = await getJson<{ nobelPrizes: Prize[] }>("https://api.nobelprize.org/2.1/nobelPrizes?nobelPrizeYear=2026&limit=25");
  const facts: Fact[] = (body?.nobelPrizes ?? []).flatMap((p) => {
    if (!p.dateAwarded) return [];
    const who = (p.laureates ?? []).map((l) => `${l.knownName?.en ?? l.orgName?.en ?? "an unnamed laureate"}${l.portion && l.portion !== "1" ? ` (${l.portion} of the prize)` : ""} "${l.motivation?.en ?? ""}"`);
    return [{ date: p.dateAwarded, sentence: dot(`On ${longDate(p.dateAwarded)}, the ${(p.categoryFullName?.en ?? "Nobel Prize").replace(/^The /, "")} for ${p.awardYear} was announced, awarded to ${who.join("; and to ") || "no one"}${p.prizeAmount ? `. The prize amount is ${p.prizeAmount.toLocaleString("en-US")} Swedish kronor` : ""}`) }];
  });
  return monthly("nobel", "Nobel Prize API", "https://www.nobelprize.org/", "CC0 (Nobel Prize API metadata); credit nobelprize.org", "public", facts);
}

// ---- Retractions, private ----

async function retractionWatch(): Promise<SourceRecord[]> {
  const csv = await get("https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv");
  if (!csv) throw new Error("could not read the Retraction Watch CSV");
  const facts: Fact[] = parseCsv(csv).flatMap((r) => {
    const m = r.RetractionDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    const date = m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
    if (!inWindow(date)) return [];
    const reasons = r.Reason.split(";").map((x) => x.replace(/^\+/, "").trim()).filter(Boolean);
    return [{ date, sentence: dot(`On ${longDate(date)}, ${clean(r.Journal) || "a journal"} (${clean(r.Publisher)}) issued a ${clean(r.RetractionNature).toLowerCase() || "retraction"} for "${clean(r.Title)}"${r.OriginalPaperDOI ? ` (DOI ${r.OriginalPaperDOI})` : ""}${reasons.length ? `. Reasons: ${reasons.join("; ")}` : ""}`) }];
  });
  return monthly("retraction-watch", "Retraction Watch", "https://gitlab.com/crossref/retraction-watch-data", "Retraction Watch data via Crossref; license not confirmed, training only", "private", facts);
}

const STEPS: Array<[string, () => Promise<SourceRecord[]>]> = [
  ["arxiv", () => byMonth("arxiv", arxivMonth)],
  ["crossref-retractions", crossrefRetractions],
  ["pubmed", pubmed],
  ["europepmc", () => byMonth("europepmc", europePmcMonth)],
  ["biorxiv", () => preprints("biorxiv", "bioRxiv")],
  ["medrxiv", () => preprints("medrxiv", "medRxiv")],
  ["acl-anthology", aclAnthology],
  ["doaj", () => byMonth("doaj", doajMonth)],
  ["pmc-fulltext", pmcFulltext],
  ["clinicaltrials", clinicalTrials],
  ["openfda", openFda],
  ["dailymed", dailyMed],
  ["mmwr", mmwr],
  ["ecdc", ecdc],
  ["ema", ema],
  ["nih-reporter", nihReporter],
  ["nsf-awards", nsfAwards],
  ["nasa-news", nasaNews],
  ["exoplanets", exoplanets],
  ["usgs-earthquakes", usgsEarthquakes],
  ["noaa-storm-events", noaaStormEvents],
  ["nhc", hurricaneCenter],
  ["gcat-launches", gcatLaunches],
  ["launch-library", launchLibrary],
  ["gdacs", gdacs],
  ["nobel", nobel],
  ["retraction-watch", retractionWatch],
];

runAll(STEPS.map(([name, run]): [string, () => Promise<SourceRecord[]>] => [name, async () => (await run()).map(noEmDash)])).catch((err) => {
  console.error(err);
  process.exit(1);
});

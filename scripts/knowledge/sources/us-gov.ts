/**
 * Collects US government records from the window for the knowledge corpus: the Federal Register, GovInfo bulk data,
 * GAO, the Federal Reserve, Treasury, OFAC, the Supreme Court, the CFTC, USDA NASS, the White House and DOJ. Writes
 * .data/knowledge/sources/us-*.jsonl. All of it is public domain and needs no key. Rows of data become one plain
 * sentence each, grouped into a document per source and month; longer texts stay documents of their own.
 *
 * Each host's robots.txt sets its gap: GAO asks for 420 seconds and DOJ for 10; the rest get 1 second. www.cftc.gov
 * says ai-train=no in its robots.txt, so nothing here touches it; the CFTC step reads only the separate Public
 * Reporting API on publicreporting.cftc.gov, whose robots.txt has no such signal.
 *
 * With LIMIT set, each step stops at 12 requests, for a small test.
 *
 *   npx tsx scripts/knowledge/sources/us-gov.ts [step ...]
 */
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { constants, createGunzip } from "node:zlib";
import { longDate } from "@/lib/knowledge/passages";
import { htmlToText, type SourceRecord } from "@/lib/knowledge/sources";
import { FROM, get, LIMIT, pauseRequested, runAll, TO, USER_AGENT } from "./common";

const SAMPLING = LIMIT !== Infinity;
const SAMPLE_REQUESTS = 12;
/** A monthly document longer than this is split, so one month of bill actions doesn't become one enormous record. */
const MAX_DOC_WORDS = 4000;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const license = (name: string) => `Public domain (US government work), ${name}`;
const inWindow = (date: string | null | undefined): date is string => !!date && date >= FROM && date <= TO;
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const sentence = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return /[.!?]["')]*$/.test(t) ? t : `${t}.`;
};

/** `get` for one step: with LIMIT set it returns null once the step has spent its requests. */
function fetcher(gapMs = 1000) {
  let used = 0;
  return async (url: string, headers?: Record<string, string>): Promise<string | null> => {
    if (SAMPLING && used >= SAMPLE_REQUESTS) return null;
    used++;
    return get(url, { gapMs, headers });
  };
}

interface Fact {
  date: string;
  text: string;
}

/** Small facts as documents by month, oldest first, one line of text a day, split when a month runs long. */
function monthly(facts: Fact[], o: { id: string; source: string; subject: string; url: string; license: string }): SourceRecord[] {
  const byMonth = new Map<string, Fact[]>();
  const seen = new Set<string>();
  for (const f of facts) {
    const key = `${f.date}|${f.text}`;
    if (!inWindow(f.date) || seen.has(key)) continue;
    seen.add(key);
    const month = f.date.slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month)!.push(f);
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
      const days = new Map<string, string[]>();
      for (const f of part) days.set(f.date, [...(days.get(f.date) ?? []), f.text]);
      const label = `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}${parts.length > 1 ? `, part ${i + 1}` : ""}`;
      records.push({
        id: `${o.id}:${month}${parts.length > 1 ? `:${i + 1}` : ""}`,
        source: o.source,
        title: `${o.subject}, ${label}`,
        url: o.url,
        date: part[part.length - 1].date,
        license: o.license,
        visibility: "public",
        text: [...days.values()].map((lines) => lines.join(" ")).join("\n\n"),
      });
    });
  }
  return records;
}

// Federal Register

const FR_LICENSE = license("Federal Register, Office of the Federal Register, NARA");
const FR_API = "https://www.federalregister.gov/api/v1/documents.json";
const FR_FIELDS = ["document_number", "title", "abstract", "type", "action", "agency_names", "publication_date", "html_url", "significant", "effective_on", "comments_close_on"];
/** Thousands of near-identical rules a year: each is one sentence in a monthly digest, not a document of its own. */
const FR_ROUTINE = /Airworthiness Directives|Standard Instrument Approach Procedures|IFR Altitudes|Amendment of (Class|VOR|Area)|Establishment of (Class|Area)|Revocation of Class|Modification of (Class|Area)|Safety Zones?\b|Special Local Regulations?|Drawbridge Operation|Regulated Navigation Area|Security Zones?\b|Approval and Promulgation of|Air Plan Approval|Fisheries of the|Fisheries Off|Pesticide Tolerances?|Tolerance Exemption|Marine Mammals/i;
/** Paperwork and procedure with nothing a person would ask about. */
const FR_BOILERPLATE = /Information Collection|Collection of Information|Paperwork Reduction|Submission for OMB|Proposed Collection|Comment Request|Agency Forms|Meetings?\b|Sunshine Act|Advisory (Committee|Board|Council)|Privacy Act of 1974|System of Records|Computer Matching|Self-Regulatory Organizations|Combined Notice|Notice of Filing|Filings? (of|by)|Environmental Impact Statements?|Environmental Assessment|Request for Nominations|Charter Renewal|Renewal of Charter|Foreign-Trade Zone|Administrative Review|Sunset Review|Exempted Fishing|Incidental (Take|Harassment)|Taking of Marine Mammals|Marine Mammals|Applications? for (New Awards|Permit)|Notice Inviting|Delegation of Authority|Cancellation of|Correction$/i;
/** These name private people (registrants, drivers, exporters, debarred parties), so the personal-data rule drops them. */
const FR_PERSONAL = /In the Matter of|Decision and Order|Order Denying|Denial of Export|Debarment|Exclusion of|Revocation of Registration|Qualification of Drivers|Hours of Service|Commercial Driver|Vision Standard|Hearing Standard|Epilepsy|\bM\.D\.|\bD\.O\.|\bD\.D\.S\.|\bN\.P\.|Notice of Disqualification|Disbarment|Civil Penalty Against/i;
const MIN_NOTICE_ABSTRACT_WORDS = 25;

interface FrDoc {
  document_number: string;
  title: string;
  abstract: string | null;
  type: string;
  action: string | null;
  agency_names: string[];
  publication_date: string;
  html_url: string;
  significant: boolean | null;
  effective_on: string | null;
  comments_close_on: string | null;
}

/** A query string with FR_API's repeated bracket parameters. */
function frUrl(conditions: Array<[string, string]>, fields: string[]): string {
  const q = new URLSearchParams([...conditions, ["per_page", "1000"], ["order", "oldest"], ...fields.map((f): [string, string] => ["fields[]", f])]);
  return `${FR_API}?${q}`;
}

function frAgency(names: string[]): string {
  return names[names.length - 1] ?? "A federal agency";
}

function frLabel(type: string): string {
  return type === "Rule" ? "a final rule" : type === "Proposed Rule" ? "a proposed rule" : "a notice";
}

async function federalRegister(): Promise<SourceRecord[]> {
  const fetchPage = fetcher();
  const docs: SourceRecord[] = [];
  const digest: Fact[] = [];
  for (const day = new Date(`${FROM}T00:00:00Z`); day.toISOString().slice(0, 10) <= TO && !pauseRequested(); day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    if (SAMPLING && docs.length >= LIMIT) break;
    const date = day.toISOString().slice(0, 10);
    let next: string | null = frUrl([["conditions[publication_date][is]", date], ["conditions[type][]", "RULE"], ["conditions[type][]", "PRORULE"], ["conditions[type][]", "NOTICE"]], FR_FIELDS);
    while (next) {
      const body: string | null = await fetchPage(next);
      if (!body) break;
      const page = JSON.parse(body) as { results?: FrDoc[]; next_page_url?: string };
      for (const d of page.results ?? []) {
        if (!inWindow(d.publication_date) || FR_PERSONAL.test(d.title) || FR_PERSONAL.test(d.abstract ?? "")) continue;
        const agency = frAgency(d.agency_names);
        const when = longDate(d.publication_date);
        const lead = `On ${when}, ${agency === "A federal agency" ? "a federal agency" : `the ${agency.replace(/^the /i, "")}`} published ${frLabel(d.type)} in the Federal Register titled "${d.title.trim()}".`;
        if (d.type !== "Notice" && FR_ROUTINE.test(d.title)) {
          digest.push({ date: d.publication_date, text: lead });
          continue;
        }
        const abstract = (d.abstract ?? "").trim();
        if (d.type === "Notice" && !d.significant && (FR_BOILERPLATE.test(d.title) || FR_ROUTINE.test(d.title) || countWords(abstract) < MIN_NOTICE_ABSTRACT_WORDS)) continue;
        const dates = [
          d.effective_on ? `It takes effect on ${longDate(d.effective_on)}.` : "",
          d.comments_close_on ? `Comments are due by ${longDate(d.comments_close_on)}.` : "",
        ].filter(Boolean);
        docs.push({ id: `us-fr:${d.document_number}`, source: "Federal Register", title: d.title.trim(), url: d.html_url, date: d.publication_date, license: FR_LICENSE, visibility: "public", text: [lead, abstract, ...dates].filter(Boolean).join("\n\n") });
      }
      next = page.next_page_url ?? null;
    }
  }
  return [...monthly(digest, { id: "us-fr-routine", source: "Federal Register", subject: "Routine Federal Register rules", url: "https://www.federalregister.gov/", license: FR_LICENSE }), ...docs];
}

interface FrPresidential {
  document_number: string;
  title: string;
  subtype: string | null;
  executive_order_number: string | null;
  proclamation_number: string | null;
  signing_date: string | null;
  publication_date: string;
  raw_text_url: string;
  html_url: string;
  president: { name: string } | null;
}

/** The full text of a Federal Register document, without its page furniture and with hard line wraps undone. */
function frFullText(raw: string): string {
  const text = htmlToText(raw);
  /** Everything up to the last "Presidential Documents" banner is the issue's title page. */
  const banners = [...text.slice(0, 3000).matchAll(/Presidential Documents\]?/g)];
  const last = banners[banners.length - 1];
  return (last ? text.slice(last.index + last[0].length) : text)
    .replace(/\[\[Page \d+\]\]/g, " ")
    .replace(/[_-]{5,}/g, "")
    .replace(/Title 3-+[^A-Za-z]*The President/, "")
    .replace(/\[FR Doc\.[^\]]*\][\s\S]*$/, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Asked for by publication date with no end, since an order signed in the window can be printed days later. */
async function federalRegisterPresidential(): Promise<SourceRecord[]> {
  const fetchPage = fetcher();
  const records: SourceRecord[] = [];
  let next: string | null = frUrl([["conditions[publication_date][gte]", FROM], ["conditions[type][]", "PRESDOCU"]], ["document_number", "title", "subtype", "executive_order_number", "proclamation_number", "signing_date", "publication_date", "raw_text_url", "html_url", "president"]);
  while (next && !pauseRequested()) {
    const body: string | null = await fetchPage(next);
    if (!body) break;
    const page = JSON.parse(body) as { results?: FrPresidential[]; next_page_url?: string };
    for (const d of page.results ?? []) {
      const date = d.signing_date ?? d.publication_date;
      if (!inWindow(date)) continue;
      if (SAMPLING && records.length >= LIMIT) break;
      const raw = await fetchPage(d.raw_text_url);
      if (!raw) continue;
      const kind = d.executive_order_number ? `Executive Order ${d.executive_order_number}` : d.proclamation_number ? `Proclamation ${d.proclamation_number}` : `a ${(d.subtype ?? "presidential document").toLowerCase()}`;
      const heading = d.executive_order_number || d.proclamation_number ? kind : (d.subtype ?? "Presidential document");
      const who = d.president?.name ? `President ${d.president.name}` : "The President";
      const signed = d.signing_date ? `On ${longDate(d.signing_date)}, ${who} signed ${kind}, "${d.title.trim()}".` : `On ${longDate(d.publication_date)}, the Federal Register published ${kind}, "${d.title.trim()}".`;
      const printed = d.signing_date ? ` It was published in the Federal Register on ${longDate(d.publication_date)}.` : "";
      records.push({ id: `us-fr-presidential:${d.document_number}`, source: "Federal Register presidential documents", title: `${heading}: ${d.title.trim()}`, url: d.html_url, date, license: FR_LICENSE, visibility: "public", text: `${signed}${printed}\n\n${frFullText(raw)}` });
    }
    next = page.next_page_url ?? null;
  }
  return records;
}

// GovInfo bulk data

const GOVINFO = "https://www.govinfo.gov/bulkdata";
const GOVINFO_LICENSE = license("GovInfo bulk data, US Government Publishing Office");
const BILL_TYPES: Array<[string, string]> = [["hr", "H.R."], ["s", "S."], ["hjres", "H.J.Res."], ["sjres", "S.J.Res."], ["hconres", "H.Con.Res."], ["sconres", "S.Con.Res."], ["hres", "H.Res."], ["sres", "S.Res."]];
/** Steps in a bill's life that say something happened to it; the referral is folded into the sentence that introduces it. */
const BILL_ACTION_TYPES = new Set(["Committee", "Calendars", "Floor", "Discharge", "President", "BecameLaw", "ResolvingDifferences", "Veto"]);
const BILL_NOISE = /^(Referred to (the )?Subcommittee|Sponsor introductory remarks|Considered as unfinished|POSTPONED|Motion to reconsider|Cosponsor)/i;

interface ListedFile {
  name: string;
  link: string;
  formattedLastModifiedTime: string;
  folder: boolean;
}

async function listing(fetchPage: ReturnType<typeof fetcher>, path: string): Promise<ListedFile[]> {
  const body = await fetchPage(`${GOVINFO}/json/${path}`, { Accept: "application/json" });
  return body ? ((JSON.parse(body) as { files?: ListedFile[] }).files ?? []) : [];
}

/** "30-Oct-2026 16:46" as YYYY-MM-DD. */
function listedDate(s: string): string {
  const d = new Date(s.replace(/-/g, " "));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

const fileNumber = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? "";
/** The element at this exact indent, so a bill's own <title> and <actions> aren't confused with a related bill's. */
const block = (xml: string, name: string, indent: number) => xml.match(new RegExp(`^ {${indent}}<${name}>[\\s\\S]*?^ {${indent}}</${name}>`, "m"))?.[0] ?? "";
const children = (xml: string, name: string, indent: number) => xml.split(new RegExp(`^ {${indent}}<${name}>`, "m")).slice(1);
const unwrap = (s: string) => s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
/** Action text can hold escaped links; drop them and keep the words. */
const plain = (s: string) => htmlToText(unwrap(s).replace(/&lt;[^&]*&gt;/g, ""));

/** "Rep. Schrier, Kim [D-WA-8]" as "Rep. Kim Schrier (D-WA-8)". */
function sponsorName(full: string): string {
  const m = full.match(/^(\S+)\s+([^,]+),\s+([^[]+?)\s*\[([^\]]+)\]/);
  return m ? `${m[1]} ${m[3]} ${m[2]} (${m[4]})` : full;
}

async function billStatus(): Promise<SourceRecord[]> {
  const fetchPage = fetcher();
  const facts: Fact[] = [];
  const summaries: SourceRecord[] = [];
  for (const [type, label] of SAMPLING ? BILL_TYPES.slice(0, 1) : BILL_TYPES) {
    const files = (await listing(fetchPage, `BILLSTATUS/119/${type}`))
      .filter((f) => !f.folder && f.name.endsWith(".xml") && listedDate(f.formattedLastModifiedTime) >= FROM)
      .sort((a, b) => fileNumber(b.name) - fileNumber(a.name));
    /** A test takes bills from across the Congress, since the newest have no actions or summaries yet. */
    const step = SAMPLING ? Math.ceil(files.length / (SAMPLE_REQUESTS - 1)) : 1;
    for (const file of files.filter((_, i) => i % step === 0)) {
      if (pauseRequested()) break;
      const xml = await fetchPage(file.link);
      if (!xml) {
        if (SAMPLING) break;
        continue;
      }
      const name = `${label} ${fileNumber(file.name)}`;
      const title = plain(xml.match(/^ {4}<title>(.*)<\/title>/m)?.[1] ?? "");
      const named = title ? `${name}, "${title}"` : name;
      const url = tag(xml, "legislationUrl") || file.link;
      const seen = new Set<string>();
      for (const item of children(block(xml, "actions", 4), "item", 6)) {
        const date = tag(item, "actionDate");
        const kind = tag(item, "type");
        const text = plain(tag(item, "text"));
        if (!inWindow(date) || !BILL_ACTION_TYPES.has(kind) || !text || BILL_NOISE.test(text) || seen.has(`${date}|${text}`)) continue;
        seen.add(`${date}|${text}`);
        facts.push({ date, text: sentence(`On ${longDate(date)}, action on ${named}: ${text}`) });
      }
      const introduced = tag(xml, "introducedDate");
      if (inWindow(introduced)) {
        const sponsor = sponsorName(plain(tag(block(xml, "sponsors", 4), "fullName")));
        const chamber = tag(xml, "originChamber");
        const area = plain(tag(block(xml, "policyArea", 4), "name"));
        facts.push({ date: introduced, text: `On ${longDate(introduced)}, ${sponsor || "a member of Congress"} introduced ${title ? `${named},` : named} in the ${chamber}.${area ? ` Its policy area is ${area}.` : ""}` });
      }
      /** The Congressional Research Service's newest summary is the best plain account of a bill; a dated one in the window gets a document. */
      const newest = children(block(xml, "summaries", 4), "summary", 6)
        .map((s) => ({ action: tag(s, "actionDate"), desc: plain(tag(s, "actionDesc")), updated: tag(s, "updateDate").slice(0, 10), text: htmlToText(unwrap(tag(s, "text"))) }))
        .filter((s) => s.text && (inWindow(s.action) || inWindow(s.updated)))
        .sort((a, b) => b.updated.localeCompare(a.updated))[0];
      if (newest) {
        const date = inWindow(newest.action) ? newest.action : newest.updated;
        summaries.push({ id: `us-bill-summary:119${type}${fileNumber(file.name)}`, source: "Congressional Research Service bill summaries (GovInfo)", title: `${name}: ${title}`, url, date, license: GOVINFO_LICENSE, visibility: "public", text: `This is the Congressional Research Service summary of ${named} of the 119th Congress, for the version "${newest.desc}", dated ${longDate(date)}.\n\n${newest.text}` });
      }
    }
  }
  return [...monthly(facts, { id: "us-bill-actions", source: "GovInfo BILLSTATUS, 119th Congress", subject: "Actions on bills in the 119th Congress", url: `${GOVINFO}/BILLSTATUS/119`, license: GOVINFO_LICENSE }), ...summaries];
}

/** USLM XML as text: furniture goes, and each structural element ends its line so numbers and headings don't run together. */
function uslmToText(xml: string): string {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<meta>[\s\S]*?<\/meta>/, "")
    .replace(/<(sidenote|page|notes?|footnote)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<\/(num|heading)>/g, " ")
    .replace(/<\/(chapeau|content|continuation|subsection|paragraph|subparagraph|clause|subclause|item|level|longTitle|enactingFormula|officialTitle|docTitle|preface)>/g, "</p>");
  return htmlToText(body)
    .replace(/\u00ad/g, "")
    .replace(/^\s*PUBLIC LAW \d+\S*.*$/gim, "")
    .replace(/Public Law(?=\d)/g, "Public Law ")
    .replace(/\s*\n\s*(\n\s*)+/g, "\n\n")
    .trim();
}

async function publicLaws(): Promise<SourceRecord[]> {
  const fetchPage = fetcher();
  const records: SourceRecord[] = [];
  for (const kind of SAMPLING ? ["public"] : ["public", "private"]) {
    const files = (await listing(fetchPage, `PLAW/119/${kind}`))
      .filter((f) => !f.folder && f.name.endsWith(".xml") && listedDate(f.formattedLastModifiedTime) >= FROM)
      .sort((a, b) => fileNumber(b.name) - fileNumber(a.name));
    for (const file of files) {
      if (pauseRequested()) break;
      if (SAMPLING && records.length >= LIMIT) break;
      const xml = await fetchPage(file.link);
      if (!xml) continue;
      const date = tag(xml, "approvedDate") || tag(xml, "dc:date");
      if (!inWindow(date)) continue;
      const title = plain(tag(xml, "dc:title"));
      const cite = title.split(":")[0].trim() || file.name;
      const about = title.slice(cite.length + 1).trim();
      records.push({ id: `us-plaw:${file.name.replace(/\.xml$/, "")}`, source: "GovInfo PLAW, 119th Congress", title: title || cite, url: file.link, date, license: GOVINFO_LICENSE, visibility: "public", text: `${cite} was approved on ${longDate(date)}.${about ? ` Its long title is: ${sentence(about)}` : ""}\n\n${uslmToText(xml)}` });
    }
  }
  return records;
}

// GAO

/**
 * GAO's robots.txt asks for 420 seconds between requests and bars its report listings, so this reads only the feed,
 * which holds the newest 25 reports. Run weekly, it builds up the rest; a backfill page by page would take days.
 */
async function gaoReports(): Promise<SourceRecord[]> {
  const xml = await fetcher(420_000)("https://www.gao.gov/rss/reports.xml");
  const records: SourceRecord[] = [];
  for (const item of xml?.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const t = (name: string) => item.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1]?.trim() ?? "";
    const parsed = new Date(t("pubDate"));
    if (Number.isNaN(parsed.getTime())) continue;
    /** Published in US Eastern time, and the feed's offset says so; keep that day rather than the UTC one. */
    const date = t("pubDate").match(/\d{1,2} \w{3} \d{4}/) ? new Date(`${t("pubDate").match(/\d{1,2} \w{3} \d{4}/)![0]} UTC`).toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
    if (!inWindow(date)) continue;
    const link = t("link");
    const title = htmlToText(t("title"));
    records.push({ id: `us-gao:${link.split("/").pop()}`, source: "US Government Accountability Office reports", title, url: link, date, license: license("US Government Accountability Office"), visibility: "public", text: `On ${longDate(date)}, the Government Accountability Office published "${title}".\n\n${htmlToText(t("description"))}` });
  }
  return records;
}

// Federal Reserve

const FED = "https://www.federalreserve.gov";
const FED_LICENSE = license("Board of Governors of the Federal Reserve System");
/** Enforcement releases against people rather than banks name them, so they go. */
const FED_PERSONAL = /former|employee|individual|officer|director|institution-affiliated|prohibition/i;

interface FedRelease {
  d: string;
  t: string;
  pt: string;
  l: string;
}

function fedDate(d: string): string {
  const [m, day, y] = d.split(" ")[0].split("/");
  return `${y}-${m.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** The body of a release: the column under its heading, up to the last-update line. */
function fedBody(html: string): string {
  const article = html.slice(Math.max(html.indexOf('id="article"'), 0));
  const end = article.indexOf('id="lastUpdate"');
  const scoped = end > 0 ? article.slice(0, article.lastIndexOf("<div", end)) : article;
  const marker = 'class="col-xs-12 col-sm-8 col-md-8"';
  const start = scoped.indexOf(marker);
  const paragraphs = htmlToText((start > 0 ? scoped.slice(start + marker.length + 1) : scoped).replace(/<!--[\s\S]*?-->/g, "")).split(/\n\s*\n/);
  /** Press contacts and link lists close a release; nothing after them is news. */
  const close = paragraphs.findIndex((p) => /^(Media Contacts?\b|Contacts?:|Related Content\b)/i.test(p.trim()));
  return (close > 0 ? paragraphs.slice(0, close) : paragraphs)
    .filter((p) => !/^(For media inquiries|Attachment \(PDF\)|Implementation Note|FOMC Statement|Press Release)/i.test(p.trim()) && !(/\b(PDF|HTML)\b/.test(p) && countWords(p) < 15))
    .join("\n\n");
}

async function fedReleases(keep: (r: FedRelease) => boolean, id: string, source: string): Promise<SourceRecord[]> {
  const fetchPage = fetcher();
  const body = await fetchPage(`${FED}/json/ne-press.json`);
  const all = body ? (JSON.parse(body.replace(/^﻿/, "")) as FedRelease[]) : [];
  const records: SourceRecord[] = [];
  for (const r of all) {
    if (!r.d || !r.l) continue;
    const date = fedDate(r.d);
    if (!inWindow(date) || !keep(r) || pauseRequested()) continue;
    if (SAMPLING && records.length >= LIMIT) break;
    const url = `${FED}${r.l}`;
    const html = await fetchPage(url);
    if (!html) continue;
    const text = fedBody(html);
    if (r.pt === "Enforcement Actions" && /\b(Mr|Ms|Mrs)\.\s/.test(text)) continue;
    const title = htmlToText(r.t);
    records.push({ id: `${id}:${r.l.split("/").pop()!.replace(/\.htm$/, "")}`, source, title, url, date, license: FED_LICENSE, visibility: "public", text: `On ${longDate(date)}, the Federal Reserve released "${title}".\n\n${text}` });
  }
  return records;
}

// Treasury

const FISCAL = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service";
const TREASURY_LICENSE = license("US Department of the Treasury, Fiscal Data");

async function fiscal<T>(fetchPage: ReturnType<typeof fetcher>, endpoint: string): Promise<T[]> {
  const body = await fetchPage(`${FISCAL}/${endpoint}?filter=record_date:gte:${FROM},record_date:lte:${TO}&page%5Bsize%5D=10000&sort=record_date`);
  return body ? ((JSON.parse(body) as { data?: T[] }).data ?? []) : [];
}

const trillions = (s: string) => `$${(Number(s) / 1e12).toFixed(2)} trillion`;
const billions = (s: string) => `$${(Math.abs(Number(s)) / 1e9).toFixed(2)} billion`;
const number = (s: string | undefined) => s !== undefined && s !== "" && s !== "null" && Number.isFinite(Number(s));

async function treasury(): Promise<SourceRecord[]> {
  const fetchPage = fetcher();
  const debt = await fiscal<{ record_date: string; debt_held_public_amt: string; intragov_hold_amt: string; tot_pub_debt_out_amt: string }>(fetchPage, "v2/accounting/od/debt_to_penny");
  const debtFacts = debt.filter((r) => number(r.tot_pub_debt_out_amt)).map((r) => ({
    date: r.record_date,
    text: `On ${longDate(r.record_date)}, the total US public debt outstanding was ${trillions(r.tot_pub_debt_out_amt)}, with ${trillions(r.debt_held_public_amt)} held by the public and ${trillions(r.intragov_hold_amt)} in intragovernmental holdings.`,
  }));

  const rates = await fiscal<{ record_date: string; security_type_desc: string; security_desc: string; avg_interest_rate_amt: string }>(fetchPage, "v2/accounting/od/avg_interest_rates");
  const rateFacts = rates.filter((r) => number(r.avg_interest_rate_amt)).map((r) => ({
    date: r.record_date,
    text: `On ${longDate(r.record_date)}, the average interest rate on US Treasury ${r.security_type_desc.toLowerCase()} debt, ${r.security_desc}, was ${Number(r.avg_interest_rate_amt).toFixed(3)} percent.`,
  }));

  const statement = await fiscal<{ record_date: string; parent_id: string; classification_id: string; classification_desc: string; current_month_gross_rcpt_amt: string; current_month_gross_outly_amt: string; record_fiscal_year: string }>(fetchPage, "v1/accounting/mts/mts_table_1");
  const fiscalYears = new Map(statement.filter((r) => r.parent_id === "null").map((r) => [`${r.record_date}|${r.classification_id}`, r.classification_desc]));
  const statementFacts = statement
    .filter((r) => r.classification_desc === MONTHS[Number(r.record_date.slice(5, 7)) - 1] && fiscalYears.get(`${r.record_date}|${r.parent_id}`) === `FY ${r.record_fiscal_year}` && number(r.current_month_gross_rcpt_amt) && number(r.current_month_gross_outly_amt))
    .map((r) => {
      const balance = Number(r.current_month_gross_rcpt_amt) - Number(r.current_month_gross_outly_amt);
      return {
        date: r.record_date,
        text: `For ${r.classification_desc} ${r.record_date.slice(0, 4)}, the Monthly Treasury Statement reported federal receipts of ${billions(r.current_month_gross_rcpt_amt)}, outlays of ${billions(r.current_month_gross_outly_amt)} and a ${balance < 0 ? "deficit" : "surplus"} of ${billions(String(balance))}.`,
      };
    });

  const csv = await fetchPage(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${FROM.slice(0, 4)}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${FROM.slice(0, 4)}&page&_format=csv`);
  const lines = (csv ?? "").trim().split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((c) => c.replace(/"/g, "").trim());
  const curveFacts: Fact[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const [m, d, y] = (cells[0] ?? "").split("/");
    if (!y) continue;
    const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const points = header.slice(1).map((label, i) => (number(cells[i + 1]) ? `${Number(cells[i + 1]).toFixed(2)} percent for ${label.replace(/\bMo\b/, "month").replace(/\bMonth\b/, "month").replace(/\bYr\b/, "year")}` : "")).filter(Boolean);
    if (points.length) curveFacts.push({ date, text: `On ${longDate(date)}, the Treasury par yield curve rates were ${points.join(", ")}.` });
  }

  const common = { source: "US Treasury", license: TREASURY_LICENSE };
  return [
    ...monthly(debtFacts, { ...common, id: "us-treasury-debt", subject: "US public debt to the penny", url: "https://fiscaldata.treasury.gov/datasets/debt-to-the-penny/" }),
    ...monthly(rateFacts, { ...common, id: "us-treasury-avg-rates", subject: "Average interest rates on US Treasury securities", url: "https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/" }),
    ...monthly(statementFacts, { ...common, id: "us-treasury-mts", subject: "Monthly Treasury Statement", url: "https://fiscaldata.treasury.gov/datasets/monthly-treasury-statement/" }),
    ...monthly(curveFacts, { ...common, id: "us-treasury-yields", subject: "Treasury par yield curve rates", url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates" }),
  ];
}

// OFAC

const OFAC = "https://ofac.treasury.gov";
/** A sanctions list entry: identifiers of a person or company, not prose. These never reach the corpus. */
const OFAC_ENTRY = /\b(DOB|POB|Passport|nationality|Gender|Digital Currency Address|Linked To|Registration Number|Tax ID|National ID|Organization Established Date|Secondary sanctions risk|Website)\b|\(individual\)|a\.k\.a\.|\[[A-Z0-9-]+\]\s*\.?\s*$/;

/** One action's body as sentences: each "The following X" list becomes a count, and its entries are dropped. */
function ofacBody(html: string): string {
  const start = html.indexOf("field--name-field-body");
  if (start < 0) return "";
  const end = html.indexOf("</article>", start);
  const body = html.slice(html.indexOf(">", start) + 1, end > 0 ? end : undefined).replace(/<div class="field__label[^>]*>[\s\S]*?<\/div>/, "");
  const out: string[] = [];
  let list: { label: string; count: number } | null = null;
  const flush = () => {
    if (list) {
      const label = list.label.replace(/:\s*$/, "");
      const one = label.replace(/^(\S+?)ies\b/, "$1y").replace(/^(\S+?)s\b/, "$1").replace(/\bhave been\b/, "has been");
      out.push(sentence(`${list.count} ${list.count === 1 ? one : label}`));
    }
    list = null;
  };
  for (const [, tagName, inner] of body.matchAll(/<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const text = htmlToText(inner);
    if (!text) continue;
    const following = /^h/.test(tagName) ? text.match(/^The following (.+)$/i) : null;
    if (following) {
      flush();
      list = { label: following[1], count: 0 };
    } else if (/^h/.test(tagName)) {
      flush();
    } else if (list) {
      /** Several entries can share one paragraph, a line each. */
      list.count += inner.split(/<br\s*\/?>/i).filter((line) => htmlToText(line)).length;
    } else if (text !== "None" && !OFAC_ENTRY.test(text)) {
      out.push(text);
    }
  }
  flush();
  return out.join(" ");
}

async function ofacActions(): Promise<SourceRecord[]> {
  const fetchPage = fetcher();
  const facts: Fact[] = [];
  for (let page = 0; !pauseRequested(); page++) {
    const html = await fetchPage(`${OFAC}/recent-actions?page=${page}`);
    const rows = html?.match(/<div class="margin-bottom-4 search-result views-row">[\s\S]*?<\/a><\/div><\/div><\/div>/g) ?? [];
    if (rows.length === 0) break;
    let older = false;
    for (const row of rows) {
      const link = row.match(/<a href="(\/recent-actions\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const stamp = row.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})/);
      if (!link || !stamp) continue;
      const date = new Date(`${stamp[1]} UTC`).toISOString().slice(0, 10);
      if (date < FROM) older = true;
      if (!inWindow(date)) continue;
      const title = htmlToText(link[2]);
      const detail = await fetchPage(`${OFAC}${link[1]}`);
      const releases = [...(detail?.match(/field--name-field-press-release-link[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)?.[0] ?? "").matchAll(/<a href="[^"]+"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => htmlToText(m[1])).filter((r) => !/^PRESS CHART/i.test(r));
      const parts = [
        `On ${longDate(date)}, the Treasury's Office of Foreign Assets Control (OFAC) published the recent action "${title}".`,
        releases.length ? `Treasury's press release${releases.length > 1 ? "s were" : " was"} titled ${releases.map((r) => `"${r}"`).join(" and ")}.` : "",
        detail ? ofacBody(detail) : "",
      ];
      facts.push({ date, text: parts.filter(Boolean).join(" ") });
      if (SAMPLING && facts.length >= LIMIT) older = true;
    }
    if (older) break;
  }
  return monthly(facts, { id: "us-ofac", source: "OFAC recent actions", subject: "OFAC recent actions", url: `${OFAC}/recent-actions`, license: license("Office of Foreign Assets Control, US Treasury") });
}

// Supreme Court

const SCOTUS = "https://www.supremecourt.gov";
const JUSTICES: Record<string, string> = { R: "Chief Justice Roberts", T: "Justice Thomas", A: "Justice Alito", SS: "Justice Sotomayor", EK: "Justice Kagan", NG: "Justice Gorsuch", BK: "Justice Kavanaugh", AB: "Justice Barrett", KJ: "Justice Jackson" };

/** Dates and captions from the listing tables, with the one-line holding the Court's site gives each opinion. */
async function supremeCourt(): Promise<SourceRecord[]> {
  const fetchPage = fetcher();
  const facts: Fact[] = [];
  for (const [path, verb] of [["slipopinion/25", "decided"], ["relatingtoorders/25", "issued an opinion relating to orders in"]]) {
    const html = await fetchPage(`${SCOTUS}/opinions/${path}`);
    for (const [, row] of (html ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
      const when = htmlToText(cells[1] ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      const link = cells[3]?.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/);
      if (!when || !link) continue;
      const date = `20${when[3]}-${when[1].padStart(2, "0")}-${when[2].padStart(2, "0")}`;
      const author = htmlToText(cells[4] ?? "");
      const holding = htmlToText(link[1].match(/title="([^"]*)"/)?.[1] ?? "");
      const by = author === "PC" ? " in an unsigned per curiam opinion" : JUSTICES[author] ? ` in an opinion by ${JUSTICES[author]}` : "";
      facts.push({ date, text: `On ${longDate(date)}, the Supreme Court ${verb} ${htmlToText(link[2])} (No. ${htmlToText(cells[2] ?? "")})${by}.${holding ? ` ${sentence(holding)}` : ""}` });
    }
  }
  return monthly(facts, { id: "us-scotus", source: "Supreme Court of the United States", subject: "Supreme Court opinions of the 2025 term", url: `${SCOTUS}/opinions/slipopinion/25`, license: license("Supreme Court of the United States") });
}

// CFTC

/** The largest and best known markets; there are about 380 in each weekly report, most of them obscure power and gas hubs. */
const CFTC_MARKETS: Record<string, string> = {
  "WTI-PHYSICAL": "WTI crude oil",
  "NAT GAS NYME": "natural gas",
  "GASOLINE RBOB": "RBOB gasoline",
  GOLD: "gold",
  SILVER: "silver",
  "COPPER- #1": "copper",
  CORN: "corn",
  SOYBEANS: "soybeans",
  "WHEAT-SRW": "soft red winter wheat",
  "SUGAR NO. 11": "sugar",
  "COTTON NO. 2": "cotton",
  "LIVE CATTLE": "live cattle",
  "E-MINI S&P 500": "E-mini S&P 500",
  "VIX FUTURES": "VIX",
  "UST 2Y NOTE": "2-year Treasury note",
  "UST 10Y NOTE": "10-year Treasury note",
  "UST BOND": "Treasury bond",
  "FED FUNDS": "30-day federal funds",
  "SOFR-3M": "3-month SOFR",
  "EURO FX": "euro",
  "JAPANESE YEN": "Japanese yen",
  BITCOIN: "Bitcoin",
};

interface CotRow {
  contract_market_name: string;
  market_and_exchange_names: string;
  report_date_as_yyyy_mm_dd: string;
  open_interest_all: string;
  noncomm_positions_long_all: string;
  noncomm_positions_short_all: string;
  comm_positions_long_all: string;
  comm_positions_short_all: string;
}

const count = (s: string) => Number(s).toLocaleString("en-US");

async function cftc(): Promise<SourceRecord[]> {
  const names = Object.keys(CFTC_MARKETS).map((n) => `'${n}'`).join(",");
  const q = new URLSearchParams({
    $select: "contract_market_name,market_and_exchange_names,report_date_as_yyyy_mm_dd,open_interest_all,noncomm_positions_long_all,noncomm_positions_short_all,comm_positions_long_all,comm_positions_short_all",
    $where: `report_date_as_yyyy_mm_dd between '${FROM}T00:00:00' and '${TO}T00:00:00' and contract_market_name in(${names})`,
    $order: "report_date_as_yyyy_mm_dd",
    $limit: "50000",
  });
  const body = await fetcher()(`https://publicreporting.cftc.gov/resource/6dca-aqww.json?${q}`);
  const rows = body ? (JSON.parse(body) as CotRow[]) : [];
  const facts = rows.map((r) => {
    const date = r.report_date_as_yyyy_mm_dd.slice(0, 10);
    const exchange = r.market_and_exchange_names.split(" - ").pop()!.trim();
    return {
      date,
      text: `As of ${longDate(date)}, the CFTC Commitments of Traders report showed open interest of ${count(r.open_interest_all)} contracts in ${CFTC_MARKETS[r.contract_market_name]} futures on ${exchange.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ Of /g, " of ")}, with non-commercial traders holding ${count(r.noncomm_positions_long_all)} long and ${count(r.noncomm_positions_short_all)} short and commercial traders holding ${count(r.comm_positions_long_all)} long and ${count(r.comm_positions_short_all)} short.`,
    };
  });
  return monthly(facts, { id: "us-cftc-cot", source: "CFTC Commitments of Traders", subject: "CFTC Commitments of Traders, futures only", url: "https://publicreporting.cftc.gov/", license: license("US Commodity Futures Trading Commission") });
}

// USDA NASS

const NASS = "https://www.nass.usda.gov/datasets";
const NASS_LICENSE = `${license("USDA National Agricultural Statistics Service")}. Not endorsed or certified by NASS`;
const NASS_UNITS: Record<string, string> = { PCT: "percent", BU: "bushels", LB: "pounds", CWT: "hundredweight", "$": "dollars", HEAD: "head", ACRES: "acres", TONS: "tons" };
const MONTH_CODES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** About this much of a file, compressed, in a small test. The files are unordered, so this is a fair sample of them. */
const NASS_SAMPLE_BYTES = 20_000_000;

function nassUnit(unit: string): string {
  return unit.split(/\s*\/\s*/).map((u, i) => {
    const [first, ...rest] = u.trim().split(/\s+/);
    const word = NASS_UNITS[first] ?? first.toLowerCase();
    return [i > 0 ? word.replace(/s$/, "") : word, ...rest.map((w) => w.toLowerCase())].join(" ");
  }).join(" per ");
}

/** One national estimate as a sentence, or null if the row is withheld or isn't readable. */
function nassFact(row: Record<string, string>): Fact | null {
  const value = row.VALUE?.trim();
  if (!value || !/^[\d,.]+$/.test(value)) return null;
  const loaded = row.LOAD_TIME?.slice(0, 10);
  const weekEnding = row.WEEK_ENDING?.slice(0, 10);
  const date = row.FREQ_DESC === "WEEKLY" && weekEnding ? weekEnding : loaded;
  if (!inWindow(loaded) || !inWindow(date)) return null;
  /** Last year's totals first appear in this window; last year's months and weeks here are only revisions, so they go. */
  if (row.YEAR !== FROM.slice(0, 4) && !/^(YEAR|MARKETING YEAR)/.test(row.REFERENCE_PERIOD_DESC)) return null;
  const [what, stat] = row.SHORT_DESC.split(" - ");
  if (!stat) return null;
  const measure = stat.replace(/,?\s*MEASURED IN .*$/, "").toLowerCase();
  const month = MONTH_CODES.indexOf(row.REFERENCE_PERIOD_DESC);
  const period = row.FREQ_DESC === "WEEKLY" && weekEnding
    ? `the week ending ${longDate(weekEnding)}`
    : month >= 0
      ? `${MONTHS[month]} ${row.YEAR}`
      : row.REFERENCE_PERIOD_DESC === "YEAR"
        ? String(row.YEAR)
        : `${row.YEAR}, ${row.REFERENCE_PERIOD_DESC.toLowerCase().replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/, (m) => MONTHS[MONTH_CODES.indexOf(m.toUpperCase())])}`;
  return { date, text: `USDA NASS reported US ${measure} of ${value} ${nassUnit(row.UNIT_DESC)} for ${what.toLowerCase()}, for ${period}, in data published by ${longDate(loaded!)}.` };
}

/**
 * The one step that doesn't use `get`: these are gzip files of about a gigabyte, too big to hold or cache as text, so
 * each is streamed once and only national estimates are kept. A small test reads just the start of one.
 */
async function nass(): Promise<SourceRecord[]> {
  const listing = await fetcher()(`${NASS}/`);
  const files = [...new Set((listing ?? "").match(/qs\.(crops|animals_products)_\d{8}\.txt\.gz/g) ?? [])].sort();
  const facts: Fact[] = [];
  for (const file of SAMPLING ? files.slice(0, 1) : files) {
    const res = await fetch(`${NASS}/${file}`, { headers: { "User-Agent": USER_AGENT, ...(SAMPLING ? { Range: `bytes=0-${NASS_SAMPLE_BYTES}` } : {}) } });
    if (!res.ok || !res.body) {
      console.warn(`${res.status} ${file}`);
      continue;
    }
    /** A sync flush lets a test read a file cut short without an error at the end. */
    const lines = createInterface({ input: Readable.fromWeb(res.body as unknown as NodeWebStream).pipe(createGunzip({ finishFlush: constants.Z_SYNC_FLUSH })), crlfDelay: Infinity });
    let columns: string[] | null = null;
    for await (const line of lines) {
      if (pauseRequested()) break;
      const cells = line.split("\t");
      if (!columns) {
        columns = cells;
        continue;
      }
      /** Cheap checks on the raw line first: only a few rows in a million are this year's national totals. */
      if (!line.includes("\tNATIONAL\t") || !line.startsWith("SURVEY\t") || !/\t202[56]\t/.test(line)) continue;
      const row = Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ""]));
      if (row.DOMAIN_DESC !== "TOTAL") continue;
      const fact = nassFact(row);
      if (fact) facts.push(fact);
    }
  }
  return monthly(facts, { id: "us-nass", source: "USDA NASS Quick Stats", subject: "USDA national agricultural estimates", url: `${NASS}/`, license: NASS_LICENSE });
}

// White House

const WH_THIRD_PARTY = /^(ICYMI|WTAS|What They Are Saying|MUST READ|ICYMI:)/i;

/** The article between its top banner and whatever follows it, or empty if the page isn't laid out that way. */
function whiteHouseBody(html: string): string {
  const main = html.slice(Math.max(html.indexOf("<main"), 0));
  const first = main.indexOf('<p class="wp-block-paragraph"');
  if (first < 0) return "";
  const stops = [main.indexOf("</main>", first), main.indexOf('wp-block-query', first), main.indexOf("wp-block-whitehouse-related", first)].filter((i) => i > 0);
  return htmlToText(main.slice(first, stops.length ? Math.min(...stops) : undefined))
    .split(/\n\s*\n/)
    .filter((p) => !/^Learn more$|Download$/i.test(p.trim()))
    .join("\n\n");
}

/** The sitemap's URLs carry year and month, so only this window's pages are fetched. */
async function whiteHouse(): Promise<SourceRecord[]> {
  const fetchPage = fetcher();
  const index = await fetchPage("https://www.whitehouse.gov/sitemap_index.xml");
  const maps = [...(index ?? "").matchAll(/<loc>([^<]*\/post-sitemap\d*\.xml)<\/loc>/g)].map((m) => m[1]).reverse();
  const records: SourceRecord[] = [];
  const firstMonth = FROM.slice(0, 7).replace("-", "/");
  const lastMonth = TO.slice(0, 7).replace("-", "/");
  for (const map of maps) {
    const xml = await fetchPage(map);
    const urls = [...(xml ?? "").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).reverse();
    for (const url of urls) {
      const ym = url.match(/\/(\d{4}\/\d{2})\//)?.[1];
      if (!ym || ym < firstMonth || ym > lastMonth) continue;
      if (pauseRequested() || (SAMPLING && records.length >= LIMIT)) break;
      const html = await fetchPage(url);
      if (!html) {
        if (SAMPLING) break;
        continue;
      }
      /** The first <time> is the post's own, in Eastern time; the meta tag is UTC and can land on the next day. */
      const date = html.match(/<time datetime="(\d{4}-\d{2}-\d{2})/)?.[1] ?? html.match(/article:published_time" content="(\d{4}-\d{2}-\d{2})/)?.[1];
      if (!inWindow(date)) continue;
      const title = htmlToText(html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "").replace(/\s*[-–]\s*The White House\s*$/, "");
      if (WH_THIRD_PARTY.test(title)) continue;
      const text = whiteHouseBody(html);
      const kind = url.split("/")[3].replace(/-/g, " ");
      if (text) records.push({ id: `us-whitehouse:${url.replace(/^https:\/\/www\.whitehouse\.gov\//, "").replace(/\/$/, "")}`, source: "The White House", title, url, date, license: license("The White House"), visibility: "public", text: `On ${longDate(date)}, the White House published "${title}" under ${kind}.\n\n${text}` });
    }
  }
  return records;
}

// DOJ

/** A headline about one person's case: the personal-data rule drops these, whoever they are. */
const DOJ_CASE = /sentenc|plead|pled\b|guilty|convict|indict|charged?\b|charges\b|arrest|arraign|extradit|jury|fugitive|\b(man|woman|men|women|resident|teen|couple|brothers|sisters|doctor|nurse|attorney for|citizen|national)\b|admits|alleged|accused|murder|trafficker|fraudster|defendant|inmate|prison|detain|removed from|deport|illegal alien|reentry|re-entry|forfeit|kidnap|robber|shooting|firearm|bank fraud|wire fraud|tax evasion|smuggl|child (sexual|exploit|porn)|execution of|search warrant|former\b/i;
/** A company or institution in a civil resolution, or the Department speaking about policy. */
const DOJ_KEEP = /\b(Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Company|Co\.|Ltd\.?|LP|L\.P\.|PLC|Bank|Holdings|Group|Hospital|University|Health|Systems)\b.*\b(settle|agree|pay|resolv|consent decree|lawsuit|sues?|antitrust|acquisition|merger|civil penalt)|\b(settle|agree|pay|resolv|consent decree|lawsuit|sues?|antitrust|acquisition|merger|civil penalt).*\b(Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Company|Co\.|Ltd\.?|LP|L\.P\.|PLC|Bank|Holdings|Group|Hospital|University|Health|Systems)\b|\b(Justice Department|Department of Justice|Attorney General|Antitrust Division)\b.*\b(announces?|issues?|publish|launch|propos|statement of interest|guidance|policy|rule|memorandum|task force|initiative|report|strategy|sues?|files? (suit|lawsuit)|settle|grants?|fund)/i;
/** A person named with an age and home town, as DOJ names defendants, or by the words that mark a named party. */
const DOJ_NAMES_PERSON = /[A-Z][\w'-]+,\s+\d{2},\s+(of|from)\s+[A-Z]|a\/k\/a|\baka\b|\b(defendants?|owner|founder|CEO|chief executive|president of|employee of|relator|whistleblower)\s+[A-Z][a-z]+\s+[A-Z]|[A-Z][a-z]+\s+[A-Z][a-z]+,\s+(the\s+)?(owner|founder|CEO|chief executive|former)\b/;

interface DojRelease {
  uuid: string;
  title: string;
  url: string;
  date: string;
  body: string;
  component?: Array<{ name: string }>;
}

/** Text with sentences about the person who brought a whistleblower suit taken out, and the contact lines at the end. */
function dojText(body: string): string {
  return htmlToText(body)
    .split(/\n\s*\n/)
    .map((p) => p.split(/(?<=[.!?])\s+/).filter((s) => !/\b(relator|whistleblower|qui tam)\b/i.test(s)).join(" "))
    .filter((p) => p.trim() && !/^(Contact|Press Office|Updated|Component|Topic|Press Release Number)\b/i.test(p.trim()))
    .join("\n\n");
}

async function dojPress(): Promise<SourceRecord[]> {
  const fetchPage = fetcher(10_000);
  const records: SourceRecord[] = [];
  const seen = new Set<string>();
  for (let page = 0; !pauseRequested(); page++) {
    const body = await fetchPage(`https://www.justice.gov/api/v1/press_releases.json?pagesize=50&sort=date&direction=DESC&page=${page}`);
    const results = body ? ((JSON.parse(body) as { results?: DojRelease[] }).results ?? []) : [];
    if (results.length === 0) break;
    let older = false;
    for (const r of results) {
      const date = new Date(Number(r.date) * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      if (date < FROM) older = true;
      if (!inWindow(date)) continue;
      const title = htmlToText(r.title);
      /** The same release comes back once per component that posted it. */
      if (seen.has(r.url) || DOJ_CASE.test(title) || !DOJ_KEEP.test(title)) continue;
      seen.add(r.url);
      const text = dojText(r.body ?? "");
      if (!text || DOJ_NAMES_PERSON.test(text)) continue;
      records.push({ id: `us-doj:${r.uuid}`, source: "US Department of Justice press releases", title, url: r.url, date, license: license("US Department of Justice"), visibility: "public", text: `On ${longDate(date)}, the Department of Justice published "${title}".\n\n${text}` });
    }
    if (older || (SAMPLING && records.length >= LIMIT)) break;
  }
  return records;
}

runAll([
  ["us-federal-register", federalRegister],
  ["us-federal-register-presidential", federalRegisterPresidential],
  ["us-govinfo-billstatus", billStatus],
  ["us-govinfo-plaw", publicLaws],
  ["us-gao", gaoReports],
  ["us-fed-fomc", () => fedReleases((r) => r.pt === "Monetary Policy", "us-fed-fomc", "Federal Reserve monetary policy releases")],
  ["us-fed-press", () => fedReleases((r) => r.pt !== "Monetary Policy" && !(r.pt === "Enforcement Actions" && FED_PERSONAL.test(r.t)), "us-fed-press", "Federal Reserve press releases")],
  ["us-treasury", treasury],
  ["us-ofac", ofacActions],
  ["us-scotus", supremeCourt],
  // Not run: www.cftc.gov's robots.txt says ai-train=no, and the opt-out rule treats that as the agency's answer.
  ["us-nass", nass],
  ["us-whitehouse", whiteHouse],
  ["us-doj", dojPress],
]).catch((err) => {
  console.error(err);
  process.exit(1);
});

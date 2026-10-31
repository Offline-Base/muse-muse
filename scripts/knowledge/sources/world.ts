/**
 * Collects what happened in the world from open sources: Wikidata dated statements, football, cricket and NFL results,
 * TV schedules, vehicle recalls and fuel economy listings, US airline punctuality, Global Voices, VOA, Kremlin.ru, UN News,
 * Agência Brasil, GDELT summaries and Wikisource. Structured data becomes dated sentences, grouped by source and month.
 * Writes .data/knowledge/sources/<step>.jsonl. Everything goes through a polite cache, so a rerun only fetches what's
 * missing. LIMIT=n also shrinks each source to a small sample of requests (see `few`), for a test.
 *
 * Left out on purpose: GLEIF (about 1,650 new LEIs each working day, so not a small delta); DVIDS (the API needs a key, its
 * RSS only holds the latest 20 summaries, and its robots.txt couldn't be read); datahub.transportation.gov for recalls
 * (robots.txt disallows everything, so recalls come from NHTSA's own flat file); github.com/.../releases/download (robots.txt
 * disallows it, so nflverse files come through the REST API); MusicBrainz, Discogs, Open Library (another job).
 *
 *   npx tsx scripts/knowledge/sources/world.ts [step ...]
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync, gunzipSync } from "node:zlib";
import { longDate } from "@/lib/knowledge/passages";
import { htmlToText, type SourceRecord } from "@/lib/knowledge/sources";
import { CACHE, FROM, get, LIMIT, pauseRequested, runAll, TO, USER_AGENT } from "./common";

const SAMPLE = Number.isFinite(LIMIT);
/** The whole list on a full run, its first n items in a LIMIT test, so a test stays at about a dozen requests. */
const few = <T>(all: T[], n: number): T[] => (SAMPLE ? all.slice(0, n) : all);

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const inWindow = (date: string) => date >= FROM && date <= TO;
const utcDate = (text: string) => {
  const t = Date.parse(text);
  return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10);
};

function windowDays(): string[] {
  const days: string[] = [];
  for (let d = FROM; d <= TO; d = addDays(d, 1)) days.push(d);
  return days;
}

/** The window's months as [from, to] day pairs, the first and last clipped to the window. */
function windowMonths(): Array<[string, string]> {
  const months: Array<[string, string]> = [];
  for (let m = 1; m <= Number(TO.slice(5, 7)); m++) {
    const first = `2026-${String(m).padStart(2, "0")}-01`;
    const last = addDays(m === 12 ? "2027-01-01" : `2026-${String(m + 1).padStart(2, "0")}-01`, -1);
    months.push([first < FROM ? FROM : first, last > TO ? TO : last]);
  }
  return months;
}

const monthName = (ym: string) => longDate(`${ym}-01`).replace(/ 1,/, "");
const monthEnd = (ym: string) => windowMonths().find(([from]) => from.startsWith(ym))?.[1] ?? TO;

interface Fact {
  date: string;
  text: string;
}

interface DocInfo {
  id: string;
  source: string;
  what: string;
  url: string;
  license: string;
  visibility: SourceRecord["visibility"];
}

/** Facts as one document per month, dated the month's last day in the window, with facts outside the window dropped. */
function byMonth(facts: Fact[], info: DocInfo): SourceRecord[] {
  const months = new Map<string, Set<string>>();
  for (const f of [...facts].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!inWindow(f.date)) continue;
    const ym = f.date.slice(0, 7);
    if (!months.has(ym)) months.set(ym, new Set());
    months.get(ym)!.add(f.text);
  }
  return [...months].map(([ym, texts]) => ({
    id: `${info.id}:${ym}`,
    source: info.source,
    title: `${info.what}, ${monthName(ym)}`,
    url: info.url,
    date: monthEnd(ym),
    license: info.license,
    visibility: info.visibility,
    text: [...texts].join("\n\n"),
  }));
}

const lastBinary = new Map<string, number>();

/** `get` for zip and gzip files, which can't pass through text: same gap per host and same retries, cached unless told not to. */
async function getBytes(url: string, opts: { gapMs?: number; cache?: boolean } = {}): Promise<Buffer | null> {
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.bin`);
  if (existsSync(file)) return readFile(file);
  const host = new URL(url).host;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = (lastBinary.get(host) ?? 0) + (opts.gapMs ?? 1000) - Date.now();
    lastBinary.set(host, Date.now() + Math.max(wait, 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(600_000) });
    } catch {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if (res.ok) {
      const body = Buffer.from(await res.arrayBuffer());
      if (opts.cache !== false) await writeFile(file, body);
      return body;
    }
    if (res.status !== 429 && res.status < 500) {
      console.warn(`${res.status} ${url}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 0) * 1000 || 15_000 * (attempt + 1)));
  }
  console.warn(`gave up on ${url}`);
  return null;
}

/** A zip's files by name, each inflated only when asked for. */
function unzip(zip: Buffer): Map<string, () => Buffer> {
  const files = new Map<string, () => Buffer>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  if (end < 0) return files;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    files.set(zip.toString("utf8", at + 46, at + 46 + nameLength), () => {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

function csvLine(line: string, sep = ","): string[] {
  if (!line.includes('"')) return line.split(sep);
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '"' && line[i + 1] === '"') {
      cell += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === sep && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += c;
    }
  }
  cells.push(cell);
  return cells;
}

/** CSV rows as objects keyed by the header. Assumes no line breaks inside a cell, true of every file read here. */
function csvRows(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = csvLine(lines[0] ?? "");
  return lines.slice(1).map((line) => {
    const cells = csvLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

const AI_AGENTS = /ccbot|gptbot|google-extended|claudebot|anthropic-ai|applebot-extended|meta-externalagent|bytespider/i;

/** True if the site's robots.txt shuts out AI-training crawlers or everyone, or carries a training opt-out signal. */
async function robotsBlocksTraining(origin: string): Promise<boolean> {
  const robots = await get(`${origin}/robots.txt`);
  if (!robots) return false;
  if (/content-signal:.*ai-train\s*=\s*no|content-usage:.*train-ai\s*=\s*n/i.test(robots)) return true;
  let agents: string[] = [];
  let inRules = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const agent = line.match(/^user-agent:\s*(.+)$/i)?.[1];
    if (agent) {
      if (inRules) agents = [];
      inRules = false;
      agents.push(agent);
    } else if (/^(dis)?allow:/i.test(line)) {
      inRules = true;
      if (/^disallow:\s*\/\s*$/i.test(line) && agents.some((a) => a === "*" || AI_AGENTS.test(a))) return true;
    }
  }
  return false;
}

/** Runs a source only if its site still allows it on the day of the run. */
const ifAllowed = (origin: string, run: () => Promise<SourceRecord[]>) => async () => {
  if (await robotsBlocksTraining(origin)) {
    console.warn(`${origin}: robots.txt blocks AI training crawlers, skipped.`);
    return [];
  }
  return run();
};

/** A tag's content in a feed item, without any CDATA wrapper. */
const xmlTag = (xml: string, name: string) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>(?:\\s*<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>\\s*)?</${name}>`))?.[1] ?? "";
/** Feed HTML to text; some feeds escape their HTML once more, which takes a second pass. */
const feedText = (raw: string) => (/&lt;\/?[a-z]/i.test(raw) ? htmlToText(htmlToText(raw)) : htmlToText(raw)).replace(/\u00a0|&nbsp;/g, " ");
const feedItems = (xml: string | null) => xml?.match(/<item\b[\s\S]*?<\/item>/g) ?? [];

/** Where the element opening at `start` closes, counting nested elements of the same name. */
function blockEnd(html: string, start: number, name: string): number {
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return html.length;
}

/** HTML without the blocks whose class matches, nested contents included. */
function dropBlocks(html: string, classes: string): string {
  const re = new RegExp(`<(div|table|span|ul|ol|style)\\b[^>]*class="[^"]*(?:${classes})[^"]*"[^>]*>`, "i");
  let out = html;
  for (let m = re.exec(out); m; m = re.exec(out)) out = out.slice(0, m.index) + " " + out.slice(blockEnd(out, m.index, m[1]));
  return out;
}

// Wikidata SPARQL. Date range first (the rangeSafe hint keeps it under the 60-second timeout), day precision only, because a
// year or month precision date is stored as the first of that period and would read as a false exact date.

const WIKIDATA_LICENSE = "CC0 1.0, credit Wikidata (wikidata.org)";
const LABELS = `SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }`;
const between = (from: string, toExclusive: string) => `FILTER(?d >= "${from}T00:00:00Z"^^xsd:dateTime && ?d < "${toExclusive}T00:00:00Z"^^xsd:dateTime)`;
const DAY_PRECISION = "?v wikibase:timeValue ?d; wikibase:timePrecision ?p. FILTER(?p >= 11)";

const itemDated = (prop: string, where: string) => (from: string, toExclusive: string) =>
  `SELECT ?item ?itemLabel ?itemDescription ?d ?xLabel WHERE { ?item wdt:${prop} ?d. hint:Prior hint:rangeSafe true. ${between(from, toExclusive)} ?item p:${prop} ?st. ?st psv:${prop} ?v. ${DAY_PRECISION} ${where} ${LABELS} }`;

const statementDated = (prop: string, qualifier: string) => (from: string, toExclusive: string) =>
  `SELECT ?item ?itemLabel ?itemDescription ?d ?xLabel WHERE { ?st pq:${qualifier} ?d. hint:Prior hint:rangeSafe true. ${between(from, toExclusive)} ?item p:${prop} ?st. ?st ps:${prop} ?x; pqv:${qualifier} ?v. ${DAY_PRECISION} ?item wikibase:sitelinks ?n. FILTER(?n > 0) ${LABELS} }`;

const isClass = (...classes: string[]) => `VALUES ?c { ${classes.map((c) => `wd:${c}`).join(" ")} } ?item wdt:P31 ?c.`;

interface WikidataClass {
  name: string;
  what: string;
  /** Days per query; heavy classes need less than a month. */
  days: number;
  query: (from: string, toExclusive: string) => string;
  /** Keep one date per item, its earliest in the range, as with a film's many national releases. */
  earliest?: boolean;
  keep?: (label: string, description: string, extras: string[]) => boolean;
  sentence: (who: string, when: string, extras: string[]) => string;
}

const names = (extras: string[], max = 4) => extras.slice(0, max).join(", ");
const plural = (n: number | string, word: string) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;
const by = (extras: string[]) => (extras.length ? `, by ${names(extras)}` : "");
const NOT_WORK_AWARD = /wikivoyage|wikipedia|wikimedia|previously|featured|of the month/i;

const WIKIDATA_CLASSES: WikidataClass[] = [
  {
    name: "deaths",
    what: "Deaths",
    days: 31,
    // People with a Wikipedia article or the like: a bare Wikidata entry may be a private person.
    query: itemDated("P570", "?item wdt:P31 wd:Q5; wikibase:sitelinks ?n. FILTER(?n > 0) OPTIONAL { ?item wdt:P20 ?x. }"),
    sentence: (who, when, extras) => `${who} died on ${when}${extras.length ? ` in ${extras[0]}` : ""}.`,
  },
  {
    name: "films",
    what: "Film releases",
    days: 31,
    earliest: true,
    query: itemDated("P577", `${isClass("Q11424", "Q202866", "Q93204", "Q24869")} OPTIONAL { ?st pq:P291 ?x. }`),
    sentence: (who, when, extras) => `${who} was released on ${when}${extras.length ? ` in ${names(extras)}` : ""}.`,
  },
  {
    name: "games",
    what: "Video game releases",
    days: 31,
    earliest: true,
    query: itemDated("P577", `${isClass("Q7889")} OPTIONAL { ?item wdt:P178 ?x. }`),
    sentence: (who, when, extras) => `${who} was released on ${when}${by(extras)}.`,
  },
  {
    name: "albums",
    what: "Album releases",
    days: 31,
    earliest: true,
    query: itemDated("P577", `${isClass("Q482994", "Q169930")} OPTIONAL { ?item wdt:P175 ?x. }`),
    sentence: (who, when, extras) => `${who} was released on ${when}${by(extras)}.`,
  },
  {
    name: "books",
    what: "Book publications",
    days: 31,
    earliest: true,
    query: itemDated("P577", `${isClass("Q7725634", "Q571", "Q8261", "Q47461344")} OPTIONAL { ?item wdt:P50 ?x. }`),
    sentence: (who, when, extras) => `${who} was published on ${when}${by(extras)}.`,
  },
  {
    name: "awards",
    what: "Awards received",
    days: 31,
    query: statementDated("P166", "P585"),
    keep: (_label, _description, extras) => extras.some((e) => !NOT_WORK_AWARD.test(e)),
    sentence: (who, when, extras) => `${who} received the ${names(extras.filter((e) => !NOT_WORK_AWARD.test(e)))} on ${when}.`,
  },
  {
    name: "office-starts",
    what: "People taking office",
    days: 7,
    query: statementDated("P39", "P580"),
    sentence: (who, when, extras) => `${who} took office as ${names(extras)} on ${when}.`,
  },
  {
    name: "office-ends",
    what: "People leaving office",
    days: 7,
    query: statementDated("P39", "P582"),
    sentence: (who, when, extras) => `${who} left office as ${names(extras)} on ${when}.`,
  },
  {
    name: "elections",
    what: "Elections",
    days: 31,
    query: (from, toExclusive) =>
      `SELECT ?item ?itemLabel ?itemDescription ?d ?xLabel WHERE { ?item wdt:P585 ?d. hint:Prior hint:rangeSafe true. ${between(from, toExclusive)} ?item wdt:P31/wdt:P279* wd:Q40231; p:P585 ?st. ?st psv:P585 ?v. ${DAY_PRECISION} OPTIONAL { ?item wdt:P991 ?x. } ?item wikibase:sitelinks ?n. FILTER(?n > 0 || BOUND(?x)) ${LABELS} }`,
    // Placeholders for future votes and votes called off aren't events that happened.
    keep: (label, description) => !/^next\b/i.test(label) && !/annul|cancel|postpone|planned|scheduled|upcoming|future/i.test(`${label} ${description}`),
    sentence: (who, when, extras) => (extras.length ? `${who} took place on ${when}. Wikidata lists these winners: ${names(extras, 8)}.` : `${who} is recorded with the date ${when}.`),
  },
];

type Row = Record<string, string>;

async function sparql(query: string): Promise<Row[] | null> {
  const body = await get(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, { gapMs: 1500 });
  if (!body) return null;
  try {
    const bindings = JSON.parse(body).results.bindings as Array<Record<string, { value: string }>>;
    return bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
  } catch {
    return null; // A timeout can arrive as a 200 with the JSON cut off.
  }
}

/** Rows for a date range; on a timeout, each half of it, down to single days. */
async function wikidataRange(query: WikidataClass["query"], from: string, to: string): Promise<Row[]> {
  if (pauseRequested()) return [];
  const rows = await sparql(query(from, addDays(to, 1)));
  if (rows) return rows;
  if (from === to || SAMPLE) {
    console.warn(`wikidata: nothing for ${from} to ${to}`);
    return [];
  }
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const mid = addDays(from, Math.floor(span / 2));
  return [...(await wikidataRange(query, from, mid)), ...(await wikidataRange(query, addDays(mid, 1), to))];
}

function wikidataFacts(rows: Row[], c: WikidataClass): Fact[] {
  const items = new Map<string, { label: string; description: string; date: string; extras: Set<string> }>();
  for (const r of rows) {
    const label = r.itemLabel ?? "";
    if (!label || /^Q\d+$/.test(label)) continue;
    const date = (r.d ?? "").slice(0, 10);
    const key = c.earliest ? r.item : `${r.item} ${date}`;
    const seen = items.get(key);
    if (seen && seen.date < date) continue;
    const item = seen && seen.date === date ? seen : { label, description: r.itemDescription ?? "", date, extras: new Set<string>() };
    if (r.xLabel && !/^Q\d+$/.test(r.xLabel)) item.extras.add(r.xLabel);
    items.set(key, item);
  }
  const facts: Fact[] = [];
  for (const { label, description, date, extras } of items.values()) {
    // A work's description often names its maker already, as in "2026 album by Lamb of God".
    const list = [...extras].filter((e) => !c.earliest || !description.includes(e));
    if (c.keep && !c.keep(label, description, list)) continue;
    const about = description.replace(/^\((.*)\)$/, "$1");
    facts.push({ date, text: c.sentence(about ? `${label} (${about})` : label, longDate(date), list) });
  }
  return facts;
}

async function wikidata(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  const months = SAMPLE ? [windowMonths()[2]] : windowMonths();
  for (const c of WIKIDATA_CLASSES) {
    const facts: Fact[] = [];
    for (const [from, to] of months) {
      const chunks: Array<[string, string]> = [];
      for (let start = from; start <= to; start = addDays(start, c.days)) {
        const end = addDays(start, c.days - 1);
        chunks.push([start, end > to ? to : end]);
      }
      for (const [a, b] of few(chunks, 1)) facts.push(...wikidataFacts(await wikidataRange(c.query, a, b), c));
    }
    records.push(...byMonth(facts, { id: `wikidata-${c.name}`, source: "Wikidata", what: c.what, url: "https://www.wikidata.org/", license: WIKIDATA_LICENSE, visibility: "public" }));
  }
  return records;
}

// Football.

interface FootballMatch {
  date: string;
  round?: string;
  group?: string;
  ground?: string;
  team1: string;
  team2: string;
  score?: { ft?: [number, number]; et?: [number, number]; p?: [number, number] };
  goals1?: Array<{ name: string; minute: string; owngoal?: boolean; penalty?: boolean }>;
  goals2?: Array<{ name: string; minute: string; owngoal?: boolean; penalty?: boolean }>;
}

function footballSentence(m: FootballMatch, competition: string): string | null {
  const { ft, et, p } = m.score ?? {};
  if (!ft) return null; // No score yet: not played, or not finished.
  const [a, b] = et ?? ft;
  const where = [m.group, m.round].filter(Boolean).join(", ");
  const place = m.ground ? ` at ${m.ground}` : "";
  const extra = et ? " after extra time" : "";
  let result: string;
  if (p) result = `${m.team1} and ${m.team2} drew ${a}-${b} after extra time, and ${p[0] > p[1] ? m.team1 : m.team2} won ${Math.max(...p)}-${Math.min(...p)} on penalties`;
  else if (a === b) result = `${m.team1} and ${m.team2} drew ${a}-${b}${extra}`;
  else result = `${a > b ? m.team1 : m.team2} beat ${a > b ? m.team2 : m.team1} ${Math.max(a, b)}-${Math.min(a, b)}${extra}`;
  const goal = (g: { name: string; minute: string; owngoal?: boolean; penalty?: boolean }) => `${g.name} ${g.minute}'${g.penalty ? " (penalty)" : ""}${g.owngoal ? " (own goal)" : ""}`;
  const goals = [...(m.goals1 ?? []), ...(m.goals2 ?? [])].map(goal);
  return `On ${longDate(m.date)}, in ${competition}${where ? ` (${where})` : ""}${place}, ${result}.${goals.length ? ` Goals: ${goals.join(", ")}.` : ""}`;
}

async function openfootball(): Promise<SourceRecord[]> {
  const files: string[] = ["worldcup.json/master/2026/worldcup.json", "worldcup.json/master/2026/worldcup.quali_playoffs.json"];
  for (const season of few(["2025-26", "2026", "2026-27"], 1)) {
    const listing = await get(`https://api.github.com/repos/openfootball/football.json/contents/${season}`);
    const listed = listing ? (JSON.parse(listing) as Array<{ name: string }>).map((f) => f.name) : [];
    for (const name of listed) if (name.endsWith(".json") && !name.includes("-full")) files.push(`football.json/master/${season}/${name}`);
  }
  const facts: Fact[] = [];
  for (const file of few(files, 6)) {
    if (pauseRequested()) break;
    const body = await get(`https://raw.githubusercontent.com/openfootball/${file}`);
    if (!body) continue;
    const data = JSON.parse(body) as { name?: string; matches?: FootballMatch[] };
    const competition = data.name ?? path.basename(file, ".json");
    for (const m of data.matches ?? []) {
      const text = inWindow(m.date ?? "") ? footballSentence(m, competition) : null;
      if (text) facts.push({ date: m.date, text });
    }
  }
  return byMonth(facts, { id: "openfootball", source: "openfootball", what: "Football results", url: "https://github.com/openfootball", license: "CC0 1.0, credit openfootball (github.com/openfootball)", visibility: "public" });
}

// Cricket.

interface CricketMatch {
  info: {
    dates: string[];
    teams: string[];
    gender?: string;
    match_type?: string;
    venue?: string;
    city?: string;
    event?: { name?: string; match_number?: number; stage?: string };
    outcome?: { winner?: string; result?: string; method?: string; by?: { runs?: number; wickets?: number; innings?: number }; eliminator?: string };
    player_of_match?: string[];
  };
  innings?: Array<{ team: string; super_over?: boolean; overs?: Array<{ deliveries: Array<{ runs: { total: number }; wickets?: unknown[] }> }> }>;
}

function cricketSentence(m: CricketMatch): Fact | null {
  const { info, innings } = m;
  const date = info.dates[info.dates.length - 1];
  const o = info.outcome;
  if (!o || !inWindow(date)) return null; // No outcome: not finished.
  const scores = new Map<string, string[]>();
  for (const inn of innings ?? []) {
    if (inn.super_over) continue;
    let runs = 0;
    let wickets = 0;
    for (const over of inn.overs ?? []) for (const d of over.deliveries) { runs += d.runs.total; wickets += d.wickets?.length ?? 0; }
    scores.set(inn.team, [...(scores.get(inn.team) ?? []), `${runs}/${wickets}`]);
  }
  const team = (name: string) => (scores.has(name) ? `${name} (${scores.get(name)!.join(" and ")})` : name);
  const [t1, t2] = info.teams;
  let result: string;
  if (o.winner) {
    const margin = o.by?.innings ? `an innings and ${plural(o.by.runs ?? 0, "run")}` : o.by?.runs ? plural(o.by.runs, "run") : o.by?.wickets ? plural(o.by.wickets, "wicket") : "";
    const loser = o.winner === t1 ? t2 : t1;
    result = `${team(o.winner)} beat ${team(loser)}${margin ? ` by ${margin}` : ""}${o.method ? ` (${o.method} method)` : ""}`;
  } else if (o.eliminator) {
    result = `${team(t1)} and ${team(t2)} tied, and ${o.eliminator} won the eliminator`;
  } else if (o.result === "no result") {
    result = `${team(t1)} and ${team(t2)} had no result`;
  } else {
    result = `${team(t1)} and ${team(t2)} ended in a ${o.result ?? "draw"}`;
  }
  const event = info.event?.name ? `${info.event.name}${info.event.stage ? `, ${info.event.stage}` : info.event.match_number ? `, match ${info.event.match_number}` : ""}` : "a match";
  const kind = [info.gender === "female" ? "women's" : "men's", info.match_type].filter(Boolean).join(" ");
  const place = [info.venue, info.venue?.includes(info.city ?? "\u0000") ? "" : info.city].filter(Boolean).join(", ");
  const star = info.player_of_match?.length ? ` Player of the match: ${info.player_of_match.join(", ")}.` : "";
  return { date, text: `On ${longDate(date)}, in ${event} (${kind})${place ? ` at ${place}` : ""}, ${result}.${star}` };
}

async function cricsheet(): Promise<SourceRecord[]> {
  const zip = await getBytes(`https://cricsheet.org/downloads/${SAMPLE ? "recently_played_2_json" : "all_json"}.zip`);
  if (!zip) return [];
  const files = unzip(zip);
  const readme = files.get("README.txt")?.().toString("utf8") ?? "";
  // The README lists each match's start date; a multi-day match that began just before the window can still end in it.
  const ids = [...readme.matchAll(/^(\d{4}-\d{2}-\d{2}) - \w+ - \S+ - \w+ - (\d+) - /gm)].filter(([, start]) => start >= addDays(FROM, -10) && start <= TO).map(([, , id]) => id);
  const facts: Fact[] = [];
  for (const id of ids) {
    const fact = cricketSentence(JSON.parse(files.get(`${id}.json`)?.().toString("utf8") ?? '{"info":{"dates":[""],"teams":[]}}'));
    if (fact) facts.push(fact);
  }
  return byMonth(facts, { id: "cricsheet", source: "Cricsheet", what: "Cricket results", url: "https://cricsheet.org/", license: "ODC-BY 1.0, credit Cricsheet (cricsheet.org)", visibility: "public" });
}

// NFL.

const NFL_TEAMS: Record<string, string> = {
  ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills", CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers", HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs",
  LA: "Los Angeles Rams", LAC: "Los Angeles Chargers", LV: "Las Vegas Raiders", MIA: "Miami Dolphins", MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants",
  NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SEA: "Seattle Seahawks", SF: "San Francisco 49ers", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders",
};

const NFL_ROUNDS: Record<string, string> = { WC: "the wild card round", DIV: "the divisional round", CON: "the conference championship", SB: "the Super Bowl" };

/** A file from an nflverse-data release, through the REST API rather than github.com's download links, which robots.txt disallows. */
async function nflverseAsset(tag: string, name: string): Promise<string | null> {
  const listing = await get(`https://api.github.com/repos/nflverse/nflverse-data/releases/tags/${tag}`);
  const asset = listing ? (JSON.parse(listing).assets as Array<{ name: string; url: string }>).find((a) => a.name === name) : undefined;
  return asset ? get(asset.url, { headers: { Accept: "application/octet-stream" } }) : null;
}

async function nflverse(): Promise<SourceRecord[]> {
  const leaders = new Map<string, string[]>();
  for (const season of few(["2025", "2026"], 2)) {
    const body = await nflverseAsset("stats_player", `stats_player_week_${season}.csv`);
    const rows = body ? csvRows(body) : [];
    const best = new Map<string, { value: number; text: string }>();
    const offer = (game: string, stat: string, value: number, text: string) => {
      const key = `${game} ${stat}`;
      if (value > 0 && value > (best.get(key)?.value ?? 0)) best.set(key, { value, text });
    };
    for (const r of rows) {
      const who = `${r.player_display_name} (${NFL_TEAMS[r.team] ?? r.team})`;
      offer(r.game_id, "1passing", Number(r.passing_yards), `leading passer ${who} with ${plural(r.passing_yards, "yard")} and ${plural(r.passing_tds, "touchdown")}`);
      offer(r.game_id, "2rushing", Number(r.rushing_yards), `leading rusher ${who} with ${plural(r.rushing_yards, "yard")} and ${plural(r.rushing_tds, "touchdown")}`);
      offer(r.game_id, "3receiving", Number(r.receiving_yards), `leading receiver ${who} with ${plural(r.receiving_yards, "yard")} and ${plural(r.receiving_tds, "touchdown")}`);
    }
    for (const key of [...best.keys()].sort()) {
      const game = key.split(" ")[0];
      leaders.set(game, [...(leaders.get(game) ?? []), best.get(key)!.text]);
    }
  }
  const schedule = await nflverseAsset("schedules", "games.csv");
  const facts: Fact[] = [];
  for (const g of schedule ? csvRows(schedule) : []) {
    if (!inWindow(g.gameday) || g.result === "" || g.home_score === "" || g.away_score === "") continue; // No score: not finished.
    const home = NFL_TEAMS[g.home_team] ?? g.home_team;
    const away = NFL_TEAMS[g.away_team] ?? g.away_team;
    const [hs, as] = [Number(g.home_score), Number(g.away_score)];
    const round = NFL_ROUNDS[g.game_type] ? `${NFL_ROUNDS[g.game_type]} of the ${g.season} season` : `week ${g.week} of the ${g.season} regular season`;
    const result = hs === as ? `${home} and ${away} tied ${hs}-${as}` : hs > as ? `${home} beat ${away} ${hs}-${as}` : `${away} beat ${home} ${as}-${hs}`;
    const stats = leaders.get(g.game_id);
    facts.push({
      date: g.gameday,
      text: `On ${longDate(g.gameday)}, in ${round}, ${result}${g.overtime === "1" ? " in overtime" : ""}${g.stadium ? ` at ${g.stadium}` : ""}.${stats ? ` Game leaders: ${stats.join("; ")}.` : ""}`,
    });
  }
  return byMonth(facts, { id: "nflverse", source: "nflverse", what: "NFL results", url: "https://github.com/nflverse/nflverse-data", license: "CC BY 4.0, credit nflverse (github.com/nflverse/nflverse-data)", visibility: "public" });
}

// TV.

interface TvEpisode {
  id: number;
  name?: string;
  season?: number;
  number?: number | null;
  type?: string;
  airdate?: string;
  summary?: string | null;
  show?: TvShow;
  _embedded?: { show?: TvShow };
}

interface TvShow {
  name: string;
  type?: string;
  language?: string | null;
  network?: { name: string } | null;
  webChannel?: { name: string } | null;
}

/** News, talk and sports shows repeat daily with nothing to know about an episode, so they stay out. */
const TV_SKIPPED_TYPES = new Set(["News", "Talk Show", "Sports", "Panel Show"]);

function tvSentence(e: TvEpisode): Fact | null {
  const show = e.show ?? e._embedded?.show;
  const date = e.airdate ?? "";
  if (!show || !inWindow(date) || show.language !== "English" || TV_SKIPPED_TYPES.has(show.type ?? "")) return null;
  if (e.type === "insignificant_special") return null;
  const channel = show.network?.name ?? show.webChannel?.name;
  const which = e.number ? `season ${e.season} episode ${e.number}` : `a special of season ${e.season}`;
  const title = e.name && !/^(episode|chapter|part)\s*\d+$/i.test(e.name) ? `, "${e.name}"` : "";
  const opening = e.number === 1 ? (e.season === 1 ? " This was the series premiere." : " This was the season premiere.") : "";
  const summary = e.summary ? ` ${htmlToText(e.summary).replace(/\s+/g, " ")}` : "";
  return { date, text: `On ${longDate(date)}, ${show.name}${show.type ? ` (${show.type.toLowerCase()})` : ""}${channel ? ` on ${channel}` : ""} aired ${which}${title}.${opening}${summary}` };
}

async function tvmaze(): Promise<SourceRecord[]> {
  const seen = new Set<number>();
  const facts: Fact[] = [];
  const days = SAMPLE ? windowDays().filter((_, i) => i % 100 === 40) : windowDays();
  for (const day of days) {
    for (const route of [`schedule?country=US&date=${day}`, `schedule?country=GB&date=${day}`, `schedule/web?date=${day}`]) {
      if (pauseRequested()) break;
      const body = await get(`https://api.tvmaze.com/${route}`);
      for (const e of body ? (JSON.parse(body) as TvEpisode[]) : []) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const fact = tvSentence(e);
        if (fact) facts.push(fact);
      }
    }
  }
  return byMonth(facts, { id: "tvmaze", source: "TVmaze", what: "Television episodes", url: "https://www.tvmaze.com/", license: "CC BY-SA, credit TVmaze (tvmaze.com)", visibility: "public" });
}

// US government data.

async function nhtsaRecalls(): Promise<SourceRecord[]> {
  const zip = await getBytes("https://static.nhtsa.gov/odi/ffdd/rcl/FLAT_RCL_POST_2010.zip");
  const file = zip ? [...unzip(zip).values()][0] : undefined;
  if (!file) return [];
  // Field order from https://static.nhtsa.gov/odi/ffdd/rcl/RCL.txt, one line per campaign, make, model and year.
  const campaigns = new Map<string, { date: string; maker: string; units: string; component: string; defect: string; consequence: string; remedy: string; models: Set<string>; years: Set<string> }>();
  for (const line of file().toString("utf8").split(/\r?\n/)) {
    const f = line.split("\t");
    const raw = f[15] ?? "";
    if (!/^2026\d{4}$/.test(raw)) continue;
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    if (!inWindow(date)) continue;
    let c = campaigns.get(f[1]);
    if (!c) {
      c = { date, maker: f[7], units: f[11], component: f[6], defect: f[19], consequence: f[20], remedy: f[21], models: new Set(), years: new Set() };
      campaigns.set(f[1], c);
    }
    c.models.add(`${f[2]} ${f[3]}`.trim());
    if (f[4] && f[4] !== "9999") c.years.add(f[4]);
  }
  const facts: Fact[] = [...campaigns].map(([id, c]) => {
    const models = [...c.models];
    const years = [...c.years].sort();
    const span = years.length ? ` (model years ${years[0]}${years.length > 1 ? ` to ${years[years.length - 1]}` : ""})` : "";
    const covered = `${models.slice(0, 8).join(", ")}${models.length > 8 ? ` and ${models.length - 8} more` : ""}`;
    return {
      date: c.date,
      text: `On ${longDate(c.date)}, ${c.maker} filed recall ${id} with NHTSA, for about ${Number(c.units || 0).toLocaleString("en-US")} units of ${covered}${span}. Component: ${c.component.toLowerCase()}. ${c.defect} ${c.consequence} ${c.remedy}`.trim(),
    };
  });
  return byMonth(facts, { id: "nhtsa-recalls", source: "NHTSA recalls", what: "US vehicle safety recalls", url: "https://www.nhtsa.gov/recalls", license: "US government work, public domain, credit NHTSA (nhtsa.gov)", visibility: "public" });
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function fuelEconomy(): Promise<SourceRecord[]> {
  const zip = await getBytes("https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip");
  const file = zip ? unzip(zip).get("vehicles.csv") : undefined;
  if (!file) return [];
  const facts: Fact[] = [];
  for (const v of csvRows(file().toString("utf8"))) {
    if (v.year !== "2026" && v.year !== "2027") continue;
    // createdOn reads like "Wed May 13 00:00:00 EDT 2026": the listing date, as the time zone doesn't matter here.
    const m = v.createdOn?.match(/^\w+ (\w{3}) (\d{1,2}) .* (\d{4})$/);
    if (!m) continue;
    const date = `${m[3]}-${String(SHORT_MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    const electric = v.fuelType1 === "Electricity";
    const equivalent = electric || v.fuelType1 === "Hydrogen";
    const engine = electric ? "electric" : [v.displ && `${v.displ} L`, v.cylinders && `${v.cylinders}-cylinder`].filter(Boolean).join(" ");
    const details = [engine, v.trany, v.drive, electric ? "" : v.fuelType1].filter(Boolean).join(", ");
    const unit = equivalent ? "MPGe" : "mpg";
    const range = Number(v.range) > 0 ? ` Its listed range is ${v.range} miles.` : "";
    facts.push({ date, text: `On ${longDate(date)}, the US fuel economy listing added the ${v.year} ${v.make} ${v.model} (${details}): ${v.city08} ${unit} city, ${v.highway08} highway, ${v.comb08} combined.${range}` });
  }
  return byMonth(facts, { id: "fueleconomy", source: "fueleconomy.gov", what: "New US fuel economy listings", url: "https://www.fueleconomy.gov/feg/download.shtml", license: "US government work, public domain, credit EPA and US Department of Energy (fueleconomy.gov)", visibility: "public" });
}

const CARRIERS: Record<string, string> = {
  AA: "American Airlines", AS: "Alaska Airlines", B6: "JetBlue", DL: "Delta Air Lines", F9: "Frontier Airlines", G4: "Allegiant Air", HA: "Hawaiian Airlines", MQ: "Envoy Air", NK: "Spirit Airlines", OH: "PSA Airlines",
  OO: "SkyWest Airlines", UA: "United Airlines", WN: "Southwest Airlines", YX: "Republic Airways", "9E": "Endeavor Air", QX: "Horizon Air", YV: "Mesa Airlines", ZW: "Air Wisconsin", C5: "CommutAir", G7: "GoJet Airlines", PT: "Piedmont Airlines",
};

interface FlightTally {
  flights: number;
  onTime: number;
  cancelled: number;
}

const percent = (part: number, whole: number) => `${((part / Math.max(whole, 1)) * 100).toFixed(1)}%`;

/** One month's flights as sentences: the whole country, each carrier, the busiest airports, and the worst day for cancellations. */
function btsMonth(text: string, from: string, to: string): string[] {
  const lines = text.split(/\r?\n/);
  const header = csvLine(lines[0]);
  const col = (name: string) => header.indexOf(name);
  const [dateAt, carrierAt, originAt, cityAt, lateAt, cancelledAt] = [col("FlightDate"), col("Reporting_Airline"), col("Origin"), col("OriginCityName"), col("ArrDel15"), col("Cancelled")];
  const total: FlightTally = { flights: 0, onTime: 0, cancelled: 0 };
  const tallies = { carrier: new Map<string, FlightTally>(), origin: new Map<string, FlightTally>(), day: new Map<string, FlightTally>() };
  const cities = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const f = csvLine(lines[i]);
    const day = f[dateAt];
    if (day < from || day > to) continue;
    cities.set(f[originAt], f[cityAt]);
    // ArrDel15 is empty for cancelled and diverted flights, which don't count as on time.
    const onTime = f[lateAt] !== "" && Number(f[lateAt]) === 0 ? 1 : 0;
    const cancelled = Number(f[cancelledAt]) === 1 ? 1 : 0;
    const buckets: FlightTally[] = [total];
    for (const [map, key] of [[tallies.carrier, f[carrierAt]], [tallies.origin, f[originAt]], [tallies.day, day]] as const) {
      if (!map.has(key)) map.set(key, { flights: 0, onTime: 0, cancelled: 0 });
      buckets.push(map.get(key)!);
    }
    for (const t of buckets) {
      t.flights++;
      t.onTime += onTime;
      t.cancelled += cancelled;
    }
  }
  if (total.flights === 0) return [];
  const span = `From ${longDate(from)} to ${longDate(to)}`;
  const onTime = (t: FlightTally) => percent(t.onTime, t.flights);
  const sentences = [`${span}, US airlines reported ${total.flights.toLocaleString("en-US")} domestic flights to the Bureau of Transportation Statistics. ${onTime(total)} arrived within 15 minutes of schedule and ${percent(total.cancelled, total.flights)} were cancelled.`];
  for (const [code, t] of [...tallies.carrier].sort((a, b) => b[1].flights - a[1].flights)) {
    sentences.push(`${span}, ${CARRIERS[code] ?? code} operated ${t.flights.toLocaleString("en-US")} of those flights: ${onTime(t)} arrived on time and ${percent(t.cancelled, t.flights)} were cancelled.`);
  }
  for (const [code, t] of [...tallies.origin].sort((a, b) => b[1].flights - a[1].flights).slice(0, 15)) {
    sentences.push(`${span}, ${t.flights.toLocaleString("en-US")} of those flights left from ${code} (${cities.get(code)}), and ${onTime(t)} of them arrived on time.`);
  }
  const worst = [...tallies.day].sort((a, b) => b[1].cancelled - a[1].cancelled)[0];
  if (worst) sentences.push(`The day with the most cancellations in that period was ${longDate(worst[0])}, with ${worst[1].cancelled.toLocaleString("en-US")} of ${worst[1].flights.toLocaleString("en-US")} flights cancelled.`);
  return sentences;
}

async function btsOnTime(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  const months = windowMonths();
  for (const [from, to] of SAMPLE ? [months[7]] : months) {
    if (pauseRequested()) break;
    const month = Number(from.slice(5, 7));
    // Data arrives about two months late: later months are simply not there yet.
    const zip = await getBytes(`https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_2026_${month}.zip`);
    const file = zip ? [...unzip(zip)].find(([name]) => name.endsWith(".csv"))?.[1] : undefined;
    if (!file) continue;
    const sentences = btsMonth(file().toString("latin1"), from, to);
    if (!sentences.length) continue;
    records.push({
      id: `bts-ontime:${from.slice(0, 7)}`,
      source: "US Bureau of Transportation Statistics",
      title: `US airline on-time performance, ${monthName(from.slice(0, 7))}`,
      url: "https://www.transtats.bts.gov/",
      date: to,
      license: "US government work, public domain, credit US Bureau of Transportation Statistics (bts.gov)",
      visibility: "public",
      text: sentences.join("\n\n"),
    });
  }
  return records;
}

// News published under open terms.

/** Every feed post opens with this line of Global Voices' own, so it says nothing about where the text came from. */
const GV_BOILERPLATE = /Originally published on Global Voices\s*/g;
/** Partner stories can carry their publisher's own terms, so they stay private. */
const REPUBLISHED = /content[- ]sharing|originally (?:published|appeared)|first (?:published|appeared)|republished|re-published/i;

async function globalVoices(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  // robots.txt asks for ten seconds between requests. Paged feeds carry full posts, so the sitemap isn't needed.
  for (let page = 1; page <= (SAMPLE ? 1 : 60) && !pauseRequested(); page++) {
    const items = feedItems(await get(`https://globalvoices.org/feed/?paged=${page}`, { gapMs: 10_000 }));
    if (items.length === 0) break;
    let older = false;
    for (const item of items) {
      const date = utcDate(xmlTag(item, "pubDate"));
      if (date < FROM) older = true;
      if (!inWindow(date)) continue;
      const link = xmlTag(item, "link").trim();
      const text = feedText(xmlTag(item, "content:encoded")).replace(GV_BOILERPLATE, "");
      const reused = REPUBLISHED.test(text);
      records.push({
        id: `global-voices:${xmlTag(item, "guid").replace(/.*\?p=/, "") || link}`,
        source: "Global Voices",
        title: feedText(xmlTag(item, "title")),
        url: link,
        date,
        license: reused ? "Republished partner text under its publisher's terms, training only" : `CC BY 3.0, credit ${feedText(xmlTag(item, "dc:creator"))} and Global Voices (globalvoices.org)`,
        visibility: reused ? "private" : "public",
        text,
      });
    }
    if (older) break;
  }
  return records;
}

/** VOA's own work is public domain; anything from a wire service isn't. Naming a wire at all drops the story, to be safe. */
const WIRE = /\b(?:Associated Press|Reuters|Agence France[- ]Presse|AFP)\b|\(AP\)|\bAP\b/;

async function voa(): Promise<SourceRecord[]> {
  const urls = new Set<string>();
  // Sitemaps cover the window but were last built days before its end; the RSS feeds fill in the latest stories.
  const index = await get("https://www.voanews.com/sitemap.xml");
  const sitemaps = (index?.match(/https:\/\/www\.voanews\.com\/sitemap_[^<]+\.xml\.gz/g) ?? []).sort((a, b) => Number(a.match(/_(\d+)\.xml/)?.[1]) - Number(b.match(/_(\d+)\.xml/)?.[1]));
  for (const loc of few(sitemaps, 1)) {
    if (pauseRequested()) break;
    const gz = await getBytes(loc);
    if (!gz) continue;
    let oldest = "9999";
    for (const [, url, modified] of gunzipSync(gz).toString("utf8").matchAll(/<loc>([^<]+)<\/loc><lastmod>(\d{4}-\d{2}-\d{2})/g)) {
      if (modified < oldest) oldest = modified;
      // lastmod is never before the story's own date, so this keeps everything in the window; the page's date decides.
      if (modified >= FROM && /\/a\/.+\/\d+\.html$/.test(url)) urls.add(url);
    }
    if (oldest < FROM) break;
  }
  const feedList = await get("https://www.voanews.com/rssfeeds");
  for (const feed of few([...new Set(feedList?.match(/\/api\/z[a-z_-]+/g) ?? [])], 1)) {
    if (pauseRequested()) break;
    for (const item of feedItems(await get(`https://www.voanews.com${feed}`))) {
      const link = xmlTag(item, "link").trim();
      if (/\/a\/.+\/\d+\.html$/.test(link)) urls.add(link);
    }
  }
  const records: SourceRecord[] = [];
  let checked = 0;
  for (const url of urls) {
    if (pauseRequested() || (SAMPLE && (records.length >= LIMIT || checked >= 8))) break;
    checked++;
    const html = await get(url);
    if (!html) continue;
    let meta: { headline?: string; datePublished?: string; author?: { name?: string } } = {};
    try {
      meta = JSON.parse(html.match(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "{}");
    } catch {
      continue;
    }
    const date = (meta.datePublished ?? "").slice(0, 10);
    const start = html.indexOf('<div class="wsw">');
    if (!inWindow(date) || start < 0) continue;
    const text = htmlToText(html.slice(start, blockEnd(html, start, "div")));
    if (WIRE.test(text) || WIRE.test(meta.author?.name ?? "")) continue;
    records.push({
      id: `voa:${url.match(/(\d+)\.html$/)?.[1]}`,
      source: "Voice of America",
      title: htmlToText(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? meta.headline ?? ""),
      url,
      date,
      license: "US government work, public domain, credit Voice of America (voanews.com)",
      visibility: "public",
      text,
    });
  }
  return records;
}

async function kremlin(): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  // The English site answers on plain HTTP. Its Atom feed holds full texts, 20 to a page, newest first.
  for (let page = 1; page <= (SAMPLE ? 1 : 300) && !pauseRequested(); page++) {
    const xml = await get(`http://en.kremlin.ru/events/all/feed${page > 1 ? `/page/${page}` : ""}`);
    const entries = xml?.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    if (entries.length === 0) break;
    let older = false;
    for (const entry of entries) {
      const date = xmlTag(entry, "published").slice(0, 10);
      if (date < FROM) older = true;
      if (!inWindow(date)) continue;
      const url = xmlTag(entry, "id").trim();
      // The content repeats the summary when it has any.
      const text = feedText(xmlTag(entry, "content")) || feedText(xmlTag(entry, "summary"));
      records.push({ id: `kremlin:${url.split("/").pop()}`, source: "President of Russia (kremlin.ru)", title: feedText(xmlTag(entry, "title")), url, date, license: "CC BY 4.0, credit Presidential Executive Office of Russia (kremlin.ru)", visibility: "public", text });
    }
    if (older) break;
  }
  return records;
}

const UN_FEEDS = [
  "all/rss.xml",
  ...["africa", "americas", "asia-pacific", "europe", "middle-east"].map((r) => `region/${r}/feed/rss.xml`),
  ...["climate-change", "culture-and-education", "economic-development", "health", "human-rights", "humanitarian-aid", "law-and-crime-prevention", "migrants-and-refugees", "peace-and-security", "sdgs", "un-affairs", "women"].map((t) => `topic/${t}/feed/rss.xml`),
];

/** RSS only reaches back a few days, so this holds what the feeds show on the day of the run, and only summaries. */
async function unNews(): Promise<SourceRecord[]> {
  const records = new Map<string, SourceRecord>();
  for (const feed of few(UN_FEEDS, 2)) {
    if (pauseRequested()) break;
    for (const item of feedItems(await get(`https://news.un.org/feed/subscribe/en/news/${feed}`))) {
      const date = utcDate(xmlTag(item, "pubDate"));
      const url = xmlTag(item, "guid").trim() || xmlTag(item, "link").trim();
      if (!inWindow(date) || !url) continue;
      records.set(url, { id: `un-news:${url.split("/").pop()}`, source: "UN News", title: feedText(xmlTag(item, "title")), url, date, license: "UN News, reprint with credit; training only", visibility: "private", text: feedText(xmlTag(item, "description")) });
    }
  }
  return [...records.values()];
}

/** Stories built on wire copy aren't Agência Brasil's to license, so they stay out even as private text. */
const BRASIL_WIRE = /com informa[çc][õo]es d[aeo]s? .{0,40}\b(?:Reuters|AFP|AP|Associated Press|EFE|Lusa|Xinhua)\b|^\s*\*?\s*(?:Reuters|AFP|Associated Press)\s*$/im;

const BRASIL_FEEDS = ["rss/ultimasnoticias", "rss/economia", "rss/politica", "rss/geral", "rss/internacional", "rss/justica", "rss/saude", "rss/educacao", "rss/direitos-humanos", "rss/esportes", "en/rss/ultimasnoticias", "es/rss/ultimasnoticias"];

/** Same limit as UN News: only what the feeds show on the day of the run, full text this time. */
async function agenciaBrasil(): Promise<SourceRecord[]> {
  const records = new Map<string, SourceRecord>();
  // robots.txt asks for ten seconds between requests.
  for (const feed of few(BRASIL_FEEDS, 2)) {
    if (pauseRequested()) break;
    for (const item of feedItems(await get(`https://agenciabrasil.ebc.com.br/${feed}/feed.xml`, { gapMs: 10_000 }))) {
      const date = utcDate(xmlTag(item, "pubDate"));
      const url = xmlTag(item, "link").trim();
      if (!inWindow(date) || !url) continue;
      const text = feedText(xmlTag(item, "description").replace(/&lt;h3&gt;Notícias relacionadas:[\s\S]*?&lt;\/ul&gt;/i, " "));
      if (BRASIL_WIRE.test(text)) continue;
      records.set(url, { id: `agencia-brasil:${url.split("/").pop()}`, source: "Agência Brasil", title: feedText(xmlTag(item, "title")), url, date, license: "Agência Brasil (EBC), reproduction with credit; training only", visibility: "private", text });
    }
  }
  return [...records.values()];
}

// GDELT: machine-coded metadata only, never article text, titles or quotations. Worded as what the coding says, since it isn't checked.

const GDELT_CITATION = "Source: The GDELT Project, https://www.gdeltproject.org/.";
const GDELT_LICENSE = "GDELT Project terms: free use and redistribution with citation and a link to https://www.gdeltproject.org/";
/** A sample of each day: GDELT files arrive every 15 minutes, and hourly events and six-hourly GKG are plenty for daily tops. */
const EVENT_SLOTS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}0000`);
const GKG_SLOTS = ["000000", "060000", "120000", "180000"];
const CAMEO_ROOTS: Record<string, string> = {
  "01": "made a public statement about", "02": "appealed to", "03": "expressed intent to cooperate with", "04": "consulted with", "05": "cooperated diplomatically with", "06": "cooperated materially with", "07": "provided aid to",
  "08": "yielded to", "09": "investigated", "10": "made demands of", "11": "criticized", "12": "rejected", "13": "threatened", "14": "protested against", "15": "showed military force toward", "16": "reduced relations with",
  "17": "coerced", "18": "assaulted", "19": "fought", "20": "used mass violence against",
};

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

async function gdeltFile(stamp: string, suffix: string): Promise<string> {
  // Static files with no stated limit; 28 a day for 299 days would take 2.3 hours at one a second.
  const zip = await getBytes(`http://data.gdeltproject.org/gdeltv2/${stamp}.${suffix}.zip`, { cache: false, gapMs: 500 });
  const file = zip ? [...unzip(zip).values()][0] : undefined;
  return file ? file().toString("utf8") : "";
}

/** The day's most-reported coded events: the top ones, plus the top conflict events so wars aren't crowded out by statements. */
async function gdeltEvents(day: string, slots: string[]): Promise<string[]> {
  const compact = day.replace(/-/g, "");
  const tally = new Map<string, { actor1: string; actor2: string; root: string; place: string; articles: number; sources: number }>();
  for (const slot of slots) {
    if (pauseRequested()) break;
    for (const line of (await gdeltFile(`${compact}${slot}`, "export.CSV")).split("\n")) {
      const f = line.split("\t");
      // Files also hold events first mentioned today but dated long ago; only today's count.
      if (f[1] !== compact || !f[6] || f[6] === f[16] || !CAMEO_ROOTS[f[28]]) continue;
      const key = [f[6], f[28], f[16], f[52]].join("\t");
      const t = tally.get(key) ?? { actor1: f[6], actor2: f[16], root: f[28], place: f[52], articles: 0, sources: 0 };
      t.articles += Number(f[33]) || 0;
      t.sources += Number(f[32]) || 0;
      tally.set(key, t);
    }
  }
  // Ranked by outlets, not articles: one site's repeated page can claim hundreds of articles.
  const ranked = [...tally.values()].filter((t) => t.sources >= 3).sort((a, b) => b.sources - a.sources);
  const conflict = ranked.filter((t) => Number(t.root) >= 14).slice(0, 5);
  const top = [...new Set([...ranked.slice(0, 10), ...conflict])];
  return top.map((t) => {
    const verb = t.actor2 ? CAMEO_ROOTS[t.root] : CAMEO_ROOTS[t.root].replace(/ (?:about|to|with|of|against|toward)$/, "");
    return `On ${longDate(day)}, ${t.articles} news articles from ${t.sources} sources were machine-coded by GDELT as reporting that ${titleCase(t.actor1)} ${verb}${t.actor2 ? ` ${titleCase(t.actor2)}` : ""}${t.place ? `, in ${t.place}` : ""}.`;
  });
}

/** The people, organizations and countries named in the most articles of the day's sampled GKG files. */
async function gdeltGkg(day: string, slots: string[]): Promise<string[]> {
  const compact = day.replace(/-/g, "");
  const counts = { people: new Map<string, number>(), groups: new Map<string, number>(), places: new Map<string, number>() };
  const bump = (map: Map<string, number>, names: Iterable<string>) => {
    for (const name of new Set(names)) if (name) map.set(name, (map.get(name) ?? 0) + 1);
  };
  let articles = 0;
  for (const slot of slots) {
    if (pauseRequested()) break;
    for (const line of (await gdeltFile(`${compact}${slot}`, "gkg.csv")).split("\n")) {
      const f = line.split("\t");
      if (f.length < 15) continue;
      articles++;
      bump(counts.people, f[11].split(";"));
      bump(counts.groups, f[13].split(";"));
      bump(counts.places, f[9].split(";").filter((l) => l.startsWith("1#")).map((l) => l.split("#")[1]));
    }
  }
  if (articles === 0) return [];
  const top = (map: Map<string, number>, n: number, format = titleCase) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, c]) => `${format(name)} (${c})`).join(", ");
  const when = longDate(day);
  return [
    `On ${when}, across a sample of ${articles.toLocaleString("en-US")} news articles in GDELT's Global Knowledge Graph, the people named in the most articles were: ${top(counts.people, 12)}.`,
    `On ${when}, the organizations named in the most of those articles were: ${top(counts.groups, 10)}.`,
    `On ${when}, the countries named in the most of those articles were: ${top(counts.places, 10, (s) => s)}.`,
  ];
}

async function gdelt(): Promise<SourceRecord[]> {
  const facts: Fact[] = [];
  const days = SAMPLE ? [windowDays()[60], windowDays()[150]] : windowDays();
  for (const day of days) {
    if (pauseRequested()) break;
    // Files aren't kept, only each finished day's summary, so a rerun carries on where it stopped.
    const saved = path.join(CACHE, `gdelt-summary-${day}.json`);
    let sentences: string[];
    if (!SAMPLE && existsSync(saved)) {
      sentences = JSON.parse(await readFile(saved, "utf8"));
    } else {
      sentences = [...(await gdeltEvents(day, SAMPLE ? EVENT_SLOTS.slice(0, 2) : EVENT_SLOTS)), ...(await gdeltGkg(day, SAMPLE ? GKG_SLOTS.slice(2, 3) : GKG_SLOTS))];
      if (!SAMPLE && !pauseRequested() && sentences.length) await writeFile(saved, JSON.stringify(sentences));
    }
    for (const text of sentences) facts.push({ date: day, text });
  }
  const docs = byMonth(facts, { id: "gdelt", source: "GDELT", what: "Top news events and names coded by GDELT", url: "https://www.gdeltproject.org/", license: GDELT_LICENSE, visibility: "public" });
  return docs.map((d) => ({ ...d, text: `${d.text}\n\n${GDELT_CITATION}` }));
}

// Wikisource.

const WS_API = "https://en.wikisource.org/w/api.php?format=json&formatversion=2";
const MONTH_NAMES = "January|February|March|April|May|June|July|August|September|October|November|December";

/** A work's own date: the header's fields if complete, else a decision date, else the first 2026 date in its header notes or near the top of its text. */
function wikisourceDate(wikitext: string, text: string): string {
  const field = (name: string) => wikitext.match(new RegExp(`\\|\\s*${name}\\s*=\\s*(\\d{1,2}|${MONTH_NAMES})\\s*[|}\\n]`, "i"))?.[1];
  const month = field("month");
  const day = field("day");
  const fromParts = (d: string, m: string) => {
    const number = /^\d+$/.test(m) ? Number(m) : MONTH_NAMES.split("|").indexOf(titleCase(m)) + 1;
    return number >= 1 && number <= 12 ? `2026-${String(number).padStart(2, "0")}-${d.padStart(2, "0")}` : "";
  };
  if (month && day) return fromParts(day, month);
  const decided = text.slice(0, 3000).match(new RegExp(`Decided\\s+(${MONTH_NAMES})\\s+(\\d{1,2}),\\s+2026`));
  if (decided) return fromParts(decided[2], decided[1]);
  for (const top of [wikitext.slice(0, 2000), text.slice(0, 3000)]) {
    const written = top.match(new RegExp(`(?:(${MONTH_NAMES})\\s+(\\d{1,2})(?:-\\d{1,2})?,?\\s+2026)|(?:(\\d{1,2})\\s+(${MONTH_NAMES})\\s+2026)`));
    if (written) return written[1] ? fromParts(written[2], written[1]) : fromParts(written[3], written[4]);
  }
  return text.slice(0, 3000).match(/\b2026-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/)?.[0] ?? "";
}

/** A public licence only if the page's own licence template names one; anything else stays training only. */
function wikisourceLicense(wikitext: string): { license: string; visibility: SourceRecord["visibility"] } {
  const name = wikitext.match(/\{\{\s*(PD-[^|}\n]+|CC-?BY(?:-SA)?[^|}\n]*|CC0[^|}\n]*)/i)?.[1]?.trim();
  if (!name || /\bNC\b|\bND\b/i.test(name)) return { license: "Not stated on the page; see Wikisource; training only", visibility: "private" };
  return { license: `${name}${/^PD-/i.test(name) ? " (public domain)" : ""}, credit Wikisource (en.wikisource.org) and the work's author`, visibility: "public" };
}

const WS_NOISE = "licenseContainer|wst-header|ws-header|ws-noexport|noprint|mw-editsection|pagenum|ambox|metadata";

async function wikisourcePage(title: string): Promise<{ text: string; wikitext: string } | null> {
  const body = await get(`${WS_API}&action=parse&redirects=1&prop=text%7Cwikitext&page=${encodeURIComponent(title)}`);
  const parsed = body ? JSON.parse(body).parse : null;
  if (!parsed) return null;
  return { text: htmlToText(dropBlocks(parsed.text as string, WS_NOISE)), wikitext: parsed.wikitext as string };
}

async function wikisourceCreated(title: string): Promise<string> {
  const body = await get(`${WS_API}&action=query&prop=revisions&rvlimit=1&rvdir=newer&rvprop=timestamp&titles=${encodeURIComponent(title)}`);
  const pages = body ? (JSON.parse(body).query.pages as Array<{ revisions?: Array<{ timestamp: string }> }>) : [];
  return pages[0]?.revisions?.[0]?.timestamp.slice(0, 10) ?? "";
}

async function wikisource(): Promise<SourceRecord[]> {
  const pages = new Set<string>();
  const categories = ["Category:2026 works"];
  for (let i = 0; i < categories.length && !pauseRequested(); i++) {
    const body = await get(`${WS_API}&action=query&list=categorymembers&cmlimit=500&cmtitle=${encodeURIComponent(categories[i])}`);
    for (const m of body ? (JSON.parse(body).query.categorymembers as Array<{ ns: number; title: string }>) : []) {
      if (m.ns === 14 && !categories.includes(m.title) && !SAMPLE) categories.push(m.title);
      if (m.ns === 0) pages.add(m.title);
    }
  }
  const records: SourceRecord[] = [];
  let dropped = 0;
  let checked = 0;
  for (const title of pages) {
    if (pauseRequested() || (SAMPLE && (records.length >= LIMIT || checked >= 8))) break;
    checked++;
    const page = await wikisourcePage(title);
    if (!page) continue;
    // With no date in the work itself, the day Wikisource first published it; the category already vouches for the year.
    const date = wikisourceDate(page.wikitext, page.text) || (await wikisourceCreated(title));
    if (!inWindow(date)) {
      dropped++;
      continue;
    }
    // Long works keep their parts on subpages, such as a court's opinions.
    const parts: string[] = [page.text];
    const listing = SAMPLE && records.length > 0 ? null : await get(`${WS_API}&action=query&list=allpages&aplimit=200&apnamespace=0&apprefix=${encodeURIComponent(`${title}/`)}`);
    for (const sub of few(listing ? (JSON.parse(listing).query.allpages as Array<{ title: string }>) : [], 1)) {
      if (pauseRequested()) break;
      const part = await wikisourcePage(sub.title);
      if (part) parts.push(part.text);
    }
    records.push({ id: `wikisource:${title}`, source: "Wikisource", title, url: `https://en.wikisource.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, date, ...wikisourceLicense(page.wikitext), text: parts.join("\n\n") });
  }
  if (dropped) console.log(`wikisource: ${dropped} pages had no date in the window and were left out.`);
  return records;
}

runAll([
  ["wikidata-sparql", wikidata],
  ["openfootball", openfootball],
  ["cricsheet", ifAllowed("https://cricsheet.org", cricsheet)],
  ["nflverse", nflverse],
  ["tvmaze", ifAllowed("https://www.tvmaze.com", tvmaze)],
  ["nhtsa-recalls", nhtsaRecalls],
  ["fueleconomy", fuelEconomy],
  ["bts-ontime", btsOnTime],
  ["global-voices", ifAllowed("https://globalvoices.org", globalVoices)],
  ["voa", ifAllowed("https://www.voanews.com", voa)],
  ["kremlin", ifAllowed("http://en.kremlin.ru", kremlin)],
  ["un-news", ifAllowed("https://news.un.org", unNews)],
  ["agencia-brasil", ifAllowed("https://agenciabrasil.ebc.com.br", agenciaBrasil)],
  ["gdelt", gdelt],
  ["wikisource", wikisource],
]).catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Keyless 2026 sources nothing else collects: Meta's developer blog, the facebook org's Hugging Face cards, the EU and UK
 * sanctions lists, other languages' Wikipedia month, year and deaths articles, and US agency releases. Writes
 * .data/knowledge/sources/gap-*.jsonl, one file per step, so one failing doesn't lose the others.
 *
 * Left out, each after a real check on October 30, 2026:
 * - investor.atmeta.com: its home page and RSS feed both answer 403 with a Cloudflare challenge. EDGAR has the releases.
 * - www.who.int: its robots.txt bars CCBot from the whole site, which fails the opt-out rule in docs/KNOWLEDGE_UPDATE.md.
 * - www.state.gov, www.hhs.gov, www.nih.gov: robots.txt itself answers 403, so its rules can't be read and respected.
 *
 * Sanctioned people are counted, never named: the personal-data rule can't tell a minister from a private person here.
 * Companies, organisations and ships are named.
 *
 *   npx tsx scripts/knowledge/sources/gap-extra.ts [step ...]
 */
import { longDate } from "@/lib/knowledge/passages";
import { htmlToText, markdownToText, type SourceRecord } from "@/lib/knowledge/sources";
import { FROM, get, LIMIT, pauseRequested, runAll, TO, USER_AGENT } from "./common";

const SAMPLING = LIMIT !== Infinity;
const CONTACT = { "User-Agent": USER_AGENT.replace(/\)$/, "; team@offlinebase.com)") };
const MAX_DOC_WORDS = 4000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const inWindow = (date: string | null | undefined): date is string => !!date && date >= FROM && date <= TO;
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

interface Fact {
  date: string;
  text: string;
}

/** Dated sentences as documents by month, oldest first, split when a month runs long. */
function monthly(facts: Fact[], o: { id: string; source: string; subject: string; url: string; license: string }): SourceRecord[] {
  const byMonth = new Map<string, Fact[]>();
  for (const f of facts) {
    if (inWindow(f.date)) byMonth.set(f.date.slice(0, 7), [...(byMonth.get(f.date.slice(0, 7)) ?? []), f]);
  }
  const records: SourceRecord[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    const parts: Fact[][] = [[]];
    let words = 0;
    for (const f of byMonth.get(month)!.sort((a, b) => a.date.localeCompare(b.date))) {
      const n = countWords(f.text);
      if (words && words + n > MAX_DOC_WORDS) {
        parts.push([]);
        words = 0;
      }
      parts[parts.length - 1].push(f);
      words += n;
    }
    parts.forEach((part, i) => {
      const suffix = parts.length > 1 ? `, part ${i + 1}` : "";
      records.push({
        id: `${o.id}:${month}${parts.length > 1 ? `:${i + 1}` : ""}`,
        source: o.source,
        title: `${o.subject}, ${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}${suffix}`,
        url: o.url,
        date: part[part.length - 1].date,
        license: o.license,
        visibility: "public",
        text: part.map((f) => f.text).join("\n\n"),
      });
    });
  }
  return records;
}

// Meta developer blog

const META_LICENSE = "Meta copyright, training only";
const DEV_META = "https://dev.meta.ai";

/**
 * The blog isn't in llms.txt and has no Markdown copies, so the listing's embedded data gives slugs and dates, and each
 * post's text comes from its server-rendered page, between its title and the page's closing sections.
 */
async function devMetaBlog(): Promise<SourceRecord[]> {
  const index = await get(`${DEV_META}/resources/blog`);
  const posts = new Map<string, number>();
  for (const [, slug, time] of (index ?? "").matchAll(/\\"collection\\":\\"blog\\",\\"slug\\":\\"([^"\\]+)\\"[\s\S]{0,600}?\\"creation_time\\":(\d+)/g)) posts.set(slug, Number(time));
  const records: SourceRecord[] = [];
  for (const [slug, time] of posts) {
    if (pauseRequested()) break;
    const date = new Date(time * 1000).toISOString().slice(0, 10);
    if (!inWindow(date)) continue;
    const url = `${DEV_META}/resources/blog/${slug}`;
    const html = await get(url);
    if (!html) continue;
    const start = html.search(/<h1[\s>]/);
    if (start < 0) continue;
    const end = html.search(/<footer[\s>]/);
    const body = html.slice(start, end > start ? end : undefined).replace(/<(script|style|svg|button|nav)\b[\s\S]*?<\/\1>/gi, " ");
    const title = htmlToText(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? slug);
    /** Bylines name staff, and the rest is page furniture. */
    const text = htmlToText(body.replace(/<h1[^>]*>[\s\S]*?<\/h1>/, ""))
      .split(/\n\s*\n/)
      .filter((p) => !/^(By [A-Z]|TAGS|←→)/.test(p.trim()))
      .join("\n\n");
    records.push({ id: `gap-meta-dev-blog:${slug}`, source: "Meta AI developers blog", title, url, date, license: META_LICENSE, visibility: "private", text: `On ${longDate(date)}, Meta's AI developers blog published "${title}".\n\n${text}` });
  }
  return records;
}

// Hugging Face

const HF_OPEN = new Set(["apache-2.0", "mit", "bsd", "bsd-2-clause", "bsd-3-clause", "cc0-1.0", "cc-by-4.0", "cc-by-sa-4.0"]);
const HF_NOISE = /^(initial commit|update readme|upload|add files|create readme|delete|\.gitattributes|update \S+\.(md|json)$)/i;

interface HfModel {
  id: string;
  gated?: boolean | string;
  tags?: string[];
  pipeline_tag?: string;
  createdAt?: string;
  lastModified?: string;
}

/**
 * Cards of the facebook org's models changed in the window. A gated repo's commits are closed without a login, so its
 * dates come from the listing alone, and a card that is only its access form leaves a record of those dates and the license.
 */
async function huggingFaceFacebook(): Promise<SourceRecord[]> {
  const list = await get("https://huggingface.co/api/models?author=facebook&sort=lastModified&direction=-1&limit=1000&full=true");
  const models = (list ? (JSON.parse(list) as HfModel[]) : []).filter((m) => (m.lastModified ?? "") >= FROM);
  const records: SourceRecord[] = [];
  for (const m of models) {
    if (pauseRequested() || records.length >= LIMIT) break;
    const created = m.createdAt?.slice(0, 10);
    const commits = m.gated ? null : await get(`https://huggingface.co/api/models/${m.id}/commits/main`);
    const inside = (commits ? (JSON.parse(commits) as Array<{ title: string; date: string }>) : [])
      .map((c) => ({ title: c.title.trim(), date: c.date.slice(0, 10) }))
      .filter((c) => inWindow(c.date));
    const date = inWindow(created) ? created : (inside[0]?.date ?? m.lastModified?.slice(0, 10));
    if (!inWindow(date)) continue;
    const licenseTag = m.tags?.find((t) => t.startsWith("license:"))?.slice(8) ?? "";
    const md = await get(`https://huggingface.co/${m.id}/resolve/main/README.md`);
    const card = md ? markdownToText(md).replace(/https?:\/\/\S+/g, "").trim() : "";
    const open = HF_OPEN.has(licenseTag);
    const facts = [
      inWindow(created) ? `${m.id} was published on Hugging Face on ${longDate(created)}.` : `${m.id} was first published on Hugging Face on ${created ? longDate(created) : "an earlier date"} and last changed by ${longDate(date)}.`,
      licenseTag ? `Its license tag is ${licenseTag}.` : "It declares no license tag.",
      m.pipeline_tag ? `Its task is ${m.pipeline_tag}.` : "",
      m.gated ? "Access to its files is gated." : "",
      ...inside.filter((c) => !HF_NOISE.test(c.title)).slice(0, 10).map((c) => `On ${longDate(c.date)}, a commit was titled "${c.title}".`),
    ].filter(Boolean);
    records.push({
      id: `gap-hf-facebook:${m.id}`,
      source: "Hugging Face model card, facebook org",
      title: m.id,
      url: `https://huggingface.co/${m.id}`,
      date,
      license: open ? licenseTag : `${licenseTag || "No license tag"}, training only`,
      visibility: open ? "public" : "private",
      text: [facts.join(" "), countWords(card) >= 40 ? card : ""].filter(Boolean).join("\n\n"),
    });
  }
  return records;
}

// Sanctions

const EU_LICENSE = "European Union Financial Sanctions Files; reuse with attribution, European Commission";
const EU_LIST = "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw";
const EU_PROGRAMMES: Record<string, string> = {
  AFG: "Afghanistan", BDI: "Burundi", BIH: "Bosnia and Herzegovina", BLR: "Belarus", CAF: "the Central African Republic", CHEM: "chemical weapons", COD: "the Democratic Republic of the Congo", CYB: "cyber attacks", DPRK: "North Korea",
  EUAQ: "ISIL and Al-Qaida (autonomous)", GIN: "Guinea", GNB: "Guinea-Bissau", GTM: "Guatemala", HAI: "Haiti", HR: "human rights", HTI: "Haiti", IRN: "Iran", IRQ: "Iraq", LBN: "Lebanon", LBY: "Libya", MDA: "Moldova", MLI: "Mali", MMR: "Myanmar", NIC: "Nicaragua",
  RUS: "Russia", RUSDA: "Russian destabilising activities", SDN: "Sudan", SDNZ: "Sudan", SOM: "Somalia", SSD: "South Sudan", SYR: "Syria", TAQA: "ISIL and Al-Qaida", TERR: "terrorism", TUN: "Tunisia", UKR: "Ukraine territorial integrity", UNLI: "United Nations listings", VEN: "Venezuela", YEM: "Yemen", ZWE: "Zimbabwe",
};
const EU_KINDS: Record<string, string> = { regulation: "regulation", amendment: "amending act", repealing: "repealing act" };
const attr = (s: string, name: string) => s.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
const decode = (s: string) => htmlToText(s).replace(/\s+/g, " ").trim();

interface EuAct {
  date: string;
  number: string;
  programme: string;
  kind: string;
  body: string;
  inForce: string;
  people: number;
  newEntries: number;
  entities: Set<string>;
}

function namedList(names: Iterable<string>, max = 100): string {
  const all = [...names];
  const shown = all.slice(0, max).join("; ");
  return all.length > max ? `${shown}; and ${all.length - max} more` : shown;
}

/** The list as it stands now: an act's entries since removed from the list aren't in the file, so removals don't show. */
async function euSanctions(): Promise<SourceRecord[]> {
  const xml = await get(EU_LIST, { headers: CONTACT });
  const acts = new Map<string, EuAct>();
  for (const [entry] of (xml ?? "").matchAll(/<sanctionEntity [\s\S]*?<\/sanctionEntity>/g)) {
    const isPerson = /<subjectType code="person"/.test(entry);
    const designated = attr(entry.slice(0, entry.indexOf(">")), "designationDate");
    const aliases = [...entry.matchAll(/<nameAlias [^>]*>/g)].map((m) => m[0]);
    const alias = aliases.find((a) => attr(a, "strong") === "true" && /^(EN)?$/.test(attr(a, "nameLanguage"))) ?? aliases[0] ?? "";
    for (const [tag] of entry.matchAll(/<regulation [^>]*>/g)) {
      const date = attr(tag, "publicationDate");
      if (!inWindow(date)) continue;
      const number = attr(tag, "numberTitle").replace(/\s*\(OJ .*$/, "");
      const key = `${date}|${number}|${attr(tag, "programme")}`;
      const act = acts.get(key) ?? { date, number, programme: attr(tag, "programme"), kind: attr(tag, "regulationType"), body: attr(tag, "organisationType"), inForce: attr(tag, "entryIntoForceDate"), people: 0, newEntries: 0, entities: new Set<string>() };
      if (isPerson) act.people++;
      else act.entities.add(decode(attr(alias, "wholeName")));
      if (designated === date) act.newEntries++;
      acts.set(key, act);
    }
  }
  const facts = [...acts.values()].map((a) => {
    const issuer = a.body === "council" ? "the Council of the EU" : a.body === "commission" ? "the European Commission" : "the EU";
    const area = EU_PROGRAMMES[a.programme] ? `the ${EU_PROGRAMMES[a.programme]} sanctions` : `the ${a.programme} sanctions programme`;
    const act = a.programme === "UNLI" ? `recorded United Nations listing ${a.number}` : `published ${EU_KINDS[a.kind] ?? "act"} ${a.number} under ${area}`;
    const who = [a.people ? `${a.people} ${a.people === 1 ? "person" : "people"}` : "", a.entities.size ? `${a.entities.size} ${a.entities.size === 1 ? "organisation or company" : "organisations or companies"} (${namedList(a.entities)})` : ""].filter(Boolean).join(" and ");
    const total = a.people + a.entities.size;
    const fresh = a.newEntries === total ? " All of them were newly designated that day." : a.newEntries ? ` ${a.newEntries} of them ${a.newEntries === 1 ? "was" : "were"} newly designated that day.` : "";
    const force = a.inForce && a.inForce !== a.date ? ` It entered into force on ${longDate(a.inForce)}.` : "";
    return { date: a.date, text: `On ${longDate(a.date)}, ${issuer} ${act}. Its entries on the EU's consolidated financial sanctions list cover ${who}.${fresh}${force}` };
  });
  return monthly(facts, { id: "gap-eu-sanctions", source: "EU consolidated financial sanctions list", subject: "Changes to the EU consolidated financial sanctions list", url: "https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions", license: EU_LICENSE });
}

const UK_LICENSE = "Contains public sector information licensed under the Open Government Licence v3.0, UK Sanctions List, FCDO";
const ukDate = (s: string) => (/^\d{2}\/\d{2}\/\d{4}$/.test(s) ? `${s.slice(6)}-${s.slice(3, 5)}-${s.slice(0, 2)}` : "");
const ukRegime = (s: string) => decode(s).replace(/^The /, "the ");

/** Each entry holds only its latest update, so an entry changed twice in the window counts on the later day, and removals don't show. */
async function ukSanctions(): Promise<SourceRecord[]> {
  const xml = await get("https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml", { headers: CONTACT });
  const designated = new Map<string, { date: string; regime: string; people: number; entities: string[]; ships: string[] }>();
  const updated = new Map<string, { date: string; regime: string; count: number }>();
  for (const [entry] of (xml ?? "").matchAll(/<Designation>[\s\S]*?<\/Designation>/g)) {
    const field = (name: string) => entry.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? "";
    const when = ukDate(field("DateDesignated"));
    const changed = ukDate(field("LastUpdated"));
    const regime = ukRegime(field("RegimeName"));
    const kind = field("IndividualEntityShip");
    if (inWindow(when)) {
      const key = `${when}|${regime}`;
      const row = designated.get(key) ?? { date: when, regime, people: 0, entities: [], ships: [] };
      const primary = [...entry.matchAll(/<Name6>([^<]*)<\/Name6>\s*<NameType>Primary name<\/NameType>/gi)][0]?.[1];
      if (kind === "Individual") row.people++;
      else if (primary) (kind === "Ship" ? row.ships : row.entities).push(decode(primary));
      designated.set(key, row);
    } else if (inWindow(changed)) {
      const key = `${changed}|${regime}`;
      const row = updated.get(key) ?? { date: changed, regime, count: 0 };
      row.count++;
      updated.set(key, row);
    }
  }
  const facts: Fact[] = [
    ...[...designated.values()].map((d) => {
      const groups = [
        d.people ? `${d.people} ${d.people === 1 ? "person" : "people"}` : "",
        d.entities.length ? `${d.entities.length} ${d.entities.length === 1 ? "organisation or company" : "organisations or companies"} (${namedList(d.entities)})` : "",
        d.ships.length ? `${d.ships.length} ${d.ships.length === 1 ? "ship" : "ships"} (${namedList(d.ships)})` : "",
      ].filter(Boolean);
      return { date: d.date, text: `On ${longDate(d.date)}, the UK designated ${groups.join(" and ")} under ${d.regime}.` };
    }),
    ...[...updated.values()].map((u) => ({ date: u.date, text: `On ${longDate(u.date)}, the UK updated ${u.count} existing ${u.count === 1 ? "entry" : "entries"} on the UK Sanctions List under ${u.regime}.` })),
  ];
  return monthly(facts, { id: "gap-uk-sanctions", source: "UK Sanctions List", subject: "Changes to the UK Sanctions List", url: "https://www.gov.uk/government/publications/the-uk-sanctions-list", license: UK_LICENSE });
}

// Wikipedia in other languages

const WIKI_GAP_MS = 1500;
const SNAPSHOT = `${TO}T23:59:59Z`;
/** A revision whose text is a list of links to the month pages has nothing to add. */
const MIN_ARTICLE_WORDS = 150;
const FOOTER_SECTIONS = /^(Einzelnachweise|Weblinks|Siehe auch|Literatur|Anmerkungen|Références|Notes et références|Liens externes|Voir aussi|Articles connexes|脚注|出典|関連項目|外部リンク|注釈|Примечания|Ссылки|См\. также|Литература|Referencias|Enlaces externos|Véase también|Notas|Note|Collegamenti esterni|Voci correlate|Altri progetti|Referências|Ligações externas|Ver também|Przypisy|Linki zewnętrzne|Zobacz też|Bronnen|Externe links|Zie ook|Noten|Bronnen, noten en\/of referenties)$/i;

/** Calendar grids and year-navigation bars, a cell or a row at a time. */
const WIKI_FURNITURE = /^([\d\s.,·–-]*|\S{1,2}(, \S{1,2})*)$|[◄►]|^(※|掲載例)/;

interface WikiLanguage {
  code: string;
  name: string;
  /** Titles with the month they cover, 1 to 10; 0 for a page about the year, dated the window's last day. */
  titles: Array<[string, number]>;
}

const each = (names: string[], title: (name: string, i: number) => string): Array<[string, number]> => names.map((n, i) => [title(n, i), i + 1]);
const TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(String);

const WIKIS: WikiLanguage[] = [
  {
    code: "de",
    name: "German",
    titles: [["2026", 0], ...each(["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober"], (m) => `${m} 2026`), ...each(["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober"], (m) => `Nekrolog ${m} 2026`)],
  },
  {
    code: "fr",
    name: "French",
    titles: [["2026", 0], ...each(["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre"], (m) => `${m} 2026`), ...each(["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre"], (m) => `Décès en ${m} 2026`)],
  },
  {
    code: "ja",
    name: "Japanese",
    titles: [["2026年", 0], ...each(TEN, (m) => `Portal:最近の出来事/2026年${m}月`), ...each(TEN, (m) => `訃報 2026年${m}月`)],
  },
  {
    code: "ru",
    name: "Russian",
    titles: [
      ["2026 год", 0],
      ...each(["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь"], (m) => `${m} 2026 года`),
      ...each(["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре"], (m) => `Умершие в ${m} 2026 года`),
      ["Список умерших в 2026 году", 10],
    ],
  },
  {
    code: "es",
    name: "Spanish",
    titles: [["2026", 0], ...each(["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre"], (m) => `Anexo:Fallecidos en ${m} de 2026`)],
  },
  { code: "it", name: "Italian", titles: [["2026", 0], ["Morti nel 2026", 0], ...each(["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre"], (m) => `Morti nel 2026/${m}`)] },
  {
    code: "pt",
    name: "Portuguese",
    titles: [["2026", 0], ...each(["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro"], (m) => `Mortes em ${m} de 2026`)],
  },
  {
    code: "pl",
    name: "Polish",
    titles: [
      ["2026", 0],
      ...each(["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik"], (m) => `${m} 2026`),
      ...each(["w styczniu", "w lutym", "w marcu", "w kwietniu", "w maju", "w czerwcu", "w lipcu", "w sierpniu", "we wrześniu", "w październiku"], (m) => `Zmarli ${m} 2026`),
    ],
  },
  {
    code: "nl",
    name: "Dutch",
    titles: [["2026", 0], ...each(["Januari", "Februari", "Maart", "April", "Mei", "Juni", "Juli", "Augustus", "September", "Oktober"], (m) => `${m} 2026`), ...each(["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober"], (m) => `Lijst van personen overleden in ${m} 2026`)],
  },
];

/** A table row as one line, so a death's day, name and occupation stay together. */
const tableRow = (row: string) =>
  row
    .replace(/<\/(p|div|li)>|<br\s*\/?>/gi, " ")
    .replace(/<\/t[dh]>/g, ", ")
    .replace(/<t[dh]\b[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/(,\s*)+<\/tr>/g, "</tr>");

/** A page's parsed HTML as text: references, navigation boxes and the closing sections of links go. */
function wikiText(html: string): string {
  const sections = html.split(/(?=<div class="mw-heading mw-heading2")/);
  const kept = sections.filter((s) => !FOOTER_SECTIONS.test(htmlToText(s.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "").trim()));
  return htmlToText(
    kept
      .join("")
      .replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[\s\S]*?<\/sup>/g, "")
      .replace(/<ol class="references">[\s\S]*?<\/ol>/g, "")
      .replace(/<(div|table)\b[^>]*class="[^"]*(navbox|metadata|ambox|sister|noprint)[^"]*"[\s\S]*?<\/\1>/g, "")
      .replace(/<tr\b[\s\S]*?<\/tr>/g, tableRow),
  )
    .replace(/\u200b/g, "")
    .replace(/\[[а-яё]{2,5}\.\]/g, "")
    .split(/\n\s*\n/)
    .filter((p) => !WIKI_FURNITURE.test(p.trim()) && (p.match(/\|/g) ?? []).length < 3)
    .join("\n\n");
}

/** Each article as it stood at the end of the window, so nothing from after it leaks in, and the revision is on the record. */
async function wikipedia(lang: WikiLanguage): Promise<SourceRecord[]> {
  const api = `https://${lang.code}.wikipedia.org/w/api.php?format=json&formatversion=2`;
  const opts = { gapMs: WIKI_GAP_MS, headers: CONTACT };
  const records: SourceRecord[] = [];
  for (const [title, month] of lang.titles) {
    if (pauseRequested() || records.length >= LIMIT) break;
    const rev = await get(`${api}&action=query&prop=revisions&rvlimit=1&rvprop=ids|timestamp&rvdir=older&rvstart=${SNAPSHOT}&redirects=1&titles=${encodeURIComponent(title)}`, opts);
    const page = rev ? (JSON.parse(rev) as { query?: { pages?: Array<{ title: string; revisions?: Array<{ revid: number }> }> } }).query?.pages?.[0] : null;
    const revid = page?.revisions?.[0]?.revid;
    if (!page || !revid) {
      console.warn(`${lang.code}: no revision of ${title} by ${SNAPSHOT}`);
      continue;
    }
    const parsed = await get(`${api}&action=parse&prop=text&disableeditsection=1&disabletoc=1&oldid=${revid}`, opts);
    const html = parsed ? (JSON.parse(parsed) as { parse?: { text?: string } }).parse?.text : null;
    if (!html) continue;
    const text = wikiText(html);
    if (countWords(text) < MIN_ARTICLE_WORDS && !/[぀-ヿ一-鿿]/.test(text)) continue;
    const date = month ? new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10) : TO;
    const url = `https://${lang.code}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}?oldid=${revid}`;
    records.push({
      id: `gap-wikipedia-${lang.code}:${page.title}`,
      source: `${lang.name} Wikipedia`,
      title: page.title,
      url,
      date: date > TO ? TO : date,
      license: `CC BY-SA 4.0, Wikipedia contributors, ${lang.code}.wikipedia.org, revision ${revid}`,
      visibility: "public",
      text: `This is the ${lang.name} Wikipedia article "${page.title}", as it stood on ${longDate(TO)}.\n\n${text}`,
    });
  }
  return records;
}

// US agency releases

/** A release about one person's case: the personal-data rule drops these. Round-ups of third parties' praise aren't the agency's own words. */
const US_SKIP = /sentenc|plead|pled\b|guilty|convict|indict|charged?\b|arrest|\b(man|woman|resident)\b|^(What They Are Saying|ICYMI|WTAS)\b/i;

/** All of a Drupal site's sitemap pages, as its URLs that match, with each one's last-changed date. */
async function drupalSitemap(host: string, keep: RegExp, gapMs: number): Promise<Array<{ url: string; lastmod: string }>> {
  const index = await get(`https://${host}/sitemap.xml`, { gapMs, headers: CONTACT });
  const pages = [...(index ?? "").matchAll(/<loc>([^<]*sitemap\.xml\?page=\d+)<\/loc>/g)].map((m) => m[1]);
  const found = new Map<string, string>();
  for (const page of pages) {
    if (pauseRequested()) break;
    const xml = await get(page, { gapMs, headers: CONTACT });
    for (const [, url, lastmod] of (xml ?? "").matchAll(/<loc>([^<]*)<\/loc>\s*(?:<lastmod>([^<]*)<\/lastmod>)?/g)) {
      if (keep.test(url)) found.set(url, lastmod ?? "");
    }
  }
  return [...found].map(([url, lastmod]) => ({ url, lastmod })).sort((a, b) => b.lastmod.localeCompare(a.lastmod));
}

/** A release's own date: DOE prints it on the page, and its metadata can be a reused page's older date. */
function pageDate(html: string): string | undefined {
  const printed = html.match(/(?:press-release-buttons__date|display-date)[^>]*>\s*([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1];
  if (printed) return new Date(`${printed} UTC`).toISOString().slice(0, 10);
  return html.match(/article:published_time"[^>]*content="(\d{4}-\d{2}-\d{2})/)?.[1] ?? html.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/)?.[1];
}

function pageTitle(html: string): string {
  const raw = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  return htmlToText(raw).replace(/\s*\|\s*(US EPA|Department of Energy)\s*$/i, "").trim();
}

/** The release's words: the title and date it repeats, press contacts and what follows its related links all go. */
function pageBody(html: string, title: string): string {
  const start = html.indexOf("<main");
  const main = start >= 0 ? html.slice(start) : html;
  const end = main.indexOf("</main>");
  const paragraphs = htmlToText((end > 0 ? main.slice(0, end) : main).replace(/<(nav|aside|form|button)\b[\s\S]*?<\/\1>/gi, " "))
    .split(/\n\s*\n/)
    .map((p) => p.trim());
  const close = paragraphs.findIndex((p) => /^(Related Links|Related Topics|Tags:|###|Explore more on these topics|Media Inquiries|View (Previous|Next) Press Release)/i.test(p));
  return (close > 0 ? paragraphs.slice(0, close) : paragraphs)
    .filter((p) => p !== title && !/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(p) && !/@\w+\.gov|^\(\d{3}\) \d{3}-\d{4}$|^(Contact|Media Contact|Share|Print|Top of Page|Last updated|Energy\.gov$|Estimated Read Time)\b/i.test(p))
    .join("\n\n");
}

/** `listing` is a page of the newest releases, for a site whose sitemap has stopped keeping up. */
async function agencyReleases(o: { host: string; id: string; source: string; name: string; keep: RegExp; gapMs: number; listing?: string }): Promise<SourceRecord[]> {
  const urls = await drupalSitemap(o.host, o.keep, o.gapMs);
  const changed = urls.filter((u) => !u.lastmod || u.lastmod.slice(0, 10) >= FROM).map((u) => u.url);
  const listed = o.listing ? [...((await get(o.listing, { gapMs: o.gapMs, headers: CONTACT })) ?? "").matchAll(/href="(\/articles\/[^"]+)"/g)].map((m) => `https://${o.host}${m[1]}`) : [];
  const candidates = [...new Set([...listed, ...changed])];
  console.log(`${o.id}: ${urls.length} URLs in the sitemap, ${changed.length} changed since ${FROM}, ${listed.length} listed`);
  const records: SourceRecord[] = [];
  for (const url of SAMPLING ? candidates.slice(0, 40) : candidates) {
    if (pauseRequested() || records.length >= LIMIT) break;
    const html = await get(url, { gapMs: o.gapMs, headers: CONTACT });
    if (!html) continue;
    const date = pageDate(html);
    if (!inWindow(date)) continue;
    const title = pageTitle(html);
    if (!title || US_SKIP.test(title)) continue;
    const text = pageBody(html, title);
    if (countWords(text) < 40) continue;
    records.push({ id: `${o.id}:${url.split("/").filter(Boolean).pop()}`, source: o.source, title, url, date, license: `Public domain (US government work), ${o.name}`, visibility: "public", text: `On ${longDate(date)}, the ${o.name} published "${title}".\n\n${text}` });
  }
  return records;
}

runAll([
  // Not run: investor.atmeta.com, www.who.int, www.state.gov, www.hhs.gov, www.nih.gov. See the note at the top.
  ["gap-meta-dev-blog", devMetaBlog],
  ["gap-hf-facebook", huggingFaceFacebook],
  ["gap-eu-sanctions", euSanctions],
  ["gap-uk-sanctions", ukSanctions],
  ...WIKIS.map((lang): [string, () => Promise<SourceRecord[]>] => [`gap-wikipedia-${lang.code}`, () => wikipedia(lang)]),
  ["gap-us-epa", () => agencyReleases({ host: "www.epa.gov", id: "gap-us-epa", source: "US Environmental Protection Agency news releases", name: "Environmental Protection Agency", keep: /\/newsreleases\/[^/]+$/, gapMs: 2000 })],
  ["gap-us-energy", () => agencyReleases({ host: "www.energy.gov", id: "gap-us-energy", source: "US Department of Energy articles", name: "Department of Energy", keep: /www\.energy\.gov\/articles\/[^/]+$/, gapMs: 1000, listing: "https://www.energy.gov/newsroom" })],
]).catch((err) => {
  console.error(err);
  process.exit(1);
});

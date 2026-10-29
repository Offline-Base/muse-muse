import { wikitextToPlain } from "@/lib/knowledge/wikitext";

/**
 * A small, polite client for English Wikipedia's Action API: one request at a time, maxlag set, a User-Agent that
 * names the project (Wikimedia asks for one), and a few retries on lag or 5xx. Text is CC BY-SA 4.0, so anything
 * built from it says so and links back.
 */

export const WIKI_API = "https://en.wikipedia.org/w/api.php";
export const USER_AGENT = "MuseMuse-knowledge/0.1 (https://github.com/Offline-Base/muse-muse)";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function wikiGet(params: Record<string, string>, fetcher: Fetcher = fetch): Promise<Record<string, unknown>> {
  const url = `${WIKI_API}?${new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetcher(url, { headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT } });
    const retryable = res.status === 429 || res.status >= 500;
    if (res.ok) {
      const json = (await res.json()) as Record<string, unknown> & { error?: { code?: string; info?: string } };
      if (json.error?.code === "maxlag" && attempt < 4) {
        await sleep(Number(res.headers.get("retry-after") ?? 5) * 1000);
        continue;
      }
      if (json.error) throw new Error(`Wikipedia API: ${json.error.code}: ${json.error.info}`);
      return json;
    }
    if (!retryable || attempt >= 4) throw new Error(`Wikipedia API: HTTP ${res.status} for ${params.page ?? params.titles ?? ""}`);
    await sleep(Number(res.headers.get("retry-after") ?? 2 ** attempt) * 1000);
  }
}

/** A page's current wikitext, or null when it doesn't exist. */
export async function pageWikitext(title: string, fetcher?: Fetcher): Promise<string | null> {
  try {
    const json = (await wikiGet({ action: "parse", page: title, prop: "wikitext", redirects: "1" }, fetcher)) as {
      parse?: { wikitext?: string };
    };
    return json.parse?.wikitext ?? null;
  } catch (err) {
    if (/missingtitle/.test((err as Error).message)) return null;
    throw err;
  }
}

interface Revision {
  revid: number;
  timestamp: string;
  slots?: { main?: { content?: string } };
}

/** The article as it stood at `at` (the last revision on or before it) and now. old is null for a newer article. */
export async function articleThenAndNow(
  title: string,
  at: string,
  fetcher?: Fetcher,
): Promise<{ title: string; old: Revision | null; current: Revision | null }> {
  const base = { action: "query", prop: "revisions", titles: title, redirects: "1", rvslots: "main", rvprop: "ids|timestamp|content" };
  const now = (await wikiGet({ ...base, rvlimit: "1" }, fetcher)) as {
    query?: { pages?: Array<{ title: string; missing?: boolean; revisions?: Revision[] }> };
  };
  const page = now.query?.pages?.[0];
  if (!page || page.missing) return { title, old: null, current: null };
  const then = (await wikiGet({ ...base, titles: page.title, rvlimit: "1", rvdir: "older", rvstart: at }, fetcher)) as {
    query?: { pages?: Array<{ revisions?: Revision[] }> };
  };
  return { title: page.title, old: then.query?.pages?.[0]?.revisions?.[0] ?? null, current: page.revisions?.[0] ?? null };
}

/** Words that end in a full stop without ending the sentence. */
const ABBREVIATION = /(?:\b(?:U\.S|U\.K|U\.N|E\.U|St|Mr|Mrs|Ms|Dr|Jr|Sr|No|Nos|Inc|Ltd|Co|Corp|Gen|Lt|Col|Sgt|Capt|Maj|Rep|Sen|Gov|Pres|Prof|Rev|Mt|Ft|vs|etc|approx|Jan|Feb|Mar|Apr|Aug|Sept|Sep|Oct|Nov|Dec)|\b[A-Z])\.$/;

/** Splits on . ! ? before a capital or digit, but not after an abbreviation or an initial ("The U.S. Army"). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?]["')]*)\s+(?=[A-Z0-9"'(])/)) {
    if (out.length && ABBREVIATION.test(out[out.length - 1])) out[out.length - 1] += ` ${part}`;
    else out.push(part);
  }
  return out;
}

/** Sentences of plain text, each under the section heading it sits in. */
export function sectionSentences(wikitext: string): Array<{ section: string; sentence: string }> {
  const out: Array<{ section: string; sentence: string }> = [];
  let section = "";
  for (const block of wikitext.split(/\n(?==+[^=\n]+=+\s*\n)/)) {
    const heading = block.match(/^=+\s*([^=\n]+?)\s*=+\s*\n/);
    if (heading) section = wikitextToPlain(heading[1]);
    const text = wikitextToPlain(heading ? block.slice(heading[0].length) : block)
      .split("\n")
      .filter((l) => !/^\s*[|!*#:;]/.test(l)) // table rows, list markup that survived, indents
      .join(" ");
    for (const s of splitSentences(text)) {
      const sentence = s.replace(/\s+/g, " ").trim();
      if (sentence.split(" ").length >= 6 && /[.!?]["')]*$/.test(sentence)) out.push({ section, sentence });
    }
  }
  return out;
}

const SKIP_SECTIONS = /^(references|notes|external links|see also|further reading|sources|bibliography|citations|footnotes)$/i;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Share of the smaller sentence's words that the other one has too. */
function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.max(1, Math.min(a.size, b.size));
}

/** Old sentences indexed by their longer words, so each new sentence is compared only with likely rewrites. */
function rewriteFinder(old: string[]): (sentence: string) => boolean {
  const sets = old.map(words);
  const index = new Map<string, number[]>();
  sets.forEach((set, i) => {
    for (const w of set) if (w.length >= 5) index.set(w, [...(index.get(w) ?? []), i]);
  });
  return (sentence) => {
    const mine = words(sentence);
    const hits = new Map<number, number>();
    for (const w of mine) if (w.length >= 5) for (const i of index.get(w) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1);
    for (const [i, n] of hits) if (n >= 2 && overlap(mine, sets[i]) >= REWRITE_OVERLAP) return true;
    return false;
  };
}

/** A sentence sharing this much of its words with an old one is a copyedit of it, not news. */
export const REWRITE_OVERLAP = 0.7;

const RECENT = /\b2026\b/;

/**
 * What an article gained after a date, grouped by section. A new article (no old revision) counts in full. For an
 * older one, a sentence counts when no old sentence reads like it and it mentions 2026, or sits in a section or an
 * article whose name does: big articles get rewritten all the time, and those rewrites aren't news.
 */
export function addedSince(
  oldWikitext: string | null,
  currentWikitext: string,
  title = "",
): Array<{ section: string; sentences: string[] }> {
  const old = oldWikitext ? sectionSentences(oldWikitext).map((s) => s.sentence) : [];
  const exact = new Set(old.map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()));
  const isRewrite = rewriteFinder(old);
  const groups = new Map<string, string[]>();
  for (const { section, sentence } of sectionSentences(currentWikitext)) {
    if (SKIP_SECTIONS.test(section)) continue;
    if (oldWikitext !== null) {
      if (exact.has(sentence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()) || isRewrite(sentence)) continue;
      if (!RECENT.test(sentence) && !RECENT.test(section) && !RECENT.test(title)) continue;
    }
    groups.set(section, [...(groups.get(section) ?? []), sentence]);
  }
  return [...groups].map(([section, sentences]) => ({ section, sentences }));
}

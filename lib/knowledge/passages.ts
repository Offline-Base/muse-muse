import type { CurrentEvent } from "@/lib/knowledge/current-events";

/**
 * The corpus as passages a question writer can work from: a day's events grouped by the story they belong to, and
 * each article's 2026 additions grouped by section. Every passage carries a header that says where it's from and
 * when, so questions and answers can name the date.
 */

export interface ArticleDelta {
  title: string;
  url: string;
  linkedFrom: number;
  isNew: boolean;
  added: Array<{ section: string; sentences: string[] }>;
}

export interface Passage {
  /** Stable id: "event:2026-06-15:3" or "article:2026 Iran war:Ceasefire:0". */
  id: string;
  kind: "event" | "article" | "source";
  /** One line: the date and story for events, the article and section for article text, the document for a source. */
  header: string;
  text: string;
  /** The day for events; null for article text, which only says it was added after the cutoff. */
  date: string | null;
  url: string;
  words: number;
}

export const PASSAGE_WORDS = 220;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-06-15" as "June 15, 2026". */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Splits sentences into runs of at most `max` words, never splitting a sentence. */
function chunk(sentences: string[], max: number): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  let words = 0;
  for (const s of sentences) {
    const n = countWords(s);
    if (run.length && words + n > max) {
      runs.push(run);
      run = [];
      words = 0;
    }
    run.push(s);
    words += n;
  }
  if (run.length) runs.push(run);
  return runs;
}

const dayUrl = (date: string) =>
  `https://en.wikipedia.org/wiki/Portal:Current_events/${longDate(date).replace(",", "").replace(/ /g, "_")}`;

export function eventPassages(events: CurrentEvent[], max = PASSAGE_WORDS): Passage[] {
  const groups = new Map<string, CurrentEvent[]>();
  for (const e of events) {
    const key = `${e.date}\u0000${e.category}\u0000${e.topics[e.topics.length - 1] ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const passages: Passage[] = [];
  const perDay = new Map<string, number>();
  for (const [key, group] of groups) {
    const [date, category] = key.split("\u0000");
    for (const run of chunk(group.map((e) => e.text), max)) {
      const n = perDay.get(date) ?? 0;
      perDay.set(date, n + 1);
      const text = run.join(" ");
      passages.push({
        id: `event:${date}:${n}`,
        kind: "event",
        header: [longDate(date), category, ...group[0].topics].filter(Boolean).join(" | "),
        text,
        date,
        url: dayUrl(date),
        words: countWords(text),
      });
    }
  }
  return passages;
}

export function articlePassages(articles: ArticleDelta[], asOf: string, max = PASSAGE_WORDS): Passage[] {
  const passages: Passage[] = [];
  for (const a of articles) {
    for (const g of a.added) {
      chunk(g.sentences, max).forEach((run, i) => {
        const text = run.join(" ");
        const where = g.section ? `${a.title}, section "${g.section}"` : a.title;
        passages.push({
          id: `article:${a.title}:${g.section}:${i}`,
          kind: "article",
          header: `Wikipedia article ${where}, text ${a.isNew ? "of an article created" : "added"} between the cutoff and ${longDate(asOf)}`,
          text,
          date: null,
          url: a.url,
          words: countWords(text),
        });
      });
    }
  }
  return passages;
}

/** How many question-answer pairs a passage gets: about one per 35 words, 2 to 8. */
export function pairsFor(words: number): number {
  return Math.max(2, Math.min(8, Math.round(words / 35)));
}

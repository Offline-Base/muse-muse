/**
 * Builds the 2026 knowledge corpus from English Wikipedia (CC BY-SA 4.0). No model calls, no keys.
 *
 *   npx tsx scripts/knowledge/build-corpus.ts [--from 2026-01-04] [--to 2026-10-28] [--articles 0]
 *
 * 1. Every daily current-events page from --from to --to becomes dated events (.data/knowledge/events.jsonl).
 * 2. With --articles N, the N articles those events link to most get "what changed since --from": the sentences the
 *    article gained after its last revision on --from, or the whole text of an article made after it
 *    (.data/knowledge/articles.jsonl).
 *
 * Raw pages are cached under .data/knowledge/raw/, so a rerun only fetches what's missing. One request at a time.
 * Pause any time with `npm run knowledge:pause` or Ctrl+C. Everything fetched is already cached, so a paused run
 * leaves the output files as they were, and the same command carries on later and rebuilds them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { currentEventsTitle, daysBetween, parseCurrentEvents, type CurrentEvent } from "@/lib/knowledge/current-events";
import { KNOWLEDGE_DIR, pauseRequested, PAUSE_FILE, stopOnInterrupt } from "@/lib/knowledge/control";
import { addedSince, articleThenAndNow, pageWikitext } from "@/lib/knowledge/wikipedia";

const OUT = KNOWLEDGE_DIR;
const RAW = path.join(OUT, "raw");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const from = arg("from", "2026-01-04");
const to = arg("to", "2026-10-28");
const articleCount = Number(arg("articles", "0"));

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 150);

async function cached<T>(file: string, load: () => Promise<T>): Promise<T> {
  const full = path.join(RAW, file);
  if (existsSync(full)) return JSON.parse(await readFile(full, "utf8")) as T;
  const value = await load();
  await writeFile(full, JSON.stringify(value));
  return value;
}

/** Articles about 2026 come first (whatever their link count), then the rest by how many events link to them. */
const ABOUT_2026 = /2026|2025–26\b/;

function articleRanking(events: CurrentEvent[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const e of events) for (const l of e.links) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].sort(
    (a, b) => Number(ABOUT_2026.test(b[0])) - Number(ABOUT_2026.test(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

async function main() {
  await mkdir(RAW, { recursive: true });
  if (existsSync(PAUSE_FILE)) {
    console.log("Paused (the PAUSE file is there). Run npm run knowledge:resume, then this command again.");
    return;
  }
  stopOnInterrupt();
  let paused = false;
  const days = daysBetween(from, to);
  const events: CurrentEvent[] = [];
  let missingDays = 0;
  for (const [i, day] of days.entries()) {
    if (pauseRequested()) {
      paused = true;
      break;
    }
    const text = await cached(`day-${day}.json`, () => pageWikitext(currentEventsTitle(day)));
    if (text === null) missingDays++;
    else events.push(...parseCurrentEvents(text, day));
    if ((i + 1) % 25 === 0) console.log(`days ${i + 1}/${days.length}, events ${events.length}`);
  }
  if (paused) return pausedNote(`days ${events.length ? "partly" : "not yet"} read`);
  await writeFile(path.join(OUT, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const ranking = articleRanking(events);
  console.log(`${events.length} events from ${days.length - missingDays} of ${days.length} days; ${ranking.length} linked articles.`);
  console.log(`Most linked: ${ranking.slice(0, 15).map(([t, n]) => `${t} (${n})`).join(", ")}`);

  let articles = 0;
  let sentences = 0;
  if (articleCount > 0) {
    const lines: string[] = [];
    for (const [i, [title, linkedFrom]] of ranking.slice(0, articleCount).entries()) {
      if (pauseRequested()) {
        paused = true;
        break;
      }
      const pair = await cached(`article-${safe(title)}.json`, () => articleThenAndNow(title, `${from}T23:59:59Z`));
      const current = pair.current?.slots?.main?.content;
      if (!current || /^#redirect/i.test(current)) continue;
      const added = addedSince(pair.old?.slots?.main?.content ?? null, current, pair.title);
      const count = added.reduce((n, g) => n + g.sentences.length, 0);
      if (!count) continue;
      articles++;
      sentences += count;
      lines.push(
        JSON.stringify({
          title: pair.title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(pair.title.replace(/ /g, "_"))}`,
          linkedFrom,
          isNew: pair.old === null,
          oldRevision: pair.old?.revid ?? null,
          currentRevision: pair.current?.revid ?? null,
          added,
        }),
      );
      if ((i + 1) % 50 === 0) console.log(`articles ${i + 1}/${articleCount}, kept ${articles}, sentences ${sentences}`);
    }
    if (paused) return pausedNote("articles partly fetched");
    await writeFile(path.join(OUT, "articles.jsonl"), lines.join("\n") + "\n");
  }

  const words = events.reduce((n, e) => n + e.text.split(/\s+/).length, 0);
  const manifest = {
    source: "English Wikipedia",
    license: "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)",
    from,
    to,
    builtAt: new Date().toISOString(),
    articlesAsked: articleCount,
    days: days.length,
    missingDays,
    events: events.length,
    eventWords: words,
    articles,
    articleSentences: sentences,
  };
  await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}

function pausedNote(where: string): void {
  console.log(`Paused (${where}). Everything fetched is cached and the output files are unchanged. Run npm run knowledge:resume, then the same command, to carry on.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Builds the training set from every cached answer, whichever run, host or writer produced it. make-dataset.ts
 * --offline only sees the passages its own flags select, and runs used many different flags, so this starts from the
 * cache instead: each answer's passage is rebuilt from the corpus, and the answer is kept only if it was written for
 * the passage's current text (its file name matches the hash). Answers for passages that changed or were filtered out
 * since, such as BLS releases with revised numbers or passages with contact details, drop out.
 *
 *   npx tsx scripts/knowledge/assemble-dataset.ts [--out train-stage1.jsonl] [--replay .data/knowledge/replay.jsonl]
 *
 * Later stages: --all-writers keeps every writer's answer to a passage (Spark Open's and Glimmer's question sets differ),
 * --exclude a.jsonl,b.jsonl drops fact examples whose question an earlier stage trained on or a probe set holds (compared
 * after normalizeAnswer, so a curly apostrophe doesn't hide a probe), and --cap-low N keeps at most N examples from each bulky government and science source, so AI, Meta and news lead.
 *
 * Adds the overviews from make-anchors.ts (dataset/anchors.jsonl) and replay answers, shuffles with a fixed seed, and
 * writes dataset/<out>, dataset/<out>-probes.jsonl and dataset/<out>-report.json.
 *
 * To keep a set on Glimmer's own lineage, --writers muse-glimmer-30b,muse-glimmer-q4 keeps only those writers' answers,
 * and --no-anchors leaves out the overviews, which Spark Open wrote. Replay answers are base Glimmer's
 * (aws/job/replay_glimmer.py) and the cutoff examples are templates, so both stay.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CurrentEvent } from "@/lib/knowledge/current-events";
import { KNOWLEDGE_SYSTEM, knowledgeExamples, type KnowledgeExample } from "@/lib/knowledge/dataset";
import { articlePassages, eventPassages, type ArticleDelta, type Passage } from "@/lib/knowledge/passages";
import { checkQa, normalizeAnswer, QA_INSTRUCTIONS, qaRequestText, type PassageQa } from "@/lib/knowledge/qa";
import { sourcePassages, type SourceRecord } from "@/lib/knowledge/sources";

const DIR = path.join(process.cwd(), ".data", "knowledge");
const QA_DIR = path.join(DIR, "qa");
const OUT = path.join(DIR, "dataset");
/** Every writer whose answers count. Spark Open (any host) first, so it wins when two wrote the same passage. */
const WRITERS = ["muse-spark-open", "muse-glimmer-30b", "muse-glimmer-q4"];
/** Sets that stay out of training (docs/KNOWLEDGE_UPDATE.md and the Oct 30 reviews). */
const NEVER = /^(gap-wikipedia-|wikisource|us-doj|s3-infini-news|s3-fine-news|s3-forecastbench|s3-openlibrary)/;
/** Bulky government and science sources, which --cap-low limits (record id prefixes, not file names). */
const LOW = /^(us-sec-8k|ec-press|us-fr|us-fr-routine|ons|us-nass|us-plaw|legifrance|eurlex|hansard-uk|egov-japan|gastat|eurostat|us-ofac|us-gao|pmc|openalex|biorxiv|medrxiv|courtlistener|pubmed|europepmc|doaj|clinicaltrials|acl|arxiv|osv|cve|github-advisor|nih|nsf|statcan|inegi|wikidata|noaa|usgs|nhc|dailymed|openfda|ietf|s3-openstates|s3-musicbrainz|s3-discogs|s3-gleif|s3-clickstream|s3-retrosheet)/;

/** The source a training example came from: the record id's prefix for collected sources, else the passage kind. */
const group = (source: string) => (source.startsWith("source:") ? source.split(":")[1] : source.split(":")[0]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** The writers --writers names, kept in WRITERS order so the first-writer rule doesn't change; all of them by default. */
function chosenWriters(): string[] {
  if (!process.argv.includes("--writers")) return WRITERS;
  const named = arg("writers")?.split(",").filter(Boolean) ?? [];
  if (!named.length || named.some((w) => !WRITERS.includes(w))) throw new Error(`--writers takes some of ${WRITERS.join(", ")}; got ${arg("writers")}.`);
  return WRITERS.filter((w) => named.includes(w));
}

/** What --exclude compares: the normalized question, or the question itself when that leaves no latin letter (a question in another script would reduce to its digits and match others). */
function questionKey(q: string): string {
  const key = normalizeAnswer(q).trim();
  return /[a-z]/.test(key) ? key : q;
}

const hash = (writer: string, p: Passage) => createHash("sha256").update(`${writer}\n${QA_INSTRUCTIONS}\n${qaRequestText(p)}`).digest("hex").slice(0, 24);

async function jsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}

/** The records whose ids are wanted, read a line at a time so the big sets don't have to fit in memory. */
async function records(file: string, wanted: Set<string>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    const id = /"id":\s*"((?:[^"\\]|\\.)*)"/.exec(line.slice(0, 600))?.[1];
    if (id === undefined || !wanted.has(JSON.parse(`"${id}"`))) continue;
    out.push(JSON.parse(line) as SourceRecord);
  }
  return out;
}

/** A fixed shuffle, so the same cache gives the same file. */
function shuffle<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function main() {
  const writersUsed = chosenWriters();
  const manifest = JSON.parse(await readFile(path.join(DIR, "manifest.json"), "utf8")) as { to: string };
  const cache = new Map<string, unknown>();
  const byPassage = new Map<string, string[]>();
  for (const f of await readdir(QA_DIR)) {
    if (!f.endsWith(".json") || f.startsWith("dry-")) continue;
    const answer = JSON.parse(await readFile(path.join(QA_DIR, f), "utf8")) as { passageId?: string; json?: unknown };
    if (!answer.passageId) continue;
    cache.set(f.slice(0, -5), answer.json);
    byPassage.set(answer.passageId, [...(byPassage.get(answer.passageId) ?? []), f.slice(0, -5)]);
  }

  const passages = new Map<string, Passage>();
  for (const p of eventPassages(await jsonl<CurrentEvent>(path.join(DIR, "events.jsonl")))) if (byPassage.has(p.id)) passages.set(p.id, p);
  for (const p of articlePassages(await jsonl<ArticleDelta>(path.join(DIR, "articles.jsonl")), manifest.to)) if (byPassage.has(p.id)) passages.set(p.id, p);
  const wanted = new Set([...byPassage.keys()].filter((id) => id.startsWith("source:")).map((id) => id.slice(7, id.lastIndexOf(":"))));
  const files = (await readdir(path.join(DIR, "sources"))).filter((f) => f.endsWith(".jsonl") && !NEVER.test(f)).sort();
  for (const f of files) {
    for (const r of await records(path.join(DIR, "sources", f), wanted)) {
      for (const p of sourcePassages(r, manifest.to)) if (byPassage.has(p.id)) passages.set(p.id, p);
    }
  }

  const results: PassageQa[] = [];
  const counts = { cachedPassages: byPassage.size, rebuilt: passages.size, kept: 0, stale: 0, otherWriters: 0, byWriter: {} as Record<string, number> };
  const allWriters = process.argv.includes("--all-writers");
  for (const p of passages.values()) {
    const writers = writersUsed.filter((w) => cache.has(hash(w, p)));
    if (!writers.length) {
      // Answered, but only by writers --writers left out: not stale, just not this set's.
      if (WRITERS.some((w) => cache.has(hash(w, p)))) counts.otherWriters++;
      else counts.stale++;
      continue;
    }
    counts.kept++;
    for (const writer of allWriters ? writers : writers.slice(0, 1)) {
      counts.byWriter[writer] = (counts.byWriter[writer] ?? 0) + 1;
      results.push(checkQa(cache.get(hash(writer, p)), p));
    }
  }
  const made = knowledgeExamples(results, passages, manifest.to);
  const probes = made.probes;
  // Questions already trained on, or held out for scoring, don't go in again.
  const seen = new Set<string>();
  for (const f of arg("exclude")?.split(",").filter(Boolean) ?? []) {
    for (const e of await jsonl<{ messages?: Array<{ content: string }>; question?: string }>(f)) {
      const q = e.question ?? e.messages?.[1]?.content;
      if (q) seen.add(questionKey(q));
    }
  }
  const isFact = (e: KnowledgeExample) => /^(source|event|article):/.test(e.source);
  let train = made.train.filter((e) => !isFact(e) || !seen.has(questionKey(e.messages[1].content)));
  const capLow = Number(arg("cap-low") ?? 0);
  if (capLow > 0) {
    const kept = new Map<string, number>();
    train = shuffle(train, 7).filter((e) => {
      if (!isFact(e) || !LOW.test(group(e.source))) return true;
      const n = (kept.get(group(e.source)) ?? 0) + 1;
      kept.set(group(e.source), n);
      return n <= capLow;
    });
  }

  const anchors = process.argv.includes("--no-anchors") ? [] : await jsonl<KnowledgeExample>(path.join(OUT, "anchors.jsonl"));
  const replayFile = arg("replay") ?? path.join(DIR, "replay.jsonl");
  const replay = (await jsonl<{ prompt: string; answer: string }>(replayFile)).map(
    (r): KnowledgeExample => ({
      messages: [
        { role: "system", content: KNOWLEDGE_SYSTEM },
        { role: "user", content: r.prompt },
        { role: "assistant", content: r.answer },
      ],
      source: "replay",
    }),
  );
  const all = shuffle([...train, ...anchors, ...replay], 20261030);
  const out = arg("out") ?? "train-stage1.jsonl";
  await writeFile(path.join(OUT, out), all.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(path.join(OUT, out.replace(/\.jsonl$/, "") + "-probes.jsonl"), probes.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const dropped: Record<string, number> = {};
  for (const r of results) for (const d of r.dropped) dropped[d] = (dropped[d] ?? 0) + 1;
  const kinds: Record<string, number> = {};
  for (const e of all) {
    kinds[group(e.source)] = (kinds[group(e.source)] ?? 0) + 1;
  }
  const report = { argv: process.argv.slice(2), ...counts, writers: writersUsed, examples: all.length, facts: train.length, anchors: anchors.length, replay: replay.length, probes: probes.length, dropped, kinds };
  await writeFile(path.join(OUT, out.replace(/\.jsonl$/, "") + "-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, kinds: undefined }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Checks the news sample files against the real passage code: each record must make exactly one passage.
 *
 *   npx tsx scripts/knowledge/s3_sample/news/check_output.ts .data/knowledge/sources/s3-ccnews.jsonl ...
 */
import { readFileSync } from "node:fs";
import { sourcePassages, type SourceRecord } from "@/lib/knowledge/sources";

const FIRST = "2026-01-04";
const LAST = "2026-10-29";
const seen = new Set<string>();
const texts = new Set<string>();

for (const file of process.argv.slice(2)) {
  const problems: Record<string, number> = {};
  const hit = (k: string) => (problems[k] = (problems[k] ?? 0) + 1);
  const months: Record<string, number> = {};
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let totalWords = 0;
  for (const line of lines) {
    const r = JSON.parse(line) as SourceRecord;
    for (const k of ["id", "source", "title", "url", "date", "license", "visibility", "text"] as const) if (!r[k]) hit(`missing_${k}`);
    if (seen.has(r.id)) hit("duplicate_id");
    seen.add(r.id);
    if (texts.has(r.text)) hit("duplicate_text");
    texts.add(r.text);
    if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date < FIRST || r.date > LAST) hit("bad_date");
    if (r.visibility !== "private") hit("not_private");
    const n = r.text.split(/\s+/).filter(Boolean).length;
    totalWords += n;
    if (n < 40) hit("under_40_words");
    if (n > 210) hit("over_210_words");
    if (!/[.!?…।؟。]["'”’»)\]]*$/.test(r.text.trim())) hit("no_sentence_end");
    if (r.text.includes("—") || r.title.includes("—")) hit("has_em_dash");
    const passages = sourcePassages(r, "2026-10-29");
    if (passages.length !== 1) hit(`passages_${passages.length}`);
    months[r.date?.slice(0, 7) ?? "none"] = (months[r.date?.slice(0, 7) ?? "none"] ?? 0) + 1;
  }
  console.log(file.split("/").pop(), "records", lines.length, "avg words", Math.round(totalWords / (lines.length || 1)), "problems", JSON.stringify(problems), JSON.stringify(Object.fromEntries(Object.entries(months).sort())));
}

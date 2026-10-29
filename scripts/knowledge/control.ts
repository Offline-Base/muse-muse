/**
 * Pause, resume and status for the 2026 knowledge work (docs/KNOWLEDGE_UPDATE.md).
 *
 *   npm run knowledge:status
 *   npm run knowledge:pause     running stages finish what's in flight, save and stop; new runs won't start
 *   npm run knowledge:resume    then rerun the stage's command; it carries on from its cache
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { clearPause, KNOWLEDGE_DIR, PAUSE_FILE, requestPause } from "@/lib/knowledge/control";

async function json<T>(file: string): Promise<T | null> {
  return existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as T) : null;
}

async function files(dir: string, prefix: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith(".json")) : [];
}

async function status() {
  const manifest = await json<{ from: string; to: string; days: number; articlesAsked?: number; events: number; articles: number; articleSentences: number; builtAt: string }>(
    path.join(KNOWLEDGE_DIR, "manifest.json"),
  );
  const raw = path.join(KNOWLEDGE_DIR, "raw");
  const days = (await files(raw, "day-")).length;
  const articles = (await files(raw, "article-")).length;
  const qaDir = path.join(KNOWLEDGE_DIR, "qa");
  const answers = (await files(qaDir, "")).filter((f) => !f.startsWith("dry-"));
  let spent = 0;
  for (const f of answers) spent += Number(JSON.parse(await readFile(path.join(qaDir, f), "utf8")).cost ?? 0);
  const report = await json<{ dryRun: boolean; complete: boolean; passages: number; answered: number; trainExamples: number; probes: number }>(
    path.join(KNOWLEDGE_DIR, "dataset", "report.json"),
  );

  console.log(existsSync(PAUSE_FILE) ? "PAUSED. Run npm run knowledge:resume to allow runs again." : "Not paused.");
  console.log("\n1. Corpus (Wikipedia, free)");
  console.log(`   Days fetched: ${days}${manifest ? ` of ${manifest.days} (${manifest.from} to ${manifest.to})` : ""}`);
  console.log(`   Articles fetched: ${articles}${manifest?.articlesAsked ? ` of ${manifest.articlesAsked} asked for` : ""}`);
  if (manifest) console.log(`   Last full build ${manifest.builtAt}: ${manifest.events} events, ${manifest.articles} articles, ${manifest.articleSentences} article sentences`);
  console.log("\n2. Training data (Muse Spark Open writes question-answer pairs)");
  console.log(`   Answers cached: ${answers.length}, spent so far: $${spent.toFixed(3)}`);
  if (report) {
    console.log(
      `   Last dataset${report.dryRun ? " (dry run)" : ""}: ${report.answered} of ${report.passages} passages, ${report.trainExamples} examples, ${report.probes} probes, ${report.complete ? "complete" : "not complete"}`,
    );
  }
  console.log("\n3. Fine-tuning: not started (waits for the owner's go-ahead).");
}

const command = process.argv[2] ?? "status";
const run = { status, pause: async () => (await requestPause(), console.log("Paused. Running stages stop after what's in flight.")), resume: async () => (await clearPause(), console.log("Resumed. Rerun the stage's command to carry on.")) }[command];
if (!run) {
  console.error("Use: status, pause or resume.");
  process.exit(2);
}
run().catch((err) => {
  console.error(err);
  process.exit(1);
});

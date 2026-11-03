/**
 * The self-hosted Muse Spark Open take: Spark Open on a GPU we started writes training rows from invented passages, on
 * screen, with the knowledge run's own instructions and checks (lib/knowledge/take.ts). It never starts or stops a GPU.
 *
 * Rehearse with no server and no spend (rows say "Fake writer"):
 *   npx tsx scripts/knowledge/spark-take.ts --dry-run
 *
 * Real take, after scripts/knowledge/aws/spark_endpoint.py deploy says InService and relay.py is running:
 *   npx tsx scripts/knowledge/spark-take.ts --host sagemaker-own --yes
 *
 * Any other Chat Completions server (vLLM or SGLang on a rented node, through an SSH tunnel):
 *   npx tsx scripts/knowledge/spark-take.ts --base-url http://127.0.0.1:8000/v1 --model muse-spark-open --host lambda-own --yes
 *
 * --passages N (1 to 6, default 4). SPARK_TAKE_KEY is sent as a bearer token if set; the relay needs none. Rows go to
 * .data/spark-take/<time>.jsonl (gitignored). The GPU bills by the hour whatever this does: tear it down after.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkQa } from "@/lib/knowledge/qa";
import { fakeReply, hostLabel, INVENTED_PASSAGES, TAKE_MAX_PASSAGES, takeRows, writePassage, type TakeRow } from "@/lib/knowledge/take";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const dryRun = process.argv.includes("--dry-run");
const count = Number(arg("passages") ?? 4);
const baseUrl = arg("base-url") ?? "http://127.0.0.1:18787/v1";
const model = arg("model") ?? "muse-spark-open";
const host = dryRun ? "dry-run" : hostLabel(arg("host"));

async function main() {
  if (!Number.isInteger(count) || count < 1 || count > TAKE_MAX_PASSAGES) {
    console.error(`--passages must be 1 to ${TAKE_MAX_PASSAGES}.`);
    process.exitCode = 1;
    return;
  }
  if (!host) {
    console.error("Say where Spark Open runs with --host, such as sagemaker-own or lambda-own (lowercase, digits, dashes).");
    process.exitCode = 1;
    return;
  }
  if (!dryRun && !process.argv.includes("--yes")) {
    console.log(`This sends ${count} invented passages to ${new URL(baseUrl).host}. Run it again with --yes, or --dry-run to rehearse.`);
    return;
  }
  const writer = dryRun ? "fake-writer (dry run, not a model)" : `muse-spark-open@${host}`;
  console.log(`Writer: ${writer}`);
  console.log(`Passages: ${count} invented, made up for this demo\n`);

  const rows: TakeRow[] = [];
  let dropped = 0;
  for (const [i, p] of INVENTED_PASSAGES.slice(0, count).entries()) {
    const at = new Date().toISOString();
    const reply = dryRun
      ? { qa: checkQa(fakeReply(p), p), ms: 0, outputTokens: null }
      : await writePassage({ baseUrl, model, key: process.env.SPARK_TAKE_KEY?.trim() || undefined }, p);
    const made = takeRows(reply.qa, writer, reply.ms, at);
    rows.push(...made);
    dropped += reply.qa.dropped.length;
    const secs = (reply.ms / 1000).toFixed(1);
    const tokens = reply.outputTokens === null ? "" : `, ${reply.outputTokens} tokens out`;
    console.log(`[${at.slice(11, 19)} UTC] ${i + 1}/${count} ${p.header.split("| ")[1]}: ${made.length} ${made.length === 1 ? "row" : "rows"} in ${secs} s${tokens}`);
    for (const row of made) {
      console.log(`  Q: ${row.messages[1].content}`);
      console.log(`  A: ${row.messages[2].content}`);
    }
    if (reply.qa.dropped.length) console.log(`  dropped by the checks: ${reply.qa.dropped.join(", ")}`);
    console.log("");
  }

  const dir = path.join(".data", "spark-take");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}${dryRun ? "-dry" : ""}.jsonl`);
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  console.log(`Wrote ${rows.length} training rows to ${file} (${dropped} dropped by the checks).`);
  console.log(dryRun ? "Dry run: a fake writer, no model. Don't film this as real." : "Built with Muse Spark Open. Rows are model-written, from invented passages.");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});

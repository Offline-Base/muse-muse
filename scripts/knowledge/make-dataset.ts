/**
 * Turns the knowledge corpus (scripts/knowledge/build-corpus.ts) into a training set: Muse Spark Open writes
 * question-answer pairs and one held-out probe per passage. Spark Open runs on a host's OpenAI-compatible API, not
 * Meta's Model API, and only sees the text of Wikipedia and the collected sources.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/knowledge/make-dataset.ts --dry-run [--limit 40]
 *   npx tsx --env-file-if-exists=.env.local scripts/knowledge/make-dataset.ts --limit 300 --max-usd 3
 *
 * Env (real runs only): SPARK_OPEN_BASE_URL (e.g. https://api.fireworks.ai/inference/v1), SPARK_OPEN_API_KEY,
 * SPARK_OPEN_MODEL (e.g. accounts/fireworks/models/muse-spark-open), and optionally SPARK_OPEN_PRICE_IN and
 * SPARK_OPEN_PRICE_OUT in dollars per million tokens (default 1.25 and 4.25) and SPARK_OPEN_REASONING (low, medium,
 * high or xhigh; default low).
 *
 * Several hosts at once: --host fireworks|baseten|modal --shard 0/3 takes that host's address and key (FIREWORKS_API_KEY,
 * BASETEN_API_KEY, or MODAL_API_TOKEN and MODAL_BASE_URL) and every third passage. --max-usd then counts that host's
 * answers only, and all hosts share the cache, so run one last time with --offline to write the dataset from it.
 *
 * Self-hosted on a Vertex AI endpoint: set SPARK_OPEN_AUTH=gcloud instead of a key, and the base URL to the
 * endpoint's Chat Completions root (https://<dedicated DNS>/v1/projects/<project>/locations/<region>/endpoints/<id>).
 * A fresh `gcloud auth print-access-token` is used every 45 minutes. Set both prices to 0, since the endpoint bills
 * by the hour while deployed, and raise --concurrency (up to 64) to keep its GPUs busy.
 *
 * --limit N takes an even spread of N passages (by kind and month) for a pilot. Answers are cached under
 * .data/knowledge/qa/, so a rerun only asks for what's missing. --max-usd stops new requests once total spend, this
 * run plus every cached answer before it, reaches it. Pause any time with `npm run knowledge:pause` or Ctrl+C: the
 * requests in flight finish and are cached, the output files are left as they were, and the same command carries on
 * later.
 * Output: .data/knowledge/dataset/{train.jsonl, probes.jsonl, report.json}.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { CurrentEvent } from "@/lib/knowledge/current-events";
import { articlePassages, eventPassages, type ArticleDelta, type Passage } from "@/lib/knowledge/passages";
import { checkQa, QA_INSTRUCTIONS, qaRequestText, type PassageQa } from "@/lib/knowledge/qa";
import { KNOWLEDGE_DIR, pauseRequested, PAUSE_FILE, stopOnInterrupt } from "@/lib/knowledge/control";
import { knowledgeExamples } from "@/lib/knowledge/dataset";
import { sourcePassages, type SourceRecord } from "@/lib/knowledge/sources";

const DIR = KNOWLEDGE_DIR;
const QA_DIR = path.join(DIR, "qa");
// A dry run has its own folder, so its fake answers never replace the real training set.
const OUT = path.join(DIR, process.argv.includes("--dry-run") ? "dataset-dry" : "dataset");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const dryRun = process.argv.includes("--dry-run");
const limit = Number(arg("limit") ?? 0);
const maxUsd = Number(arg("max-usd") ?? 3);
const concurrency = Math.max(1, Math.min(64, Number(arg("concurrency") ?? 4)));
const offline = process.argv.includes("--offline");
const perSource = Number(arg("per-source") ?? 0);
const onlySources = process.argv.includes("--only-sources");
const host = arg("host");
const shard = arg("shard")?.split("/").map(Number) ?? null;
const HOSTS: Record<string, { url?: string; model: string; key?: string }> = {
  fireworks: { url: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/muse-spark-open", key: process.env.FIREWORKS_API_KEY },
  baseten: { url: "https://inference.baseten.co/v1", model: "meta-models/muse-spark-open", key: process.env.BASETEN_API_KEY },
  modal: { url: process.env.MODAL_BASE_URL, model: "meta-models/Muse-Spark-Open-816B-A42B", key: process.env.MODAL_API_TOKEN },
};
if (host) {
  const h = HOSTS[host];
  if (!h) throw new Error(`Unknown host ${host}.`);
  process.env.SPARK_OPEN_BASE_URL = h.url;
  process.env.SPARK_OPEN_MODEL = h.model;
  process.env.SPARK_OPEN_API_KEY = h.key;
}
/** Who wrote the answers, whichever host served them: the same weights share one cache. */
const WRITER_ID = host || offline ? "muse-spark-open" : process.env.SPARK_OPEN_MODEL;

async function jsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
}

/** An even spread: round-robin over (kind, month) buckets, in a fixed order. */
function spread(passages: Passage[], n: number): Passage[] {
  const buckets = new Map<string, Passage[]>();
  for (const p of passages) {
    const key = `${p.kind}:${p.date?.slice(0, 7) ?? "article"}`;
    buckets.set(key, [...(buckets.get(key) ?? []), p]);
  }
  const lists = [...buckets.values()].map((list) => list.filter((_, i) => i % 7 === 3).concat(list.filter((_, i) => i % 7 !== 3)));
  const out: Passage[] = [];
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]);
  return out;
}

// The writer is part of the key, so answers from one model are never reused as another's.
const hash = (p: Passage) => createHash("sha256").update(`${dryRun ? "" : WRITER_ID}\n${QA_INSTRUCTIONS}\n${qaRequestText(p)}`).digest("hex").slice(0, 24);

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** A stand-in writer for --dry-run: one pair per sentence and a probe from the first one. No network. */
function fakeAnswer(p: Passage): unknown {
  const sentences = p.text.split(/(?<=[.!?])\s+/).slice(0, 4);
  const lead = p.date ? `On ${p.header.split(" | ")[0]}, ` : "";
  return {
    pairs: sentences.map((s, i) => ({ question: `What was reported in ${p.header.split(" | ").slice(-1)[0]} (item ${i + 1})?`, answer: `${lead}${s}` })),
    probe: { question: `Which story is this from: ${p.header.split(" | ").slice(-1)[0]}?`, answer: p.header.split(" | ").slice(-1)[0].split(" ").slice(0, 6).join(" "), aliases: [] },
  };
}

let gcloudToken: { value: string; at: number } | null = null;

/** The bearer credential: the host's API key, or a gcloud access token (they last an hour) for Vertex AI. */
async function credential(): Promise<string | undefined> {
  if (process.env.SPARK_OPEN_AUTH !== "gcloud") return process.env.SPARK_OPEN_API_KEY;
  if (!gcloudToken || Date.now() - gcloudToken.at > 45 * 60_000) {
    const { stdout } = await promisify(execFile)("gcloud", ["auth", "print-access-token"]);
    gcloudToken = { value: stdout.trim(), at: Date.now() };
  }
  return gcloudToken.value;
}

async function askSparkOpen(p: Passage): Promise<{ json: unknown; usage: Usage }> {
  const base = process.env.SPARK_OPEN_BASE_URL;
  const model = process.env.SPARK_OPEN_MODEL;
  const key = await credential();
  if (!base || !key || !model) {
    throw new Error("Set SPARK_OPEN_BASE_URL, SPARK_OPEN_MODEL and SPARK_OPEN_API_KEY (or SPARK_OPEN_AUTH=gcloud) in .env.local, or use --dry-run.");
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify({
        model,
        temperature: 0.4,
        // Spark Open's reasoning counts toward max_tokens, so leave room for it before the JSON answer.
        max_tokens: 6000,
        // Spark Open takes reasoning_effort; Glimmer's template takes reasoning_strength.
        reasoning_effort: process.env.SPARK_OPEN_REASONING ?? "low",
        ...(host ? {} : { chat_template_kwargs: { reasoning_strength: process.env.SPARK_OPEN_REASONING ?? "low" } }),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: QA_INSTRUCTIONS },
          { role: "user", content: qaRequestText(p) },
        ],
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: Usage };
      const text = body.choices?.[0]?.message?.content ?? "";
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) || "{}");
      return { json, usage: body.usage ?? {} };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 2 ** (attempt + 1)) * 1000));
      continue;
    }
    // The body can echo the request, never the key, but keep it short anyway.
    throw new Error(`Spark Open host: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/** What every cached real answer cost, so --max-usd counts across runs. */
async function spentBefore(): Promise<number> {
  let total = 0;
  for (const f of await readdir(QA_DIR)) {
    if (f.startsWith("dry-") || !f.endsWith(".json")) continue;
    const answer = JSON.parse(await readFile(path.join(QA_DIR, f), "utf8"));
    if (!host || answer.host === host) total += Number(answer.cost ?? 0);
  }
  return total;
}

async function main() {
  await mkdir(QA_DIR, { recursive: true });
  await mkdir(OUT, { recursive: true });
  if (existsSync(PAUSE_FILE)) {
    console.log("Paused (the PAUSE file is there). Run npm run knowledge:resume, then this command again.");
    return;
  }
  stopOnInterrupt();
  const manifest = JSON.parse(await readFile(path.join(DIR, "manifest.json"), "utf8")) as { to: string; from: string };
  const events = await jsonl<CurrentEvent>(path.join(DIR, "events.jsonl"));
  const articles = await jsonl<ArticleDelta>(path.join(DIR, "articles.jsonl"));
  const sourcesDir = path.join(DIR, "sources");
  // --sources meta-,us- takes only files whose names start with one of these; none takes them all.
  const wanted = arg("sources")?.split(",") ?? null;
  const sourceFiles = existsSync(sourcesDir)
    ? (await readdir(sourcesDir)).filter((f) => f.endsWith(".jsonl") && (!wanted || wanted.some((w) => f.startsWith(w)))).sort()
    : [];
  const recordSets = await Promise.all(sourceFiles.map((f) => jsonl<SourceRecord>(path.join(sourcesDir, f))));
  const records = recordSets.flat();
  // --per-source N takes an even spread of at most N passages from each file, so big sets don't crowd out small ones.
  const sourced = recordSets.flatMap((set) => {
    const list = set.flatMap((r) => sourcePassages(r, manifest.to));
    return perSource > 0 ? spread(list, perSource) : list;
  });
  // --only-sources leaves out the Wikipedia events and articles.
  const all = [...(onlySources ? [] : [...eventPassages(events), ...articlePassages(articles, manifest.to)]), ...sourced];
  const picked = limit > 0 ? spread(all, limit) : all;
  const passages = shard ? picked.filter((_, i) => i % shard[1] === shard[0]) : picked;
  console.log(`${all.length} passages (${all.filter((p) => p.kind === "event").length} event, ${all.filter((p) => p.kind === "article").length} article, ${all.filter((p) => p.kind === "source").length} from ${records.length} source documents); using ${passages.length}${dryRun ? ", dry run" : ""}.`);

  const priceIn = Number(process.env.SPARK_OPEN_PRICE_IN ?? 1.25);
  const priceOut = Number(process.env.SPARK_OPEN_PRICE_OUT ?? 4.25);
  const before = dryRun ? 0 : await spentBefore();
  let spent = before;
  let asked = 0;
  let paused = false;
  let failed = 0;
  let stopped = false;
  const results: PassageQa[] = [];
  const queue = [...passages];

  async function worker() {
    for (let p = queue.shift(); p; p = queue.shift()) {
      if (pauseRequested()) {
        paused = true;
        break;
      }
      const file = path.join(QA_DIR, `${dryRun ? "dry-" : ""}${hash(p)}.json`);
      let raw: unknown;
      if (existsSync(file)) raw = JSON.parse(await readFile(file, "utf8")).json;
      else if (dryRun) raw = fakeAnswer(p);
      else if (offline) continue;
      else {
        if (spent >= maxUsd) {
          stopped = true;
          continue;
        }
        try {
          const { json, usage } = await askSparkOpen(p);
          const cost = ((usage.prompt_tokens ?? 0) * priceIn + (usage.completion_tokens ?? 0) * priceOut) / 1e6;
          spent += cost;
          asked++;
          raw = json;
          await writeFile(file, JSON.stringify({ passageId: p.id, host, json, usage, cost }));
          if (asked % 25 === 0) console.log(`asked ${asked}, spent $${spent.toFixed(3)}`);
        } catch (err) {
          failed++;
          console.warn(`${p.id}: ${(err as Error).message}`);
          continue;
        }
      }
      results.push(checkQa(raw, p));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (paused) {
    console.log(
      `Paused: ${results.length} of ${passages.length} passages answered, $${spent.toFixed(3)} spent in all. Answers are cached and the output files are unchanged. Run npm run knowledge:resume, then the same command, to carry on.`,
    );
    return;
  }

  if (shard) {
    console.log(`${host} shard ${shard.join("/")}: ${results.length} of ${passages.length} answered, ${failed} failed, ${asked} new, $${spent.toFixed(3)} spent on this host. Run --offline to write the dataset.`);
    return;
  }
  const byId = new Map(passages.map((p) => [p.id, p]));
  const { train, probes } = knowledgeExamples(results, byId, manifest.to);
  await writeFile(path.join(OUT, "train.jsonl"), train.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(path.join(OUT, "probes.jsonl"), probes.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const dropped: Record<string, number> = {};
  for (const r of results) for (const d of r.dropped) dropped[d] = (dropped[d] ?? 0) + 1;
  const report = {
    dryRun,
    writer: dryRun ? "fake" : process.env.SPARK_OPEN_MODEL,
    corpus: { from: manifest.from, to: manifest.to },
    passages: passages.length,
    answered: results.length,
    failed,
    complete: !stopped && failed === 0 && results.length === passages.length,
    stoppedAtSpendCap: stopped,
    newRequests: asked,
    spentThisRunUsd: Math.round((spent - before) * 1e4) / 1e4,
    spentTotalUsd: Math.round(spent * 1e4) / 1e4,
    trainExamples: train.length,
    probes: probes.length,
    dropped,
    license: `Built from English Wikipedia text, CC BY-SA 4.0${sourceFiles.length ? `, and ${sourceFiles.length} collected sources, each under its own license` : ""}. Question-answer pairs written by ${dryRun ? "a fake writer" : process.env.SPARK_OPEN_WRITER_NAME ?? "Muse Spark Open"}.`,
  };
  await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (stopped) console.log(`Stopped at the $${maxUsd} cap. Raise --max-usd to carry on.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

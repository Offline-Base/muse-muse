/**
 * Test harness for docs/TRAINING.md's GPU flow on a site with no public address, where POST /api/train/jobs answers
 * platform_not_public. It runs the real RUNNER_PY and GLIMMER_PY on a rented GPU against a small stand-in for the callback
 * routes that lives on the GPU itself, then replays what the GPU reported through the real store and the real judge, in a
 * COPY of the site's PGlite folder. It proves training, cost and scores. It doesn't prove launch, callbacks over https,
 * the workflow, the sweep or the Hub steps.
 *
 *   DATABASE_URL=pglite:<copy> npx tsx scripts/dev/tune-harness.ts bundle <datasetId> <outDir> <paramsJson> <maxMinutes>
 *   DATABASE_URL=pglite:<copy> npx tsx scripts/dev/tune-harness.ts ingest <bundleDir> <meta.json>
 *
 * A run that reported "failed", or stopped with no "done", is recorded as failed and isn't judged; ingest then exits 1.
 *
 * Never point it at the site's own folder: two PGlites on one folder corrupt it. Made-up data only.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (!process.env.DATABASE_URL?.startsWith("pglite:") || process.env.DATABASE_URL.includes(".data/prove")) {
  throw new Error("DATABASE_URL must be pglite: on a copy of the site's folder");
}
process.loadEnvFile?.(".env.local");

const STUB_PY = String.raw`import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
HERE = os.path.dirname(os.path.abspath(__file__))
data = {p: json.load(open(os.path.join(HERE, p + ".json"))) for p in ("train", "eval")}
meta = json.load(open(os.path.join(HERE, "dataset.json")))
PAGE = 100
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def reply(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path.endswith("/dataset"):
            part, page = q["part"][0], int(q["page"][0])
            items = data[part][page * PAGE:(page + 1) * PAGE]
            more = (page + 1) * PAGE < len(data[part])
            return self.reply(200, {"title": meta["title"], "items": items, "nextPage": page + 1 if more else None})
        self.reply(404, {"error": "not_found"})
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length") or 0))
        if self.path.endswith("/events"):
            with open(os.path.join(HERE, "events.jsonl"), "ab") as f:
                f.write(raw.replace(b"\n", b" ") + b"\n")
            return self.reply(200, {"ok": True})
        if self.path.endswith("/upload"):
            return self.reply(503, {"error": "no_storage"})
        self.reply(404, {"error": "not_found"})
ThreadingHTTPServer(("127.0.0.1", 8099), H).serve_forever()
`;

async function bundle(datasetId: string, out: string, paramsJson: string, maxMinutes: number) {
  const { getDataset, datasetPage } = await import("@/lib/train/store");
  const { RUNNER_PY } = await import("@/lib/train/recipes/runner");
  const { GLIMMER_PY } = await import("@/lib/train/recipes/glimmer");
  const dataset = await getDataset(datasetId);
  if (!dataset || dataset.status !== "ready") throw new Error("That dataset isn't ready in this copy");
  const train = (await datasetPage(datasetId, "train", 0, 2000))!.items;
  const held = (await datasetPage(datasetId, "eval", 0, 2000))!.items;
  mkdirSync(out, { recursive: true });
  const jobId = randomUUID();
  const job = {
    jobId,
    callbackBase: `http://127.0.0.1:8099/api/train/jobs/${jobId}`,
    token: randomBytes(32).toString("base64url"),
    params: { datasetId, publish: 0, ...JSON.parse(paramsJson) },
    maxMinutes,
    recipe: "glimmer-lora",
    deadlineEpoch: Math.floor(Date.now() / 1000) + maxMinutes * 60,
  };
  writeFileSync(join(out, "job.json"), JSON.stringify(job));
  writeFileSync(join(out, "runner.py"), RUNNER_PY);
  writeFileSync(join(out, "recipe.py"), GLIMMER_PY);
  writeFileSync(join(out, "stub.py"), STUB_PY);
  writeFileSync(join(out, "train.json"), JSON.stringify(train));
  writeFileSync(join(out, "eval.json"), JSON.stringify(held));
  writeFileSync(join(out, "dataset.json"), JSON.stringify({ title: dataset.title }));
  console.log(JSON.stringify({ jobId, train: train.length, eval: held.length, title: dataset.title, writer: dataset.writerModel, costUsd: dataset.costUsd }));
}

async function ingest(dir: string, metaPath: string) {
  const store = await import("@/lib/train/store");
  const { judgePlanStep, judgeStep, saveEvalSummaryStep } = await import("@/lib/train/judge");
  const { evalVerdict } = await import("@/lib/train/tune/verdict");
  const { harnessOutcome } = await import("@/lib/train/harness-outcome");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
    instanceId: string;
    instanceType: string;
    region: string;
    priceCentsPerHour: number;
    launchedAt: string;
    finishedAt: string;
    title: string;
    version?: number;
  };
  const planned = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as { params: Record<string, string | number>; maxMinutes: number };
  const job = await store.createJob({
    recipe: "glimmer-lora",
    title: meta.title,
    params: planned.params,
    instanceType: meta.instanceType,
    region: meta.region,
    priceCentsPerHour: meta.priceCentsPerHour,
    maxMinutes: planned.maxMinutes,
    maxUsd: 50,
    createdBy: null,
  });
  await store.markLaunched(job.id, { instanceId: meta.instanceId, launchedAt: new Date(meta.launchedAt) });
  const lines = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  const when = new Date(meta.finishedAt);
  let evals = 0;
  for (const line of lines) {
    const body = JSON.parse(line);
    if (body.type === "eval") {
      const { type, index, prompt, reference, base, tuned } = body;
      if ((await store.recordEvalEvent(job.id, { type, index, prompt, reference, base, tuned })) === "recorded") evals++;
    } else if (body.type !== "artifact") {
      await store.applyCallback(job.id, body, when);
    }
  }
  const outcome = harnessOutcome(lines);
  await store.finishJob(job.id, { status: outcome.status, reason: outcome.reason, terminatedAt: when });
  if (outcome.status === "failed") {
    console.log(JSON.stringify({ jobId: job.id, status: "failed", evals, reason: outcome.reason }, null, 1));
    throw new Error(`The harness run failed: ${outcome.reason}`);
  }
  const { indexes, task } = await judgePlanStep(job.id);
  const judged: Awaited<ReturnType<typeof judgeStep>>[] = [];
  for (let i = 0; i < indexes.length; i += 4) {
    judged.push(...(await Promise.all(indexes.slice(i, i + 4).map((n) => judgeStep(job.id, n, task)))));
    process.stderr.write(`judged ${judged.length}/${indexes.length}\n`);
  }
  const items = judged.filter((x): x is NonNullable<typeof x> => Boolean(x));
  const summary = await saveEvalSummaryStep(job.id, items, indexes.length);
  const cost = items.reduce((s, x) => s + x.costUsd, 0);
  console.log(JSON.stringify({ jobId: job.id, evals, judged: items.length, judgeCostUsd: cost, summary, verdict: summary ? evalVerdict(summary, false) : null }, null, 1));
}

const [, , cmd, ...args] = process.argv;
const run = cmd === "bundle" ? bundle(args[0], args[1], args[2], Number(args[3])) : cmd === "ingest" ? ingest(args[0], args[1]) : Promise.reject(new Error("bundle or ingest"));
run.then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

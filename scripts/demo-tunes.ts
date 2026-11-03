/**
 * Starts the model side of the demos on the live site through the same admin automation key as demo-batch: a dataset
 * that writes its examples and stops, and a full tune of Muse Glimmer on a rented GPU. Plans go through
 * POST /api/train/plan, starts through POST /api/train/runs, as the Make chat does. Made-up data only.
 *   npm run demo-tunes                       both
 *   npm run demo-tunes -- dataset            only the named ones (dataset, tune)
 *   npm run demo-tunes -- --dry              print the notes, call nothing
 *   npm run demo-tunes -- --plan             draft the plans (a cent or two each) and print their cost, start nothing
 *   npm run demo-tunes -- --max-gpu-usd=20   refuse a tune whose GPU ceiling is over this (default 20, the owner's cap)
 *   npm run demo-tunes -- --url=<origin>     another deployment (default https://www.musemuse.dev)
 * Checks before any run starts:
 *   - the examples writer the site will use is Contributor (repo rule: test data uses TEST_MODEL). --allow-writer=<id>
 *     accepts another one on purpose;
 *   - the tune's GPU ceiling fits --max-gpu-usd.
 * The tune never uploads to Hugging Face by itself (autoPublish false); publishing stays a person's choice in the room.
 * Every run's plan cost, writer and result (or the server's refusal) goes to .data/demo-tunes-<time>.json, saved after
 * each step, so a failure partway keeps what already started.
 */
import { env } from "@/lib/env";
import { SPARK_STANDIN } from "@/lib/meta/spark";
import { runHref } from "@/lib/train/writer";
import { arg, pickIds, postJson, refusalOf, resultsFile, siteArg, words } from "./automation";

const RUNS: ReadonlyArray<{ id: string; note: string; datasetOnly: boolean }> = [
  {
    id: "dataset",
    datasetOnly: true,
    note: "Write a dataset of made-up documents with hard cases for redaction, such as names that are also common words, addresses inside sentences, and IDs that look like dates.",
  },
  {
    id: "tune",
    datasetOnly: false,
    note: "Tune a model that turns messy made-up shift handoff notes from a restaurant's walk-in cold room into a short checklist: readings out of range, the door left open, what to do next, and who to tell.",
  },
];

type PlanCost = { metaLowUsd?: number; metaHighUsd?: number; gpuMaxUsd?: number; scoreLowUsd?: number; scoreHighUsd?: number; minutes?: number };
type Outcome = Record<string, unknown> & { id: string; error?: unknown };

const usd = (n: unknown) => (typeof n === "number" ? `$${n.toFixed(2)}` : "?");
const costLine = (c: PlanCost) => `examples ${usd(c.metaLowUsd)} to ${usd(c.metaHighUsd)}, GPU up to ${usd(c.gpuMaxUsd)}, scoring ${usd(c.scoreLowUsd)} to ${usd(c.scoreHighUsd)}, about ${c.minutes ?? "?"} min`;

async function runOne(
  r: (typeof RUNS)[number],
  o: { site: string; secret: string; planOnly: boolean; maxGpuUsd: number; allowWriter: string | undefined; record: (x: Outcome) => void },
): Promise<Outcome> {
  const out: Outcome = { id: r.id, datasetOnly: r.datasetOnly };
  const fail = (step: string, error: unknown): Outcome => {
    Object.assign(out, { failedAt: step, error });
    o.record(out);
    console.log(`FAILED   ${r.id.padEnd(8)} ${step} ${JSON.stringify(error).slice(0, 300)}`);
    return out;
  };
  // Saying datasetOnly here makes a site without MAKE_CHAT_ALL refuse before the plan's model call is paid for.
  const planned = await postJson(o.site, "/api/train/plan", { note: r.note, settings: { examples: 200, ...(r.datasetOnly ? { datasetOnly: true } : {}) } }, o.secret);
  const plan = planned.json.plan as { cost?: PlanCost } | undefined;
  if (planned.status >= 300 || !plan) return fail("plan", refusalOf(planned));
  const cost = plan.cost ?? {};
  const writer = typeof planned.json.writerModel === "string" ? planned.json.writerModel : null;
  Object.assign(out, { cost, writerModel: writer });
  o.record(out);
  console.log(`planned  ${r.id.padEnd(8)} ${costLine(cost)}; examples written by ${writer ?? "unknown"}`);

  const wanted = o.allowWriter ?? SPARK_STANDIN;
  if (writer !== wanted) {
    return fail("writer", {
      message: writer
        ? `The site would write the examples with ${writer}, not ${wanted}. Turn BUILDS_ON_CONTRIBUTOR on, or pass --allow-writer=${writer} on purpose.`
        : "The site didn't say which model writes the examples (it predates this check). Deploy main first, or pass --allow-writer=<id> on purpose.",
    });
  }
  if (!r.datasetOnly && typeof cost.gpuMaxUsd === "number" && cost.gpuMaxUsd > o.maxGpuUsd) {
    return fail("cost", { message: `The tune's GPU ceiling is ${usd(cost.gpuMaxUsd)}, over --max-gpu-usd=${o.maxGpuUsd}.` });
  }
  if (o.planOnly) {
    Object.assign(out, { started: false });
    o.record(out);
    return out;
  }

  const settings = r.datasetOnly ? { datasetOnly: true } : { autoPublish: false };
  const started = await postJson(o.site, "/api/train/runs", { plan, settings }, o.secret);
  const runId = started.json.runId;
  if (started.status >= 300 || typeof runId !== "string") return fail("start", refusalOf(started));
  const link = `${o.site}${typeof started.json.href === "string" ? started.json.href : runHref(runId)}`;
  Object.assign(out, { runId, link, autoPublish: r.datasetOnly ? undefined : false });
  o.record(out);
  console.log(`started  ${r.id.padEnd(8)} ${link}`);
  return out;
}

async function main(): Promise<void> {
  const runs = pickIds(RUNS, words());
  if (process.argv.includes("--dry")) {
    for (const r of runs) console.log(`${r.id}${r.datasetOnly ? " (dataset only)" : ""}\n  ${r.note}\n`);
    return;
  }
  const site = siteArg();
  const maxGpuUsd = Number(arg("max-gpu-usd") ?? 20);
  if (!Number.isFinite(maxGpuUsd) || maxGpuUsd <= 0) throw new Error("--max-gpu-usd must be a positive number of dollars.");
  if (!env.automationSecret) throw new Error("AUTOMATION_SECRET isn't in .env.local. It must match the one on Vercel Production.");

  const file = resultsFile("demo-tunes");
  const outcomes = new Map<string, Outcome>();
  const record = (x: Outcome) => {
    outcomes.set(x.id, x);
    file.save({ site, maxGpuUsd, runs: [...outcomes.values()] });
  };
  const opts = { site, secret: env.automationSecret, planOnly: process.argv.includes("--plan"), maxGpuUsd, allowWriter: arg("allow-writer"), record };
  // Independent runs, side by side: one failing (a network drop, a slow plan call) never loses the other's run id.
  const settled = await Promise.allSettled(runs.map((r) => runOne(r, opts)));
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      const id = runs[i]!.id;
      record({ ...(outcomes.get(id) ?? { id }), id, error: { message: s.reason instanceof Error ? s.reason.message : String(s.reason) } });
      console.log(`FAILED   ${id.padEnd(8)} ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
    }
  });
  if (!outcomes.size) file.save({ site, maxGpuUsd, runs: [] });
  console.log(`\nSaved ${file.path}.`);
  if ([...outcomes.values()].some((o) => o.error !== undefined)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

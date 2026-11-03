/**
 * Starts the model side of the demos on the live site through the same admin automation key as demo-batch: a dataset
 * that writes its examples and stops, and a full tune of Muse Glimmer on a rented GPU (capped by the run's own limits,
 * TRAIN_JOB_MAX_USD). Plans go through POST /api/train/plan, starts through POST /api/train/runs, exactly as the Make
 * chat does. Made-up data only; examples are written by the site's writer (Contributor while TRAIN_CONTRIBUTOR_WRITER is on).
 *   npm run demo-tunes                 both
 *   npm run demo-tunes -- dataset      only the dataset
 *   npm run demo-tunes -- --dry        print the notes
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { env } from "@/lib/env";

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

async function call(site: string, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${site}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.automationSecret}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
}

async function main(): Promise<void> {
  const site = (process.argv.find((a) => a.startsWith("--url="))?.slice(6) ?? "https://www.musemuse.dev").replace(/\/$/, "");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const runs = only.length ? RUNS.filter((r) => only.includes(r.id)) : RUNS;
  if (process.argv.includes("--dry")) {
    for (const r of runs) console.log(`${r.id}${r.datasetOnly ? " (dataset only)" : ""}\n  ${r.note}\n`);
    return;
  }
  if (!env.automationSecret) throw new Error("AUTOMATION_SECRET isn't in .env.local.");
  const out: Array<Record<string, unknown>> = [];
  for (const r of runs) {
    const planned = await call(site, "/api/train/plan", { note: r.note, settings: { examples: 200 } });
    if (planned.status >= 300 || !planned.json.plan) {
      console.log(`FAILED   ${r.id.padEnd(8)} plan ${planned.status} ${JSON.stringify(planned.json).slice(0, 200)}`);
      out.push({ id: r.id, error: `plan ${planned.status}` });
      continue;
    }
    const started = await call(site, "/api/train/runs", { plan: planned.json.plan, ...(r.datasetOnly ? { settings: { datasetOnly: true } } : {}) });
    if (started.status >= 300 || !started.json.runId) {
      console.log(`FAILED   ${r.id.padEnd(8)} start ${started.status} ${JSON.stringify(started.json).slice(0, 200)}`);
      out.push({ id: r.id, error: `start ${started.status}` });
      continue;
    }
    const link = `${site}${String(started.json.href ?? `/fine-tuning/runs/${started.json.runId}`)}`;
    console.log(`started  ${r.id.padEnd(8)} ${link}`);
    out.push({ id: r.id, runId: started.json.runId, link });
  }
  mkdirSync(".data", { recursive: true });
  const file = `.data/demo-tunes-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, `${JSON.stringify({ site, runs: out }, null, 2)}\n`);
  console.log(`\nSaved ${file}.`);
  if (out.some((o) => o.error)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

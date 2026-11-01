// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for background jobs:
//   manifest      musemuse.json's jobs block names the brief's schedules and webhooks, and each results collection is
//                 marked jobWrites (the brief's lists come from the gateway's record of this build)
//   job-ran       the gateway recorded a test-fired run as done in this verify, and the smoke test fired it
//   job-wrote     the gateway saved a row for a job, when the brief names a results collection
//   result-shown  the smoke test saw a job's result on a screen
//   webhook-run   a sample payload led to a finished run, for a brief with a webhook
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const sorted = (list) => [...new Set(list)].sort();

/** The brief's picks, from the gateway's `brief:schedule:<name>`, `brief:webhook:<name>` and `brief:result:<name>` counts. */
export function briefPicks(proof) {
  if (!proof) return null;
  const of = (kind) => sorted(Object.keys(proof).filter((k) => k.startsWith(`brief:${kind}:`)).map((k) => k.slice(`brief:${kind}:`.length)));
  return { schedules: of("schedule"), webhooks: of("webhook"), results: of("result") };
}

export function manifestPicks(root) {
  const file = path.join(root, "musemuse.json");
  const manifest = existsSync(file) ? readJson(file) : null;
  const block = manifest?.jobs;
  if (!block || typeof block !== "object") return null;
  const names = (v) => sorted(Array.isArray(v) ? v.map((x) => x?.name).filter((x) => typeof x === "string") : []);
  const collections = Array.isArray(manifest?.data?.collections) ? manifest.data.collections : [];
  return { schedules: names(block.schedules), webhooks: names(block.webhooks), results: names(collections.filter((c) => c?.jobWrites === true)) };
}

const recorded = (record, id) => (Array.isArray(record?.checks) ? record.checks.find((c) => c?.id === id) : undefined);
const say = (p) => `schedules ${p.schedules.join(", ") || "none"}; webhooks ${p.webhooks.join(", ") || "none"}; job results ${p.results.join(", ") || "none"}`;

export async function check({ record, proof, root }) {
  const out = [];
  const brief = briefPicks(proof);
  const manifest = manifestPicks(root);
  if (!brief) out.push({ id: "manifest", ok: false, detail: "the gateway's record of the brief's jobs is missing" });
  else if (!manifest) out.push({ id: "manifest", ok: false, detail: "musemuse.json has no jobs block" });
  else out.push({ id: "manifest", ok: JSON.stringify(brief) === JSON.stringify(manifest), detail: `musemuse.json has ${say(manifest)}; the brief has ${say(brief)}` });

  const fired = recorded(record, "job-fired");
  const done = Number(proof?.done ?? 0);
  out.push({ id: "job-ran", ok: fired?.ok === true && done > 0, detail: done > 0 ? (fired?.detail ?? "the smoke test didn't run fireJob") : "the gateway saw no job run finish in this verify" });

  if (!brief || brief.results.length) {
    const rows = Number(proof?.rows ?? 0);
    out.push({ id: "job-wrote", ok: rows > 0, detail: rows > 0 ? `the gateway saved ${rows} row${rows === 1 ? "" : "s"} for finished job runs` : "no finished job run saved a row to its results collection" });
    const shown = recorded(record, "result-shown");
    out.push({ id: "result-shown", ok: shown?.ok === true, detail: shown?.detail ?? "the smoke test didn't run checkResultShown" });
  }

  if (!brief || brief.webhooks.length) {
    const hook = recorded(record, "webhook-run");
    const runs = Number(proof?.webhook_runs ?? 0);
    out.push({ id: "webhook-run", ok: hook?.ok === true && runs > 0, detail: runs > 0 ? (hook?.detail ?? "the smoke test didn't run fireWebhook") : "the gateway saw no webhook lead to a finished run in this verify" });
  }
  return out;
}

/**
 * Replication spike (Oct 31): can a build sandbox install CPU PyTorch, fetch MNIST, close its egress and run a small continual
 * learning experiment, and can Muse Code implement a made-up method from one paragraph? One throwaway sandbox from the builder
 * snapshot, never saved, named spike-rep-*, at most 8 vCPUs. Phases, in the order given:
 *   setup   open egress ("allow-all"): uv, Python 3.12, CPU torch and torchvision, MNIST (phase-setup.sh)
 *   closed  deny-all, then proves every setup host is unreachable (phase-closed.sh)
 *   run     deny-all: cl.py at 8 threads, then 4 threads on 4 vCPUs (phase-run.sh)
 *   muse    api.meta.ai only, its real key given only to mc-proxy.mjs's placeholder; Muse Code on Contributor (phase-muse.sh)
 * Uploads this folder's scripts to /tmp/spike, copies /tmp/out back to <out dir>. Stops the sandbox, checks it stopped, reads its
 * usage, deletes it. Every run adds its cost to cost-ledger.jsonl and refuses to start when the worst case could pass the cap.
 *   docs/spikes/replication-2026-10-31/run.sh <out dir> setup closed run [muse]
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { SANDBOX_ENV } from "@/lib/sandbox/muse";
import { placeholderKey } from "@/lib/sandbox/policy";
import { sh } from "@/lib/sandbox/shell";

const [outDir, ...phases] = process.argv.slice(2);
const snapshotId = process.env.BUILDER_SNAPSHOT_ID ?? "";
const key = process.env.MODEL_API_KEY ?? "";
const KNOWN = ["setup", "closed", "run", "muse"];
if (!outDir || !phases.length || phases.some((p) => !KNOWN.includes(p)) || !snapshotId) {
  throw new Error(`usage: <out dir> ${KNOWN.join(" | ")} ..., with BUILDER_SNAPSHOT_ID set`);
}
if (phases.includes("muse") && !key) throw new Error("the muse phase needs MODEL_API_KEY");

const HERE = import.meta.dirname;
const LEDGER = path.join(HERE, "cost-ledger.jsonl");
const CAP_USD = 1;
const VCPUS = Math.min(8, Number(process.env.REP_VCPUS) || 8);
const MEMORY_GB = VCPUS * 2;
const PHASE_MINUTES: Record<string, number> = { setup: 10, closed: 2, run: 10, muse: 15 };
const TIMEOUT_MS = Math.min(30, 3 + phases.reduce((m, p) => m + PHASE_MINUTES[p]!, 0)) * 60_000;
const PROXY_BUDGET_USD = 0.13; // Under the $0.15 cap even if the last call in flight overshoots.
// Pro rates, https://vercel.com/docs/sandbox/pricing (Oct 31): $0.128 per active vCPU-hour, $0.0212 per GB-hour of memory,
// 2 GB per vCPU, data transfer $0.15 per GB. The worst case takes every vCPU as busy for the whole timeout.
const RATE = { cpuHour: 0.128, gbHour: 0.0212, transferGb: 0.15 };
const worstCaseUsd = (ms: number) => (ms / 3_600_000) * (VCPUS * RATE.cpuHour + MEMORY_GB * RATE.gbHour) + 0.1;

function spent(): number {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (JSON.parse(l) as { worstCaseUsd: number }).worstCaseUsd, 0);
}
const before = spent();
if (before + worstCaseUsd(TIMEOUT_MS) > CAP_USD) {
  throw new Error(`ledger holds $${before.toFixed(3)}; a ${TIMEOUT_MS / 60_000}-minute run could pass the $${CAP_USD} cap`);
}

const say = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);
mkdirSync(outDir, { recursive: true });
const name = `spike-rep-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const t0 = Date.now();
const sb = await Sandbox.create({
  name,
  source: { type: "snapshot", snapshotId },
  persistent: false,
  resources: { vcpus: VCPUS },
  timeout: TIMEOUT_MS,
  networkPolicy: "deny-all",
  tags: { app: "musemuse", role: "spike" },
});
const createS = (Date.now() - t0) / 1000;
console.log(`sandbox ${sb.name}, ${VCPUS} vCPUs, created in ${createS.toFixed(1)} s, timeout ${TIMEOUT_MS / 60_000} min`);

const ph = key ? placeholderKey(key, sb.name) : "";
const standIn = `rep_standin_${randomBytes(12).toString("hex")}`;
const carries = [{ key: { regex: "(?i)^authorization$" }, value: { exact: `Bearer ${ph}` } }];
const policies: Record<string, NetworkPolicy> = {
  setup: "allow-all",
  closed: "deny-all",
  run: "deny-all",
  muse: {
    allow: {
      "api.meta.ai": [
        { match: { headers: carries }, transform: [{ headers: { Authorization: `Bearer ${key}` } }] },
        { response: { statusCode: 403, body: "replication spike firewall: refused", contentType: "text/plain" } },
      ],
    },
  } as unknown as NetworkPolicy,
};

const timings: Record<string, number> = { createS };
const exits: Record<string, number> = {};
try {
  const files = readdirSync(HERE).filter((f) => /^(phase-.*\.sh|cl\.py|mc-proxy\.mjs)$/.test(f));
  await sb.writeFiles(files.map((f) => ({ path: `/tmp/spike/${f}`, content: readFileSync(path.join(HERE, f)) })));
  let proxyUp = false;
  for (const p of phases) {
    await sb.update({ networkPolicy: policies[p]! });
    if (p === "muse" && !proxyUp) {
      // The only process in the sandbox that holds the placeholder. Root, with the firewall's CA, as the musecode spike ran it.
      const ca = (await sh(sb, 'printf %s "$NODE_EXTRA_CA_CERTS"', { allowFail: true })).stdout.trim();
      await sb.runCommand({
        cmd: "node",
        args: ["/tmp/spike/mc-proxy.mjs"],
        sudo: true,
        detached: true,
        env: { REP_UPSTREAM_KEY: ph, REP_STANDIN_SHA: createHash("sha256").update(standIn).digest("hex"), PROXY_BUDGET_USD: String(PROXY_BUDGET_USD), ...(ca ? { NODE_EXTRA_CA_CERTS: ca } : {}) },
      });
      const up = await sh(sb, "for i in $(seq 1 40); do curl -s -m 1 http://127.0.0.1:8787/__health && exit 0; sleep 0.25; done; exit 1", { allowFail: true });
      proxyUp = up.exitCode === 0;
      console.log(`proxy up: ${proxyUp} ${up.stdout.slice(0, 120)}`);
      if (!proxyUp) {
        exits[p] = -1;
        continue;
      }
    }
    const t = Date.now();
    const r = await sh(sb, `bash /tmp/spike/phase-${p}.sh`, {
      env: { ...SANDBOX_ENV, ...(p === "muse" ? { REP_STANDIN: standIn } : {}) },
      allowFail: true,
      timeoutMs: PHASE_MINUTES[p]! * 60_000,
    });
    timings[`${p}S`] = (Date.now() - t) / 1000;
    exits[p] = r.exitCode;
    writeFileSync(path.join(outDir, `phase-${p}.txt`), `--- phase ${p}: exit ${r.exitCode} in ${timings[`${p}S`]!.toFixed(0)} s\n${r.stdout}\n[stderr]\n${r.stderr.slice(-6000)}\n`);
    console.log(`phase ${p}: exit ${r.exitCode} in ${timings[`${p}S`]!.toFixed(0)} s`);
    if (p === "setup" && r.exitCode !== 0) break;
  }
  await sh(sb, "mkdir -p /tmp/out && sudo chmod -R a+rX /tmp/out && tar -C /tmp/out -czf /tmp/out.tgz .", { allowFail: true });
  const tgz = await sb.readFileToBuffer({ path: "/tmp/out.tgz" }).catch(() => null);
  if (tgz) {
    const file = path.join(outDir, "out.tgz");
    writeFileSync(file, tgz);
    execFileSync("tar", ["-xzf", file, "-C", outDir]);
    execFileSync("rm", ["-f", file]);
    console.log(`copied /tmp/out (${(tgz.length / 1e6).toFixed(2)} MB)`);
  }
} catch (e) {
  console.log(`runner error: ${say(e)}`);
} finally {
  const stopAt = Date.now();
  await sb.stop({ blocking: true }).catch((e) => console.log(`stop: ${say(e)}`));
  const ms = Date.now() - t0;
  const after = await Sandbox.get({ name: sb.name, resume: false }).catch(() => null);
  const status = after?.status ?? "gone";
  const cpuMs = after?.activeCpuUsageMs ?? null;
  const net = after?.networkTransfer ?? null;
  console.log(`stop took ${((Date.now() - stopAt) / 1000).toFixed(1)} s; status now ${status}; active CPU ${cpuMs ?? "?"} ms; transfer ${net ? `${(net.ingress / 1e6).toFixed(1)} MB in, ${(net.egress / 1e6).toFixed(1)} MB out` : "?"}`);
  const billedUsd =
    cpuMs === null ? null : (cpuMs / 3_600_000) * RATE.cpuHour + (ms / 3_600_000) * MEMORY_GB * RATE.gbHour + (net ? ((net.ingress + net.egress) / 1e9) * RATE.transferGb : 0);
  await sb.delete().catch((e) => console.log(`delete: ${say(e)}`));
  const worst = worstCaseUsd(ms);
  const row = { at: new Date().toISOString(), sandbox: sb.name, phases, exits, vcpus: VCPUS, seconds: Math.round(ms / 1000), timings, status, activeCpuMs: cpuMs, transfer: net, estimateUsd: billedUsd === null ? null : Number(billedUsd.toFixed(4)), worstCaseUsd: Number(worst.toFixed(4)) };
  appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
  writeFileSync(path.join(outDir, "sandbox.json"), JSON.stringify(row, null, 1));
  console.log(`${(ms / 1000).toFixed(0)} s; estimate $${billedUsd?.toFixed(3) ?? "?"}, worst case $${worst.toFixed(3)}, ledger at most $${(before + worst).toFixed(3)}`);
}

// Nothing copied out may hold a credential. Checked without printing what it looks for.
const secrets = [key, ph, standIn].filter(Boolean);
let clean = true;
for (const rel of readdirSync(outDir, { recursive: true }).map(String)) {
  let text = "";
  try {
    text = readFileSync(path.join(outDir, rel), "utf8");
  } catch {
    continue;
  }
  if (secrets.some((s) => text.includes(s))) {
    clean = false;
    console.log(`CREDENTIAL IN OUTPUT: ${rel}`);
  }
}
console.log(`credential scan of ${outDir}: ${clean ? "clean" : "FOUND, do not commit"}`);

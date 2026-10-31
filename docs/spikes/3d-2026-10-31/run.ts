/**
 * 3D spike runner (Oct 31): can a build sandbox run Blender headless, and can Muse Code drive it? Runs phase-<name>.sh
 * scripts in one throwaway sandbox from BUILDER_SNAPSHOT_ID, never saved, then copies /tmp/out back and stops it.
 *   docs/spikes/3d-2026-10-31/creds.sh docs/spikes/3d-2026-10-31/run.ts <out dir> <phase>:<firewall> ...
 * Firewalls:
 *   open    allow-all (SNAPSHOT_POLICY), for installing Blender only, the way the snapshot script installs everything.
 *   locked  builderNetworkPolicy() exactly as a build gets it (lib/sandbox/policy.ts), with no platform host: api.meta.ai
 *           brokered on Muse Code's routes for this sandbox's placeholder, registry.npmjs.org, nothing else.
 * Muse Code never holds the placeholder. It gets a random stand-in and talks to proxy.mjs on 127.0.0.1:8787, which runs as
 * root with the placeholder, forwards only muse-spark-1.3-contributor, meters every call and refuses past its budget.
 * Every run adds its worst-case sandbox cost and the proxy's metered Meta cost to cost-ledger.jsonl, and refuses to start
 * when either cap could be passed. SPIKE_VCPUS sets the size (default 4, what builds use). PROXY_BUDGET_USD is the Meta
 * budget for this run (default 0, so nothing can cost money).
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { SANDBOX_ENV } from "@/lib/sandbox/muse";
import { builderNetworkPolicy, placeholderKey, SNAPSHOT_POLICY } from "@/lib/sandbox/policy";
import { sh } from "@/lib/sandbox/shell";

const HERE = import.meta.dirname;
const LEDGER = path.join(HERE, "cost-ledger.jsonl");
const SANDBOX_CAP_USD = 0.95;
const META_CAP_USD = 0.2;
const META_MARGIN_USD = 0.03; // One call in flight when the budget runs out costs well under this on Contributor.
const VCPUS = Math.min(8, Number(process.env.SPIKE_VCPUS) || 4);
const TIMEOUT_MS = Math.min(40, Number(process.env.SPIKE_TIMEOUT_MIN) || 40) * 60_000;
/** The linux x64 line of https://download.blender.org/release/Blender5.2/blender-5.2.3.sha256, read from the laptop side on Oct 31. */
const BLENDER_LINUX_SHA256 = "78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec";
// Pro rates in iad1 (https://vercel.com/docs/sandbox/pricing, Oct 31): $0.128 per active vCPU-hour, $0.0212 per GB-hour,
// 2 GB per vCPU. Downloads are free. "Worst case" counts every vCPU busy for the whole time.
const worstCaseUsd = (ms: number) => (ms / 3_600_000) * (VCPUS * 0.128 + VCPUS * 2 * 0.0212);

const [outDir, ...phases] = process.argv.slice(2);
const key = process.env.MODEL_API_KEY ?? "";
const snapshotId = process.env.BUILDER_SNAPSHOT_ID ?? "";
if (!outDir || !phases.length || !key || !snapshotId) throw new Error("usage: <out dir> <phase>:<open|locked> ..., with credentials from creds.sh");
for (const p of phases) if (!/^[a-z0-9-]+:(open|locked)$/.test(p)) throw new Error(`bad phase ${p}`);

type Entry = { worstCaseUsd?: number; metaUsd?: number };
const ledger = (): Entry[] => (existsSync(LEDGER) ? readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry) : []);
const sandboxSpent = ledger().reduce((s, e) => s + (e.worstCaseUsd ?? 0), 0);
const metaSpent = ledger().reduce((s, e) => s + (e.metaUsd ?? 0), 0);
if (sandboxSpent + worstCaseUsd(TIMEOUT_MS) > SANDBOX_CAP_USD) throw new Error(`sandboxes spent up to $${sandboxSpent.toFixed(3)}; one more run could pass $${SANDBOX_CAP_USD}`);
const wanted = Number(process.env.PROXY_BUDGET_USD ?? 0);
const budget = Math.max(0, Math.min(wanted, META_CAP_USD - META_MARGIN_USD - metaSpent));
if (wanted > 0 && budget <= 0) throw new Error(`Meta spent $${metaSpent.toFixed(4)}; no budget left under $${META_CAP_USD}`);
console.log(`ledger: sandboxes at most $${sandboxSpent.toFixed(3)}, Meta $${metaSpent.toFixed(4)}; this run's Meta budget $${budget.toFixed(3)}`);

const say = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);
mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const name = `spike-3d-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const placeholder = placeholderKey(key, name);
const standIn = `spike_standin_${randomBytes(12).toString("hex")}`;
const locked: NetworkPolicy = builderNetworkPolicy({ modelApiKey: key, placeholderKey: placeholder, platformHost: null });
const policies: Record<string, NetworkPolicy> = { open: SNAPSHOT_POLICY, locked };

const sb = await Sandbox.create({
  name,
  source: { type: "snapshot", snapshotId },
  persistent: false,
  resources: { vcpus: VCPUS },
  timeout: TIMEOUT_MS,
  networkPolicy: locked,
  tags: { app: "musemuse", role: "spike" },
});
console.log(`sandbox ${sb.name}, ${VCPUS} vCPUs, in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

function walk(root: string, rel = ""): string[] {
  return readdirSync(path.join(root, rel)).flatMap((n) => {
    const child = rel ? `${rel}/${n}` : n;
    return statSync(path.join(root, child)).isDirectory() ? walk(root, child) : [child];
  });
}

let proxyUp = false;
async function startProxy(): Promise<void> {
  const ca = (await sh(sb, 'printf %s "${NODE_EXTRA_CA_CERTS:-}"', { allowFail: true })).stdout.trim();
  await sb.runCommand({
    cmd: "node",
    args: ["/tmp/spike/proxy.mjs"],
    sudo: true,
    detached: true,
    env: { SPIKE_UPSTREAM_KEY: placeholder, SPIKE_STANDIN_SHA: createHash("sha256").update(standIn).digest("hex"), PROXY_BUDGET_USD: String(budget), ...(ca ? { NODE_EXTRA_CA_CERTS: ca } : {}) },
  });
  const up = await sh(sb, "for i in $(seq 1 20); do curl -s -m 1 http://127.0.0.1:8787/__health && exit 0; sleep 0.25; done; exit 1", { allowFail: true });
  console.log(`proxy up: exit ${up.exitCode} ${up.stdout.slice(0, 200)}`);
  proxyUp = true;
}

async function copyOut(): Promise<void> {
  await sh(sb, "mkdir -p /tmp/out && sudo -n chmod -R a+rX /tmp/out; tar -C /tmp/out -czf /tmp/out.tgz .", { allowFail: true });
  const tgz = await sb.readFileToBuffer({ path: "/tmp/out.tgz" }).catch(() => null);
  if (!tgz) return;
  const file = path.join(outDir!, "out.tgz");
  writeFileSync(file, tgz);
  const { execFileSync } = await import("node:child_process");
  execFileSync("tar", ["-xzf", file, "-C", outDir!]);
  console.log(`copied /tmp/out (${(tgz.length / 1e6).toFixed(2)} MB)`);
}

const timings: Record<string, number> = {};
let metaUsd = 0;
try {
  const files = walk(HERE)
    .filter((rel) => /^(phase-[a-z0-9-]+\.sh|proxy\.mjs|lib\/.+)$/.test(rel))
    .map((rel) => ({ path: `/tmp/spike/${rel}`, content: readFileSync(path.join(HERE, rel)) }));
  for (let i = 0; i < files.length; i += 100) await sb.writeFiles(files.slice(i, i + 100));
  for (const item of phases) {
    const [p, firewall] = item.split(":") as [string, string];
    await sb.update({ networkPolicy: policies[firewall]! });
    if (p.startsWith("muse") && !proxyUp) await startProxy();
    const t = Date.now();
    const r = await sh(sb, `bash /tmp/spike/phase-${p}.sh`, {
      env: { ...SANDBOX_ENV, SPIKE_STANDIN: standIn, SPIKE_FIREWALL: firewall, SPIKE_VCPUS: String(VCPUS), SPIKE_EXPECTED_SHA: BLENDER_LINUX_SHA256 },
      allowFail: true,
      timeoutMs: 25 * 60_000,
    });
    timings[p] = Math.round((Date.now() - t) / 1000);
    const text = `--- phase ${p} firewall ${firewall}: exit ${r.exitCode} in ${timings[p]} s\n${r.stdout}\n[stderr]\n${r.stderr.slice(-6000)}\n`;
    writeFileSync(path.join(outDir, `phase-${p}.txt`), text);
    console.log(`phase ${p} (${firewall}): exit ${r.exitCode} in ${timings[p]} s, ${r.stdout.length} chars`);
  }
} catch (e) {
  console.log(`runner error: ${say(e)}`);
} finally {
  await copyOut().catch((e) => console.log(`copy out: ${say(e)}`));
  const proxyLog = path.join(outDir, "proxy.jsonl");
  if (existsSync(proxyLog)) {
    for (const line of readFileSync(proxyLog, "utf8").split("\n").filter(Boolean)) {
      const j = JSON.parse(line) as { spentUsd?: number };
      if (typeof j.spentUsd === "number") metaUsd = Math.max(metaUsd, j.spentUsd);
    }
  }
  await sb.stop({ blocking: true }).catch((e) => console.log(`stop: ${say(e)}`));
  const ms = Date.now() - t0;
  const after = await Sandbox.get({ name: sb.name }).catch(() => null);
  const cost = worstCaseUsd(ms);
  appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), sandbox: sb.name, phases, timings, seconds: Math.round(ms / 1000), vcpus: VCPUS, worstCaseUsd: Number(cost.toFixed(4)), metaUsd: Number(metaUsd.toFixed(6)), statusAfterStop: after?.status ?? "gone" })}\n`);
  console.log(`stopped after ${(ms / 1000).toFixed(0)} s, status ${after?.status ?? "gone"}; at most $${cost.toFixed(3)} (sandboxes $${(sandboxSpent + cost).toFixed(3)} so far), Meta $${metaUsd.toFixed(6)} (total $${(metaSpent + metaUsd).toFixed(6)})`);
}

// Nothing from the sandbox may carry a credential out. Checked without printing what it looks for.
let clean = true;
for (const rel of readdirSync(outDir, { recursive: true }).map(String)) {
  const file = path.join(outDir, rel);
  if (!statSync(file).isFile() || statSync(file).size > 50_000_000) continue;
  const text = readFileSync(file).toString("latin1");
  if (text.includes(key) || text.includes(placeholder) || text.includes(standIn) || (process.env.VERCEL_OIDC_TOKEN && text.includes(process.env.VERCEL_OIDC_TOKEN))) {
    clean = false;
    console.log(`CREDENTIAL IN OUTPUT: ${rel}`);
  }
}
console.log(`credential scan of ${outDir}: ${clean ? "clean" : "FOUND, do not commit"}`);

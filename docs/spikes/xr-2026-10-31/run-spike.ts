/**
 * VR spike S1: can a Vercel Sandbox render and test WebXR with IWER and no GPU? Runs phase-<x>.sh scripts in a throwaway
 * sandbox from the current builder snapshot, never saving it. Network is deny-all except npm, and no key for Meta is ever
 * in this process or the sandbox, so no model call can happen. Uploads this folder to /tmp/spike, then copies /tmp/out
 * back as <out dir>/. Every run adds its worst-case cost to cost-ledger.jsonl and refuses to start past the cap.
 *   VERCEL_OIDC_TOKEN=... BUILDER_SNAPSHOT_ID=... npx tsx docs/spikes/xr-2026-10-31/run-spike.ts <out dir> A [B] [T] [D]
 * XR_VCPUS sets the sandbox size. XR_SKIP_MATRIX skips phase B's flag tests and verify, for a run that only wants its build.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Sandbox } from "@vercel/sandbox";
import { SANDBOX_ENV } from "@/lib/sandbox/muse";
import { sh } from "@/lib/sandbox/shell";

const [outDir, ...phases] = process.argv.slice(2);
const snapshotId = process.env.BUILDER_SNAPSHOT_ID ?? "";
if (!outDir || !phases.length || !snapshotId) throw new Error("usage: <out dir> A [B] [T] [D], with BUILDER_SNAPSHOT_ID set");

const HERE = import.meta.dirname;
const LEDGER = path.join(HERE, "cost-ledger.jsonl");
const CAP_USD = 3;
const VCPUS = Number(process.env.XR_VCPUS) || 4; // 4 is what builds use (lib/sandbox/builder.ts), so the timings carry over.
const TIMEOUT_MS = 40 * 60_000;
// Pro rates in iad1, https://vercel.com/docs/sandbox/pricing (Oct 31): $0.128 per active vCPU-hour, $0.0212 per GB-hour,
// 2 GB per vCPU. "Worst case" takes every vCPU as busy the whole time.
const worstCaseUsd = (ms: number) => (ms / 3_600_000) * (VCPUS * 0.128 + VCPUS * 2 * 0.0212);

function spent(): number {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).reduce((sum, line) => sum + (JSON.parse(line) as { worstCaseUsd: number }).worstCaseUsd, 0);
}

const before = spent();
if (before + worstCaseUsd(TIMEOUT_MS) > CAP_USD) throw new Error(`spent up to $${before.toFixed(2)}; one more run could pass the $${CAP_USD} cap`);

function walk(root: string, rel = ""): string[] {
  return readdirSync(path.join(root, rel)).flatMap((name) => {
    const child = rel ? `${rel}/${name}` : name;
    return statSync(path.join(root, child)).isDirectory() ? walk(root, child) : [child];
  });
}

mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const sb = await Sandbox.create({
  name: `spike-xr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  source: { type: "snapshot", snapshotId },
  persistent: false,
  resources: { vcpus: VCPUS },
  timeout: TIMEOUT_MS,
  networkPolicy: { allow: { "registry.npmjs.org": [] } },
  tags: { app: "musemuse", role: "spike" },
});
console.log(`sandbox ${sb.name} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
try {
  const files = walk(HERE)
    .filter((rel) => /^phase-|^lib\//.test(rel) && !rel.endsWith(".txt"))
    .map((rel) => ({ path: `/tmp/spike/${rel}`, content: readFileSync(path.join(HERE, rel)) }));
  for (let i = 0; i < files.length; i += 100) await sb.writeFiles(files.slice(i, i + 100));
  for (const p of phases) {
    const t = Date.now();
    const r = await sh(sb, `bash /tmp/spike/phase-${p.toLowerCase()}.sh`, { env: { ...SANDBOX_ENV, ...(process.env.XR_SKIP_MATRIX ? { XR_SKIP_MATRIX: "1" } : {}) }, allowFail: true, timeoutMs: 25 * 60_000 });
    const text = `--- phase ${p}: exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(0)} s\n${r.stdout}\n[stderr]\n${r.stderr.slice(-6000)}\n`;
    writeFileSync(path.join(outDir, `phase-${p}.txt`), text);
    console.log(`phase ${p}: exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(0)} s, ${r.stdout.length} chars of output`);
  }
  await sh(sb, "mkdir -p /tmp/out && tar -C /tmp/out -czf /tmp/out.tgz .", { allowFail: true });
  const tgz = await sb.readFileToBuffer({ path: "/tmp/out.tgz" }).catch(() => null);
  if (tgz) {
    const file = path.join(outDir, "out.tgz");
    writeFileSync(file, tgz);
    execFileSync("tar", ["-xzf", file, "-C", outDir]);
    console.log(`copied /tmp/out (${(tgz.length / 1e6).toFixed(1)} MB)`);
  }
} finally {
  await sb.stop().catch((e) => console.warn("stop:", String(e)));
  await sb.delete().catch((e) => console.warn("delete:", String(e)));
  const ms = Date.now() - t0;
  const cost = worstCaseUsd(ms);
  appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), sandbox: sb.name, phases, seconds: Math.round(ms / 1000), vcpus: VCPUS, worstCaseUsd: Number(cost.toFixed(4)) })}\n`);
  console.log(`stopped and deleted after ${(ms / 1000).toFixed(0)} s, at most $${cost.toFixed(3)}, at most $${(before + cost).toFixed(3)} so far`);
}

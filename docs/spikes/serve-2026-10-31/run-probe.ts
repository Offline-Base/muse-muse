/**
 * Throwaway sandbox probe for the Oct 31 serve test: runs phase-<n>.sh in a sandbox from the current builder snapshot,
 * never saved. Phase 1: model calls answered 403 by the firewall (free). Phase 2: the echo provider (free). Phase 3: the
 * real build firewall, a tiny paid turn. Installs @muse-code/sdk as the bridge does, then copies /tmp/out back.
 *   npx tsx --env-file=<.env.local> docs/spikes/serve-2026-10-31/run-probe.ts <out dir> 1 2 [3]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { MUSE_SDK_VERSION } from "@/lib/sandbox/bridge-protocol";
import { museEnv, SANDBOX_ENV } from "@/lib/sandbox/muse";
import { BROKERED_META_ROUTES, builderNetworkPolicy, placeholderKey } from "@/lib/sandbox/policy";
import { sh } from "@/lib/sandbox/shell";

const dir = import.meta.dirname;
const [outDir, ...phases] = process.argv.slice(2);
const key = process.env.MODEL_API_KEY ?? "";
const snapshotId = process.env.BUILDER_SNAPSHOT_ID ?? "";
if (!outDir || !phases.length || !key || !snapshotId) throw new Error("usage: <out dir> 1 [2] [3]");
mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const sb = await Sandbox.create({
  name: `spike-serve-${Date.now().toString(36)}`,
  source: { type: "snapshot", snapshotId },
  persistent: false,
  resources: { vcpus: 2 },
  timeout: 30 * 60_000,
  networkPolicy: "deny-all",
  tags: { app: "musemuse", role: "spike" },
});
console.log(`sandbox ${sb.name} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const ph = placeholderKey(key, sb.name);
const real = builderNetworkPolicy({ modelApiKey: key, placeholderKey: ph, platformHost: null });
const rule = (methods: string[], p: string) => ({
  match: { method: methods, path: { exact: p }, headers: [{ key: { regex: "(?i)^authorization$" }, value: { exact: `Bearer ${ph}` } }] },
  transform: [{ headers: { Authorization: `Bearer ${key}` } }],
});
// As the build firewall, without the model route: nothing that costs money gets out.
const noModel = {
  allow: {
    "api.meta.ai": [
      ...BROKERED_META_ROUTES.filter((r) => r.path !== "/v1/responses").map((r) => rule(r.methods, r.path)),
      { response: { statusCode: 403, body: "probe: model calls blocked", contentType: "text/plain" } },
    ],
    "registry.npmjs.org": [],
  },
} as unknown as NetworkPolicy;
try {
  await sb.update({ networkPolicy: noModel });
  const files = ["msp-host-probe.mjs", "phase-1.sh", "phase-1b.sh", "phase-1c.sh", "phase-1d.sh", "phase-1e.sh", "phase-1f.sh", "phase-1g.sh", "phase-1h.sh", "phase-1i.sh", "phase-2.sh", "phase-3.sh", "phase-4.sh"].map((f) => ({
    path: `/tmp/${f.endsWith(".mjs") ? "sdk" : "spike"}/${f}`,
    content: readFileSync(path.join(dir, f)),
  }));
  files.push({ path: "/tmp/spike/bridge.mjs", content: readFileSync(path.join(dir, "../../../lib/sandbox/bridge/bridge.mjs")) });
  await sb.writeFiles(files);
  const inst = await sh(sb, `cd /tmp/sdk && printf '{"private":true}' > package.json && npm install --no-audit --no-fund --loglevel=error --no-save @muse-code/sdk@${MUSE_SDK_VERSION} && node -p 'require("./node_modules/@muse-code/sdk/package.json").version'`, { allowFail: true, timeoutMs: 60_000 });
  console.log(`sdk install exit ${inst.exitCode}: ${inst.stdout.trim()} ${inst.stderr.slice(-300)}`);
  for (const p of phases) {
    await sb.update({ networkPolicy: p === "3" || p === "4" ? real : noModel });
    const t = Date.now();
    const r = await sh(sb, `bash /tmp/spike/phase-${p}.sh`, { env: p === "3" || p === "4" ? museEnv(ph) : p === "2" ? { ...SANDBOX_ENV, META_API_KEY: "unused" } : museEnv(ph), allowFail: true, timeoutMs: 15 * 60_000 });
    const text = `--- phase ${p}: exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(0)} s\n${r.stdout}\n[stderr]\n${r.stderr.slice(-4000)}\n`;
    writeFileSync(path.join(outDir, `phase-${p}.txt`), text);
    console.log(`phase ${p}: exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(0)} s, ${r.stdout.length} chars`);
  }
  const list = await sh(sb, "ls -1 /tmp/out 2>/dev/null", { allowFail: true });
  for (const name of list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const buf = await sb.readFileToBuffer({ path: `/tmp/out/${name}` }).catch(() => null);
    if (buf) writeFileSync(path.join(outDir, name), buf);
  }
} finally {
  await sb.stop().catch(() => {});
  await sb.delete().catch((e) => console.warn("delete:", String(e)));
  console.log(`stopped and deleted after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

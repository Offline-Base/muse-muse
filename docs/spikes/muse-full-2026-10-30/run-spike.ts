/**
 * One-off Muse Code spike (git-ignored): runs phase-<x>.sh scripts in a throwaway sandbox from the current builder
 * snapshot, never saving it. A: no network. B: the model catalog brokered, model calls refused by the firewall. C: the
 * real build policy (tiny, paid model calls). Uploads the @muse-code/sdk package and the probe, then copies /tmp/out
 * back.
 *   npx tsx --env-file=.env.local scripts/.tmp-muse-spike.ts <spike dir> <sdk package dir> <out dir> A B [C]
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { museEnv, SANDBOX_ENV } from "@/lib/sandbox/muse";
import { builderNetworkPolicy, placeholderKey } from "@/lib/sandbox/policy";
import { sh } from "@/lib/sandbox/shell";

const [dir, sdkDir, outDir, ...phases] = process.argv.slice(2);
const key = process.env.MODEL_API_KEY ?? "";
const snapshotId = process.env.BUILDER_SNAPSHOT_ID ?? "";
if (!dir || !sdkDir || !outDir || !phases.length || !key || !snapshotId) throw new Error("usage: <spike dir> <sdk dir> <out dir> A [B] [C]");

function walk(root: string, rel = ""): string[] {
  return readdirSync(path.join(root, rel)).flatMap((name) => {
    const child = rel ? `${rel}/${name}` : name;
    return statSync(path.join(root, child)).isDirectory() ? walk(root, child) : [child];
  });
}

const t0 = Date.now();
const sb = await Sandbox.create({
  name: `spike-muse-${Date.now().toString(36)}`,
  source: { type: "snapshot", snapshotId },
  persistent: false,
  resources: { vcpus: 2 },
  timeout: 30 * 60_000,
  networkPolicy: "deny-all",
  tags: { app: "musemuse", role: "spike" },
});
console.log(`sandbox ${sb.name} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const ph = placeholderKey(key, sb.name);
const rule = (method: string[], p: string) => ({
  match: { method, path: { exact: p }, headers: [{ key: { regex: "(?i)^authorization$" }, value: { exact: `Bearer ${ph}` } }] },
  transform: [{ headers: { Authorization: `Bearer ${key}` } }],
});
const catalogOnly = {
  allow: {
    "api.meta.ai": [
      rule(["GET", "POST"], "/muse-code/models"),
      rule(["GET"], "/v1/models"),
      { response: { statusCode: 403, body: "spike: model calls blocked", contentType: "text/plain" } },
    ],
  },
} as unknown as NetworkPolicy;
try {
  const files = walk(sdkDir).map((rel) => ({ path: `/tmp/sdk/node_modules/@muse-code/sdk/${rel}`, content: readFileSync(path.join(sdkDir, rel)) }));
  files.push({ path: "/tmp/sdk/msp-probe.mjs", content: readFileSync(path.join(dir, "msp-probe.mjs")) });
  files.push({ path: "/tmp/spike/mcp-spike.mjs", content: readFileSync(path.join(dir, "mcp-spike.mjs")) });
  for (const p of ["a", "b", "c"]) {
    const f = path.join(dir, `phase-${p}.sh`);
    try {
      files.push({ path: `/tmp/spike/phase-${p}.sh`, content: readFileSync(f) });
    } catch {
      // not written yet
    }
  }
  await sb.writeFiles(files);
  for (const p of phases) {
    if (p === "B") await sb.update({ networkPolicy: catalogOnly });
    if (p === "C") await sb.update({ networkPolicy: builderNetworkPolicy({ modelApiKey: key, placeholderKey: ph, platformHost: null }) });
    const t = Date.now();
    const r = await sh(sb, `bash /tmp/spike/phase-${p.toLowerCase()}.sh`, {
      env: p === "A" ? { ...SANDBOX_ENV } : museEnv(ph),
      allowFail: true,
      timeoutMs: 20 * 60_000,
    });
    const text = `--- phase ${p}: exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(0)} s\n${r.stdout}\n[stderr]\n${r.stderr.slice(-6000)}\n`;
    writeFileSync(path.join(outDir, `phase-${p}.txt`), text);
    console.log(`phase ${p}: exit ${r.exitCode}, ${r.stdout.length} chars of output`);
  }
  mkdirSync(outDir, { recursive: true });
  const list = await sh(sb, "ls -1 /tmp/out 2>/dev/null", { allowFail: true });
  for (const name of list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const buf = await sb.readFileToBuffer({ path: `/tmp/out/${name}` }).catch(() => null);
    if (buf) writeFileSync(path.join(outDir, name), buf);
  }
  console.log(`copied /tmp/out (${list.stdout.split("\n").filter(Boolean).length} files)`);
} finally {
  await sb.stop().catch(() => {});
  await sb.delete().catch((e) => console.warn("delete:", String(e)));
  console.log(`stopped and deleted after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

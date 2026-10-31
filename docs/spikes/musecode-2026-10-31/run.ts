/**
 * Throwaway sandbox runner for the Oct 31 Muse Code in products spike. Runs phase-<name>.sh in one sandbox from the builder
 * snapshot, never saved, then copies /tmp/out back and stops the sandbox.
 *   npx tsx --env-file=<.env.local> docs/spikes/musecode-2026-10-31/run.ts <out dir> <phase>[:<firewall>] ...
 * Firewalls:
 *   free    every api.meta.ai call answered 403 by the firewall. Nothing can cost money. The default.
 *   catalog as free, but the catalog routes get the real key when they carry the placeholder.
 *   proxy   every route gets the real key only when it carries the placeholder, which only proxy.mjs holds. Muse Code itself
 *           gets a different stand-in, so a call that skips the proxy is answered 403 with a body the phase can spot.
 *   proxy-responses  as proxy, on POST /v1/responses and the catalog routes only.
 * The placeholder reaches the sandbox only as SPIKE_UPSTREAM_KEY in a phase's environment. It is never printed or written out.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { MUSE_SDK_VERSION } from "@/lib/sandbox/bridge-protocol";
import { SANDBOX_ENV } from "@/lib/sandbox/muse";
import { placeholderKey } from "@/lib/sandbox/policy";
import { sh } from "@/lib/sandbox/shell";

const dir = import.meta.dirname;
const [outDir, ...phases] = process.argv.slice(2);
const key = process.env.MODEL_API_KEY ?? "";
const snapshotId = process.env.BUILDER_SNAPSHOT_ID ?? "";
if (!outDir || !phases.length || !key || !snapshotId) throw new Error("usage: <out dir> <phase>[:<firewall>] ...");
mkdirSync(outDir, { recursive: true });

export const REFUSED = "spike-firewall-refused-this-direct-call";
const t0 = Date.now();
const sb = await Sandbox.create({
  name: `musecode-spike-${Date.now().toString(36)}`,
  source: { type: "snapshot", snapshotId },
  persistent: false,
  resources: { vcpus: 2 },
  timeout: 40 * 60_000,
  networkPolicy: "deny-all",
  tags: { app: "musemuse", role: "spike" },
});
const createdS = (Date.now() - t0) / 1000;
console.log(`sandbox ${sb.name} in ${createdS.toFixed(1)} s`);
const ph = placeholderKey(key, sb.name);
const carriesPlaceholder = [{ key: { regex: "(?i)^authorization$" }, value: { exact: `Bearer ${ph}` } }];
const brokered = (methods: string[], p: string) => ({
  match: { method: methods, path: { exact: p }, headers: carriesPlaceholder },
  transform: [{ headers: { Authorization: `Bearer ${key}` } }],
});
const refuse = { response: { statusCode: 403, body: REFUSED, contentType: "text/plain" } };
const CATALOG = [brokered(["GET", "POST"], "/muse-code/models"), brokered(["GET"], "/v1/models")];
const policies: Record<string, NetworkPolicy> = {
  free: { allow: { "api.meta.ai": [refuse], "registry.npmjs.org": [] } } as unknown as NetworkPolicy,
  catalog: { allow: { "api.meta.ai": [...CATALOG, refuse], "registry.npmjs.org": [] } } as unknown as NetworkPolicy,
  "proxy-responses": { allow: { "api.meta.ai": [...CATALOG, brokered(["POST"], "/v1/responses"), refuse], "registry.npmjs.org": [] } } as unknown as NetworkPolicy,
};
try {
  await sb.update({ networkPolicy: policies.free! });
  const scripts = readdirSync(dir).filter((f) => /\.(sh|mjs|txt)$/.test(f) && !f.startsWith("result-"));
  await sb.writeFiles([
    ...scripts.map((f) => ({ path: `/tmp/spike/${f}`, content: readFileSync(path.join(dir, f)) })),
    { path: "/tmp/spike/bridge.mjs", content: readFileSync(path.join(dir, "../../../lib/sandbox/bridge/bridge.mjs")) },
  ]);
  const inst = await sh(sb, `mkdir -p /tmp/out /tmp/sdk && cd /tmp/sdk && printf '{"private":true}' > package.json && npm install --no-audit --no-fund --loglevel=error --no-save @muse-code/sdk@${MUSE_SDK_VERSION} && node -p 'require("./node_modules/@muse-code/sdk/package.json").version' && cp /tmp/spike/*.mjs /tmp/sdk/`, { allowFail: true, timeoutMs: 90_000 });
  console.log(`sdk install exit ${inst.exitCode} in ${((Date.now() - t0) / 1000).toFixed(1)} s from create: ${inst.stdout.trim()} ${inst.stderr.slice(-300)}`);
  writeFileSync(path.join(outDir, "timing-create.json"), JSON.stringify({ createdS, sdkReadyS: (Date.now() - t0) / 1000, t0 }));
  for (const item of phases) {
    const [p, firewall = "free"] = item.split(":");
    await sb.update({ networkPolicy: policies[firewall]! });
    const t = Date.now();
    const r = await sh(sb, `bash /tmp/spike/phase-${p}.sh`, {
      env: {
        ...SANDBOX_ENV,
        SPIKE_UPSTREAM_KEY: ph,
        SPIKE_KEY_SHA256: createHash("sha256").update(key).digest("hex"),
        SPIKE_T0_MS: String(t0),
      },
      allowFail: true,
      timeoutMs: 20 * 60_000,
    });
    const text = `--- phase ${p} firewall ${firewall}: exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(0)} s\n${r.stdout}\n[stderr]\n${r.stderr.slice(-4000)}\n`;
    writeFileSync(path.join(outDir, `phase-${p}.txt`), text);
    console.log(`phase ${p}: exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(0)} s, ${r.stdout.length} chars`);
  }
  const list = await sh(sb, "cd /tmp/out 2>/dev/null && find . -type f | sed 's|^./||'", { allowFail: true });
  for (const name of list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const buf = await sb.readFileToBuffer({ path: `/tmp/out/${name}` }).catch(() => null);
    if (buf) {
      mkdirSync(path.dirname(path.join(outDir, name)), { recursive: true });
      writeFileSync(path.join(outDir, name), buf);
    }
  }
} finally {
  await sb.stop({ blocking: true }).catch((e) => console.warn("stop:", String(e)));
  const after = await Sandbox.get({ name: sb.name }).catch(() => null);
  console.log(`stopped after ${((Date.now() - t0) / 1000).toFixed(0)} s; status now: ${after?.status ?? "gone"}`);
}
// Nothing from the sandbox may carry a credential out. Checked here, without printing what it looks for.
for (const name of readdirSync(outDir, { recursive: true }).map(String)) {
  let text = "";
  try {
    text = readFileSync(path.join(outDir, name), "utf8");
  } catch {
    continue;
  }
  if (text.includes(key) || text.includes(ph)) console.log(`CREDENTIAL IN OUTPUT: ${name}`);
}

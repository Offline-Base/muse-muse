/**
 * Throwaway sandbox runner for the Oct 31 Muse Code in products spike. Runs phase-<name>.sh in one sandbox from the builder
 * snapshot, never saved, then copies /tmp/out back and stops the sandbox.
 *   docs/spikes/musecode-2026-10-31/creds.sh docs/spikes/musecode-2026-10-31/run.ts <out dir> <phase>[:<firewall>] ...
 * Firewalls:
 *   free    every api.meta.ai call answered 403 by the firewall. Nothing can cost money. The default.
 *   catalog as free, but the catalog routes get the real key when they carry the placeholder.
 *   proxy   every api.meta.ai route gets the real key only when it carries the placeholder, which only proxy.mjs holds, as root.
 *           Muse Code itself gets a different stand-in, so a call that skips the proxy is answered 403 with REFUSED.
 * The placeholder reaches the sandbox only in proxy.mjs's own environment. It is never printed or written out.
 * PROXY_BUDGET_USD (default 0) is what the proxy may spend in this run before it refuses everything.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

const REFUSED = "spike-firewall-refused-this-direct-call";
const say = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);
const t0 = Date.now();
const sb = await Sandbox.create({
  name: `musecode-spike-${Date.now().toString(36)}`,
  source: { type: "snapshot", snapshotId },
  persistent: false,
  resources: { vcpus: 2 },
  timeout: 30 * 60_000,
  networkPolicy: "deny-all",
  tags: { app: "musemuse", role: "spike" },
});
const createdS = (Date.now() - t0) / 1000;
console.log(`sandbox ${sb.name} in ${createdS.toFixed(1)} s`);
const ph = placeholderKey(key, sb.name);
const standIn = `spike_standin_${randomBytes(12).toString("hex")}`;
const carriesPlaceholder = [{ key: { regex: "(?i)^authorization$" }, value: { exact: `Bearer ${ph}` } }];
const brokered = (methods: string[], p: string) => ({
  match: { method: methods, path: { exact: p }, headers: carriesPlaceholder },
  transform: [{ headers: { Authorization: `Bearer ${key}` } }],
});
const refuse = { response: { statusCode: 403, body: REFUSED, contentType: "text/plain" } };
const CATALOG = [brokered(["GET", "POST"], "/muse-code/models"), brokered(["GET"], "/v1/models")];
const anyRoute = { match: { headers: carriesPlaceholder }, transform: [{ headers: { Authorization: `Bearer ${key}` } }] };
const policies: Record<string, NetworkPolicy> = {
  free: { allow: { "api.meta.ai": [refuse], "registry.npmjs.org": [] } } as unknown as NetworkPolicy,
  catalog: { allow: { "api.meta.ai": [...CATALOG, refuse], "registry.npmjs.org": [] } } as unknown as NetworkPolicy,
  proxy: { allow: { "api.meta.ai": [anyRoute, refuse], "registry.npmjs.org": [] } } as unknown as NetworkPolicy,
};
async function copyOut(): Promise<void> {
  const list = await sh(sb, "cd /tmp/out 2>/dev/null && sudo chmod -R a+rX . && find . -type f | sed 's|^./||'", { allowFail: true });
  for (const name of list.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const buf = await sb.readFileToBuffer({ path: `/tmp/out/${name}` }).catch(() => null);
    if (buf) {
      mkdirSync(path.dirname(path.join(outDir!, name)), { recursive: true });
      writeFileSync(path.join(outDir!, name), buf);
    }
  }
}
let timing: Record<string, number> = { createdS };
try {
  await sb.update({ networkPolicy: policies.free! });
  const scripts = readdirSync(dir).filter((f) => /\.(sh|mjs|txt)$/.test(f) && !f.startsWith("result-"));
  await sb.writeFiles([
    ...scripts.map((f) => ({ path: `/tmp/spike/${f}`, content: readFileSync(path.join(dir, f)) })),
    { path: "/tmp/spike/bridge.mjs", content: readFileSync(path.join(dir, "../../../lib/sandbox/bridge/bridge.mjs")) },
  ]);
  const inst = await sh(sb, `mkdir -p /tmp/out /tmp/sdk && cd /tmp/sdk && printf '{"private":true}' > package.json && npm install --no-audit --no-fund --loglevel=error --no-save @muse-code/sdk@${MUSE_SDK_VERSION} && node -p 'require("./node_modules/@muse-code/sdk/package.json").version' && cp /tmp/spike/*.mjs /tmp/sdk/`, { allowFail: true, timeoutMs: 90_000 });
  timing.sdkReadyS = (Date.now() - t0) / 1000;
  console.log(`sdk install exit ${inst.exitCode}, ready ${timing.sdkReadyS.toFixed(1)} s from create: ${inst.stdout.trim()} ${inst.stderr.slice(-300)}`);
  writeFileSync(path.join(outDir, "timing-create.json"), JSON.stringify({ ...timing, t0 }));

  // The only thing in the sandbox that ever holds the placeholder. Root, so the session's user can't read its environment.
  if (process.env.NO_PROXY_SPIKE !== "1") {
    const ca = (await sh(sb, 'printf %s "$NODE_EXTRA_CA_CERTS"', { allowFail: true })).stdout.trim();
    await sb.runCommand({
      cmd: "node",
      args: ["/tmp/spike/proxy.mjs"],
      sudo: true,
      detached: true,
      env: { SPIKE_UPSTREAM_KEY: ph, SPIKE_STANDIN_SHA: createHash("sha256").update(standIn).digest("hex"), PROXY_BUDGET_USD: process.env.PROXY_BUDGET_USD ?? "0", ...(ca ? { NODE_EXTRA_CA_CERTS: ca } : {}) },
    });
    const up = await sh(sb, "for i in $(seq 1 20); do curl -s -m 1 http://127.0.0.1:8787/__health && exit 0; sleep 0.25; done; exit 1", { allowFail: true });
    console.log(`proxy up: exit ${up.exitCode} ${up.stdout.slice(0, 200)}`);
  }
  for (const item of phases) {
    const [p, firewall = "free"] = item.split(":");
    await sb.update({ networkPolicy: policies[firewall]! });
    const t = Date.now();
    const r = await sh(sb, `bash /tmp/spike/phase-${p}.sh`, {
      env: {
        ...SANDBOX_ENV,
        SPIKE_STANDIN: standIn,
        SPIKE_KEY_SHA256: createHash("sha256").update(key).digest("hex"),
        SPIKE_PH_SHA256: createHash("sha256").update(ph).digest("hex"),
        SPIKE_T0_MS: String(t0),
        SPIKE_REFUSED: REFUSED,
        SPIKE_SANDBOX_NAME: sb.name,
      },
      allowFail: true,
      timeoutMs: 15 * 60_000,
    });
    const text = `--- phase ${p} firewall ${firewall}: exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(0)} s\n${r.stdout}\n[stderr]\n${r.stderr.slice(-4000)}\n`;
    writeFileSync(path.join(outDir, `phase-${p}.txt`), text);
    console.log(`phase ${p}: exit ${r.exitCode} in ${((Date.now() - t) / 1000).toFixed(0)} s, ${r.stdout.length} chars`);
  }
} catch (e) {
  console.log(`runner error: ${say(e)}`);
} finally {
  await copyOut().catch((e) => console.log(`copy out: ${say(e)}`));
  const stopAt = Date.now();
  await sb.stop({ blocking: true }).catch((e) => console.log(`stop: ${say(e)}`));
  console.log(`sandbox stop took ${((Date.now() - stopAt) / 1000).toFixed(1)} s`);
  const after = await Sandbox.get({ name: sb.name }).catch(() => null);
  console.log(`stopped after ${((Date.now() - t0) / 1000).toFixed(0)} s; status now: ${after?.status ?? "gone"}`);
}
// Nothing from the sandbox may carry a credential out. Checked here, without printing what it looks for.
let clean = true;
for (const name of readdirSync(outDir, { recursive: true }).map(String)) {
  let text = "";
  try {
    text = readFileSync(path.join(outDir, name), "utf8");
  } catch {
    continue;
  }
  if (text.includes(key) || text.includes(ph) || text.includes(standIn)) {
    clean = false;
    console.log(`CREDENTIAL IN OUTPUT: ${name}`);
  }
}
console.log(`credential scan of ${outDir}: ${clean ? "clean" : "FOUND, do not commit"}`);
appendFileSync(path.join(outDir, "runner.log"), `${new Date().toISOString()} ${phases.join(" ")} clean=${clean}\n`);

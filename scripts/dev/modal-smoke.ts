/**
 * Live smoke test of the Modal build host (lib/sandbox/host/modal.ts, docs/MODAL_HOST.md). No Muse Code and no Meta key:
 * it makes one small sandbox (1 vCPU, half a Modal core, 10 minutes at most), then checks the calls builder.ts makes:
 *   write a file, run a command, egress limited to one domain (api.meta.ai and a bare IP refused), a detached server on
 *   port 3000 fetched from here through the tunnel, a detached command's exit code, kill, stop with a filesystem
 *   snapshot, resume by name with the file and the egress still there, and delete.
 *
 *   npx tsx scripts/dev/modal-smoke.ts
 *
 * The SDK uses the local Modal login (or MODAL_TOKEN_ID and MODAL_TOKEN_SECRET). Nothing here reads or prints them.
 */
import { createModalHost, loadModalSdk } from "@/lib/sandbox/host/modal";
import type { HostSandbox } from "@/lib/sandbox/host/types";

const APP = process.env.MODAL_APP_NAME?.trim() || "musemuse-builds";
const name = `mm-smoke-${Date.now().toString(36)}`;
const started = Date.now();
const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const secs = () => ((Date.now() - started) / 1000).toFixed(1);

function check(step: string, ok: boolean, detail = ""): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${secs()}s ${step}${detail ? `: ${detail}` : ""}`);
}

async function sh(sb: HostSandbox, script: string) {
  const r = await sb.runCommand({ cmd: "bash", args: ["-c", script] });
  return { exitCode: r.exitCode, out: (await r.stdout()).trim(), err: (await r.stderr()).trim() };
}

const SERVER = `require("http").createServer((q,s)=>{s.setHeader("content-type","text/html");s.end(require("fs").readFileSync("/srv/index.html"))}).listen(3000,"0.0.0.0")`;

async function main() {
  const host = createModalHost(() => loadModalSdk(APP), { timeoutMs: 10 * 60_000, imageTtlMs: 24 * 60 * 60_000 });
  let sb: HostSandbox | null = null;
  try {
    sb = await host.getOrCreate({
      name,
      resources: { vcpus: 1 },
      ports: [3000],
      timeout: 10 * 60_000,
      tags: { app: "musemuse", role: "smoke" },
      // The Vercel shape builder.ts passes. The api.meta.ai rule holds a made-up key, which must never reach Modal.
      networkPolicy: { allow: { "example.com": [], "api.meta.ai": [{ transform: [{ headers: { Authorization: "Bearer not-a-real-key" } }] }] } },
    });
    check("create", sb.status === "running", `${sb.name}, tags ${JSON.stringify(sb.tags)}`);

    await sb.writeFiles([{ path: "/srv/index.html", content: `<h1>muse muse modal smoke ${name}</h1>` }]);
    const back = await sb.readFileToBuffer({ path: "/srv/index.html" });
    check("write and read a file", Boolean(back?.toString().includes(name)));
    check("missing file reads as null", (await sb.readFileToBuffer({ path: "/srv/nope.txt" })) === null);

    const uname = await sh(sb, "uname -sm && node --version && id -un");
    check("run a command", uname.exitCode === 0, uname.out.replace(/\n/g, " | "));

    const allowed = await sh(sb, "curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://example.com/ || echo fail");
    check("egress: allowed domain answers", allowed.out.startsWith("2") || allowed.out.startsWith("3"), allowed.out);
    const meta = await sh(sb, "curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://api.meta.ai/v1/models || echo blocked");
    check("egress: api.meta.ai refused", !/^[1-5]\d\d$/.test(meta.out) || meta.out === "000", meta.out);
    const ip = await sh(sb, "curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://1.1.1.1/ || echo blocked");
    check("egress: a bare IP refused", !/^[1-5]\d\d$/.test(ip.out) || ip.out === "000", ip.out);

    const server = await sb.runCommand({ cmd: "node", args: ["-e", SERVER], detached: true });
    const running = await sb.getCommand(server.cmdId);
    check("detached command is running", running.exitCode === null, server.cmdId);
    const local = await sh(sb, "for i in $(seq 1 30); do curl -s --max-time 2 http://localhost:3000/ && exit 0; sleep 0.5; done; exit 1");
    check("server answers inside", local.out.includes(name));
    const url = await sb.domain(3000);
    let body = "";
    for (let i = 0; i < 20 && !body.includes(name); i++) {
      body = await fetch(url).then((r) => r.text()).catch(() => "");
      if (!body.includes(name)) await new Promise((r) => setTimeout(r, 1000));
    }
    check("port 3000 through the tunnel", body.includes(name), url.replace(/^(https:\/\/[^.]{0,6})[^.]*/, "$1..."));

    const short = await sb.runCommand({ cmd: "bash", args: ["-c", "sleep 1; exit 7"], detached: true });
    const done = await (await sb.getCommand(short.cmdId)).wait({ signal: AbortSignal.timeout(30_000) });
    check("detached command exit code", done.exitCode === 7, String(done.exitCode));

    await running.kill("SIGTERM");
    const killed = await running.wait({ signal: AbortSignal.timeout(30_000) });
    check("kill", killed.exitCode !== 0, String(killed.exitCode));

    await sb.stop();
    check("stop (snapshot, then end)", true);
    const resumed = await host.get({ name, resume: true });
    sb = resumed;
    const kept = await resumed.readFileToBuffer({ path: "/srv/index.html" });
    check("resume by name keeps the file", resumed.status === "running" && Boolean(kept?.toString().includes(name)));
    check("resume keeps tags", resumed.tags?.role === "smoke", JSON.stringify(resumed.tags));
    const meta2 = await sh(resumed, "curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://api.meta.ai/v1/models || echo blocked");
    check("resume keeps egress (api.meta.ai refused)", !/^[1-5]\d\d$/.test(meta2.out) || meta2.out === "000", meta2.out);
    const allowed2 = await sh(resumed, "curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://example.com/ || echo fail");
    check("resume keeps egress (allowed domain answers)", allowed2.out.startsWith("2") || allowed2.out.startsWith("3"), allowed2.out);
  } catch (err) {
    check("unexpected error", false, String(err).slice(0, 600));
    if (process.env.SMOKE_DEBUG) console.error((err as Error).stack);
  } finally {
    if (sb) await sb.delete().then(() => check("delete", true)).catch((err) => check("delete", false, String(err).slice(0, 300)));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed in ${secs()} s`);
  process.exit(failed.length ? 1 : 0);
}

void main();

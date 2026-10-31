#!/usr/bin/env node
// Runs one real job on this box with no platform: a small local stand-in hands the job to a temporary agent, in the box's
// GUI session, and keeps what comes back. It's for checking a box before the routes are live, or when they're down. It
// only listens on 127.0.0.1 and it spends nothing. See docs/NATIVE_LAB.md, "Checking a box by hand".
//
//   node tools/check.mjs --kind desktop_mac --app /path/to/app.zip --target https://muse-muse.vercel.app/ --out /path/to/dir
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../lib/main.mjs";
import { run, sleep } from "../lib/proc.mjs";
import { KINDS, LANE_OF, validateJob } from "../lib/validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, "..", "agent.mjs");
const CHECK_LABEL = "ai.musemuse.lab.check";
const CHECK_TASK = "MuseLabCheck";
const APP_KINDS = { ios_sim: "ios_sim_app", glasses_sim: "ios_sim_app", android_emu: "apk", desktop_mac: "mac_zip", desktop_windows: "windows_zip" };
const VARIANT_OF = { glasses_sim: "glasses" };
const ID_OF = { ios_sim: "ai.musemuse.lab", android_emu: "ai.musemuse.lab", glasses_sim: "app.musemuse.glasses" };

/** One job, the way the platform would send it. The stand-in serves its files at /files/<name>. */
export function buildJob({ kind, origin, sha256, bytes, target, name = "Muse Muse", version = "1.0.0", limitSeconds = 420, selftestSeconds = 12, recordSeconds = 15, exeName = null }) {
  const app = { kind: APP_KINDS[kind], variant: VARIANT_OF[kind] ?? "lab", version, url: `${origin}/files/app`, sha256, bytes };
  if (kind === "ios_sim" || kind === "glasses_sim") app.bundleId = ID_OF[kind];
  if (kind === "android_emu") app.packageName = ID_OF[kind];
  if (exeName) app.exeName = exeName;
  const input = { v: 1, limitSeconds, target: { url: target }, product: { name, slug: "lab-check" }, recordSeconds, shots: 2, app };
  if (kind === "desktop_mac" || kind === "desktop_windows") input.selftestSeconds = selftestSeconds;
  if (kind === "ios_sim" || kind === "android_emu") input.selftest = { token: `check-${randomBytes(12).toString("hex")}`, platformUrl: origin };
  if (kind === "glasses_sim") input.media = { photo: { url: `${origin}/files/photo` } };
  return { id: `check_${randomBytes(6).toString("hex")}`, kind, token: `job-${randomBytes(16).toString("hex")}`, attempt: 1, runId: "lab_check", input };
}

function originOf(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * The stand-in: serves files, hands out one job once, and keeps what the agent reports.
 *
 * @param {object} opts
 * @param {(origin: string) => object} opts.makeJob called once the server has its port
 * @param {Record<string, string>} opts.files name to local path
 * @param {string} opts.outDir where uploads land
 * @param {(finish: object) => void} opts.onFinish
 */
export function createStandIn({ makeJob, files, outDir, onFinish }) {
  const reports = [];
  const beats = [];
  let job = null;
  let handed = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://stand-in");
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const file = files[url.pathname.slice("/files/".length)];
      if (!file) return send(404, {});
      return createReadStream(file).on("error", () => res.destroy()).pipe(res);
    }
    if (req.method === "PUT" && url.pathname.startsWith("/put/")) {
      const name = path.basename(url.pathname);
      req.pipe(createWriteStream(path.join(outDir, name))).on("finish", () => send(200, { url: `${originOf(server)}/put/${name}`, pathname: name }));
      return undefined;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (url.pathname === "/api/native/agent/claim") {
        job ??= makeJob(originOf(server));
        if (handed || !body.kinds?.includes(job.kind)) return send(204);
        handed = true;
        return send(200, { job });
      }
      if (url.pathname === "/api/native/selftest") {
        reports.push(body);
        return send(200, { ok: true });
      }
      const match = /^\/api\/native\/agent\/jobs\/[^/]+\/(heartbeat|upload|selftest|finish)$/.exec(url.pathname);
      if (!match) return send(404, {});
      if (match[1] === "heartbeat") {
        beats.push(body.phase);
        return send(200, { cancel: false });
      }
      if (match[1] === "selftest") return send(200, { report: reports.at(-1) ?? null });
      if (match[1] === "upload") {
        const origin = originOf(server);
        return send(200, { uploads: body.files.map((file) => ({ name: file.name, method: "put", pathname: file.name, url: `${origin}/put/${file.name}` })) });
      }
      send(200, { ok: true });
      return onFinish({ ...body, phases: [...new Set(beats)] });
    });
    return undefined;
  });
  return server;
}

/** The temporary agent's settings: its own root, no idle stop, and only this job's kind. */
export function agentEnv({ kind, origin, root, tokenFile }) {
  return {
    MUSE_LAB_LANE: LANE_OF[kind],
    MUSE_LAB_ROOT: root,
    MUSE_LAB_PLATFORM: origin,
    MUSE_LAB_ALLOW_INSECURE: "1",
    MUSE_LAB_TOKEN_FILE: tokenFile,
    MUSE_LAB_KINDS: kind,
    MUSE_LAB_IDLE_MINUTES: "0",
  };
}

const xmlEscape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A LaunchAgent for the temporary agent, which is what puts it in the GUI session. It takes the real one's PATH. */
export function checkPlist({ node, env, root }) {
  const sdk = "/opt/homebrew/share/android-commandlinetools";
  const all = {
    PATH: `/opt/homebrew/opt/node@22/bin:/opt/homebrew/opt/openjdk@17/bin:/opt/homebrew/bin:${sdk}/platform-tools:${sdk}/emulator:${sdk}/cmdline-tools/latest/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    JAVA_HOME: "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    ...env,
  };
  const entries = Object.entries(all).map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${CHECK_LABEL}</string>
<key>ProgramArguments</key><array><string>${xmlEscape(node)}</string><string>${xmlEscape(AGENT)}</string></array>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>WorkingDirectory</key><string>${xmlEscape(root)}</string>
<key>StandardOutPath</key><string>${xmlEscape(path.join(root, "agent.log"))}</string>
<key>StandardErrorPath</key><string>${xmlEscape(path.join(root, "agent.log"))}</string>
<key>EnvironmentVariables</key><dict>${entries.join("")}</dict>
</dict></plist>
`;
}

/** Starts the temporary agent in ec2-user's GUI session. Returns how to stop it. */
async function startInMacSession({ env, root }) {
  const domain = `gui/${process.getuid()}`;
  const plist = path.join(root, `${CHECK_LABEL}.plist`);
  await writeFile(plist, checkPlist({ node: process.execPath, env, root }));
  await run(["launchctl", "bootout", `${domain}/${CHECK_LABEL}`], { timeoutMs: 20_000 });
  const started = await run(["launchctl", "bootstrap", domain, plist], { timeoutMs: 20_000 });
  if (started.code !== 0) throw new Error(`launchctl bootstrap exited with ${started.code}: ${started.stderr}`);
  return async () => {
    await run(["launchctl", "bootout", `${domain}/${CHECK_LABEL}`], { timeoutMs: 30_000 });
  };
}

/** PowerShell that registers and starts the temporary agent as a task in the lab user's signed-in session. */
export function windowsTaskScript({ cmdFile, user = "musemuse" }) {
  return [
    `$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "${cmdFile}"'`,
    `$principal = New-ScheduledTaskPrincipal -UserId '${user}' -LogonType Interactive -RunLevel Limited`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `Register-ScheduledTask -TaskName '${CHECK_TASK}' -Action $action -Principal $principal -Settings $settings -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${CHECK_TASK}'`,
  ].join("; ");
}

/** The temporary agent runs as the lab user, who can only change C:\\MuseLab\\data and logs, so it needs its own root opened up. */
export function windowsRootGrant(root, user = "musemuse") {
  return ["icacls", root, "/grant", `${user}:(OI)(CI)M`, "/T", "/Q"];
}

/** Starts the temporary agent as the lab user in session 1, the way the real logon task does. */
async function startInWindowsSession({ env, root }) {
  const granted = await run(windowsRootGrant(root), { timeoutMs: 30_000 });
  if (granted.code !== 0) throw new Error(`icacls exited with ${granted.code}: ${granted.stderr}`);
  const log = path.join(root, "agent.log");
  const lines = ["@echo off", ...Object.entries(env).map(([key, value]) => `set "${key}=${value}"`)];
  lines.push('set "PATH=C:\\Program Files\\nodejs;C:\\Program Files\\Amazon\\AWSCLIV2;%PATH%"');
  lines.push(`"${process.execPath}" "${AGENT}" >> "${log}" 2>&1`);
  const cmdFile = path.join(root, "run-agent.cmd");
  await writeFile(cmdFile, `${lines.join("\r\n")}\r\n`);
  const started = await run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsTaskScript({ cmdFile })], { timeoutMs: 60_000 });
  if (started.code !== 0) throw new Error(`The task didn't start: ${started.stderr}`);
  return async () => {
    const pid = (await readFile(path.join(root, "data", "agent.pid"), "utf8").catch(() => "")).trim();
    if (/^[0-9]+$/.test(pid)) await run(["taskkill", "/F", "/T", "/FI", `PID eq ${pid}`, "/FI", "IMAGENAME eq node.exe"], { timeoutMs: 30_000 });
    await run(["powershell.exe", "-NoProfile", "-Command", `Stop-ScheduledTask -TaskName '${CHECK_TASK}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${CHECK_TASK}' -Confirm:$false`], { timeoutMs: 60_000 });
  };
}

/** Starts it as a child of this process, for a run on a machine where this already is the GUI session. */
async function startHere({ env, root }) {
  const log = createWriteStream(path.join(root, "agent.log"));
  const child = spawn(process.execPath, [AGENT], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return async () => {
    child.kill("SIGTERM");
  };
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      kind: { type: "string" },
      app: { type: "string" },
      target: { type: "string", default: "https://muse-muse.vercel.app/" },
      out: { type: "string" },
      name: { type: "string", default: "Muse Muse" },
      photo: { type: "string" },
      limit: { type: "string", default: "420" },
      here: { type: "boolean", default: false },
    },
  });
  if (!KINDS.includes(values.kind) || !values.app || !values.out) {
    process.stderr.write("usage: check.mjs --kind <kind> --app <file> --out <dir> [--target <https url>] [--photo <jpg>] [--limit <seconds>] [--here]\n");
    process.exit(2);
  }
  const outDir = path.resolve(values.out);
  const root = path.join(outDir, "root");
  await mkdir(path.join(root, "data"), { recursive: true });
  const limitSeconds = Number(values.limit);
  const files = { app: path.resolve(values.app), ...(values.photo ? { photo: path.resolve(values.photo) } : {}) };
  const [sha256, info] = await Promise.all([sha256Of(files.app), stat(files.app)]);

  let finish;
  const finished = new Promise((resolve) => (finish = resolve));
  const makeJob = (origin) => {
    const job = buildJob({ kind: values.kind, origin, sha256, bytes: info.size, target: values.target, name: values.name, limitSeconds });
    const valid = validateJob(job, { lane: LANE_OF[values.kind], platformOrigin: origin, allowInsecure: true });
    if (!valid.ok) throw new Error(`The job isn't valid: ${valid.error}`);
    return job;
  };
  const server = createStandIn({ makeJob, files, outDir, onFinish: finish });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = originOf(server);
  makeJob(origin);

  const tokenFile = path.join(root, "lab-token");
  await writeFile(tokenFile, randomBytes(24).toString("hex"));
  const env = agentEnv({ kind: values.kind, origin, root, tokenFile });
  const starter = values.here ? startHere : process.platform === "win32" ? startInWindowsSession : startInMacSession;
  const stopAgent = await starter({ env, root });

  const startedAt = Date.now();
  const result = await Promise.race([finished, sleep((limitSeconds + 120) * 1000).then(() => null)]);
  await stopAgent().catch(() => {});
  server.close();
  server.closeAllConnections?.();
  await copyFile(path.join(root, "agent.log"), path.join(outDir, "agent.log")).catch(() => {});
  await writeFile(path.join(outDir, "finish.json"), JSON.stringify(result, null, 2));
  await rm(tokenFile, { force: true }).catch(() => {});
  process.stdout.write(`${JSON.stringify({
    kind: values.kind,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    outcome: result?.outcome ?? "no_finish",
    summary: result?.summary ?? null,
    reasons: result?.reasons ?? [],
    warnings: result?.warnings ?? [],
    error: result?.error ?? null,
    device: result?.device ?? null,
    captionBurned: result?.captionBurned ?? null,
    checks: result?.checks ?? [],
    phases: result?.phases ?? [],
    artifacts: (result?.artifacts ?? []).map((a) => ({ name: a.name, bytes: a.bytes })),
    out: outDir,
  })}\n`);
  process.exit(result?.outcome === "passed" ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  });
}

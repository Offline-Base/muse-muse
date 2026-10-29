/**
 * The kit on an Android phone that adb reaches from this Mac (docs/DEVICES.md "How to run > QDC", "Over adb"): a QDC
 * interactive session in "SSH only" mode, through the SSH tunnel QDC gives (`ssh -i <key> -L <port>:sa<session
 * id>.sa.svc.cluster.local:5037 -N sshtunnel@ssh.qdc.qualcomm.com`), or a phone on USB. This works while QDC's API keys
 * are off for the owner's account. Pure logic and parsing: scripts/devices/adb.ts runs ssh and adb.
 *
 * Rules from the first live session (Oct 28, 2026):
 * - Local port 5037 is never used: the owner's own adb server lives there. The default is 5038.
 * - An adb client whose protocol version differs from its server's kills that server and starts its own [V, AOSP
 *   adb client/adb_client.cpp], and on QDC the server is the session's. So before every adb command the runner asks the
 *   server for its version with a raw "host:version" request and refuses on a mismatch.
 * - adb gets ADB_SERVER_SOCKET=tcp:127.0.0.1:<port> (and ANDROID_ADB_SERVER_PORT, which that one overrides). adb counts
 *   only an empty host or "localhost" as local [V, AOSP adb socket_spec.cpp tcp_host_is_local], so when the tunnel is
 *   down it says "cannot start server on remote host" instead of starting a server that would claim this Mac's USB
 *   phones. The phone's serial, read once, goes with every command and is never printed or written.
 * - A session can end at any minute, so the runner pulls the kit's folder after every step, not at the end.
 */
import { PHONE_RAM_TIERS_GIB, GIB, SMOKE, STAND_INS, marketedRamGiB, pickSubjects, runNeedBytes, type PickWhy } from "@/lib/devices/subjects";
import { BACKENDS, KIT_DEFAULTS, KIT_SMOKE, type Backend, type KitSettings, type Subject } from "@/lib/devices/types";

// ---------------------------------------------------------------------------------------------------------------
// The adb server and the tunnel

/** The owner's own adb server's port, which this never uses. */
export const ADB_OWNER_PORT = 5037;
export const ADB_DEFAULT_PORT = 5038;
/** The session's adb server listens on 5037 inside QDC's cluster. */
export const QDC_SESSION_ADB_PORT = 5037;
export const QDC_SSH_HOST = "ssh.qdc.qualcomm.com";
export const QDC_SSH_USER = "sshtunnel";

/** A local port the runner may use: 1024 to 65535, never 5037. Throws otherwise. */
export function checkLocalPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`The local adb port must be 1024 to 65535, not ${port}.`);
  if (port === ADB_OWNER_PORT) {
    throw new Error(`Port ${ADB_OWNER_PORT} is the owner's own adb server: use another one (${ADB_DEFAULT_PORT} is the default).`);
  }
  return port;
}

/** The session's adb host inside QDC's cluster: "sa<session id>.sa.svc.cluster.local". */
export function sessionHost(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/.test(sessionId)) throw new Error(`Not a QDC session id: ${sessionId}`);
  return `sa${sessionId.toLowerCase()}.sa.svc.cluster.local`;
}

/** What the tunnel command QDC shows for a session says. */
export interface TunnelSpec {
  sessionId: string;
  /** The local port in the pasted command (the runner may still use another one). */
  localPort: number | null;
  remotePort: number;
  /** The -i key path, when the command has one. */
  key: string | null;
}

/** Reads a pasted tunnel command: `ssh -i <key> -L <port>:sa<id>.sa.svc.cluster.local:5037 -N sshtunnel@ssh.qdc.qualcomm.com`. */
export function parseTunnelCommand(text: string): TunnelSpec {
  const forward = /-L\s*(?:(?:\[[^\]]+\]|[A-Za-z0-9.-]+):)?(\d{1,5}):sa([A-Za-z0-9-]+)\.sa\.svc\.cluster\.local:(\d{1,5})/.exec(text);
  if (!forward) throw new Error("That isn't QDC's tunnel command: it needs -L <port>:sa<session id>.sa.svc.cluster.local:5037.");
  if (!text.includes(`@${QDC_SSH_HOST}`)) throw new Error(`The tunnel command doesn't go to ${QDC_SSH_HOST}.`);
  const key = /(?:^|\s)-i\s*(\S+)/.exec(text);
  return {
    sessionId: forward[2],
    localPort: Number(forward[1]),
    remotePort: Number(forward[3]),
    key: key ? key[1].replace(/^['"]|['"]$/g, "") : null,
  };
}

/**
 * ssh's arguments for the tunnel: the session's adb server on 127.0.0.1:<port>, with a known_hosts file of the
 * runner's own (never ~/.ssh/known_hosts), no prompts, and an exit when the forward can't be set up.
 */
export function tunnelArgs(spec: { key: string; port: number; sessionId: string; knownHosts: string; remotePort?: number }): string[] {
  checkLocalPort(spec.port);
  return [
    "-i",
    spec.key,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    `UserKnownHostsFile=${spec.knownHosts}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    "-N",
    "-L",
    `127.0.0.1:${spec.port}:${sessionHost(spec.sessionId)}:${spec.remotePort ?? QDC_SESSION_ADB_PORT}`,
    `${QDC_SSH_USER}@${QDC_SSH_HOST}`,
  ];
}

/** An adb host request: the service's length in 4 hex digits, then the service. */
export function hostRequest(service: string): Buffer {
  if (service.length > 0xffff) throw new Error("An adb request that long can't be framed.");
  return Buffer.from(`${service.length.toString(16).padStart(4, "0")}${service}`, "latin1");
}

export type VersionReply =
  | { kind: "ok"; version: number }
  | { kind: "fail"; message: string }
  /** Not all of the reply is here yet. */
  | { kind: "short" }
  | { kind: "bad"; text: string };

/** The server's answer to host:version: "OKAY", a 4-hex-digit length, then the version in 4 hex digits ("OKAY00040029" is 41). */
export function parseVersionReply(reply: Buffer): VersionReply {
  const text = reply.toString("latin1");
  if (text.length < 4) return { kind: "short" };
  const status = text.slice(0, 4);
  if (status !== "OKAY" && status !== "FAIL") return { kind: "bad", text: text.slice(0, 40) };
  if (text.length < 8) return { kind: "short" };
  const length = Number.parseInt(text.slice(4, 8), 16);
  if (!Number.isInteger(length) || !/^[0-9a-fA-F]{4}$/.test(text.slice(4, 8))) return { kind: "bad", text: text.slice(0, 40) };
  if (text.length < 8 + length) return { kind: "short" };
  const payload = text.slice(8, 8 + length);
  if (status === "FAIL") return { kind: "fail", message: payload };
  if (!/^[0-9a-fA-F]{4}$/.test(payload)) return { kind: "bad", text: payload.slice(0, 40) };
  return { kind: "ok", version: Number.parseInt(payload, 16) };
}

/** This Mac's adb protocol version from `adb version` ("Android Debug Bridge version 1.0.41" is 41), or null. */
export function parseClientVersion(text: string): number | null {
  const m = /Android Debug Bridge version \d+\.\d+\.(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

/** Why the runner won't talk to a server, or null when it may. */
export function versionProblem(client: number | null, server: VersionReply, port: number): string | null {
  if (client === null) return "This Mac's adb didn't say its version (adb version), so the runner won't risk the server.";
  if (server.kind === "fail") return `The adb server on port ${port} refused host:version (${server.message}).`;
  if (server.kind === "bad" && /ECONNREFUSED|closed|no answer|ECONNRESET/.test(server.text)) {
    return `No adb server answers on 127.0.0.1:${port}: open the session's tunnel there (or pass --session and --key).`;
  }
  if (server.kind !== "ok") return `Whatever listens on port ${port} isn't an adb server.`;
  if (server.version !== client) {
    return (
      `The adb server on port ${port} speaks protocol ${server.version} and this Mac's adb speaks ${client}: any adb command ` +
      `would kill that server (on QDC, the session's). Use an adb whose "adb version" ends in 1.0.${server.version} (--adb <path>).`
    );
  }
  return null;
}

/** The environment every adb command gets: the session's server only, never a server adb would start itself. */
export function adbEnv(port: number, base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  checkLocalPort(port);
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "USER"]) if (base[name] !== undefined) env[name] = base[name] as string;
  env.ADB_SERVER_SOCKET = `tcp:127.0.0.1:${port}`;
  env.ANDROID_ADB_SERVER_PORT = String(port);
  return env;
}

export interface AdbDevice {
  serial: string;
  /** "device" when usable; "unauthorized", "offline", "no permissions", ... otherwise. */
  state: string;
}

/** `adb devices` output. */
export function parseDevices(text: string): AdbDevice[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l && !l.startsWith("List of devices") && !l.startsWith("*") && !l.startsWith("adb "))
    .map((l) => {
      const m = /^(\S+)\s+(.+)$/.exec(l);
      return m ? { serial: m[1], state: m[2].trim() } : null;
    })
    .filter((d): d is AdbDevice => d !== null);
}

/** The one usable phone's serial, or why there isn't one. The serial is never part of the message. */
export function pickDevice(devices: readonly AdbDevice[], wanted?: string): { serial: string } | { problem: string } {
  const usable = devices.filter((d) => d.state === "device");
  if (wanted) {
    const d = devices.find((x) => x.serial === wanted);
    if (!d) return { problem: "The phone given with --serial isn't on this adb server." };
    return d.state === "device" ? { serial: d.serial } : { problem: `The phone given with --serial is ${d.state}.` };
  }
  if (usable.length === 1) return { serial: usable[0].serial };
  if (usable.length > 1) return { problem: `${usable.length} phones are on this adb server: name one with --serial.` };
  const states = devices.map((d) => d.state);
  if (states.length === 0) return { problem: "No phone is on this adb server (is the session still open?)." };
  return { problem: `The phone isn't ready: it is ${states.join(", ")} (an unauthorized phone needs its USB debugging prompt accepted).` };
}

// ---------------------------------------------------------------------------------------------------------------
// The phone

/** Where the kit's files go on the phone, as on both clouds (docs/DEVICES.md "Interfaces between the parts"). */
export const ADB_DEVICE_ROOT = "/data/local/tmp/mm";
const MARK = "@@mm@@";

/** getprop's "[name]: [value]" lines. */
export function parseGetprop(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]\s*$/.exec(line.replace(/\r$/, ""));
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** MemTotal and MemAvailable from /proc/meminfo, in kB. */
export function parseMeminfo(text: string): { memTotalKb: number | null; memAvailableKb: number | null } {
  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  return { memTotalKb: kb("MemTotal"), memAvailableKb: kb("MemAvailable") };
}

/** The available kB on the last line of `df -kP <dir>`. */
export function parseDfAvailableKb(text: string): number | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  const m = last ? /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+\S/.exec(last) : null;
  return m ? Number(m[3]) : null;
}

/** What the runner reads from the phone before it plans. No serial, IMEI or other id. */
export interface PhoneFacts {
  manufacturer: string;
  model: string;
  android: string;
  sdk: number | null;
  socManufacturer: string;
  socModel: string;
  abi: string;
  memTotalKb: number | null;
  memAvailableKb: number | null;
  /** Free kB where the kit's folder goes. */
  freeKb: number | null;
  hasCurl: boolean;
  hasSha256: boolean;
}

/** One shell line that prints everything PhoneFacts needs, in sections. */
export function factsCommand(root: string = ADB_DEVICE_ROOT): string {
  const parent = root.replace(/\/[^/]+\/?$/, "") || "/";
  return (
    `getprop; echo ${MARK}; cat /proc/meminfo; echo ${MARK}; df -kP ${parent}; echo ${MARK}; ` +
    "if command -v curl >/dev/null 2>&1; then echo curl; else echo no-curl; fi; " +
    "if command -v sha256sum >/dev/null 2>&1; then echo sha256sum; " +
    "elif toybox sha256sum /dev/null >/dev/null 2>&1; then echo toybox-sha256; else echo no-sha256; fi"
  );
}

export function parseFacts(text: string): PhoneFacts {
  const [props = "", meminfo = "", df = "", tools = ""] = text.replace(/\r\n/g, "\n").split(`${MARK}\n`);
  const p = parseGetprop(props);
  const mem = parseMeminfo(meminfo);
  const sdk = Number(p["ro.build.version.sdk"]);
  return {
    manufacturer: p["ro.product.manufacturer"] ?? "",
    model: p["ro.product.model"] ?? "",
    android: p["ro.build.version.release"] ?? "",
    sdk: Number.isInteger(sdk) && sdk > 0 ? sdk : null,
    socManufacturer: p["ro.soc.manufacturer"] ?? "",
    socModel: p["ro.soc.model"] ?? p["ro.board.platform"] ?? "",
    abi: p["ro.product.cpu.abi"] ?? "",
    ...mem,
    freeKb: parseDfAvailableKb(df),
    hasCurl: /^curl$/m.test(tools),
    hasSha256: /^(sha256sum|toybox-sha256)$/m.test(tools),
  };
}

/** One line about the phone for the terminal. */
export function factsLine(f: PhoneFacts): string {
  const ram = f.memTotalKb ? `${marketedRamGiB(f.memTotalKb * 1024)} GB RAM (MemTotal ${f.memTotalKb} kB, ${f.memAvailableKb ?? "?"} kB available)` : "RAM unknown";
  const disk = f.freeKb !== null ? `${(f.freeKb / 1024 / 1024).toFixed(1)} GiB free` : "free disk unknown";
  return (
    `${[f.manufacturer, f.model].filter(Boolean).join(" ") || "A phone"}, Android ${f.android || "?"} (SDK ${f.sdk ?? "?"}), ` +
    `${f.socModel || "SoC unknown"}${f.socManufacturer ? ` (${f.socManufacturer})` : ""}, ${ram}, ${disk}, ` +
    `curl ${f.hasCurl ? "yes" : "no"}, sha256 ${f.hasSha256 ? "yes" : "no"}`
  );
}

/** True for a Snapdragon phone the Snapdragon build can try its GPU and NPU on (the kit still checks both). */
export function snapdragonPhone(f: Pick<PhoneFacts, "socManufacturer" | "socModel" | "sdk">): boolean {
  return (f.socManufacturer.toUpperCase() === "QTI" || /^SM\d{4}/.test(f.socModel)) && (f.sdk ?? 0) >= 34;
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

/** "smoke": the path check that comes first. "named": asked for by id. The rest are pickSubjects' reasons. */
export type AdbRunWhy = PickWhy | "smoke" | "named";

export interface AdbRun {
  subject: Subject;
  why: AdbRunWhy;
  settings: KitSettings;
  backends: Backend[];
}

/** "smoke", "pick" (pickSubjects for the phone's RAM) or subjects by id, in order. */
export type AdbRequest = "smoke" | "pick" | Subject;

/**
 * The runs for a phone, in order: each request expanded ("pick" by the phone's MemTotal; unknown RAM picks nothing),
 * every subject once, smoke runs with KIT_SMOKE's limits. Backends: cpu, plus gpu and npu on a Snapdragon phone with
 * Android 14 or later (`backends` overrides).
 */
export function planAdbRuns(input: {
  requests: readonly AdbRequest[];
  ramKb: number | null;
  pool?: readonly Subject[];
  backends?: readonly Backend[];
  facts?: Pick<PhoneFacts, "socManufacturer" | "socModel" | "sdk">;
}): AdbRun[] {
  const backends: Backend[] = input.backends
    ? [...input.backends]
    : input.facts && !snapdragonPhone(input.facts)
      ? ["cpu"]
      : [...BACKENDS];
  if (backends.length === 0) throw new Error("A run needs at least one backend.");
  const runs: AdbRun[] = [];
  const add = (subject: Subject, why: AdbRunWhy) => {
    if (runs.some((r) => r.subject.id === subject.id)) return;
    runs.push({ subject, why, settings: subject.kind === "smoke" ? KIT_SMOKE : KIT_DEFAULTS, backends });
  };
  for (const r of input.requests) {
    if (r === "smoke") add(SMOKE, "smoke");
    else if (r === "pick") {
      if (input.ramKb === null) continue;
      for (const p of pickSubjects({ os: "android", ramBytes: input.ramKb * 1024 }, input.pool ?? STAND_INS)) add(p.subject, p.why);
    } else add(r, r.kind === "smoke" ? "smoke" : "named");
  }
  return runs;
}

/** What one run costs in time, from tonight's SM8850 session [V]: Hub downloads at 11 to 24 MB/s, 13.96 GB checked in 5 s. */
export const ADB_ESTIMATE = {
  setupMinutes: 2,
  fetchMBps: 15,
  checkMBps: 2500,
  backendMinutes: 8,
  smokeBackendMinutes: 1,
} as const;

export function adbExpectedMinutes(run: AdbRun): number {
  const mb = run.subject.bytes / 1e6;
  const per = run.subject.kind === "smoke" ? ADB_ESTIMATE.smokeBackendMinutes : ADB_ESTIMATE.backendMinutes;
  return Math.ceil(ADB_ESTIMATE.setupMinutes + mb / ADB_ESTIMATE.fetchMBps / 60 + mb / ADB_ESTIMATE.checkMBps / 60 + run.backends.length * per);
}

/** The longest a run may take before the runner stops the kit: its download, check and total limits plus 5 minutes. */
export function adbRunLimitSeconds(settings: KitSettings): number {
  return settings.limitFetch + settings.limitCheck + settings.limitTotal + 300;
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** The plan as plain lines. Without the phone's RAM, the picks for each phone tier. */
export function adbPlanText(runs: readonly AdbRun[], options: { ramKb: number | null; requests: readonly AdbRequest[] }): string {
  const lines: string[] = [];
  runs.forEach((r, i) => {
    lines.push(
      `  ${i + 1}. ${r.subject.id} (${gb(r.subject.bytes)}, ${r.why}) on ${r.backends.join(", ")}: the phone downloads it from the Hub and checks ` +
        `its sha256; about ${adbExpectedMinutes(r)} min, stopped after ${Math.round(adbRunLimitSeconds(r.settings) / 60)} min.`,
    );
  });
  if (options.ramKb === null && options.requests.includes("pick")) {
    lines.push("  Then the files for the phone's RAM, read when the run starts:");
    for (const tier of PHONE_RAM_TIERS_GIB) {
      const picks = pickSubjects({ os: "android", ramBytes: tier * GIB });
      const words = picks.length ? picks.map((p) => `${p.subject.id} (${p.why}, needs ${gb(runNeedBytes(p.subject))})`).join(", then ") : "nothing";
      lines.push(`    ${tier} GB: ${words}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands on the phone

const SAFE_ROOT = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

function checkRoot(root: string): string {
  if (!SAFE_ROOT.test(root) || root.split("/").includes("..") || root.endsWith("/")) throw new Error(`Not a safe folder on the phone: ${root}`);
  return root;
}

function checkId(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`Not a subject id: ${id}`);
  return id;
}

/** The tools that must be executable, relative to the root. */
export const ADB_TOOLS: readonly string[] = [
  "llama-android/llama-bench",
  "llama-android/llama-completion",
  "llama-snapdragon/bin/llama-bench",
  "llama-snapdragon/bin/llama-completion",
  "kit/run.sh",
];

/** Clears the kit, builds and plan of an earlier run (a model already downloaded stays) and makes the folders. */
export function stageCommand(root: string = ADB_DEVICE_ROOT): string {
  checkRoot(root);
  return `rm -rf ${root}/kit ${root}/llama-android ${root}/llama-snapdragon ${root}/plan; mkdir -p ${root}/model ${root}/out ${root}/plan`;
}

export function chmodCommand(root: string = ADB_DEVICE_ROOT): string {
  checkRoot(root);
  return `chmod 755 ${ADB_TOOLS.map((t) => `${root}/${t}`).join(" ")}`;
}

/**
 * Starts the kit for one subject in the background of an adb shell that stays open while it runs. HUP is ignored from
 * the start, so a dropped session leaves the kit running; its exit code goes to run-<id>.exit and its own output to
 * run-<id>.stdout. The kit's output folder must not exist, so an earlier one goes first.
 */
export function startCommand(id: string, root: string = ADB_DEVICE_ROOT): string {
  checkRoot(root);
  checkId(id);
  const base = `${root}/run-${id}`;
  return (
    `cd ${root} && rm -rf out/${id} ${base}.exit ${base}.pid ${base}.stdout && ` +
    `(trap '' HUP; set -a; . ./plan/${id}.env; set +a; ` +
    `sh kit/run.sh </dev/null >${base}.stdout 2>&1 & echo $! >${base}.pid; wait $!; echo $? >${base}.exit)`
  );
}

/** One poll: the exit code (once there is one), run.txt, steps.txt and the kit's output so far, between marks. */
export function pollCommand(id: string, root: string = ADB_DEVICE_ROOT): string {
  checkRoot(root);
  checkId(id);
  const base = `${root}/run-${id}`;
  return (
    `cat ${base}.exit 2>/dev/null; echo ${MARK}; cat ${root}/out/${id}/run.txt 2>/dev/null; echo ${MARK}; ` +
    `cat ${root}/out/${id}/steps.txt 2>/dev/null; echo ${MARK}; cat ${base}.stdout 2>/dev/null; echo ${MARK}`
  );
}

export interface PollState {
  /** The kit's exit code, once it has ended. */
  exit: number | null;
  run: Record<string, string>;
  /** steps.txt's lines: one per ended step. */
  steps: string[];
  stdout: string[];
  /** run.txt has finished=: the kit wrote its end. */
  finished: boolean;
}

/** A poll's output, or null when adb didn't get through (no closing mark). */
export function parsePoll(text: string): PollState | null {
  const parts = text.replace(/\r\n/g, "\n").split(`${MARK}\n`);
  if (parts.length < 5) return null;
  const [exitText, runText, stepsText, stdoutText] = parts;
  const run: Record<string, string> = {};
  for (const line of runText.split("\n")) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line);
    if (m) run[m[1]] = m[2];
  }
  const code = exitText.trim();
  return {
    exit: /^\d+$/.test(code) ? Number(code) : null,
    run,
    steps: stepsText.split("\n").filter((l) => l.startsWith("name=")),
    stdout: stdoutText.split("\n").filter((l) => l !== ""),
    finished: run.finished !== undefined && run.finished !== "",
  };
}

/** True once the kit is over: an exit code, or run.txt's finished= (when the shell that waited for it is gone). */
export function kitEnded(state: PollState): boolean {
  return state.exit !== null || state.finished;
}

/** Seconds between pulls while one step runs long, so a session that ends mid-step still leaves its memory samples. */
export const PULL_EVERY_SECONDS = 120;

/** Pull the kit's folder now? On its first appearance, after every step that ended, at the end, and every PULL_EVERY_SECONDS. */
export function shouldPull(previous: PollState | null, now: PollState, secondsSinceLastPull: number): boolean {
  if (Object.keys(now.run).length === 0) return false;
  if (!previous || Object.keys(previous.run).length === 0) return true;
  if (now.steps.length !== previous.steps.length || now.finished !== previous.finished || kitEnded(now)) return true;
  return secondsSinceLastPull >= PULL_EVERY_SECONDS;
}

/** Stops the kit: TERM (it ends its tool and writes run.txt's end), or KILL after the grace. */
export function stopCommand(id: string, signal: "TERM" | "KILL", root: string = ADB_DEVICE_ROOT): string {
  checkRoot(root);
  checkId(id);
  return `kill -${signal} $(cat ${root}/run-${id}.pid) 2>/dev/null; echo stopped`;
}

/** After a subject: its output and run files go, and its model too unless it is kept. */
export function afterRunCommand(id: string, modelPath: string, keepModel: boolean, root: string = ADB_DEVICE_ROOT): string {
  checkRoot(root);
  checkId(id);
  if (!modelPath.startsWith(`${root}/model/`) || !SAFE_ROOT.test(modelPath)) throw new Error(`The model isn't in ${root}/model: ${modelPath}`);
  return `rm -rf ${root}/out/${id} ${root}/run-${id}.exit ${root}/run-${id}.pid ${root}/run-${id}.stdout${keepModel ? "" : ` ${modelPath} ${modelPath}.part`}`;
}

/** At the end: everything the runner put on the phone (the model folder too unless models are kept). */
export function cleanupCommand(keepModel: boolean, root: string = ADB_DEVICE_ROOT): string {
  checkRoot(root);
  return keepModel
    ? `rm -rf ${root}/kit ${root}/llama-android ${root}/llama-snapdragon ${root}/plan ${root}/out ${root}/run-*`
    : `rm -rf ${root}`;
}

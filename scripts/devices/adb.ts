/**
 * Runs the device kit on an Android phone over adb from this Mac (docs/DEVICES.md "How to run > QDC", "Over adb"): a
 * QDC interactive session in "SSH only" mode, which works while QDC's API keys are off, or a phone on USB.
 *
 *   npx tsx scripts/devices/adb.ts plan [--ram-gb 24]                          what a run does (runs nothing)
 *   npx tsx scripts/devices/adb.ts check --session <id> --key <ssh key>        tunnel, version check, the phone's facts
 *   npx tsx scripts/devices/adb.ts run --yes --session <id> --key <ssh key>    smoke, then the files for the phone's RAM
 *   npx tsx scripts/devices/adb.ts run --yes --tunnel '<the ssh command QDC shows>'
 *   npx tsx scripts/devices/adb.ts run --yes --port 5038                       an adb server already on that port
 *
 * More flags: --subjects smoke,pick (the default: the smoke run, then pickSubjects for the phone's MemTotal; or ids),
 * --tuned <repo>, --backends cpu,gpu,npu, --usb (a phone of the owner's: results go to devices/results/local/),
 * --keep-model, --poll-seconds 10, --reconnect-minutes 10, --adb <path>, --serial <serial> (never printed),
 * --record-probe <chipset> (check: the phone's RAM into devices/qdc/targets.json).
 *
 * With --session the runner starts the tunnel itself (ssh with its own known_hosts file in the cache, never
 * ~/.ssh/known_hosts) on 127.0.0.1:<port> (5038 unless --port; 5037 is refused, the owner's adb server is there) and
 * stops it at the end. Before every adb command it checks the server's protocol version with a raw host:version
 * request. It pushes the kit and both pinned llama.cpp builds to /data/local/tmp/mm, and for each subject starts the
 * kit, which downloads the model from the Hub with the phone's curl and checks its sha256. It pulls the kit's folder
 * after every step, so a session that ends early still leaves what ran, and writes devices/results/qdc/... (or
 * local/... with --usb) with lib/devices/result.ts. Ctrl-C stops the kit, pulls, writes what there is and cleans up.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ADB_DEFAULT_PORT,
  ADB_DEVICE_ROOT,
  adbEnv,
  adbPlanText,
  adbRunLimitSeconds,
  afterRunCommand,
  checkLocalPort,
  chmodCommand,
  cleanupCommand,
  factsCommand,
  factsLine,
  hostRequest,
  kitEnded,
  parseClientVersion,
  parseDevices,
  parseFacts,
  parsePoll,
  parseTunnelCommand,
  parseVersionReply,
  pickDevice,
  planAdbRuns,
  pollCommand,
  shouldPull,
  stageCommand,
  startCommand,
  stopCommand,
  tunnelArgs,
  versionProblem,
  type AdbRequest,
  type AdbRun,
  type PhoneFacts,
  type PollState,
  type VersionReply,
} from "@/lib/devices/adb";
import { QDC_BUILD_DIRS, parseProbes, probeFromDevice, probesText, qdcKitPlace, qdcPlanFiles, withProbe, type QdcBuild } from "@/lib/devices/qdc";
import { parseKitOutput, writeResult } from "@/lib/devices/result";
import { GIB, SMOKE, STAND_INS, deviceSlug, fetchTunedSubjects, marketedRamGiB, repoFileUrl, subjectById, utcStamp } from "@/lib/devices/subjects";
import { BACKENDS, type Backend, type Cloud, type Result, type Subject } from "@/lib/devices/types";
import { cacheDir } from "./local";
import { ensureAndroidBuild } from "./qdc";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
type Env = Record<string, string | undefined>;

export interface AdbArgs {
  command: "plan" | "check" | "run" | null;
  yes: boolean;
  session: string | null;
  key: string | null;
  port: number;
  tunnel: string | null;
  subjects: string[];
  tuned: string | null;
  backends: Backend[] | null;
  usb: boolean;
  keepModel: boolean;
  pollSeconds: number;
  reconnectMinutes: number;
  adb: string;
  serial: string | null;
  ramGb: number | null;
  recordProbe: string | null;
  /** The local port of a pasted --tunnel command (this runner uses --port, 5038 by default, never 5037). */
  pastedPort: number | null;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/devices/adb.ts <plan|check|run> [flags]
  where the phone is:  --session <id> --key <ssh key> | --tunnel '<QDC's ssh command>' | --port <n> (an adb server already there)
  plan                 [--ram-gb 12|16|24] [--subjects smoke,pick|<id>,...] [--tuned <repo>]
  check                [--record-probe <chipset>]
  run --yes            [--subjects smoke,pick|<id>,...] [--tuned <repo>] [--backends cpu,gpu,npu] [--usb] [--keep-model]
                       [--poll-seconds 10] [--reconnect-minutes 10] [--adb <path>] [--serial <serial>]`;

export function parseAdbArgs(argv: readonly string[]): AdbArgs {
  const args: AdbArgs = {
    command: null,
    yes: false,
    session: null,
    key: null,
    port: ADB_DEFAULT_PORT,
    tunnel: null,
    subjects: ["smoke", "pick"],
    tuned: null,
    backends: null,
    usb: false,
    keepModel: false,
    pollSeconds: 10,
    reconnectMinutes: 10,
    adb: "adb",
    serial: null,
    ramGb: null,
    recordProbe: null,
    pastedPort: null,
    help: false,
  };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.\n${USAGE}`);
    return v;
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--yes":
        args.yes = true;
        break;
      case "--session":
        args.session = value(i++, flag);
        break;
      case "--key":
        args.key = value(i++, flag);
        break;
      case "--port":
        args.port = checkLocalPort(Number(value(i++, flag)));
        break;
      case "--tunnel":
        args.tunnel = value(i++, flag);
        break;
      case "--subjects":
        args.subjects = value(i++, flag).split(",").map((s) => s.trim()).filter(Boolean);
        if (args.subjects.length === 0) throw new Error("--subjects names nothing.");
        break;
      case "--tuned":
        args.tuned = value(i++, flag);
        break;
      case "--backends": {
        const list = value(i++, flag).split(",").map((b) => b.trim());
        for (const b of list) if (!(BACKENDS as readonly string[]).includes(b)) throw new Error(`Not a backend: ${b}`);
        args.backends = list as Backend[];
        break;
      }
      case "--usb":
        args.usb = true;
        break;
      case "--keep-model":
        args.keepModel = true;
        break;
      case "--poll-seconds": {
        const n = Number(value(i++, flag));
        if (!(n >= 0.2 && n <= 300)) throw new Error("--poll-seconds must be 0.2 to 300.");
        args.pollSeconds = n;
        break;
      }
      case "--reconnect-minutes": {
        const n = Number(value(i++, flag));
        if (!(n >= 0 && n <= 120)) throw new Error("--reconnect-minutes must be 0 to 120.");
        args.reconnectMinutes = n;
        break;
      }
      case "--adb":
        args.adb = value(i++, flag);
        break;
      case "--serial":
        args.serial = value(i++, flag);
        break;
      case "--ram-gb": {
        const n = Number(value(i++, flag));
        if (!(n > 0 && n <= 1024)) throw new Error("--ram-gb must be a size in GB.");
        args.ramGb = n;
        break;
      }
      case "--record-probe":
        args.recordProbe = value(i++, flag).toUpperCase();
        if (!/^[A-Z0-9_]{2,20}$/.test(args.recordProbe)) throw new Error(`Not a chipset name: ${args.recordProbe}`);
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (flag.startsWith("--")) throw new Error(`Unknown flag ${flag}.\n${USAGE}`);
        positional.push(flag);
    }
  }
  if (positional.length > 1) throw new Error(`Unexpected ${positional.slice(1).join(" ")}.\n${USAGE}`);
  if (positional[0] !== undefined) {
    if (!["plan", "check", "run"].includes(positional[0])) throw new Error(`Unknown command ${positional[0]}.\n${USAGE}`);
    args.command = positional[0] as AdbArgs["command"];
  }
  if (args.tunnel) {
    const spec = parseTunnelCommand(args.tunnel);
    args.session = args.session ?? spec.sessionId;
    args.key = args.key ?? spec.key;
    args.pastedPort = spec.localPort;
  }
  if (args.key?.startsWith("~/")) args.key = path.join(os.homedir(), args.key.slice(2));
  if (args.session && !args.key) throw new Error("--session needs --key <the private SSH key QDC has the public half of>.");
  if (args.usb && args.session) throw new Error("--usb is for a phone of the owner's, not a QDC session.");
  return args;
}

// ---------------------------------------------------------------------------------------------------------------
// Programs

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with exactly `env`, stdin closed, killed after timeoutMs (code 124). */
export function runProgram(cmd: string, args: readonly string[], env: Env, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

/** The adb server's answer to a raw host:version on 127.0.0.1:<port>, or a "bad" reply when nothing answers in time. */
export function askServerVersion(port: number, timeoutMs = 5000): Promise<VersionReply> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = Buffer.alloc(0);
    let done = false;
    const finish = (reply: VersionReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ kind: "bad", text: "no answer" }), timeoutMs);
    socket.on("connect", () => socket.write(hostRequest("host:version")));
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const reply = parseVersionReply(data);
      if (reply.kind !== "short") finish(reply);
    });
    socket.on("error", (e) => finish({ kind: "bad", text: e.message }));
    socket.on("close", () => finish(parseVersionReply(data).kind === "short" ? { kind: "bad", text: "closed" } : parseVersionReply(data)));
  });
}

/** Thrown when the runner won't talk to the server or the phone: the message says why, and nothing was sent. */
export class AdbRefusal extends Error {}

/** adb against one server and one phone, with the version check before every command. */
export class PhoneLink {
  serial: string | null = null;
  private client: number | null = null;
  readonly env: Record<string, string>;

  constructor(
    readonly adb: string,
    readonly port: number,
    base: Env,
  ) {
    this.env = adbEnv(port, base);
  }

  /** Asks the server for its version and compares it with this Mac's adb. Throws AdbRefusal on any doubt. */
  async ensureServer(): Promise<void> {
    if (this.client === null) {
      const v = await runProgram(this.adb, ["version"], this.env, 30_000);
      this.client = v.code === 0 ? parseClientVersion(v.stdout) : null;
      if (this.client === null) throw new AdbRefusal(`${this.adb} version didn't run (${v.code}): is adb installed? (--adb <path>)`);
    }
    const problem = versionProblem(this.client, await askServerVersion(this.port), this.port);
    if (problem) throw new AdbRefusal(problem);
  }

  /** One adb command (with -s <serial> once known), after the version check. */
  async run(argv: readonly string[], timeoutMs = 120_000): Promise<Ran> {
    await this.ensureServer();
    return runProgram(this.adb, this.serial ? ["-s", this.serial, ...argv] : argv, this.env, timeoutMs);
  }

  shell(command: string, timeoutMs = 120_000): Promise<Ran> {
    return this.run(["shell", command], timeoutMs);
  }

  /** The kit's adb shell, left running in the background; its output isn't needed (the kit writes files). */
  async spawnShell(command: string): Promise<ChildProcess> {
    await this.ensureServer();
    const child = spawn(this.adb, [...(this.serial ? ["-s", this.serial] : []), "shell", command], {
      env: this.env as NodeJS.ProcessEnv,
      stdio: "ignore",
    });
    child.on("error", () => {});
    return child;
  }

  /** The phone, picked once: exactly one usable phone (or --serial). Its serial stays in memory only. */
  async attach(wanted?: string): Promise<void> {
    const listed = await this.run(["devices"], 60_000);
    if (listed.code !== 0) throw new AdbRefusal(`adb devices failed (${listed.code}): ${listed.stderr.trim().slice(0, 300)}`);
    const picked = pickDevice(parseDevices(listed.stdout), wanted);
    if ("problem" in picked) throw new AdbRefusal(picked.problem);
    this.serial = picked.serial;
  }
}

/** The SSH tunnel to a QDC session's adb server, started and stopped by the runner. */
export class Tunnel {
  private child: ChildProcess | null = null;
  private stderr = "";

  constructor(
    readonly spec: { key: string; port: number; sessionId: string; knownHosts: string },
    readonly env: Env,
  ) {}

  start(): void {
    mkdirSync(path.dirname(this.spec.knownHosts), { recursive: true, mode: 0o700 });
    if (!existsSync(this.spec.knownHosts)) writeFileSync(this.spec.knownHosts, "", { mode: 0o600 });
    this.stderr = "";
    const env: Env = {};
    for (const name of ["PATH", "HOME", "USER", "SSH_AUTH_SOCK", "TMPDIR"]) if (this.env[name] !== undefined) env[name] = this.env[name];
    this.child = spawn("ssh", tunnelArgs(this.spec), { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"] });
    this.child.stderr?.on("data", (c: Buffer) => {
      this.stderr = (this.stderr + c.toString("utf8")).slice(-2000);
    });
    this.child.on("error", (e) => {
      this.stderr += e.message;
    });
  }

  alive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Waits until the forwarded port answers host:version, or ssh gives up. */
  async ready(timeoutMs = 45_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (!this.alive()) throw new AdbRefusal(`The SSH tunnel ended: ${this.stderr.trim().split("\n").slice(-3).join(" ") || "no message"}`);
      const reply = await askServerVersion(this.spec.port, 3000);
      if (reply.kind === "ok" || reply.kind === "fail") return;
      await sleep(1000);
    }
    throw new AdbRefusal(`The SSH tunnel didn't bring the session's adb server to port ${this.spec.port} in ${timeoutMs / 1000} s.`);
  }

  stop(): void {
    if (this.alive()) this.child?.kill("SIGTERM");
    this.child = null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
// One kit run on the phone

export interface RunContext {
  link: PhoneLink;
  root: string;
  /** Local: plan files to push, and the kit folder's mirror, pulled after every step. */
  workDir: string;
  repoRoot: string;
  cloud: Cloud;
  facts: PhoneFacts;
  keepModel: boolean;
  pollSeconds: number;
  reconnectMinutes: number;
  /** Tries to bring the link back (the tunnel), true when it may work again. */
  reconnect: () => Promise<boolean>;
  interrupted: () => boolean;
  now: () => Date;
  say: (line: string) => void;
  fetchImpl: typeof fetch;
}

export interface RunOutcome {
  run: AdbRun;
  result: Result | null;
  dir: string | null;
  why: string | null;
  /** False when the phone stopped answering or the runner stopped the kit: the result holds only what was pulled. */
  complete: boolean;
}

/** Pulls <root>/out/<id> into a fresh folder, then puts it in place of the mirror. False when the pull failed. */
async function pullInto(link: PhoneLink, root: string, id: string, mirror: string): Promise<boolean> {
  const fresh = `${mirror}.pull`;
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  let pulled: Ran;
  try {
    pulled = await link.run(["pull", `${root}/out/${id}`, fresh], 300_000);
  } catch (err) {
    // The server went away between the poll and the pull: the mirror keeps the last good pull.
    if (!(err instanceof AdbRefusal)) throw err;
    rmSync(fresh, { recursive: true, force: true });
    return false;
  }
  const got = existsSync(path.join(fresh, id)) ? path.join(fresh, id) : fresh;
  if (pulled.code !== 0 || !existsSync(path.join(got, "run.txt"))) {
    rmSync(fresh, { recursive: true, force: true });
    return false;
  }
  rmSync(mirror, { recursive: true, force: true });
  renameSync(got, mirror);
  rmSync(fresh, { recursive: true, force: true });
  return true;
}

/** The device facts a result gets from the runner: a QDC session phone is named by its chipset, like QDC's jobs. */
export function contextDevice(cloud: Cloud, facts: PhoneFacts): Partial<Result["device"]> {
  const marketed = facts.memTotalKb ? marketedRamGiB(facts.memTotalKb * 1024) : 0;
  const soc = facts.socModel || "phone";
  if (cloud === "qdc") {
    return {
      slug: deviceSlug({ manufacturer: "qdc", model: soc.toLowerCase(), marketedRamGiB: marketed }),
      name: `${[facts.manufacturer, facts.model].filter(Boolean).join(" ") || "A phone"} (${soc}) in a QDC session`,
      cloudId: `${soc}/session`,
    };
  }
  return { name: `${[facts.manufacturer, facts.model].filter(Boolean).join(" ") || "A phone"} over USB` };
}

export async function runOnPhone(ctx: RunContext, run: AdbRun): Promise<RunOutcome> {
  const { link, root, say } = ctx;
  const id = run.subject.id;
  const stamp = utcStamp(ctx.now());
  const place = qdcKitPlace(run.subject, root);
  let template: string | undefined;
  if (run.subject.templatePath) {
    const res = await ctx.fetchImpl(repoFileUrl(run.subject, run.subject.templatePath));
    if (!res.ok) return { run, result: null, dir: null, why: `the Hub answered ${res.status} for its ${run.subject.templatePath}`, complete: false };
    template = await res.text();
  }
  const planDir = path.join(ctx.workDir, "plan");
  mkdirSync(planDir, { recursive: true });
  const files = qdcPlanFiles({ key: `adb-${stamp}`, subject: run.subject, settings: run.settings, backends: run.backends }, template, root);
  for (const [name, text] of Object.entries(files)) {
    if (name === "run.env") continue;
    writeFileSync(path.join(planDir, name), text);
    const pushed = await link.run(["push", path.join(planDir, name), `${root}/plan/${name}`], 60_000);
    if (pushed.code !== 0) return { run, result: null, dir: null, why: `adb push of plan/${name} failed: ${pushed.stderr.trim().slice(0, 200)}`, complete: false };
  }

  const mirror = path.join(ctx.workDir, "out", id);
  rmSync(mirror, { recursive: true, force: true });
  say(`${id}: starting the kit (${run.backends.join(", ")}); it downloads ${(run.subject.bytes / 1e9).toFixed(2)} GB itself.`);
  const session = await link.spawnShell(startCommand(id, root));
  const limitMs = adbRunLimitSeconds(run.settings) * 1000;
  const started = Date.now();
  let previous: PollState | null = null;
  let lastPull = 0;
  let pulls = 0;
  let seen = 0;
  let failingSince: number | null = null;
  let lost = false;
  let stopped: string | null = null;
  try {
    for (;;) {
      await sleep(ctx.pollSeconds * 1000);
      let state: PollState | null = null;
      try {
        const polled = await link.shell(pollCommand(id, root), 60_000);
        state = polled.code === 0 ? parsePoll(polled.stdout) : null;
      } catch (err) {
        if (!(err instanceof AdbRefusal)) throw err;
        say(`${id}: ${err.message}`);
      }
      if (!state) {
        failingSince = failingSince ?? Date.now();
        const minutes = (Date.now() - failingSince) / 60_000;
        if (minutes >= ctx.reconnectMinutes) {
          lost = true;
          say(`${id}: the phone hasn't answered for ${minutes.toFixed(1)} min; keeping what was pulled.`);
          break;
        }
        if (await ctx.reconnect()) say(`${id}: reconnected; the kit kept running on the phone.`);
        continue;
      }
      failingSince = null;
      for (const line of state.stdout.slice(seen)) say(`${id}: ${line}`);
      seen = Math.max(seen, state.stdout.length);
      if (shouldPull(previous, state, (Date.now() - lastPull) / 1000)) {
        if (await pullInto(link, root, id, mirror)) {
          pulls += 1;
          lastPull = Date.now();
        }
      }
      previous = state;
      if (kitEnded(state)) break;
      const why = ctx.interrupted() ? "interrupted (Ctrl-C)" : Date.now() - started > limitMs ? "past the kit's own limits plus 5 minutes" : null;
      if (why) {
        stopped = why;
        say(`${id}: stopping the kit, ${why}.`);
        await link.shell(stopCommand(id, "TERM", root), 60_000).catch(() => null);
        await sleep(10_000);
        await link.shell(stopCommand(id, "KILL", root), 60_000).catch(() => null);
        if (await pullInto(link, root, id, mirror).catch(() => false)) pulls += 1;
        break;
      }
    }
  } finally {
    if (session.exitCode === null) session.kill("SIGTERM");
  }

  if (!lost) await link.shell(afterRunCommand(id, place.model, ctx.keepModel, root), 120_000).catch(() => null);
  if (!existsSync(path.join(mirror, "run.txt"))) {
    return { run, result: null, dir: null, why: lost ? "the session ended before the kit wrote anything" : "the kit's folder never came back", complete: false };
  }
  const notes = [
    `Run over adb from this Mac (${ctx.cloud === "qdc" ? "a QDC interactive session" : "a phone on USB"}); the phone downloaded the model from the Hub itself.`,
    `The runner pulled the kit's folder ${pulls} time${pulls === 1 ? "" : "s"}, after each step.`,
  ];
  if (lost) notes.push(`The phone stopped answering before the kit finished; this is the last pull, ${Math.round((lastPull - started) / 1000)} s into the run.`);
  if (stopped) notes.push(`The runner stopped the kit: ${stopped}.`);
  const result = parseKitOutput(mirror, { cloud: ctx.cloud, runId: `adb-${stamp}`, stamp, subject: run.subject, device: contextDevice(ctx.cloud, ctx.facts), notes });
  const dir = writeResult(ctx.repoRoot, result, mirror);
  return { run, result, dir, why: lost ? "the phone stopped answering before the kit finished" : null, complete: !lost && !stopped };
}

// ---------------------------------------------------------------------------------------------------------------
// The commands

export interface AdbDeps {
  repoRoot?: string;
  cache?: string;
  env?: Env;
  now?: () => Date;
  say?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** The trimmed Android builds (their llama-b11669/ folders); the pinned archives by default. */
  stageBuilds?: (cache: string) => Promise<Record<QdcBuild, string>>;
  /** The kit's folder on the phone; tests put a phone elsewhere. */
  root?: string;
  /** Subjects for --subjects ids beyond the known ones (tests). */
  extraSubjects?: readonly Subject[];
}

function requestsFor(args: AdbArgs, pool: readonly Subject[], extra: readonly Subject[]): AdbRequest[] {
  return args.subjects.map((s): AdbRequest => {
    if (s === "smoke" || s === "pick") return s;
    const found = pool.find((p) => p.id === s) ?? extra.find((p) => p.id === s) ?? subjectById(s);
    if (!found) throw new Error(`Unknown subject ${s}: smoke, pick, or one of ${[...pool, SMOKE].map((p) => p.id).join(", ")}.`);
    return found;
  });
}

function knownHostsFile(cache: string): string {
  return path.join(cache, "adb", "known_hosts");
}

function runCommandText(args: AdbArgs): string {
  const where = args.session ? `--session ${args.session} --key ${args.key}` : `--port ${args.port}`;
  const parts = ["npx tsx scripts/devices/adb.ts run --yes", where];
  if (args.session && args.port !== ADB_DEFAULT_PORT) parts.push(`--port ${args.port}`);
  if (args.subjects.join(",") !== "smoke,pick") parts.push(`--subjects ${args.subjects.join(",")}`);
  if (args.tuned) parts.push(`--tuned ${args.tuned}`);
  if (args.backends) parts.push(`--backends ${args.backends.join(",")}`);
  if (args.usb) parts.push("--usb");
  if (args.keepModel) parts.push("--keep-model");
  return parts.join(" ");
}

export async function runAdb(args: AdbArgs, deps: AdbDeps = {}): Promise<number> {
  const say = deps.say ?? ((line: string) => console.log(line));
  const env = deps.env ?? process.env;
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const cache = deps.cache ?? cacheDir(env as NodeJS.ProcessEnv);
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const root = deps.root ?? ADB_DEVICE_ROOT;
  if (args.help || !args.command) {
    say(USAGE);
    return args.help ? 0 : 2;
  }
  const pool = args.tuned ? await fetchTunedSubjects(args.tuned, fetchImpl) : STAND_INS;
  const requests = requestsFor(args, pool, deps.extraSubjects ?? []);
  if (args.pastedPort !== null && args.pastedPort !== args.port) {
    say(`The pasted tunnel forwards local port ${args.pastedPort}; this runner uses ${args.port} instead${args.pastedPort === 5037 ? " (5037 is the owner's own adb server)" : ""}.`);
  }

  if (args.command === "plan" || (args.command === "run" && !args.yes)) {
    const ramKb = args.ramGb ? Math.round((args.ramGb * GIB) / 1024) : null;
    const runs = planAdbRuns({ requests, ramKb, pool, backends: args.backends ?? undefined });
    say(args.session ? `Tunnel: ssh ${tunnelArgs({ key: args.key as string, port: args.port, sessionId: args.session, knownHosts: knownHostsFile(cache) }).join(" ")}` : `adb server: 127.0.0.1:${args.port} (already running)`);
    say(`Before every adb command: a raw host:version check against this Mac's adb; a mismatch stops the run before adb starts.`);
    say(`Pushes devices/kit and both pinned llama.cpp ${"b11669"} Android builds (trimmed) to ${root}, then for each run:`);
    say(adbPlanText(runs, { ramKb, requests }).trimEnd());
    say(`It pulls ${root}/out/<subject> after every step and writes devices/results/${args.usb ? "local" : "qdc"}/<phone>/<subject>/<stamp>/.`);
    say(`Nothing was run. To run it:\n  ${runCommandText(args)}`);
    return 0;
  }

  const link = new PhoneLink(args.adb, args.port, env);
  let tunnel: Tunnel | null = null;
  let interrupted = 0;
  const onInterrupt = () => {
    interrupted += 1;
    if (interrupted === 1) say("Stopping: the kit is stopped, what ran is pulled and written. Ctrl-C again leaves at once.");
    else process.exit(130);
  };
  process.on("SIGINT", onInterrupt);
  try {
    if (args.session) {
      tunnel = new Tunnel({ key: args.key as string, port: args.port, sessionId: args.session, knownHosts: knownHostsFile(cache) }, env);
      const busy = await askServerVersion(args.port, 1500);
      if (busy.kind !== "bad" || !/ECONNREFUSED/.test(busy.text)) {
        throw new AdbRefusal(`Something already listens on 127.0.0.1:${args.port}; pick another --port, or drop --session to use it.`);
      }
      say(`Opening the SSH tunnel to QDC session ${args.session} on 127.0.0.1:${args.port}.`);
      tunnel.start();
      await tunnel.ready();
    }
    await link.ensureServer();
    await link.attach(args.serial ?? undefined);
    const factsRun = await link.shell(factsCommand(root), 60_000);
    if (factsRun.code !== 0) throw new AdbRefusal(`The phone didn't answer adb shell (${factsRun.code}).`);
    const facts = parseFacts(factsRun.stdout);
    say(`Phone: ${factsLine(facts)}.`);

    if (args.command === "check") {
      if (args.recordProbe) {
        const file = path.join(repoRoot, "devices", "qdc", "targets.json");
        const probes = existsSync(file) ? parseProbes(readFileSync(file, "utf8")) : [];
        const probe = probeFromDevice(
          args.recordProbe,
          { ram_kb: String(facts.memTotalKb ?? ""), model: facts.model, android: facts.android, sdk: String(facts.sdk ?? ""), soc_model: facts.socModel },
          now(),
        );
        writeFileSync(file, probesText(withProbe(probes, probe)));
        say(`Recorded ${args.recordProbe}: ${probe.marketedRamGiB} GB (MemTotal ${probe.ramKb} kB) in devices/qdc/targets.json.`);
      }
      return 0;
    }

    const runs = planAdbRuns({ requests, ramKb: facts.memTotalKb, pool, backends: args.backends ?? undefined, facts });
    if (runs.length === 0) {
      say("Nothing to run on this phone (no file's run fits its RAM).");
      return 0;
    }
    if (!facts.hasCurl) throw new AdbRefusal("The phone has no curl, so the kit can't download the model there.");
    const largest = Math.max(...runs.map((r) => r.subject.bytes));
    if (facts.freeKb !== null && facts.freeKb * 1024 < largest + GIB) {
      throw new AdbRefusal(`The phone has ${(facts.freeKb / 1024 / 1024).toFixed(1)} GiB free and the largest file needs ${((largest + GIB) / GIB).toFixed(1)} GiB.`);
    }
    say(`Runs: ${runs.map((r) => `${r.subject.id} (${r.why})`).join(", ")}.`);

    const builds = deps.stageBuilds
      ? await deps.stageBuilds(cache)
      : {
          "android-arm64": await ensureAndroidBuild(cache, "android-arm64", fetchImpl, say),
          "android-arm64-snapdragon": await ensureAndroidBuild(cache, "android-arm64-snapdragon", fetchImpl, say),
        };
    const staged = await link.shell(stageCommand(root), 120_000);
    if (staged.code !== 0) throw new AdbRefusal(`The phone wouldn't make ${root} (${staged.code}).`);
    const t0 = Date.now();
    const pushes: Array<[string, string]> = [
      [path.join(repoRoot, "devices", "kit"), `${root}/kit`],
      [builds["android-arm64"], `${root}/${QDC_BUILD_DIRS["android-arm64"]}`],
      [builds["android-arm64-snapdragon"], `${root}/${QDC_BUILD_DIRS["android-arm64-snapdragon"]}`],
    ];
    for (const [from, to] of pushes) {
      const pushed = await link.run(["push", from, to], 1_200_000);
      if (pushed.code !== 0) throw new AdbRefusal(`adb push to ${to} failed (${pushed.code}): ${pushed.stderr.trim().slice(0, 300)}`);
    }
    await link.shell(chmodCommand(root), 60_000);
    say(`Pushed the kit and both builds in ${Math.round((Date.now() - t0) / 1000)} s.`);

    const stamp = utcStamp(now());
    const workDir = path.join(cache, "adb", stamp);
    mkdirSync(workDir, { recursive: true });
    chmodSync(workDir, 0o700);
    const ctx: RunContext = {
      link,
      root,
      workDir,
      repoRoot,
      cloud: args.usb ? "local" : "qdc",
      facts,
      keepModel: args.keepModel,
      pollSeconds: args.pollSeconds,
      reconnectMinutes: args.reconnectMinutes,
      reconnect: async () => {
        if (!tunnel || tunnel.alive()) return false;
        say("The SSH tunnel ended; opening it again.");
        tunnel.start();
        try {
          await tunnel.ready(30_000);
          return true;
        } catch {
          return false;
        }
      },
      interrupted: () => interrupted > 0,
      now,
      say,
      fetchImpl,
    };
    const outcomes: RunOutcome[] = [];
    for (const run of runs) {
      if (interrupted > 0) break;
      const outcome = await runOnPhone(ctx, run);
      outcomes.push(outcome);
      say(outcomeLine(outcome, repoRoot));
      if (/phone stopped answering|session ended/.test(outcome.why ?? "")) {
        say("The phone stopped answering, so the runs after this one wait for another session.");
        break;
      }
    }
    await link.shell(cleanupCommand(args.keepModel, root), 120_000).catch(() => null);
    return interrupted > 0 ? 130 : outcomes.length === runs.length && outcomes.every((o) => o.result && o.complete) ? 0 : 1;
  } catch (err) {
    if (err instanceof AdbRefusal) {
      say(err.message);
      return 2;
    }
    throw err;
  } finally {
    process.off("SIGINT", onInterrupt);
    tunnel?.stop();
  }
}

export function outcomeLine(o: RunOutcome, repoRoot: string): string {
  if (!o.result || !o.dir) return `${o.run.subject.id}: no result (${o.why}).`;
  const v = o.result.verdict;
  const speed = v.backend ? `, ${v.backend} ${v.genTps?.toFixed(1) ?? "?"} t/s, ${v.answersRight} of ${v.answersTotal} right` : "";
  const partial = o.complete ? "" : `, partial: ${o.why ?? "the runner stopped the kit"}`;
  return `${o.run.subject.id}: ${v.rating}${speed}${partial} (${path.relative(repoRoot, o.dir)}).`;
}

async function main(argv: string[]): Promise<number> {
  let args: AdbArgs;
  try {
    args = parseAdbArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  return runAdb(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

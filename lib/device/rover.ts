/**
 * The demo rover (docs/ROVER.md): a two-wheeled car on an Arduino UNO Q that's enrolled in the fleet. One admin action
 * packs the board kit from this repo (muse-device/server.py, muse-device/autostart.sh and muse-device/rover/), sends it
 * through the fleet's control plane as exec jobs (jetson-infra's routes/nodes.py and routes/jobs.py), runs the kit's
 * installer and self-test there as root (muse-device/rover/setup-rover.sh), and reads the report it ends with. From then on
 * the rover's tools answer at <BOARD_FLEET_URL>/device/<board>/mcp (jetson-infra's routes/device.py), with the board's own
 * token.
 *
 * Nothing on the rover runs a model. Muse Wonder does the thinking on Meta's models, and the stop for anything close in front
 * runs in the rover's microcontroller code.
 *
 * One exec takes a command of at most 16384 characters (jetson-infra's actions.py, ExecParams), and the kit packs to more
 * than twice that, since server.py alone is about 80 KB. So the kit goes in parts, each an exec that writes one piece of the
 * packed kit to a folder only root can write, and a last exec checks the whole kit's sha256 before it unpacks and runs
 * anything. That keeps to the one channel the fleet already audits, adds no download address and no new secret, and a part
 * that's lost or changed on the way fails the check instead of running. A kit small enough goes as one exec. The installer
 * copies from the unpacked kit as the board's user, so the kit can be read by anyone there, but only root can change it.
 *
 * The board's token: the control plane keeps every exec's command and output and shows them to anyone who can read the
 * fleet's jobs, so the board never prints it. It seals it to a one-time Diffie-Hellman key this server makes for each read
 * (RFC 3526's 2048-bit group, which the board's python3 can do with its standard library), and the token is kept only in
 * this server process's memory. A process that starts without it reads it again the same way. It never goes in a reply or
 * a log, and no error here holds it, the fleet's address or the fleet's token, so every message is safe to show.
 */
import { createHash, createHmac, getDiffieHellman, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fleetAccess } from "@/lib/board-loop/fleet";
import { callDeviceTool, listDeviceTools, type DeviceConfig, type DeviceTool, type DeviceToolResult } from "@/lib/device/client";
import { BOARD_TOOL_OF, rangesOf, RoverInputError, ROVER_TOOL_NAMES, type RoverRanges } from "@/lib/device/rover-tools";

/** The board the demo uses, unless ROVER_BOARD names another. Its fleet name, which is also its .local name. */
export const DEFAULT_ROVER_BOARD = "ArduinoQ-01";
/** The board's own user. muse-device/server.py runs as this user, from cron (autostart.sh), and keeps its token in its home. */
export const ROVER_USER = "arduino";
/** jetson-infra's actions.py: ExecParams.command has max_length=16384. */
export const MAX_COMMAND_CHARS = 16384;
/** Room for a part's own lines around its piece of the kit. */
const PART_CHARS = MAX_COMMAND_CHARS - 1024;
/** Far past the real kit, and short of a folder someone dropped a model file into. */
const MAX_KIT_BYTES = 1024 * 1024;
const MAX_PARTS = 40;

/** What the kit from this repo holds, by path under muse-device/. */
const KIT_FILES = ["server.py", "autostart.sh"];
const KIT_FOLDER = "rover";
/** In the kit's folder but not for the board: host_check runs the sketch's logic on a computer, against stand-in headers. */
const KIT_LEAVE_OUT: ReadonlySet<string> = new Set(["rover/host_check"]);
/** The kit's installer and self-test, run as root from the unpacked kit. */
export const KIT_ENTRY = "rover/setup-rover.sh";
/** The lines this file reads: the report setup-rover.sh ends with, as one JSON object, and the sealed token. */
export const REPORT_MARKER = "MUSE_ROVER_REPORT ";
const SEALED_MARKER = "MUSE_ROVER_SEALED ";
/** setup-rover.sh prints each step as "name: result", which is the setup card's progress. */
const STEP_LINE = /^([a-z][a-z_]{1,23}):\s+(\S.*)$/;

/** /run is a tmpfs only root can write, unlike /tmp, where any local user could plant a part. */
const STAGE_DIR = "/run/mm-rover-kit";
const LOCK_FILE = "/run/mm-rover-setup.lock";
/**
 * setup-rover.sh gives the first build of the sketch 15 minutes, and installing cron and GStreamer can take a while on top,
 * on a board that hasn't got them.
 */
export const SETUP_TIMEOUT_S = 30 * 60;
const PART_TIMEOUT_S = 60;
const TOKEN_TIMEOUT_S = 60;
/** How long the token read waits for a server that was only just started to write its token. */
const TOKEN_WAIT_S = 20;
const CALL_MS = 15_000;
const POLL_MS = 2_000;
/** A read of the token that failed isn't tried again sooner, since each one is an exec on the board. */
const READ_RETRY_MS = 60_000;

const BOARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KIT_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const TOKEN_TEXT = /^[\x21-\x7e]{32,512}$/;

export class RoverNotConfiguredError extends Error {
  constructor() {
    super("The fleet isn't set up: BOARD_FLEET_URL and BOARD_FLEET_TOKEN.");
  }
}
/** The fleet, the board or the kit couldn't do something. The message holds no address and no token. */
export class RoverError extends Error {}
/** The kit isn't in this deployment, or isn't one this can send. */
export class RoverKitError extends RoverError {}
/** This server is already sending a kit. The setup on the board is held to one at a time by its own locks too. */
export class RoverBusyError extends RoverError {}

export interface RoverDeps {
  doFetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** The repo's muse-device/ folder. next.config.ts traces it into /api/device/rover. */
  kitDir: string;
}

const defaults = (): RoverDeps => ({
  doFetch: fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  kitDir: path.join(process.cwd(), "muse-device"),
});
const withDefaults = (deps: Partial<RoverDeps>): RoverDeps => ({ ...defaults(), ...deps });

/** The board name to use: ROVER_BOARD, or the demo's own. */
export function roverBoard(): string {
  const name = process.env.ROVER_BOARD?.trim() || DEFAULT_ROVER_BOARD;
  if (!BOARD_NAME.test(name)) throw new RoverError("ROVER_BOARD isn't a board name.");
  return name;
}

export const isJobId = (value: unknown): value is string => typeof value === "string" && JOB_ID.test(value);

// ---------- What a setup may change ----------

/** The parts' pins by role, as muse-device/rover/rover_config.py names them. Its defaults are the wiring in docs/ROVER.md. */
export const ROVER_PIN_ROLES = [
  "pwma",
  "ain1",
  "ain2",
  "pwmb",
  "bin1",
  "bin2",
  "stby",
  "enc_left",
  "enc_right",
  "servo_pan",
  "servo_tilt",
  "xshut_front",
  "xshut_left",
  "xshut_right",
] as const;
export type RoverPinRole = (typeof ROVER_PIN_ROLES)[number];
const INVERTIBLE = ["left", "right", "pan", "tilt"] as const;

/** What one setup may change, given as setup-rover.sh's own flags. Anything left out keeps what an earlier setup set. */
export interface RoverOverrides {
  pins?: Partial<Record<RoverPinRole, string>>;
  /** How close something in front may get before the rover stops itself. */
  stopMm?: number;
  /** A motor wired the other way round, or a servo mounted facing the other way. */
  invert?: Array<(typeof INVERTIBLE)[number]>;
  /** Back to the defaults first, instead of what an earlier setup set. */
  reset?: boolean;
}

/** The motor driver's speed inputs take PWM, which the board's overlay gives only these header pins. */
const PWM_ROLES: ReadonlySet<string> = new Set(["pwma", "pwmb"]);
const PWM_PINS: ReadonlySet<string> = new Set(["D2", "D3", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13"]);
/** D0 and D1 are the header's serial port. */
const PIN_NAME = /^(?:D(?:[2-9]|1[0-3])|A[0-5])$/;
const STOP_MM = { min: 50, max: 1000 };

/**
 * A setup's changes, checked, as setup-rover.sh's flags. rover_config.py checks the whole config again once they're merged
 * into what the board has, so a pin that clashes with one left as it was stops there, before anything changes.
 */
export function overrideFlags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) throw new RoverInputError("Send the changes as an object of pins, stopMm, invert and reset.");
  const { pins, stopMm, invert, reset, ...rest } = value as Record<string, unknown>;
  const unknown = Object.keys(rest)[0];
  if (unknown) throw new RoverInputError(`${unknown.slice(0, 40)} isn't something a setup can change.`);
  const flags: string[] = [];
  if (reset !== undefined) {
    if (typeof reset !== "boolean") throw new RoverInputError("reset must be true or false.");
    if (reset) flags.push("--reset");
  }
  if (pins !== undefined) {
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) throw new RoverInputError("pins must be an object of role to pin.");
    const used = new Map<string, string>();
    for (const [role, pin] of Object.entries(pins)) {
      if (!(ROVER_PIN_ROLES as readonly string[]).includes(role)) throw new RoverInputError(`${role.slice(0, 40)} isn't a pin role. The roles are ${ROVER_PIN_ROLES.join(", ")}.`);
      if (typeof pin !== "string" || !PIN_NAME.test(pin)) throw new RoverInputError(`${role} must be a pin from D2 to D13 or A0 to A5.`);
      if (PWM_ROLES.has(role) && !PWM_PINS.has(pin)) throw new RoverInputError(`${role} needs a PWM pin: ${[...PWM_PINS].join(", ")}.`);
      if (used.has(pin)) throw new RoverInputError(`${role} and ${used.get(pin)} can't share ${pin}.`);
      used.set(pin, role);
      flags.push("--pin", `${role}=${pin}`);
    }
  }
  if (stopMm !== undefined) {
    if (!Number.isInteger(stopMm) || (stopMm as number) < STOP_MM.min || (stopMm as number) > STOP_MM.max) {
      throw new RoverInputError(`stopMm must be a whole number from ${STOP_MM.min} to ${STOP_MM.max}.`);
    }
    flags.push("--stop-mm", String(stopMm));
  }
  if (invert !== undefined) {
    if (!Array.isArray(invert) || !invert.every((part) => (INVERTIBLE as readonly unknown[]).includes(part))) {
      throw new RoverInputError(`invert must list some of ${INVERTIBLE.join(", ")}.`);
    }
    for (const part of new Set(invert)) flags.push("--invert", part as string);
  }
  return flags;
}

// ---------- The kit ----------

interface KitEntry {
  path: string;
  mode: number;
  text?: string;
  b64?: string;
}

export interface PackedKit {
  /** The kit as gzipped JSON, in base64. */
  base64: string;
  /** Of the gzipped bytes, which the board checks before it unpacks anything. */
  sha256: string;
  files: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

async function kitEntry(file: string, rel: string): Promise<KitEntry> {
  const bytes = await fs.readFile(file).catch(() => {
    throw new RoverKitError(`The rover kit isn't in this deployment: muse-device/${rel} is missing.`);
  });
  let text: string | null = null;
  try {
    text = bytes.includes(0) ? null : utf8.decode(bytes);
  } catch {
    text = null;
  }
  // Scripts keep their execute bit: the installer and autostart.sh's cron line run them.
  const mode = bytes.subarray(0, 2).toString("latin1") === "#!" ? 0o755 : 0o644;
  return text === null ? { path: rel, mode, b64: bytes.toString("base64") } : { path: rel, mode, text };
}

/** Every file under muse-device/rover, in a stable order. Caches, hidden files and KIT_LEAVE_OUT stay behind. */
async function kitFolder(root: string, rel: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => {
    throw new RoverKitError(`The rover kit isn't in this deployment: muse-device/${rel}/ is missing.`);
  });
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = `${rel}/${entry.name}`;
    if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name.endsWith(".pyc") || KIT_LEAVE_OUT.has(child)) continue;
    if (entry.isDirectory()) found.push(...(await kitFolder(root, child)));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

/** Packs the board kit from the repo into one gzipped JSON in base64. */
export async function packRoverKit(deps: Partial<RoverDeps> = {}): Promise<PackedKit> {
  const { kitDir } = withDefaults(deps);
  const paths = [...KIT_FILES, ...(await kitFolder(kitDir, KIT_FOLDER))];
  if (!paths.includes(KIT_ENTRY)) throw new RoverKitError(`The rover kit isn't in this deployment: muse-device/${KIT_ENTRY} is missing.`);
  const files: KitEntry[] = [];
  for (const rel of paths) {
    if (!KIT_PATH.test(rel)) throw new RoverKitError(`muse-device/${rel.slice(0, 120)} has a name the board can't take.`);
    files.push(await kitEntry(path.join(kitDir, rel), rel));
  }
  const json = Buffer.from(JSON.stringify({ files }));
  if (json.length > MAX_KIT_BYTES) throw new RoverKitError(`The rover kit comes to ${Math.round(json.length / 1024)} KB, past the ${MAX_KIT_BYTES / 1024} KB this sends.`);
  const gz = gzipSync(json, { level: 9 });
  return { base64: gz.toString("base64"), sha256: createHash("sha256").update(gz).digest("hex"), files: files.length };
}

const q = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * Unpacks the kit as root into the setup's own folder: root's files, which anyone may read, since setup-rover.sh copies from
 * them as the board's user, and only root may change. Written with no single quote, since it travels inside one.
 */
const UNPACK_PY = [
  "import base64,gzip,json,os,sys",
  "kit,root=sys.argv[1:3]",
  "os.umask(0o022)",
  'files=json.loads(gzip.decompress(open(kit,"rb").read()))["files"]',
  "for f in files:",
  '  p=os.path.normpath(os.path.join(root,f["path"]))',
  '  if not p.startswith(root+os.sep): raise SystemExit("A kit path leaves its folder: "+f["path"])',
  "  os.makedirs(os.path.dirname(p),exist_ok=True)",
  '  with open(p,"wb") as o: o.write(f["text"].encode() if "text" in f else base64.b64decode(f["b64"]))',
  '  os.chmod(p,f["mode"])',
  'print("Unpacked %d files." % len(files))',
].join("\n");

export interface SetupCommands {
  /** Each writes one piece of the packed kit on the board. Empty when the kit fits in the install command itself. */
  parts: string[];
  install: string;
}

/** The exec commands for one setup, each within MAX_COMMAND_CHARS. `flags` go to setup-rover.sh, from overrideFlags. */
export function setupCommands(kit: PackedKit, flags: string[] = [], user: string = ROVER_USER): SetupCommands {
  if (!SHA256.test(kit.sha256) || !/^[A-Za-z0-9+/=]+$/.test(kit.base64)) throw new RoverKitError("That packed kit isn't one this made.");
  const dir = `${STAGE_DIR}/${kit.sha256}`;
  const install = (assemble: string[]) =>
    [
      `# mm-rover-setup ${kit.sha256.slice(0, 12)}`,
      `set -euo pipefail`,
      `exec 9>${LOCK_FILE}`,
      `flock -n 9 || { echo "Another rover setup is running on this board."; exit 75; }`,
      `d=${dir}`,
      `trap 'rm -rf "$d"' EXIT`,
      ...assemble,
      `echo "${kit.sha256}  $d/kit.gz" | sha256sum -c --quiet -`,
      `rm -rf "$d/kit"`,
      `python3 -I -c ${q(UNPACK_PY)} "$d/kit.gz" "$d/kit"`,
      // 9>&- so nothing the installer starts, such as the tool server, goes on holding the lock.
      [`MUSE_ROVER_USER=${q(user)} bash "$d/kit/${KIT_ENTRY}"`, ...flags.map(q), `9>&-`].join(" "),
    ].join("\n");

  const whole = install([`install -d -m 755 ${STAGE_DIR} "$d"`, `base64 -d > "$d/kit.gz" <<'KIT'`, kit.base64, `KIT`]);
  if (whole.length <= MAX_COMMAND_CHARS) return { parts: [], install: whole };

  const count = Math.ceil(kit.base64.length / PART_CHARS);
  if (count > MAX_PARTS) throw new RoverKitError("The rover kit is too large to send.");
  const parts = Array.from({ length: count }, (_, i) =>
    [
      `# mm-rover-kit ${kit.sha256.slice(0, 12)} part ${i + 1} of ${count}`,
      `set -euo pipefail`,
      `install -d -m 755 ${STAGE_DIR} ${dir}`,
      // The first part clears what an earlier setup left, here until the board restarts otherwise, unless a setup is running
      // now: that one's own folder is among them.
      ...(i === 0 ? [`if flock -n ${LOCK_FILE} true; then find ${STAGE_DIR} -mindepth 1 -maxdepth 1 ! -name ${kit.sha256} -exec rm -rf {} +; fi`] : []),
      `printf %s '${kit.base64.slice(i * PART_CHARS, (i + 1) * PART_CHARS)}' > ${dir}/part-${String(i + 1).padStart(3, "0")}`,
    ].join("\n"),
  );
  const staged = install([`cat "$d"/part-* | base64 -d > "$d/kit.gz"`]);
  for (const command of [...parts, staged]) {
    if (command.length > MAX_COMMAND_CHARS) throw new RoverKitError("A part of the kit came out too long for one exec.");
  }
  return { parts, install: staged };
}

// ---------- The fleet ----------

interface FleetTask {
  status?: unknown;
  error?: unknown;
  output?: unknown;
  result?: { exit_code?: unknown; output?: unknown } | null;
}

interface FleetJob {
  id: string;
  status: string;
  command: string;
  task: FleetTask | null;
}

function access(): { url: string; token: string } {
  const found = fleetAccess();
  if (!found) throw new RoverNotConfiguredError();
  return { url: found.url.replace(/\/+$/, ""), token: found.token };
}

async function fleet(apiPath: string, init: RequestInit, deps: RoverDeps): Promise<unknown> {
  const { url, token } = access();
  let res: Response;
  try {
    res = await deps.doFetch(`${url}${apiPath}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(CALL_MS),
      cache: "no-store",
      // The fleet's token goes only to the address that was set.
      redirect: "error",
    });
  } catch {
    throw new RoverError("The fleet can't be reached.");
  }
  // The fleet's own error text can name boards and paths, so only the status is passed on.
  if (res.status === 403) throw new RoverError("The fleet refused this. Running a command on a board needs a token with the fleet's admin role.");
  if (!res.ok) throw new RoverError(`The fleet answered ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new RoverError("The fleet's answer couldn't be read.");
  }
}

async function nodeIdOf(board: string, deps: RoverDeps): Promise<string> {
  const nodes = await fleet("/api/nodes", {}, deps);
  const node = Array.isArray(nodes) ? (nodes as Array<{ id?: unknown; name?: unknown; status?: unknown }>).find((n) => n?.name === board) : undefined;
  if (!node || typeof node.id !== "string") throw new RoverError(`The fleet has no board named ${board}.`);
  if (node.status !== "online") throw new RoverError(`${board} isn't online in the fleet.`);
  return node.id;
}

function jobOf(value: unknown): FleetJob {
  const job = value as { id?: unknown; status?: unknown; params?: { command?: unknown } | null; tasks?: unknown } | null;
  if (!job || typeof job.id !== "string" || typeof job.status !== "string") throw new RoverError("The fleet's answer couldn't be read.");
  const task = Array.isArray(job.tasks) && job.tasks[0] && typeof job.tasks[0] === "object" ? (job.tasks[0] as FleetTask) : null;
  return { id: job.id, status: job.status, command: typeof job.params?.command === "string" ? job.params.command : "", task };
}

async function launch(nodeId: string, command: string, timeoutS: number, deps: RoverDeps): Promise<string> {
  const job = jobOf(
    await fleet(`/api/nodes/${encodeURIComponent(nodeId)}/actions`, { method: "POST", body: JSON.stringify({ action: "exec", params: { command }, timeout_s: timeoutS }) }, deps),
  );
  return job.id;
}

const readJob = async (jobId: string, deps: RoverDeps) => jobOf(await fleet(`/api/jobs/${encodeURIComponent(jobId)}`, {}, deps));

/** Polls a job until it ends or `until` passes, and returns it as it last stood. */
async function waitForJob(jobId: string, until: number, deps: RoverDeps): Promise<FleetJob> {
  for (;;) {
    const job = await readJob(jobId, deps);
    if (job.status !== "running" || deps.now() >= until) return job;
    await deps.sleep(Math.max(0, Math.min(POLL_MS, until - deps.now())));
  }
}

const textOf = (value: unknown) => (typeof value === "string" ? value : "");
/** exec's ok is true even for a command that exited non-zero, so the exit code is what counts (jetson-infra's protocol.md). */
const exitOf = (job: FleetJob): number | null => (typeof job.task?.result?.exit_code === "number" ? job.task.result.exit_code : null);
const outputOf = (job: FleetJob) => textOf(job.task?.result?.output) || textOf(job.task?.output);

/** What a person may see of a board's output: no links, which can carry an address, and never a token this knows. */
export function redacted(text: string, token?: string | null): string {
  const cut = token ? text.split(token).join("[token]") : text;
  return cut.replace(/https?:\/\/[^\s"'<>]+/g, "[link]");
}

/** Why a finished job failed, in words, with the last few lines of what it printed. */
function whyFailed(job: FleetJob, what: string): string {
  const status = textOf(job.task?.status);
  if (status === "timeout") return `${what} ran out of time on the board.`;
  if (status === "offline") return `The board went offline during ${what.toLowerCase()}.`;
  const error = textOf(job.task?.error);
  if (error && exitOf(job) === null) return `The board refused ${what.toLowerCase()}: ${redacted(error).slice(0, 200)}`;
  const tail = redacted(outputOf(job))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith(REPORT_MARKER))
    .slice(-8)
    .map((line) => line.slice(0, 200))
    .join("\n");
  return `${what} exited ${exitOf(job) ?? "with an error"}.${tail ? `\n${tail}` : ""}`;
}

async function runJob(nodeId: string, command: string, timeoutS: number, what: string, deps: RoverDeps): Promise<FleetJob> {
  const id = await launch(nodeId, command, timeoutS, deps);
  const job = await waitForJob(id, deps.now() + timeoutS * 1000 + CALL_MS, deps);
  if (job.status === "running") throw new RoverError(`${what} didn't finish on the board.`);
  if (exitOf(job) !== 0) throw new RoverError(whyFailed(job, what));
  return job;
}

// ---------- The report ----------

export interface RoverCheck {
  /** setup-rover.sh's own steps, then the self-test's checks through the rover's server. */
  part: "setup" | "test";
  name: string;
  ok: boolean;
  /** The board's words, when it said more than ok. */
  detail: string | null;
}

/** What setup-rover.sh reported, with only what's safe to show. */
export interface RoverReport {
  ok: boolean;
  checks: RoverCheck[];
  /** The ranges the self-test read. */
  ranges: RoverRanges | null;
}

const MAX_CHECKS = 40;
const cap = (value: unknown, chars: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, chars) : null);

/** One step or check: the board's words, ok when they start with ok or skipped, as setup-rover.sh and selftest.py judge them. */
function checkOf(part: RoverCheck["part"], name: string, value: unknown): RoverCheck | null {
  const label = cap(name, 60);
  const said = cap(value, 300);
  if (!label || said === null) return null;
  return { part, name: label, ok: /^(?:ok|skipped)\b/.test(said), detail: said === "ok" ? null : said };
}

const entriesOf = (value: unknown): Array<[string, unknown]> => (value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []);

/**
 * The report from the last REPORT_MARKER line of a job's output, or null when there's none or it isn't a JSON object.
 * setup-rover.sh prints {ok, steps, self_test}: each step's words by name, and selftest.py's {ok, checks, seen}. It's ok
 * only when the board said so, every step and check passed, and, when `exit` is given, the setup exited 0.
 */
export function parseRoverReport(output: string, exit?: number | null, token?: string | null): RoverReport | null {
  const line = output
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(REPORT_MARKER));
  if (!line) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(redacted(line.slice(REPORT_MARKER.length), token));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { ok?: unknown; steps?: unknown; self_test?: { ok?: unknown; checks?: unknown; seen?: { ranges?: unknown } } | null };
  const test = r.self_test && typeof r.self_test === "object" ? r.self_test : null;
  const checks = [
    ...entriesOf(r.steps).map(([name, value]) => checkOf("setup", name, value)),
    ...entriesOf(test?.checks).map(([name, value]) => checkOf("test", name, value)),
  ]
    .filter((c): c is RoverCheck => c !== null)
    .slice(0, MAX_CHECKS);
  return {
    ok: r.ok === true && checks.length > 0 && checks.every((c) => c.ok) && (test === null || test.ok === true) && (exit === undefined || exit === 0),
    checks,
    ranges: rangesOf(test?.seen?.ranges),
  };
}

/** The last step setup-rover.sh printed, for the setup card while it runs. */
function stepOf(output: string): string | null {
  for (const line of output.split("\n").reverse()) {
    const step = STEP_LINE.exec(line.trimEnd());
    if (step) return redacted(`${step[1]!.replace(/_/g, " ")}: ${step[2]}`).slice(0, 120);
  }
  return null;
}

// ---------- The token ----------

/**
 * Reads the board's token and seals it to `a`, this server's public key for one read: Diffie-Hellman in RFC 3526's group 14,
 * a SHA-256 of the shared secret in hex as the key, HMAC-SHA256 blocks as the pad, and an HMAC of what it sealed. Waits a
 * little for a server that was only just started to write the token. No single quote, as UNPACK_PY.
 */
const SEAL_PY = [
  "import hashlib,hmac,json,os,pwd,secrets,sys,time",
  "user,a,p,wait=sys.argv[1],int(sys.argv[2],16),int(sys.argv[3],16),int(sys.argv[4])",
  'if not 1<a<p-1: raise SystemExit("That key is not one to seal to.")',
  'path=os.path.join(pwd.getpwnam(user).pw_dir,".muse-device","token")',
  "end=time.time()+wait",
  "while not (os.path.isfile(path) and os.path.getsize(path)>=32) and time.time()<end: time.sleep(1)",
  'if not os.path.isfile(path): raise SystemExit("The tool server has not made its token yet.")',
  't=open(path,"rb").read().strip()',
  'if not 32<=len(t)<=512: raise SystemExit("The token file is empty, cut short or too long.")',
  "x=secrets.randbits(256)|1<<255",
  'k=hashlib.sha256(format(pow(a,x,p),"x").encode()).digest()',
  's=b"".join(hmac.new(k,b"pad"+bytes([i]),"sha256").digest() for i in range(len(t)//32+1))',
  "c=bytes(i^j for i,j in zip(t,s))",
  `print("${SEALED_MARKER}"+json.dumps({"b":format(pow(2,x,p),"x"),"c":c.hex(),"m":hmac.new(k,b"mac"+c,"sha256").hexdigest()}))`,
].join("\n");

type Sealer = ReturnType<typeof getDiffieHellman>;

export function tokenCommand(sealer: Sealer, user: string = ROVER_USER, waitS: number = TOKEN_WAIT_S): string {
  return [`# mm-rover-token`, `python3 -I -c ${q(SEAL_PY)} ${q(user)} ${sealer.getPublicKey("hex")} ${sealer.getPrime("hex")} ${Math.max(0, Math.floor(waitS))}`].join("\n");
}

const hmac = (key: Buffer, ...parts: Buffer[]) => createHmac("sha256", key).update(Buffer.concat(parts)).digest();

/** The token from the board's sealed line. Throws RoverError when it's missing, doesn't open, or isn't a token. */
export function openSealedToken(output: string, sealer: Sealer): string {
  const line = output.split("\n").find((l) => l.startsWith(SEALED_MARKER));
  if (!line) throw new RoverError("The board didn't send its token back.");
  try {
    const { b, c, m } = JSON.parse(line.slice(SEALED_MARKER.length)) as { b?: unknown; c?: unknown; m?: unknown };
    if (typeof b !== "string" || typeof c !== "string" || typeof m !== "string" || ![b, c, m].every((h) => /^[0-9a-f]+$/.test(h))) throw new Error();
    const prime = BigInt(`0x${sealer.getPrime("hex")}`);
    const theirs = BigInt(`0x${b}`);
    if (theirs <= 1n || theirs >= prime - 1n) throw new Error();
    const shared = sealer.computeSecret(Buffer.from(theirs.toString(16).padStart(sealer.getPrime().length * 2, "0"), "hex"));
    const key = createHash("sha256").update(BigInt(`0x${shared.toString("hex")}`).toString(16)).digest();
    const sealed = Buffer.from(c, "hex");
    const mac = Buffer.from(m, "hex");
    if (mac.length !== 32 || !timingSafeEqual(mac, hmac(key, Buffer.from("mac"), sealed))) throw new Error();
    const pad = Buffer.concat(Array.from({ length: Math.floor(sealed.length / 32) + 1 }, (_, i) => hmac(key, Buffer.from("pad"), Buffer.from([i]))));
    const token = Buffer.from(sealed.map((byte, i) => byte ^ pad[i]!)).toString("latin1");
    if (!TOKEN_TEXT.test(token)) throw new Error();
    return token;
  } catch {
    throw new RoverError("The board's token didn't open.");
  }
}

let tokenCache: { key: string; token: string } | null = null;
let tokenRead: { key: string; promise: Promise<string> } | null = null;
let tokenFailed: { key: string; at: number; message: string } | null = null;

const cacheKey = (board: string) => `${access().url} ${board}`;

/**
 * The board's token, read through one exec and then kept in this process. `fresh` reads it again, as after a setup.
 * Several callers at once share one read, and a read that failed isn't tried again for READ_RETRY_MS.
 */
export async function roverToken(board: string, deps: Partial<RoverDeps> = {}, { fresh = false }: { fresh?: boolean } = {}): Promise<string> {
  const d = withDefaults(deps);
  const key = cacheKey(board);
  if (!fresh && tokenCache?.key === key) return tokenCache.token;
  if (tokenRead?.key === key) return tokenRead.promise;
  if (!fresh && tokenFailed?.key === key && d.now() - tokenFailed.at < READ_RETRY_MS) throw new RoverError(tokenFailed.message);
  const promise = (async () => {
    const sealer = getDiffieHellman("modp14");
    sealer.generateKeys();
    const job = await runJob(await nodeIdOf(board, d), tokenCommand(sealer), TOKEN_TIMEOUT_S, "Reading the token", d);
    return openSealedToken(outputOf(job), sealer);
  })();
  tokenRead = { key, promise };
  try {
    const token = await promise;
    tokenCache = { key, token };
    tokenFailed = null;
    return token;
  } catch (err) {
    if (tokenCache?.key === key) tokenCache = null;
    tokenFailed = { key, at: d.now(), message: err instanceof RoverError ? err.message : "The board's token couldn't be read." };
    throw err;
  } finally {
    if (tokenRead?.promise === promise) tokenRead = null;
  }
}

/** An error as a log line: no link of any kind, so not the fleet's address, and not the board's token if this holds one. */
export function roverLogText(err: unknown): string {
  return redacted(err instanceof Error ? `${err.name}: ${err.message}` : String(err), tokenCache?.token).slice(0, 300);
}

/** Whether this process holds the board's token, without reading it. */
export const roverTokenHeld = (board: string): boolean => fleetAccess() !== null && tokenCache?.key === cacheKey(board);

// ---------- Setup ----------

export type RoverSetupState =
  | { state: "running"; job: string; step: string | null }
  | { state: "done"; job: string; report: RoverReport }
  | { state: "failed"; job: string | null; message: string };

let lastReport: { key: string; report: RoverReport; at: string } | null = null;
let activeSetup: { key: string; job: string | null } | null = null;

/** The last report this process saw a setup end with, and when. */
export function lastRoverReport(board: string): { report: RoverReport; at: string } | null {
  if (fleetAccess() === null || lastReport?.key !== cacheKey(board)) return null;
  return { report: lastReport.report, at: lastReport.at };
}

/** The setup job this process sent and hasn't seen end, or null. */
export const activeRoverSetup = (board: string): string | null => (fleetAccess() !== null && activeSetup?.key === cacheKey(board) ? activeSetup.job : null);

/** Forgets the token, the report and any setup. For tests. */
export function resetRover(): void {
  tokenCache = null;
  tokenRead = null;
  tokenFailed = null;
  lastReport = null;
  activeSetup = null;
}

/**
 * Where a setup job stands, from one read of it. Only a job whose command is a rover setup's is read, so this can't show
 * another exec's output. A finished one leaves its report here and reads the board's token again, since the setup may have
 * started the board's tool server for the first time; a token that can't be read yet doesn't fail the setup.
 */
export async function roverSetupState(board: string, jobId: string, deps: Partial<RoverDeps> = {}): Promise<RoverSetupState> {
  const d = withDefaults(deps);
  if (!isJobId(jobId)) throw new RoverError("That isn't a job.");
  return settle(board, await readJob(jobId, d), d);
}

async function settle(board: string, job: FleetJob, d: RoverDeps): Promise<RoverSetupState> {
  if (!job.command.startsWith("# mm-rover-setup ")) throw new RoverError("That job isn't a rover setup.");
  const key = cacheKey(board);
  if (job.status === "running") return { state: "running", job: job.id, step: stepOf(textOf(job.task?.output)) };
  if (activeSetup?.key === key && activeSetup.job === job.id) activeSetup = null;
  // A job that ended with no exit code timed out, went offline or was refused, so its report can't say it passed.
  const report = parseRoverReport(outputOf(job), exitOf(job) ?? -1, tokenCache?.key === key ? tokenCache.token : null);
  if (!report) return { state: "failed", job: job.id, message: whyFailed(job, "The setup") };
  lastReport = { key, report, at: new Date(d.now()).toISOString() };
  await roverToken(board, d, { fresh: true }).catch(() => {});
  return { state: "done", job: job.id, report };
}

/**
 * Sends the kit to the board, runs setup-rover.sh with these changes, and waits for its report until `until` (a time in ms).
 * Past that it returns "running" with the job, for roverSetupState to follow. Throws RoverNotConfiguredError,
 * RoverBusyError, RoverKitError, RoverInputError for the changes, or RoverError.
 */
export async function setupRover(board: string, overrides: RoverOverrides | unknown = {}, deps: Partial<RoverDeps> = {}, { until }: { until?: number } = {}): Promise<RoverSetupState> {
  const d = withDefaults(deps);
  if (!BOARD_NAME.test(board)) throw new RoverError("That isn't a board name.");
  const flags = overrideFlags(overrides);
  const key = cacheKey(board);
  // A job this process sent and nobody followed to its end is settled first, so it can't hold the rover forever.
  if (activeSetup?.key === key && activeSetup.job) {
    const state = await settle(board, await readJob(activeSetup.job, d), d);
    if (state.state === "running") throw new RoverBusyError("A setup is already going on this rover.");
  }
  if (activeSetup?.key === key) throw new RoverBusyError("A setup is already going on this rover.");
  activeSetup = { key, job: null };
  try {
    const commands = setupCommands(await packRoverKit(d), flags);
    const nodeId = await nodeIdOf(board, d);
    for (const [i, part] of commands.parts.entries()) {
      await runJob(nodeId, part, PART_TIMEOUT_S, `Part ${i + 1} of ${commands.parts.length} of the kit`, d);
    }
    const job = await launch(nodeId, commands.install, SETUP_TIMEOUT_S, d);
    activeSetup = { key, job };
    return await settle(board, await waitForJob(job, until ?? d.now() + SETUP_TIMEOUT_S * 1000, d), d);
  } catch (err) {
    if (activeSetup?.key === key && activeSetup.job === null) activeSetup = null;
    throw err;
  }
}

// ---------- The rover's tools ----------

/** The MCP client follows redirects by default, and the board's token must go only to the fleet's own address. */
const noRedirect: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });

/** The rover's MCP address through the fleet, with its token. Reads the token once if this process doesn't have it. */
export async function roverDevice(board: string, deps: Partial<RoverDeps> = {}): Promise<DeviceConfig> {
  const { url } = access();
  return { url: `${url}/device/${encodeURIComponent(board)}/mcp`, token: await roverToken(board, deps) };
}

/** A board that refuses the token has a new one, so the next call reads it again. */
function forgetRefused(err: unknown): never {
  if ((err as { code?: unknown } | null)?.code === 401) tokenCache = null;
  throw err;
}

const ROVER_NAME_OF = new Map(Object.entries(BOARD_TOOL_OF).map(([rover, onBoard]) => [onBoard, rover]));

/**
 * The rover's own tools, under their rover_ names: the same server lists the board's microphone, model and training tools
 * too, and those stay out. Its capture_image is rover_photo, for the rover's camera.
 */
export async function listRoverTools(board: string, deps: Partial<RoverDeps> = {}): Promise<DeviceTool[]> {
  const config = await roverDevice(board, deps);
  const tools = await listDeviceTools(config, deps.doFetch ?? noRedirect).catch(forgetRefused);
  return tools.flatMap((tool) => {
    const name = ROVER_NAME_OF.get(tool.name);
    return name ? [{ ...tool, name, description: `On the rover: ${tool.description ?? tool.name}` }] : [];
  });
}

/** One of the rover's tools, by its rover_ name. */
export async function callRoverTool(board: string, name: string, args: Record<string, unknown>, deps: Partial<RoverDeps> = {}): Promise<DeviceToolResult> {
  if (!ROVER_TOOL_NAMES.has(name)) throw new RoverError(`${name.slice(0, 40)} isn't one of the rover's tools.`);
  const config = await roverDevice(board, deps);
  return callDeviceTool(config, BOARD_TOOL_OF[name]!, args, deps.doFetch ?? noRedirect).catch(forgetRefused);
}

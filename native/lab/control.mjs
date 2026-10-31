#!/usr/bin/env node
// The box's side of the MuseLab-Control SSM document (ssm/MuseLab-Control.json). The document passes one action from a
// fixed list and no other input, so nothing the platform sends can become a command. `reboot` is handled in the document
// itself, because it needs more rights than the lab user has.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readlink, rename, rm, statfs, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adbDevices, EMULATOR_SERIAL, tarGzExtract } from "./lib/commands.mjs";
import { labRoot } from "./lib/config.mjs";
import { downloadFile } from "./lib/download.mjs";
import { run } from "./lib/proc.mjs";

export const ACTIONS = ["status", "restart-agent", "update-agent", "cleanup", "reboot"];
export const LAUNCH_LABEL = "ai.musemuse.lab";
export const WINDOWS_TASK = "MuseLabAgent";
const VERSION = /^[A-Za-z0-9._-]{1,40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** The commands that restart the agent. */
export function restartCommands({ platform, uid }) {
  if (platform === "win32") {
    return [
      ["schtasks", "/End", "/TN", WINDOWS_TASK],
      ["schtasks", "/Run", "/TN", WINDOWS_TASK],
    ];
  }
  return [["launchctl", "kickstart", "-k", `gui/${uid}/${LAUNCH_LABEL}`]];
}

/** The commands that clear simulators and emulators. A failure is fine: there may be nothing to clear. */
export function cleanupCommands({ platform }) {
  if (platform === "win32") return [];
  return [
    ["xcrun", "simctl", "shutdown", "all"],
    ["adb", "-s", EMULATOR_SERIAL, "emu", "kill"],
  ];
}

/** The Parameter Store name that pins the agent bundle for a lane. */
export function bundleParameterName(lane) {
  return `/musemuse/lab/${lane}/bundle`;
}

/** Why a pinned bundle can't be used, or null. */
export function bundleProblem(pin) {
  if (!pin || typeof pin !== "object") return "The bundle pin isn't valid JSON.";
  if (typeof pin.version !== "string" || !VERSION.test(pin.version)) return "The bundle pin's version isn't valid.";
  if (typeof pin.sha256 !== "string" || !SHA256.test(pin.sha256)) return "The bundle pin's sha256 isn't valid.";
  if (typeof pin.url !== "string") return "The bundle pin has no URL.";
  return null;
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function restart(env, platform) {
  const uid = process.getuid?.() ?? 0;
  let code = 0;
  for (const argv of restartCommands({ platform, uid })) {
    const reply = await run(argv, { timeoutMs: 30_000, env });
    // Ending a task that isn't running fails, and that's fine.
    if (argv.includes("/Run") || platform !== "win32") code = reply.code;
  }
  return code;
}

async function status(root, env) {
  const state = await readFile(path.join(root, "data", "state.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const disk = await statfs(root).catch(() => null);
  const current = await readlink(path.join(root, "current")).catch(() => null);
  const devices = process.platform === "win32" ? null : await run(adbDevices(), { timeoutMs: 15_000, env });
  return {
    state,
    current: current ? path.basename(current) : null,
    freeBytes: disk ? disk.bavail * disk.bsize : null,
    emulator: devices ? String(devices.stdout).includes(EMULATOR_SERIAL) : null,
  };
}

async function readPin(lane, region, env) {
  const reply = await run(
    ["aws", "ssm", "get-parameter", "--name", bundleParameterName(lane), "--query", "Parameter.Value", "--output", "text", "--region", region],
    { timeoutMs: 30_000, env },
  );
  if (reply.code !== 0) throw new Error("Couldn't read the bundle pin.");
  return JSON.parse(String(reply.stdout));
}

async function update(root, env, platform) {
  const lane = env.MUSE_LAB_LANE ?? (platform === "win32" ? "windows" : "mac");
  const pin = await readPin(lane, env.AWS_REGION ?? "us-east-1", env);
  const problem = bundleProblem(pin);
  if (problem) throw new Error(problem);
  const release = path.join(root, "releases", pin.version);
  const tempDir = path.join(root, "data", "update");
  await mkdir(tempDir, { recursive: true });
  const tarball = await downloadFile(pin, { cacheDir: path.join(root, "data", "cache"), tempDir });
  if ((await sha256Of(tarball)) !== pin.sha256) throw new Error("The bundle didn't match its checksum.");
  await rm(release, { recursive: true, force: true });
  await mkdir(release, { recursive: true });
  const unpacked = await run(tarGzExtract(tarball, release), { timeoutMs: 120_000, env });
  if (unpacked.code !== 0) throw new Error("The bundle wouldn't unpack.");
  await readFile(path.join(release, "agent.mjs"));

  // Swap the link in one step on the Mac. Windows junctions can't be renamed over, so there it's two.
  const current = path.join(root, "current");
  if (platform === "win32") {
    await rm(current, { recursive: true, force: true });
    await symlink(release, current, "junction");
  } else {
    const next = `${current}.next`;
    await rm(next, { force: true });
    await symlink(release, next);
    await rename(next, current);
  }
  await rm(tempDir, { recursive: true, force: true });
  return { version: pin.version, restarted: (await restart(env, platform)) === 0 };
}

async function cleanup(root, env, platform) {
  for (const argv of cleanupCommands({ platform })) await run(argv, { timeoutMs: 60_000, env });
  await rm(path.join(root, "data", "jobs"), { recursive: true, force: true });
  // A job that was running just lost its simulator, so the agent starts over and the sweep re-queues the job.
  return { restarted: (await restart(env, platform)) === 0 };
}

async function main() {
  const action = process.argv[2];
  if (!ACTIONS.includes(action) || action === "reboot") {
    process.stderr.write(`usage: control.mjs status|restart-agent|update-agent|cleanup\n`);
    process.exit(2);
  }
  const env = process.env;
  const platform = process.platform;
  const root = labRoot({ env, platform });
  let result;
  if (action === "status") result = await status(root, env);
  if (action === "restart-agent") result = { restarted: (await restart(env, platform)) === 0 };
  if (action === "update-agent") result = await update(root, env, platform);
  if (action === "cleanup") result = await cleanup(root, env, platform);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  });
}

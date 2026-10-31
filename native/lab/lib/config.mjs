// The agent's settings, from the environment the LaunchAgent or the Windows logon script sets. No secrets live here: the
// lab token comes from Parameter Store (lib/token.mjs).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KINDS } from "./validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PLATFORM = "https://muse-muse.vercel.app";
export const POLL_SECONDS = 10;
export const HEARTBEAT_SECONDS = 15;
/** The Windows box stops itself after this long with no job. The Mac never stops: stopping scrubs it for hours. */
export const WINDOWS_IDLE_MINUTES = 20;
/** The running agent's process id, in the data folder. */
export const AGENT_PID_FILE = "agent.pid";

function agentVersion() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function isLoopback(url) {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Where the agent keeps everything of its own, per setup/mac.sh and setup/windows.ps1. */
export function labRoot({ env = process.env, platform = process.platform } = {}) {
  if (env.MUSE_LAB_ROOT) return env.MUSE_LAB_ROOT;
  return platform === "win32" ? "C:\\MuseLab" : path.join(homedir(), "musemuse-lab");
}

/**
 * @param {{ env?: Record<string, string | undefined>, platform?: string }} [opts]
 */
export function loadConfig({ env = process.env, platform = process.platform } = {}) {
  const lane = env.MUSE_LAB_LANE ?? (platform === "win32" ? "windows" : "mac");
  if (lane !== "mac" && lane !== "windows") throw new Error("MUSE_LAB_LANE must be mac or windows.");

  const platformUrl = (env.MUSE_LAB_PLATFORM ?? DEFAULT_PLATFORM).replace(/\/+$/, "");
  const parsed = new URL(platformUrl);
  // Plain http and local downloads are for a run against a local platform, and never for a real one.
  const allowInsecure = env.MUSE_LAB_ALLOW_INSECURE === "1" && isLoopback(platformUrl);
  if (parsed.protocol !== "https:" && !allowInsecure) throw new Error("MUSE_LAB_PLATFORM must use https.");

  const slots = Number(env.MUSE_LAB_SLOTS ?? 1);
  if (slots !== 1 && slots !== 2) throw new Error("MUSE_LAB_SLOTS must be 1 or 2.");

  const kinds = env.MUSE_LAB_KINDS
    ? env.MUSE_LAB_KINDS.split(",")
        .map((kind) => kind.trim())
        .filter((kind) => KINDS.includes(kind))
    : null;

  const idleDefault = lane === "windows" ? WINDOWS_IDLE_MINUTES : 0;
  const idle = env.MUSE_LAB_IDLE_MINUTES === undefined ? idleDefault : Number(env.MUSE_LAB_IDLE_MINUTES);

  const root = labRoot({ env, platform });
  return {
    lane,
    version: agentVersion(),
    platformUrl,
    platformOrigin: parsed.origin,
    allowInsecure,
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1",
    root,
    dataDir: path.join(root, "data"),
    slots,
    kinds,
    ffmpeg: env.MUSE_LAB_FFMPEG ?? null,
    idleShutdownMinutes: Number.isFinite(idle) && idle > 0 ? idle : 0,
    pollSeconds: POLL_SECONDS,
    heartbeatSeconds: HEARTBEAT_SECONDS,
    android: { avd: env.MUSE_LAB_AVD ?? "mm_pixel", deviceLabel: env.MUSE_LAB_ANDROID_LABEL ?? "Pixel 7" },
    ios: { simulator: env.MUSE_LAB_SIMULATOR ?? "Muse Lab iPhone", deviceType: env.MUSE_LAB_IPHONE_TYPE ?? null },
  };
}

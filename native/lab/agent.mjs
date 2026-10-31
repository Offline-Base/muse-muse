#!/usr/bin/env node
// The Muse Muse device lab agent (docs/NATIVE_LAB.md). It runs inside the box's GUI session as a LaunchAgent on the Mac and
// a logon Scheduled Task on Windows. It reads its lab token from Parameter Store, asks the platform for a job every 10 s
// with what it can run, heartbeats every 15 s while a job runs, uploads through presigned slots, then calls finish. The
// box takes no inbound connections.
import { mkdir, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./lib/api.mjs";
import { loadConfig } from "./lib/config.mjs";
import { windowsShutdown } from "./lib/commands.mjs";
import { executeJob } from "./lib/execute.mjs";
import { createLogger } from "./lib/log.mjs";
import { run, sleep as sleepFor } from "./lib/proc.mjs";
import { readLabToken } from "./lib/token.mjs";
import { probeCapabilities } from "./lib/tools.mjs";
import { claimableKinds } from "./lib/validate.mjs";

const PROBE_EVERY_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60_000;

/** How long to wait after the claim call failed `failures` times in a row, in ms. */
export function backoffMs(failures, retryAfterMs = null) {
  const exponential = Math.min(BACKOFF_MAX_MS, 5000 * 2 ** Math.max(0, failures - 1));
  return retryAfterMs ? Math.min(BACKOFF_MAX_MS * 5, Math.max(retryAfterMs, exponential)) : exponential;
}

/** Should the box stop itself? Only when it's enabled, nothing is running and it's been idle long enough. */
export function shouldShutDown({ idleMinutes, lastBusyAt, now, running }) {
  if (!idleMinutes || running > 0) return false;
  return now - lastBusyAt >= idleMinutes * 60_000;
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.api
 * @param {object} deps.log
 * @param {() => Promise<{ kinds: string[], tools: object }>} deps.probe
 * @param {(job: object, opts: { stopSignal: AbortSignal }) => Promise<object>} deps.execute
 * @param {() => number} [deps.now]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {() => Promise<void>} [deps.shutdownBox]
 * @param {(state: object) => Promise<void>} [deps.writeState]
 */
export function createAgent({ config, api, log, probe, execute, now = Date.now, sleep = sleepFor, shutdownBox = async () => {}, writeState = async () => {} }) {
  const stop = new AbortController();
  /** @type {Map<string, { kind: string, done: Promise<void> }>} */
  const running = new Map();
  let capabilities = { kinds: [], tools: {} };
  let probedAt = 0;
  let lastBusyAt = now();
  let failures = 0;
  let shuttingDown = false;

  const launch = (job) => {
    const id = String(job?.id ?? `job-${now()}`);
    const done = Promise.resolve()
      .then(() => execute(job, { stopSignal: stop.signal }))
      .catch((err) => log.error("job crashed", { job: id, error: String(err?.message ?? err) }))
      .finally(() => {
        running.delete(id);
        lastBusyAt = now();
      });
    running.set(id, { kind: String(job?.kind), done });
  };

  const stateNow = () => ({
    lane: config.lane,
    version: config.version,
    slots: config.slots,
    running: [...running.keys()],
    capabilities,
    lastBusyAt: new Date(lastBusyAt).toISOString(),
    at: new Date(now()).toISOString(),
  });

  /** One pass of the loop. Returns how long to wait before the next. */
  const tick = async () => {
    const started = now();
    if (running.size === 0 && started - probedAt >= PROBE_EVERY_MS) {
      capabilities = await probe();
      probedAt = started;
      log.info("capabilities", { kinds: capabilities.kinds, tools: capabilities.tools });
    }
    const runningKinds = [...running.values()].map((job) => job.kind);
    const kinds = claimableKinds(capabilities.kinds, runningKinds, config.slots);
    await writeState(stateNow()).catch(() => {});
    let job = null;
    try {
      job = await api.claim({
        lane: config.lane,
        version: config.version,
        kinds,
        slots: config.slots,
        running: [...running.keys()],
        capabilities: capabilities.tools,
        // An empty `kinds` is only a presence ping, so the platform answers at once.
        waitSeconds: kinds.length > 0 ? config.pollSeconds : 0,
      }, { signal: stop.signal });
      failures = 0;
    } catch (err) {
      if (stop.signal.aborted) return 0;
      failures += 1;
      log.warn("claim failed", { status: err?.status ?? null, code: err?.code ?? null, error: String(err?.message ?? err) });
      return backoffMs(failures, err?.retryAfterMs ?? null);
    }
    if (job) {
      lastBusyAt = now();
      launch(job);
      return 0;
    }
    if (shouldShutDown({ idleMinutes: config.idleShutdownMinutes, lastBusyAt, now: now(), running: running.size })) {
      log.info("idle shutdown", { minutes: config.idleShutdownMinutes });
      shuttingDown = true;
      await shutdownBox();
      return 0;
    }
    return Math.max(0, started + config.pollSeconds * 1000 - now());
  };

  return {
    tick,
    running,
    stop: () => stop.abort(),
    get stopping() {
      return stop.signal.aborted;
    },
    /** Runs until stop(), then waits for running jobs to report. */
    async run() {
      while (!stop.signal.aborted && !shuttingDown) {
        const wait = await tick();
        if (wait > 0) await sleep(wait, stop.signal);
      }
      await Promise.all([...running.values()].map((job) => job.done));
    },
  };
}

async function main() {
  const config = loadConfig();
  const log = createLogger();
  await mkdir(config.dataDir, { recursive: true });
  // Whatever an earlier agent left. Its jobs are already the sweep's to re-queue.
  await rm(path.join(config.dataDir, "jobs"), { recursive: true, force: true });

  const readToken = async () => {
    const token = await readLabToken({ lane: config.lane, region: config.region });
    log.addSecret(token);
    return token;
  };
  let token = null;
  const api = createApi({
    platform: config.platformUrl,
    getLabToken: async () => (token ??= await readToken()),
    refreshLabToken: async () => (token = await readToken()),
  });

  const stateFile = path.join(config.dataDir, "state.json");
  const agent = createAgent({
    config,
    api,
    log,
    probe: () => probeCapabilities(config),
    execute: (job, { stopSignal }) => executeJob(job, { config, api, log, stopSignal }),
    writeState: async (state) => {
      const disk = await statfs(config.dataDir).catch(() => null);
      await writeFile(stateFile, JSON.stringify({ ...state, freeBytes: disk ? disk.bavail * disk.bsize : null }));
    },
    shutdownBox: async () => {
      await run(windowsShutdown(), { timeoutMs: 30_000 });
    },
  });

  const onSignal = () => agent.stop();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  log.info("agent started", { lane: config.lane, version: config.version, platform: config.platformUrl });
  await agent.run();
  log.info("agent stopped");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  });
}

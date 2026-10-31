// Running tools. Always an argv array, never a shell, so nothing from a job can become a command. A timed-out or aborted
// tool is killed with its children.
import { spawn } from "node:child_process";
import { closeSync, createWriteStream, openSync } from "node:fs";

const WINDOWS = process.platform === "win32";

function killTree(child, signal = "SIGTERM") {
  if (!child.pid) return;
  if (WINDOWS) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // It already exited.
    }
  }
}

/**
 * Runs a tool to the end. It never rejects because of the tool: a missing binary gives `code: -1` and `spawnError`, a
 * nonzero exit gives that code, and a timeout gives `timedOut: true`.
 *
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.cwd]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {string} [opts.stdoutFile] send stdout there instead of keeping it
 * @param {boolean} [opts.binary] keep stdout as a Buffer
 * @param {boolean} [opts.windowsHide] false for a GUI app on Windows, where hiding can stop its window from drawing
 * @param {number} [opts.maxBytes] how much of stdout and of stderr to keep
 * @returns {Promise<{ code: number, stdout: string | Buffer, stderr: string, timedOut: boolean, aborted: boolean, spawnError?: string }>}
 */
export function run(argv, opts = {}) {
  const { timeoutMs = 60_000, signal, cwd, env, stdoutFile, binary = false, maxBytes = 2_000_000, windowsHide = true } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env ?? process.env,
        detached: !WINDOWS,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide,
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: "", timedOut: false, aborted: false, spawnError: String(err?.message ?? err) });
      return;
    }
    const out = [];
    const errs = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const file = stdoutFile ? createWriteStream(stdoutFile) : null;
    if (file) child.stdout.pipe(file);
    else {
      child.stdout.on("data", (chunk) => {
        if (outBytes < maxBytes) out.push(chunk);
        outBytes += chunk.length;
      });
    }
    child.stderr.on("data", (chunk) => {
      if (errBytes < maxBytes) errs.push(chunk);
      errBytes += chunk.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child, "SIGKILL");
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const stdout = binary ? Buffer.concat(out) : Buffer.concat(out).toString("utf8");
      const result = { code, stdout, stderr: Buffer.concat(errs).toString("utf8"), timedOut, aborted };
      if (spawnError) result.spawnError = spawnError;
      if (file) file.end(() => resolve(result));
      else resolve(result);
    };
    child.on("error", (err) => finish(-1, String(err?.message ?? err)));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/**
 * Starts a tool that keeps running, like a recorder. `stop()` sends SIGINT so the tool can finish its file, waits, then
 * kills it. `detach: true` leaves it running after the agent exits, for the emulator.
 *
 * @param {string[]} argv
 * @param {{ signal?: AbortSignal, env?: Record<string, string | undefined>, cwd?: string, detach?: boolean, logFile?: string }} [opts]
 */
export function start(argv, opts = {}) {
  const { signal, env, cwd, detach = false, logFile } = opts;
  // A detached tool outlives the agent, so it writes straight to its log. A pipe to the agent would break when the agent
  // restarts, and the write would kill it.
  const logFd = detach ? openSync(logFile ?? (WINDOWS ? "NUL" : "/dev/null"), "a") : null;
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: env ?? process.env,
    detached: !WINDOWS,
    stdio: detach ? ["ignore", logFd, logFd] : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (logFd !== null) closeSync(logFd);
  const lines = [];
  const log = logFile && !detach ? createWriteStream(logFile, { flags: "a" }) : null;
  const capture = (chunk) => {
    const text = chunk.toString("utf8");
    if (lines.length < 2000) lines.push(text);
    log?.write(text);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let exited = false;
  let exitCode = null;
  const closed = new Promise((resolve) => {
    child.on("error", () => {
      exited = true;
      exitCode = -1;
      log?.end();
      resolve(-1);
    });
    child.on("close", (code) => {
      exited = true;
      exitCode = code ?? -1;
      log?.end();
      resolve(exitCode);
    });
  });
  const onAbort = () => killTree(child, "SIGKILL");
  if (!detach) signal?.addEventListener("abort", onAbort, { once: true });
  if (detach) child.unref();
  return {
    pid: child.pid,
    closed,
    get exited() {
      return exited;
    },
    get exitCode() {
      return exitCode;
    },
    output: () => lines.join(""),
    /** SIGINT, then up to `waitMs` for it to finish, then SIGKILL. Resolves to the exit code. */
    stop: async (waitMs = 10_000) => {
      if (!exited) {
        try {
          child.kill("SIGINT");
        } catch {
          // It already exited.
        }
      }
      const timer = setTimeout(() => killTree(child, "SIGKILL"), waitMs);
      const code = await closed;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      return code;
    },
    kill: () => killTree(child, "SIGKILL"),
  };
}

/** Waits, and wakes early when aborted. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

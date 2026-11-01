import { randomBytes } from "node:crypto";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";

/**
 * The launcher for the code cap's sandboxes (docs/CAPABILITIES.md, sections 15, 15a and 15b).
 *
 * General won't build a shared lib/sandbox/session.ts before Nov 4 (General, Oct 31 ~00:05), so this is the real
 * launcher, and wave 3 owns its interface. /exec and /browse use launchSession and stopSession for short runs. Muse Code
 * sessions (15b) use launchLongSession and openSession: a session outlives the request that started it, so it needs a
 * command left running on its own, capped reads of a log that grows, and the same sandbox again by name from a later
 * request. The handlers only ever get a launcher through their deps.
 *
 * Each session is a fresh, non-persistent sandbox: nothing carries over from one run to the next, and stopSession
 * deletes it. Its own `timeout` stops it even if the function that started it dies.
 */

export interface SessionSpec {
  /** What it's for, in the sandbox's tags and name. "musecode" is a Muse Code session (15b). */
  purpose: "exec" | "browse" | "musecode";
  /** The sandbox's name, when the caller must record it before the sandbox exists (a Muse Code session does). */
  name?: string;
  /** More tags after app, role and product (Vercel allows 5 in all). */
  tags?: Record<string, string>;
  /** A snapshot to start from, or Vercel's own image when null. */
  snapshotId: string | null;
  networkPolicy: NetworkPolicy;
  vcpus: number;
  /** The sandbox stops itself after this, whatever happens to the caller. */
  timeoutMs: number;
  /** Starting the sandbox is given up after this, so a stalled create can't hold the route's slots. */
  createTimeoutMs: number;
  /**
   * Every call on the session (create, writes, the run, reads) is cut off this long after launch, so the whole run ends
   * well inside the route's maxDuration and its finally blocks always give the slots back.
   */
  deadlineMs: number;
  productId: string;
}

export interface SessionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodeSession {
  readonly name: string;
  writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<void>;
  /**
   * Runs a command and waits for it, killing it after timeoutMs. With maxOutputBytes, reads at most that much of its
   * output: for anything run after an agent, which could flood it (or replace the command).
   */
  run(cmd: string, args: string[], opts: { timeoutMs: number; cwd?: string; maxOutputBytes?: number }): Promise<SessionResult>;
  readFile(path: string): Promise<Buffer | null>;
}

export type LaunchSession = (spec: SessionSpec) => Promise<CodeSession & { stop(): Promise<void> }>;

/** A session that outlives one request (15b). */
export interface LongSession extends CodeSession {
  /** Starts a command and returns at once. `env` goes to that command's environment only, never into a file. */
  startDetached(cmd: string, args: string[], opts: { env?: Record<string, string>; cwd?: string }): Promise<{ cmdId: string }>;
  /** At most `maxBytes` of a file from byte `offset` on, or null when it's missing. Never reads past the cap. */
  readPart(path: string, offset: number, maxBytes: number): Promise<Buffer | null>;
  stop(): Promise<void>;
}

export type LaunchLongSession = (spec: SessionSpec) => Promise<LongSession>;
export type OpenSession = (name: string, opts?: { deadlineMs?: number }) => Promise<LongSession | null>;

/** Stopping and deleting get this long each, after the deadline too. */
const STOP_TIMEOUT_MS = 10_000;

/** Starts a sandbox for one run. */
export const launchSession: LaunchSession = (spec) => launchLongSession(spec);

/** Starts a sandbox and returns the longer handle. */
export const launchLongSession: LaunchLongSession = async (spec) => {
  const name = spec.name ?? `mm-${spec.purpose}-${randomBytes(6).toString("hex")}`;
  const deadline = AbortSignal.timeout(spec.deadlineMs);
  const signal = deadline;
  const common = {
    name,
    persistent: false,
    resources: { vcpus: spec.vcpus },
    timeout: spec.timeoutMs,
    networkPolicy: spec.networkPolicy,
    // No env: a run gets no secrets. A Muse Code session's own token goes to its one command (startDetached).
    env: {},
    tags: { app: "musemuse", role: `cap-${spec.purpose}`, product: spec.productId, ...(spec.tags ?? {}) },
    signal: AbortSignal.any([deadline, AbortSignal.timeout(spec.createTimeoutMs)]),
  };
  const sandbox = spec.snapshotId ? await Sandbox.create({ ...common, source: { type: "snapshot", snapshotId: spec.snapshotId } }) : await Sandbox.create(common);
  return handleFor(sandbox, name, signal);
};

/** The handle for a sandbox, with every call cut off by `signal`. */
function handleFor(sandbox: Sandbox, name: string, signal: AbortSignal): LongSession {
  return {
    name,
    async writeFiles(files) {
      await sandbox.writeFiles(files.map((f) => ({ path: f.path, content: f.content })), { signal });
    },
    async run(cmd, args, opts) {
      const done = await sandbox.runCommand({ cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}), env: {}, timeoutMs: opts.timeoutMs, signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs + 5_000)]) });
      if (opts.maxOutputBytes !== undefined) return { exitCode: done.exitCode, ...(await cappedOutput(done, opts.maxOutputBytes, signal)) };
      return { exitCode: done.exitCode, stdout: await done.stdout({ signal }), stderr: await done.stderr({ signal }) };
    },
    async readFile(path) {
      return sandbox.readFileToBuffer({ path }, { signal }).catch(() => null);
    },
    async startDetached(cmd, args, opts) {
      const started = await sandbox.runCommand({ cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}), env: opts.env ?? {}, detached: true, signal });
      return { cmdId: started.cmdId };
    },
    async readPart(path, offset, maxBytes) {
      const stream = await sandbox.readFile({ path }, { signal }).catch(() => null);
      if (!stream) return null;
      return readCapped(stream, Math.max(0, Math.floor(offset)), Math.max(0, Math.floor(maxBytes)));
    },
    async stop() {
      await stopSession(sandbox);
    },
  };
}

/** Bytes [offset, offset + maxBytes) of a stream, then lets go of it, so a huge file is never read whole. */
export async function readCapped(stream: AsyncIterable<Buffer | string> | NodeJS.ReadableStream, offset: number, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let seen = 0;
  let kept = 0;
  if (maxBytes > 0) {
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      const start = Math.max(0, offset - seen);
      seen += buf.length;
      if (start >= buf.length) continue;
      const take = buf.subarray(start, start + (maxBytes - kept));
      parts.push(take);
      kept += take.length;
      if (kept >= maxBytes) break;
    }
  }
  (stream as { destroy?: () => void }).destroy?.();
  return Buffer.concat(parts);
}

/** A command's output, at most `maxBytes` in all, then it lets go. The stream stops at the cap, however much more comes. */
export async function cappedOutput(command: { logs(opts?: { signal?: AbortSignal }): AsyncIterable<{ stream: string; data: string }> }, maxBytes: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const kept = { stdout: "", stderr: "" };
  let left = maxBytes;
  for await (const line of command.logs(signal ? { signal } : {})) {
    const part = line.data.slice(0, left);
    if (line.stream === "stderr") kept.stderr += part;
    else kept.stdout += part;
    left -= part.length;
    if (left <= 0) break;
  }
  return kept;
}

/** A sandbox in one of these has nothing left to read. */
const SANDBOX_GONE = new Set(["stopping", "stopped", "failed", "aborted"]);
/** Not found, or gone for good. */
const isGone = (err: unknown) => [404, 410].includes((err as { response?: { status?: number } } | null)?.response?.status ?? 0);

/**
 * The same sandbox again, from a later request. Null means it's really gone: anything else, such as the Sandbox API
 * failing for a moment, is thrown, so the caller can try again rather than end a healthy session.
 */
export function openSessionWith(get: (opts: { name: string; signal: AbortSignal }) => Promise<Sandbox>): OpenSession {
  return async (name, opts = {}) => {
    const signal = AbortSignal.timeout(opts.deadlineMs ?? 60_000);
    let sandbox: Sandbox;
    try {
      sandbox = await get({ name, signal });
    } catch (err) {
      if (isGone(err)) return null;
      throw err;
    }
    return SANDBOX_GONE.has(sandbox.status) ? null : handleFor(sandbox, name, signal);
  };
}

/** The same sandbox again, or null when it's gone. Every call is cut off after `deadlineMs`. Throws when it can't tell. */
export const openSession: OpenSession = openSessionWith((opts) => Sandbox.get(opts));

/** Stops and deletes a session's sandbox, each in at most 10 s. Never throws: the sandbox's own timeout is the backstop. */
export async function stopSession(sandbox: Pick<Sandbox, "stop" | "delete">): Promise<void> {
  await sandbox.stop({ signal: AbortSignal.timeout(STOP_TIMEOUT_MS) }).catch(() => undefined);
  await sandbox.delete({ signal: AbortSignal.timeout(STOP_TIMEOUT_MS) }).catch(() => undefined);
}

/** Stops and deletes a sandbox by name, for the sweep. True when one was found. Never throws. */
export async function stopSessionByName(name: string): Promise<boolean> {
  const sandbox = await Sandbox.get({ name, signal: AbortSignal.timeout(STOP_TIMEOUT_MS) }).catch(() => null);
  if (!sandbox) return false;
  await stopSession(sandbox);
  return true;
}

/** Names of running sandboxes with this role tag (cap-musecode), for the sweep's orphan check. */
export async function sandboxesWithRole(role: string): Promise<string[]> {
  // Vercel takes one tag filter at a time; the role names this platform's session sandboxes alone.
  const page = await Sandbox.list({ tags: { role } });
  const all = (await page.toArray()) as unknown as Array<{ name?: string; status?: string }>;
  return all.filter((s) => s.name && (s.status === undefined || s.status === "running" || s.status === "pending")).map((s) => s.name!);
}

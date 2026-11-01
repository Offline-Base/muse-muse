import { randomBytes } from "node:crypto";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";

/**
 * The smallest launcher for the code cap's short-lived sandboxes (docs/CAPABILITIES.md, section 15).
 *
 * STAND-IN. The plan (~/mm-wt/_plan/wave3.md, "Unit 9 does Pyodide, QuickJS, /exec and browser automation only") says
 * /exec imports General's shared launcher, lib/sandbox/session.ts. That file didn't exist on tuned-model-options or in
 * ~/mm-wt/musecode when this unit was built (Nov 1), so this one keeps to two calls, launchSession and stopSession,
 * behind the CodeSession interface. When General's launcher lands, this file becomes a thin adapter over it and nothing
 * else in lib/caps/code changes: the handlers only ever get a launcher through their deps.
 *
 * Each session is a fresh, non-persistent sandbox: nothing carries over from one run to the next, and stopSession
 * deletes it. Its own `timeout` stops it even if the function that started it dies.
 */

export interface SessionSpec {
  /** What it's for, in the sandbox's tags and name. */
  purpose: "exec" | "browse";
  /** A snapshot to start from, or Vercel's own image when null. */
  snapshotId: string | null;
  networkPolicy: NetworkPolicy;
  vcpus: number;
  /** The sandbox stops itself after this, whatever happens to the caller. */
  timeoutMs: number;
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
  /** Runs a command and waits for it, killing it after timeoutMs. */
  run(cmd: string, args: string[], opts: { timeoutMs: number; cwd?: string }): Promise<SessionResult>;
  readFile(path: string): Promise<Buffer | null>;
}

export type LaunchSession = (spec: SessionSpec) => Promise<CodeSession & { stop(): Promise<void> }>;

/** Starts a sandbox for one run. */
export const launchSession: LaunchSession = async (spec) => {
  const name = `mm-${spec.purpose}-${randomBytes(6).toString("hex")}`;
  const common = {
    name,
    persistent: false,
    resources: { vcpus: spec.vcpus },
    timeout: spec.timeoutMs,
    networkPolicy: spec.networkPolicy,
    // No env: a run gets no secrets.
    env: {},
    tags: { app: "musemuse", role: `cap-${spec.purpose}`, product: spec.productId },
  };
  const sandbox = spec.snapshotId ? await Sandbox.create({ ...common, source: { type: "snapshot", snapshotId: spec.snapshotId } }) : await Sandbox.create(common);
  return {
    name,
    async writeFiles(files) {
      await sandbox.writeFiles(files.map((f) => ({ path: f.path, content: f.content })));
    },
    async run(cmd, args, opts) {
      const done = await sandbox.runCommand({ cmd, args, ...(opts.cwd ? { cwd: opts.cwd } : {}), env: {}, timeoutMs: opts.timeoutMs });
      return { exitCode: done.exitCode, stdout: await done.stdout(), stderr: await done.stderr() };
    },
    async readFile(path) {
      return sandbox.readFileToBuffer({ path }).catch(() => null);
    },
    async stop() {
      await stopSession(sandbox);
    },
  };
};

/** Stops and deletes a session's sandbox. Never throws: the sandbox's own timeout is the backstop. */
export async function stopSession(sandbox: Pick<Sandbox, "stop" | "delete">): Promise<void> {
  await sandbox.stop().catch(() => undefined);
  await sandbox.delete().catch(() => undefined);
}

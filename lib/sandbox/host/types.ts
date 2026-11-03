import type { NetworkPolicy, Sandbox } from "@vercel/sandbox";

/**
 * The part of a build sandbox that lib/sandbox/builder.ts uses, so a build can run on Vercel Sandbox (the default) or on
 * Modal (SANDBOX_HOST=modal, docs/MODAL_HOST.md). It is shaped like @vercel/sandbox's own Sandbox, which fits it as it
 * is, so the Vercel host hands back the SDK's object untouched and a build with the flag unset runs exactly as before.
 */
export interface HostRunParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  timeoutMs?: number;
}

/** A command that ran to the end. */
export interface HostCommandResult {
  exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

/** A detached command, found again later by its id. */
export interface HostCommand {
  readonly cmdId: string;
  /** Null while it runs. Vercel also reports null for a finished one until something waits on it. */
  readonly exitCode: number | null;
  /** Resolves when it ends. Rejects when `signal` aborts first. */
  wait(params?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export interface HostSandbox {
  readonly name: string;
  readonly tags: Record<string, string> | undefined;
  /** "running" while it has a live session. Vercel's getter can throw, so callers wrap it. */
  readonly status: string;
  /** When the session ends, when the host knows. */
  readonly expiresAt: Date | undefined;
  extendTimeout(durationMs: number): Promise<void>;
  update(params: { tags?: Record<string, string>; networkPolicy?: NetworkPolicy }): Promise<void>;
  writeFiles(files: Array<{ path: string; content: string | Uint8Array; mode?: number }>): Promise<void>;
  /** Null when the file isn't there. */
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  runCommand(params: HostRunParams & { detached: true }): Promise<HostCommand>;
  runCommand(params: HostRunParams): Promise<HostCommandResult>;
  getCommand(cmdId: string): Promise<HostCommand>;
  /** The public https URL of `port`. Sync on Vercel, async on Modal (it asks for the tunnel). */
  domain(port: number): string | Promise<string>;
  /** Ends the session and keeps the files, so get({ resume: true }) can bring it back. */
  stop(): Promise<unknown>;
  /** Ends it for good. */
  delete(): Promise<void>;
}

/** What provisionSandbox and warmSandbox pass: @vercel/sandbox's getOrCreate params. Modal reads the fields it knows. */
export type HostCreateParams = NonNullable<Parameters<typeof Sandbox.getOrCreate>[0]>;
/** What the dry-run and Prove it copies pass: @vercel/sandbox's fork params. */
export type HostForkParams = Parameters<typeof Sandbox.fork>[0];

export interface SandboxHostApi {
  readonly name: "vercel" | "modal";
  /** A named sandbox. With `resume`, a stopped one is started again from its last snapshot. */
  get(params: { name: string; resume?: boolean }): Promise<HostSandbox>;
  getOrCreate(params: HostCreateParams): Promise<HostSandbox>;
  fork(params: HostForkParams): Promise<HostSandbox>;
  /** True for this host's "no such sandbox or command" error. */
  isNotFound(err: unknown): boolean;
}

// The Vercel SDK's Sandbox must keep fitting HostSandbox, or the Vercel host couldn't hand it back untouched.
type Fits<T extends HostSandbox> = T;
export type VercelSandboxFits = Fits<Sandbox>;

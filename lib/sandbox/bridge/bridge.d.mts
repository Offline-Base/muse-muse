/** Types for bridge.mjs, the session bridge that runs inside a builder sandbox. See the comments in bridge.mjs. */
import type { BridgeConfig, MuseCommand } from "../bridge-protocol";

export declare const EXIT: Readonly<{ completed: 0; failed: 1; usage: 2 }>;
export declare const POLL_MS: number;
export declare const SETTLE_MS: number;
export declare const INTERRUPT_WAIT_MS: number;
export declare const QUIET_MS: number;
export declare const MAX_IMAGE_BYTES: number;
export declare const MAX_IMAGES_BYTES: number;

/** One MSP notification or server request as the SDK delivers it. */
export interface BridgeFrame {
  method: string;
  params?: unknown;
}

/** What runBridge needs from a connection to `muse serve`. The real one wraps @muse-code/sdk's spawnMspConnection. */
export interface BridgeConnection {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  onNotification(handler: (frame: BridgeFrame) => void): void;
  /** Resolves with the answer to send back: `{}`, the receipt. */
  onServerRequest(handler: (frame: BridgeFrame) => Promise<Record<string, unknown>>): void;
  close(): Promise<unknown>;
  /** Settles when the host process ends. */
  exited?: Promise<{ code: number | null; signal: string | null }>;
  /** A fresh UUIDv7 command id. */
  mint(): string;
}

export interface BridgeFs {
  /** Synchronous, so log lines keep their order. */
  append(file: string, text: string): void;
  readText(file: string): Promise<string>;
  readBytes(file: string): Promise<Uint8Array>;
  /** Names in a folder, [] when it doesn't exist. */
  list(dir: string): Promise<string[]>;
  move(from: string, to: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
}

export interface BridgeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface RunBridgeInput {
  config: BridgeConfig | unknown;
  fs: BridgeFs;
  clock: BridgeClock;
  connect?: (args: string[], hooks: { stderr(text: string): void }) => Promise<BridgeConnection>;
  connection?: BridgeConnection;
  signal?: AbortSignal;
}

export declare function configProblem(config: unknown): string | null;
export declare function serveArgs(config: BridgeConfig): string[];
export declare function commandProblem(command: MuseCommand | unknown): string | null;
export declare function firstTurnInput(
  config: BridgeConfig,
  fs: BridgeFs,
): Promise<{ input: Array<Record<string, unknown>>; left: string[] }>;
/** Runs one round and resolves to its exit code. Never rejects, and always ends the log with the exit record. */
export declare function runBridge(input: RunBridgeInput): Promise<number>;

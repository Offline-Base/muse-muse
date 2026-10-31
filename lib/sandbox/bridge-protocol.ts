/**
 * The contract between the platform and the Muse Code session bridge that runs inside a builder sandbox
 * (docs/MUSE_CODE_FULL.md). The bridge drives `muse serve` over the Muse Session Protocol with @muse-code/sdk, writes
 * every protocol frame it sees to a JSONL log the platform polls, and reads commands the platform drops into a mailbox
 * folder. Types and paths only, so the routes, the workflow, the bridge's tests and the build room can share them.
 */

/** Which engine runs a build's Muse Code turns: the session bridge over `muse serve`, or one-shot `muse exec`. */
export type MuseEngine = "serve" | "exec";

/** One answer to a question the agent asked (MSP `userInput/answer`), one per question. */
export interface MuseAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
}

/**
 * What the platform can ask a running session to do. Every one comes from the build's owner in the build room, or from
 * the platform itself (an end after a time cap). Model output never becomes a command.
 */
export type MuseCommand =
  /** Into the running turn now (MSP `turn/steer`), or as the next turn when nothing is running. */
  | { type: "steer"; text: string }
  /** After the current turn finishes (MSP `turn/start` with `ifBusy: "queue"`). */
  | { type: "queue"; text: string }
  /** Stop the running turn (MSP `turn/interrupt`). The session stays open for more commands. */
  | { type: "interrupt" }
  | { type: "goal"; action: "set" | "edit"; objective: string }
  | { type: "goal"; action: "pause" | "resume" | "clear" }
  /** Answer a question the agent asked (MSP `userInput/answer`). */
  | { type: "answer"; userInputId: string; answers: MuseAnswer[] }
  | { type: "workflow"; action: "pause" | "resume" | "cancel"; workflowId?: string }
  | { type: "subagent"; action: "message" | "interrupt" | "stop"; childSessionId: string; text?: string }
  /** Finish: interrupt anything running, close the session and exit the bridge. */
  | { type: "end"; reason?: string };

/** A command as it sits in the mailbox: one JSON file per command, named `<at>-<id>.json`, read in name order. */
export interface MuseCommandEnvelope {
  /** A random id, so a command delivered twice is applied once. */
  id: string;
  /** ISO time the platform wrote it. */
  at: string;
  by: "owner" | "platform";
  command: MuseCommand;
}

/**
 * One line of the bridge's JSONL log. `note` is a server notification as received, `call` a request the bridge made
 * and its answer, `command` a mailbox command it applied (or refused), `stderr` raw host stderr, and `bridge` the
 * bridge's own lifecycle: started, session, exit. The final line of a run is always `{ kind: "bridge", event: "exit" }`.
 */
export type BridgeLogRecord =
  | { t: number; kind: "note"; method: string; params?: unknown }
  | { t: number; kind: "call"; method: string; ok: boolean; result?: unknown; error?: { message: string; code?: number; kind?: string } }
  | { t: number; kind: "command"; id: string; command: MuseCommand; ok: boolean; error?: string }
  | { t: number; kind: "stderr"; text: string }
  | {
      t: number;
      kind: "bridge";
      event: "started" | "session" | "turn" | "idle" | "exit";
      sessionId?: string;
      turnId?: string;
      /** For "exit": 0 when the last turn completed, 1 when it failed or was interrupted, 2 for a usage or config error. */
      exitCode?: number;
      /** For "exit": the last agent message, for the build room's "Done." line and the fix prompt. */
      finalText?: string;
      /** For "exit": the goal as it ended, when one was set. */
      goal?: { objective: string; status: string; percentComplete?: number } | null;
      reason?: string;
    };

/** Where a round's bridge files live in the sandbox. Under the platform's own folder, outside the product. */
export function bridgePaths(round: number): { log: string; mailbox: string; err: string } {
  const r = Math.max(0, Math.floor(round));
  return {
    log: `/vercel/musemuse/logs/muse-r${r}.msp.jsonl`,
    mailbox: `/vercel/musemuse/mailbox/r${r}`,
    err: `/vercel/musemuse/logs/muse-r${r}.msp.err`,
  };
}

/** The pinned SDK: it versions in lockstep with Muse Code, so it must match the builder's Muse Code (1.4.14). */
export const MUSE_SDK_VERSION = "1.4.14";

/** Where the bridge script and its SDK live in the sandbox. */
export const BRIDGE_DIR = "/vercel/musemuse/bridge";

/** The bridge script (lib/sandbox/bridge/bridge.mjs), written by the platform before every start. */
export const BRIDGE_SCRIPT = `${BRIDGE_DIR}/bridge.mjs`;

/** Where a round's bridge config lives in the sandbox: `node bridge.mjs <this path>`. */
export function bridgeConfigPath(round: number): string {
  return `${BRIDGE_DIR}/config-r${Math.max(0, Math.floor(round))}.json`;
}

/**
 * What the platform writes for one bridge run, the bridge's only argument. Paths are absolute inside the sandbox. The
 * bridge refuses a config that misses a field (exit 2), so a round that can't run on it falls back to `muse exec`.
 */
export interface BridgeConfig {
  /** The session's workspace root, the product (PRODUCT_DIR). */
  workspace: string;
  /** The build's session UUID, kept across rounds: resumed when it exists, otherwise started with this id. */
  sessionId: string;
  model: string;
  /** For every turn the bridge starts, and the session's default for the turns Muse Code starts itself. */
  reasoningEffort: string;
  /** The prompt file (brief.md, fix-<n>.md, refine-<n>.md): its text is the first turn. */
  promptFile: string;
  /** Images attached to the first turn. Missing ones are skipped, as `muse exec --image` is. */
  images: string[];
  /** The goal's objective (MSP goal/set), or null to set none. */
  goal: string | null;
  /** `muse serve -c` settings, each "key=jsonValue". */
  settings: string[];
  /** Adds --disable-request-user-input, as exec runs always do. */
  disableRequestUserInput: boolean;
  /** bridgePaths(round).log */
  logPath: string;
  /** bridgePaths(round).mailbox */
  mailboxDir: string;
  /** Model steps the round may take in all, like `muse exec --max-model-steps`: the bridge stops the turn at the cap. */
  maxModelSteps: number;
  /**
   * How long the bridge stays open with nothing running before it exits: after a stop, while a goal waits, or while a
   * workflow is paused. A workflow or subagent still at work keeps it open with no such limit, as `muse exec` waits.
   */
  idleExitMs: number;
}

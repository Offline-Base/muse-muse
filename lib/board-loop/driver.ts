/**
 * How the board loop reaches a board (docs/BOARD_LOOP.md). The loop only ever talks to this interface. Three things stand
 * behind it: the fleet control plane (./fleet.ts), a board's own MCP server (./device-mcp.ts), and the simulated board
 * (./sim.ts), which is a real tiny process serving canned text. Nothing here ever uses SSH.
 */

export type BoardKind = "simulated" | "fleet" | "device";

/** A file to put on a board. */
export interface BoardFile {
  /** Where the board fetches it from. Null only for a simulated board's stand-in, which fetches nothing. */
  url: string | null;
  name: string;
  bytes: number | null;
  sha256: string | null;
  /** The name it serves under. */
  alias: string;
  /** The tune never made this file: the simulated board is pretending to have it. */
  standIn: boolean;
}

export interface BoardStatus {
  online: boolean;
  name: string | null;
  loadedModels: string[];
}

/** What the board says about itself right now. Anything it doesn't report is null. */
export interface BoardMetrics {
  memUsedMb: number | null;
  memTotalMb: number | null;
  tempC: number | null;
  powerW: number | null;
}

export type BoardWork = { state: "running" } | { state: "done" } | { state: "failed"; message: string };

export interface BoardAnswer {
  text: string;
  tokens: number;
  /** From just before the call to its last token. */
  ms: number;
  /** Until the first token, or null when the board only returns whole answers. */
  firstTokenMs: number | null;
  tokensPerSecond: number;
  finish: string | null;
}

export interface BoardAsk {
  alias: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  maxTokens: number;
  signal?: AbortSignal;
}

/** The board can't be reached, or has no room for this now. Words for a person, with no address in them. */
export class BoardOfflineError extends Error {}
export class BoardBusyError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("The board is busy.");
  }
}

export interface BoardDriver {
  readonly kind: BoardKind;
  status(): Promise<BoardStatus>;
  metrics(): Promise<BoardMetrics>;
  /** Starts putting the file on the board. The handle goes to workState. */
  install(file: BoardFile): Promise<string>;
  /** Starts serving the file, in place of what the board served. The handle goes to workState. */
  serve(file: BoardFile): Promise<string>;
  workState(handle: string): Promise<BoardWork>;
  /** The board serves this name and can answer. */
  isServing(alias: string): Promise<boolean>;
  ask(input: BoardAsk): Promise<BoardAnswer>;
  /** Stops serving. Best effort: the loop ends either way. */
  stop(alias: string): Promise<void>;
}

/** The serve name for a real file, written as the fleet writes a Hugging Face GGUF. */
export function aliasFor(repo: string, level: string): string {
  return `hf.co/${repo}:${level}`;
}

export function tokensPerSecond(tokens: number, ms: number): number {
  return ms > 0 ? Math.round((tokens / (ms / 1000)) * 10) / 10 : 0;
}

/**
 * Types for Muse Code sessions in products (docs/CAPABILITIES.md, 15b). Plain types only, so lib/db/schema.ts can name
 * them without importing anything that runs.
 */

/** starting: the row exists and the sandbox is being made. running: the bridge is up. The rest are ends. */
export type CodeSessionStatus = "starting" | "running" | "completed" | "failed" | "stopped" | "expired";

export const ENDED_STATUSES: readonly CodeSessionStatus[] = ["completed", "failed", "stopped", "expired"];

export type CodeSessionPrincipal = "build" | "owner" | "user" | "visitor";

/** One step a person sees: what the bridge log condensed to (lib/sandbox/msp-log.ts), numbered, redacted. */
export interface CodeSessionEvent {
  n: number;
  kind: string;
  text: string;
  itemId?: string;
  tool?: string;
  ok?: boolean;
  files?: number;
  added?: number;
  removed?: number;
}

export interface CodeSessionFile {
  path: string;
  bytes: number;
}

export interface CodeSessionDropped {
  path: string;
  why: string;
}

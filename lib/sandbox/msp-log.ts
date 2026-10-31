/**
 * Condenses the session bridge's JSONL log (`BridgeLogRecord` lines, lib/sandbox/bridge-protocol.ts) into build-room
 * lines, the run's usage, its final text and its exit, the way lib/sandbox/muse-log.ts condenses `muse exec` JSONL
 * (docs/MUSE_CODE_FULL.md, "Build room"). Pure, so tests feed it recorded logs.
 *
 * STUB: the build-room work replaces this with the full condenser. The signature is the contract the engine codes
 * against.
 */
import type { BridgeLogRecord } from "@/lib/sandbox/bridge-protocol";
import type { ModelUsage, MuseLogLine } from "@/lib/types";

/** What one poll carries to the next: items already shown (by id, with their last text), and what was announced. */
export interface BridgeCondenseState {
  /** itemId -> the last line shown for it, so an update replaces rather than repeats. */
  shown: Record<string, string>;
  /** Keys announced once per run (an observer's first run, a hook's first run). */
  announced: string[];
}

export function emptyBridgeState(): BridgeCondenseState {
  return { shown: {}, announced: [] };
}

export interface BridgeCondensed {
  lines: MuseLogLine[];
  state: BridgeCondenseState;
  /** Token usage reported in these records (session/tokenUsage or usage/read), priced; empty when none. */
  usage: ModelUsage[];
  /** The last agent message, once the bridge has exited. */
  finalText: string | null;
  /** Present once the bridge wrote its exit record. */
  exit: { code: number; reason?: string } | null;
}

/** Parses raw JSONL lines into records, skipping any that aren't JSON objects with a known `kind`. */
export function parseBridgeLines(lines: readonly string[]): BridgeLogRecord[] {
  const out: BridgeLogRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as BridgeLogRecord;
      if (v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string") out.push(v);
    } catch {
      // A torn or foreign line: skip it.
    }
  }
  return out;
}

export function condenseBridgeLines(lines: readonly string[], state: BridgeCondenseState = emptyBridgeState()): BridgeCondensed {
  const records = parseBridgeLines(lines);
  const out: MuseLogLine[] = [];
  let finalText: string | null = null;
  let exit: BridgeCondensed["exit"] = null;
  for (const r of records) {
    if (r.kind === "bridge" && r.event === "exit") {
      exit = { code: r.exitCode ?? 1, ...(r.reason ? { reason: r.reason } : {}) };
      finalText = r.finalText ?? null;
      out.push({ kind: exit.code === 0 ? "done" : "error", text: exit.code === 0 ? `Done. ${finalText ?? ""}`.trim() : `Muse Code stopped (${r.reason ?? "error"})`, ok: exit.code === 0 });
    }
  }
  return { lines: out, state, usage: [], finalText, exit };
}

/**
 * Turns the Oct 30 spike's probe recordings (docs/spikes/muse-full-2026-10-30/msp-probe.mjs: `{t, note}`, `{t, call,
 * ok, result}`, `{t, stderr}` and its own markers) into the session bridge's log (`BridgeLogRecord`,
 * lib/sandbox/bridge-protocol.ts), the way the bridge would have written the same run: the probe's steer becomes the
 * mailbox command it stands for, and its close becomes the exit record with the exit code, last message and goal.
 */
import type { BridgeLogRecord, MuseCommand } from "@/lib/sandbox/bridge-protocol";
import { subLineOf } from "@/lib/sandbox/msp-log";
import type { MuseLogLine } from "@/lib/types";

type Probe = Record<string, unknown> & { t: number };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function probeToBridge(jsonl: string): BridgeLogRecord[] {
  const probes = jsonl
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Probe);
  // A steered userMessage carries the command id the steer's call returned, and the text the probe sent.
  const steered = new Map<string, string>();
  for (const p of probes) {
    const item = obj(obj(obj(p.note).params).item);
    if (item.kind === "userMessage" && item.steered === true) steered.set(String(item.commandId), String(item.text));
  }
  const out: BridgeLogRecord[] = [];
  let terminal = "";
  let turnReason = "";
  let finalText: string | undefined;
  let goal: { objective: string; status: string; percentComplete?: number } | null = null;
  for (const p of probes) {
    const t = p.t;
    if ("initialized" in p) out.push({ t, kind: "bridge", event: "started" });
    else if ("sessionId" in p) out.push({ t, kind: "bridge", event: "session", sessionId: String(p.sessionId) });
    else if ("activeTurn" in p) out.push({ t, kind: "bridge", event: "turn", turnId: String(p.activeTurn) });
    else if ("stderr" in p) out.push({ t, kind: "stderr", text: String(p.stderr) });
    else if ("note" in p) {
      const note = obj(p.note);
      const params = obj(note.params);
      out.push({ t, kind: "note", method: String(note.method), params });
      const item = obj(params.item);
      if (note.method === "item/completed" && item.kind === "agentMessage") finalText = String(item.text);
      if (note.method === "turn/completed") {
        terminal = String(params.terminal);
        turnReason = String(params.reason ?? obj(params.error).message ?? "");
      }
      if (note.method === "session/goalChanged") {
        const g = obj(params.goal);
        goal = params.goal ? { objective: String(g.objective), status: String(g.status), percentComplete: Number(g.percentComplete) } : null;
      }
    } else if ("call" in p) {
      const method = String(p.call);
      const ok = p.ok === true;
      out.push(ok ? { t, kind: "call", method, ok, result: p.result } : { t, kind: "call", method, ok, error: { message: String(p.error) } });
      if (method === "turn/steer" && ok) {
        const command: MuseCommand = { type: "steer", text: steered.get(String(obj(p.result).commandId)) ?? "" };
        out.push({ t, kind: "command", id: `cmd-${t}`, command, ok });
      }
    } else if ("closed" in p) {
      // The bridge's exit codes follow exec's: 0 when the last turn completed, 1 when it failed or was stopped.
      const code = terminal === "completed" ? 0 : 1;
      out.push({
        t,
        kind: "bridge",
        event: "exit",
        exitCode: code,
        ...(finalText ? { finalText } : {}),
        goal,
        ...(code ? { reason: turnReason || `turn ${terminal || "never finished"}` } : {}),
      });
    }
  }
  return out;
}

export function toLines(records: BridgeLogRecord[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

/**
 * What the build room keeps (components/build/derive.ts): a line with an itemId already there replaces that line in
 * place, and a new sub-line goes just before its item's line.
 */
export function upsert(lines: Iterable<MuseLogLine>): MuseLogLine[] {
  const out: MuseLogLine[] = [];
  for (const l of lines) {
    const i = l.itemId === undefined ? -1 : out.findIndex((o) => o.itemId === l.itemId);
    if (i >= 0) {
      out[i] = l;
      continue;
    }
    const parent = l.itemId === undefined ? null : subLineOf(l.itemId);
    const under = parent === null ? -1 : out.findIndex((o) => o.itemId === parent);
    if (under >= 0) out.splice(under, 0, l);
    else out.push(l);
  }
  return out;
}

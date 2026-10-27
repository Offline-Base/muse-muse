import { usageCost } from "@/lib/meta/pricing";
import type { ModelUsage, MuseLogLine } from "@/lib/types";

/**
 * Condenses Muse Code's `--json` stream into build-room lines, following the table in docs/SPIKES.md. Pure, so it is
 * unit tested against docs/spikes/muse-exec-sample.jsonl (scripts/dev/sandbox-condense.test.ts).
 */

interface RawEvent {
  payload_type?: string;
  stream?: { kind?: string; id?: string };
  payload?: Record<string, unknown>;
}

interface RawModelUsage {
  model?: string;
  input_tokens?: number;
  cached_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  calls?: number;
}

export interface Condensed {
  lines: MuseLogLine[];
  /** Priced usage from the last run.usage event seen, or empty. */
  usage: ModelUsage[];
  /** The final message from run.terminal.*, or null. */
  finalText: string | null;
  /** The session id from the stream envelope, once seen. */
  sessionId: string | null;
}

const MAX_TEXT = 240;

function firstLine(text: unknown): string {
  if (typeof text !== "string") return "";
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line.trim();
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function priceMuseUsage(models: RawModelUsage[]): ModelUsage[] {
  return models
    .filter((m) => typeof m.model === "string")
    .map((m) => {
      const u = {
        model: m.model as string,
        inputTokens: num(m.input_tokens),
        cachedInputTokens: num(m.cached_tokens),
        // Reasoning tokens are part of output_tokens, as in the Responses API usage object.
        outputTokens: num(m.output_tokens),
      };
      return { ...u, costUsd: usageCost(u) };
    });
}

function usageText(usage: ModelUsage[], calls: number): string {
  const input = usage.reduce((s, u) => s + u.inputTokens, 0);
  const cached = usage.reduce((s, u) => s + u.cachedInputTokens, 0);
  const output = usage.reduce((s, u) => s + u.outputTokens, 0);
  const cost = usage.reduce((s, u) => s + u.costUsd, 0);
  const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
  return `${calls} model call${calls === 1 ? "" : "s"}, ${k(input)} input tokens (${k(cached)} cached), ${k(output)} output tokens, about $${cost.toFixed(3)}`;
}

/** Condenses complete JSONL lines. Lines that don't parse are skipped. */
export function condenseMuseLines(rawLines: Iterable<string>): Condensed {
  const out: Condensed = { lines: [], usage: [], finalText: null, sessionId: null };
  let say: MuseLogLine | null = null;
  const flushSay = () => {
    if (say && say.text.trim()) out.lines.push(say);
    say = null;
  };

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: RawEvent;
    try {
      ev = JSON.parse(trimmed) as RawEvent;
    } catch {
      continue;
    }
    if (!out.sessionId && ev.stream?.kind === "session" && typeof ev.stream.id === "string") out.sessionId = ev.stream.id;
    const p = obj(ev.payload);
    const type = ev.payload_type ?? "";

    if (type === "run.output.delta") {
      const text = typeof p.text === "string" ? p.text : "";
      if (!say) say = { kind: "say", text: "" };
      say.text += text;
      continue;
    }
    flushSay();

    if (type === "run.lifecycle.started") {
      out.lines.push({ kind: "start", text: "Started" });
    } else if (type === "tool.result") {
      const facts = obj(p.correlation_facts);
      const tool = typeof facts.tool_name === "string" ? facts.tool_name : "tool";
      const ok = facts.outcome === undefined ? true : facts.outcome === "success";
      // Edit tools reply "edited"; their edit_facts name the file, which reads better in the log.
      const edit = obj(p.edit_facts);
      const text = typeof edit.path === "string" ? `Edited \`${edit.path}\`` : firstLine(p.text) || tool;
      out.lines.push({ kind: "tool", tool, ok, text });
    } else if (type === "task.lifecycle.tool_output_ref") {
      const ref = obj(obj(p.event).output_ref);
      if (ref.kind !== "tool_patch") continue;
      const s = obj(ref.patch_summary);
      const files = num(s.files);
      const added = num(s.added);
      const removed = num(s.removed);
      out.lines.push({
        kind: "edit",
        files,
        added,
        removed,
        text: `Edited ${files} file${files === 1 ? "" : "s"} (+${added} −${removed})`,
      });
    } else if (type === "task.lifecycle.status") {
      // Mostly retry and stream notices. Keep only real retries, which explain a slow stretch.
      const event = obj(p.event);
      const message = typeof event.message === "string" ? event.message : "";
      const attempt = /attempt (\d+)\//.exec(message);
      if (attempt && Number(attempt[1]) > 1) out.lines.push({ kind: "status", text: message });
    } else if (type === "run.usage") {
      const models = Array.isArray(p.models) ? (p.models as RawModelUsage[]) : [];
      out.usage = priceMuseUsage(models);
      const calls = num(p.calls) || models.reduce((s, m) => s + num(m.calls), 0);
      out.lines.push({ kind: "usage", text: usageText(out.usage, calls) });
    } else if (type.startsWith("run.terminal.")) {
      const terminal = typeof p.terminal === "string" ? p.terminal : type.slice("run.terminal.".length);
      const text = typeof p.text === "string" ? p.text : "";
      out.finalText = text || out.finalText;
      if (terminal === "completed") {
        const line = firstLine(text);
        out.lines.push({ kind: "done", ok: true, text: !line ? "Done" : /^done\b/i.test(line) ? line : `Done. ${line}` });
      }
      else {
        const reason = typeof p.reason === "string" ? p.reason : firstLine(text);
        out.lines.push({ kind: "error", ok: false, text: `Muse Code stopped (${terminal})${reason ? `: ${reason}` : ""}` });
      }
    }
  }
  flushSay();
  return out;
}

/**
 * Splits a chunk of bytes into complete lines. Returns the lines and how many bytes they used, so the caller can
 * resume at the start of a partial last line.
 */
export function completeLines(chunk: Buffer): { lines: string[]; consumed: number } {
  const lastNl = chunk.lastIndexOf(0x0a);
  if (lastNl < 0) return { lines: [], consumed: 0 };
  return { lines: chunk.subarray(0, lastNl + 1).toString("utf8").split("\n"), consumed: lastNl + 1 };
}

/**
 * Short "how it was built" highlights from condensed lines: a summary line with tool and edit counts, then each tool
 * call in order (consecutive repeats collapsed).
 */
export function highlightsFrom(lines: MuseLogLine[], max = 30): string[] {
  const out: string[] = [];
  let edits = 0;
  let files = 0;
  let tools = 0;
  for (const l of lines) {
    if (l.kind === "edit") {
      edits++;
      files += l.files ?? 0;
    }
    if (l.kind !== "tool") continue;
    tools++;
    const text = l.ok === false ? `${l.text} (failed)` : l.text;
    if (out[out.length - 1] !== text) out.push(text);
  }
  const summary = `${tools} tool call${tools === 1 ? "" : "s"}, ${edits} edit${edits === 1 ? "" : "s"} touching ${files} file${files === 1 ? "" : "s"}`;
  if (out.length <= max) return [summary, ...out];
  return [summary, ...out.slice(0, max - 1), `and ${out.length - (max - 1)} more steps`];
}

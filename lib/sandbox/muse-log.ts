import { usageCost } from "@/lib/meta/pricing";
import type { ModelUsage, MuseLogLine } from "@/lib/types";

/**
 * Condenses Muse Code's `--json` stream into build-room lines, following the table in docs/SPIKES.md. Pure, so it is
 * unit tested against docs/spikes/muse-exec-sample.jsonl (scripts/dev/sandbox-condense.test.ts and
 * lib/sandbox/__tests__/muse-log.test.ts).
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
  /**
   * Keys of the helper agents announced so far in this run (the `announced` passed in plus new ones), to pass to the
   * next call so a run never announces the same one twice.
   */
  announced: string[];
  /**
   * Whether run.usage already counts the child agents. False only when it says `children_included: false`, so the
   * session log's child calls are charged on top. True when it says true or doesn't say, so they are never charged
   * twice. Null when no run.usage was seen.
   */
  childrenIncluded: boolean | null;
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

/** At most this many helper-agent keys are carried between polls. Past it, new ones are still announced once per call. */
const MAX_ANNOUNCED = 32;

/**
 * The reminder agent a task kind names, such as "verify" for reminder.agent.verify-reminder. Plugin reminders look like
 * reminder.agent.plugin:reminders:skill-reminder (from the binary), so only the last segment counts. Null for others.
 */
export function reminderName(taskKind: string): string | null {
  if (!taskKind.startsWith("reminder.agent.")) return null;
  const id = taskKind.slice("reminder.agent.".length).split(":").pop() ?? "";
  return id.replace(/-reminder$/, "").replace(/[-_]+/g, " ").trim() || null;
}

/**
 * The build-room text for a subagent tool's JSON reply (Muse Code 1.4.14, Oct 27), or null to keep the raw first line.
 * subagent_spawn answers `{"status":"accepted","subagent_id":...,"agent_path":"main/scout/1",...}`, where the task name
 * is the last path segment that isn't a number. subagent_wait and subagent_read_result answer
 * `{"status":"ready",...,"summary":"Created scout.txt ..."}` once it is done.
 */
export function subagentText(tool: string, text: unknown): string | null {
  if (!tool.startsWith("subagent_") || typeof text !== "string" || !text.trim().startsWith("{")) return null;
  let reply: Record<string, unknown>;
  try {
    reply = obj(JSON.parse(text));
  } catch {
    return null;
  }
  if (tool === "subagent_spawn") {
    const path = typeof reply.agent_path === "string" ? reply.agent_path : "";
    const name = path.split("/").filter((s) => s && !/^\d+$/.test(s)).pop();
    return name && name !== "main" ? `Muse Code started a subagent: ${name}` : "Muse Code started a subagent";
  }
  if (reply.status === "ready" && typeof reply.summary === "string" && reply.summary.trim()) {
    return firstLine(`A subagent finished: ${reply.summary}`);
  }
  return null;
}

/**
 * Condenses complete JSONL lines. Lines that don't parse are skipped. `announced` is the previous call's
 * `announced` for the same run: Muse Code's reminder agents get one line per run (the skill reminder runs after every
 * model step), so they don't flood the build room.
 */
export function condenseMuseLines(rawLines: Iterable<string>, announced: Iterable<string> = []): Condensed {
  const out: Condensed = {
    lines: [],
    usage: [],
    finalText: null,
    sessionId: null,
    announced: [...announced],
    childrenIncluded: null,
  };
  const seen = new Set(out.announced);
  /** True the first time a key is seen in this run. */
  const announce = (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (out.announced.length < MAX_ANNOUNCED) out.announced.push(key);
    return true;
  };
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
      const text =
        (ok && subagentText(tool, p.text)) ||
        (typeof edit.path === "string" ? `Edited \`${edit.path}\`` : firstLine(p.text) || tool);
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
    } else if (type === "task.lifecycle.proposed") {
      // The only event that carries task_kind. Model calls and tools are shown by other events.
      const taskKind = obj(p.event).task_kind;
      const reminder = typeof taskKind === "string" ? reminderName(taskKind) : null;
      if (reminder && announce(`reminder:${reminder}`)) {
        out.lines.push({ kind: "status", text: `Muse Code started its ${reminder} reminder` });
      }
    } else if (type === "task.lifecycle.status") {
      // Mostly retry and stream notices. Keep only real retries, which explain a slow stretch.
      const event = obj(p.event);
      const message = typeof event.message === "string" ? event.message : "";
      const attempt = /attempt (\d+)\//.exec(message);
      if (attempt && Number(attempt[1]) > 1) out.lines.push({ kind: "status", text: message });
    } else if (type === "run.usage") {
      const models = Array.isArray(p.models) ? (p.models as RawModelUsage[]) : [];
      out.usage = priceMuseUsage(models);
      out.childrenIncluded = p.children_included !== false;
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

// ---------------------------------------------------------------------------------------------------------------
// Usage that run.usage leaves out

/**
 * Prints one run's usage records from Muse Code's session logs, as JSON lines. Muse Code writes a
 * goal_usage_attribution record per provider call, while run.usage counts only the main agent (children_included:
 * false). Measured on Muse Code 1.4.14 (Oct 27):
 * - The parent session log has the main agent's calls (owner main_root) and every reminder agent's (reminder_child),
 *   all with owner.run_id set to the run.
 * - A subagent's calls (native_child) are only in its own log, subagent/<child session>/session.jsonl, under its own
 *   run id. A subagent's own subagents nest the same way under its folder.
 * - Reminder agents' own logs, also under subagent/, repeat calls the parent log already has, under other usage ids.
 * - A subagent resumed by a later run (a fix round, a refinement) keeps writing to the log it started in.
 *
 * So every subagent/**\/session.jsonl under the parent session is read, and only its records from this run's start
 * on count: the recorded_at of the run's first record in the parent log, which uses the same clock. parseSessionUsage
 * drops main_root and reminder_child records found there.
 *
 * Output: first `{ session_id, run_id, model, session_log }`, read from the start of the run's own --json stream
 * (argv[1]). Then each parent record (from the run's first line on, naming the run), then
 * `{ child_session, model, record }` for each record from the run's start on in a log under subagent/. Runs with
 * `node -e`, so the whole read is one sandbox command. It runs when the run has ended and before the next one starts,
 * so "from the start on" is the run itself.
 */
export const SESSION_USAGE_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const head = { session_id: null, run_id: null, model: null, session_log: null };
const buf = Buffer.alloc(1 << 20);
const fd = fs.openSync(process.argv[1], "r");
const n = fs.readSync(fd, buf, 0, buf.length, 0);
fs.closeSync(fd);
for (const line of buf.subarray(0, n).toString("utf8").split("\\n")) {
  let ev; try { ev = JSON.parse(line); } catch { continue; }
  const p = ev.payload || {};
  if (!head.session_id && ev.stream && ev.stream.kind === "session") head.session_id = ev.stream.id;
  if (!head.run_id && typeof p.command_id === "string") head.run_id = p.command_id;
  if (ev.payload_type === "run.model.configured" && typeof p.model_id === "string") { head.model = p.model_id; break; }
}
const root = path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || "", ".local/share"), "muse/sessions");
const ls = (dir) => { try { return fs.readdirSync(dir).filter((f) => !f.startsWith(".")); } catch { return []; } };
// Sessions live in YYYY/MM/DD/<id>/ under the day they were created.
for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
  const file = path.join(root, y, m, d, String(head.session_id), "session.jsonl");
  if (!head.session_log && head.session_id && fs.existsSync(file)) head.session_log = file;
}
console.log(JSON.stringify(head));
// Every record on a log line. A retained frame holds whole records as JSON strings.
const recordsOn = (line) => {
  let o; try { o = JSON.parse(line); } catch { return []; }
  if (!o || !o.retained_frame) return [o];
  return (o.children || []).map((c) => { try { return JSON.parse(c.record_json); } catch { return null; } });
};
const lines = (file) => readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
// Every session.jsonl under dir, at any depth. Symlinks are not followed.
const logsUnder = (dir) => {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return logsUnder(file);
    return e.isFile() && e.name === "session.jsonl" ? [file] : [];
  });
};
async function main() {
  if (!head.session_log || !head.run_id) return;
  let inRun = false;
  let start = null;
  for await (const line of lines(head.session_log)) {
    // Runs in one session never overlap, so everything from the run's first line on is this run's.
    if (!inRun && !line.includes(head.run_id)) continue;
    inRun = true;
    if (start === null) for (const r of recordsOn(line)) if (r && Number.isFinite(r.recorded_at)) { start = r.recorded_at; break; }
    if (!line.includes("goal_usage_attribution") || !line.includes(head.run_id)) continue;
    for (const r of recordsOn(line)) {
      const p = (r && r.payload) || {};
      if (p.event && p.event.kind === "goal_usage_attribution" && p.event.record) console.log(JSON.stringify(p.event.record));
    }
  }
  // Without a start, a child record can't be placed in this run, so none count.
  if (start === null) return;
  for (const file of logsUnder(path.join(path.dirname(head.session_log), "subagent"))) {
    // recorded_at is in microseconds. A log nobody wrote to since the run started has nothing from it.
    try { if (fs.statSync(file).mtimeMs * 1000 < start) continue; } catch { continue; }
    const child = path.basename(path.dirname(file));
    let model = null;
    for await (const line of lines(file)) {
      if (!line.includes("goal_usage_attribution") && !line.includes("run.model.configured")) continue;
      for (const r of recordsOn(line)) {
        const p = (r && r.payload) || {};
        if (r && r.payload_type === "run.model.configured" && !model) model = (p.record && p.record.model_id) || p.model_id || null;
        if (!(p.event && p.event.kind === "goal_usage_attribution" && p.event.record)) continue;
        // An earlier run's calls by a subagent this run resumed are in the same log.
        if (Number.isFinite(r.recorded_at) && r.recorded_at >= start) console.log(JSON.stringify({ child_session: child, model, record: p.event.record }));
      }
    }
  }
}
main().catch((err) => { console.error(String(err)); process.exit(1); });
`;

interface RawAttribution {
  usage_id?: unknown;
  usage_family?: unknown;
  owner?: { owner_type?: unknown; run_id?: unknown };
  quantity?: { input_tokens?: unknown; cached_tokens?: unknown; output_tokens?: unknown };
}

export interface UsageGroup {
  /** Provider calls. */
  calls: number;
  /** Priced, one entry per model. Empty when there were no calls. */
  usage: ModelUsage[];
}

export interface SessionUsage {
  runId: string | null;
  /** False when the session log wasn't found or the stream named no run, so nothing could be counted. */
  found: boolean;
  /** The main agent (owner main_root). run.usage reports the same calls. */
  main: UsageGroup;
  /** Reminder agents and subagents: what run.usage leaves out when it says children_included: false. */
  children: UsageGroup & { owners: string[] };
  /**
   * Calls by owner types that were never measured (workflow agents, side sessions, anything new), or a known type
   * found where it wasn't expected. Never charged, since run.usage or another log may already count them.
   */
  unknown: UsageGroup & { owners: string[] };
}

type Tally = Map<string, { calls: number; input: number; cached: number; output: number }>;

function priced(tally: Tally): UsageGroup {
  const usage: ModelUsage[] = [];
  let calls = 0;
  for (const [model, t] of tally) {
    const u = { model, inputTokens: t.input, cachedInputTokens: t.cached, outputTokens: t.output };
    usage.push({ ...u, costUsd: usageCost(u) });
    calls += t.calls;
  }
  return { calls, usage };
}

/**
 * Where each owner type's calls are charged from, as measured on Muse Code 1.4.14 (see SESSION_USAGE_SCRIPT). A
 * main_root or reminder_child record in a log under subagent/ repeats the parent log, so it is dropped.
 */
const PARENT_OWNERS = new Set(["main_root", "reminder_child"]);
const CHILD_OWNERS = new Set(["native_child"]);

/**
 * Sums SESSION_USAGE_SCRIPT output for its run: provider records only (tool records are all zero), each usage_id
 * once. Parent records count only when they name the run. Owner types outside PARENT_OWNERS and CHILD_OWNERS go to
 * `unknown`, which is not charged. Records carry no model: reminder agents run on "same-as-main", so parent records
 * are priced at the run's model (run.model.configured, or `fallbackModel` when the stream didn't say), and a
 * subagent's at its own run's model.
 */
export function parseSessionUsage(stdout: string, fallbackModel = "muse-spark-1.3"): SessionUsage {
  const [first = "", ...rest] = stdout.split("\n");
  let head: Record<string, unknown> = {};
  try {
    head = obj(JSON.parse(first));
  } catch {
    // No header: nothing to count.
  }
  const runId = typeof head.run_id === "string" ? head.run_id : null;
  const runModel = typeof head.model === "string" && head.model ? head.model : fallbackModel;
  const main: Tally = new Map();
  const children: Tally = new Map();
  const unknown: Tally = new Map();
  const owners = new Set<string>();
  const unknownOwners = new Set<string>();
  const ids = new Set<string>();
  for (const line of rest) {
    if (!runId || !line.trim().startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = obj(JSON.parse(line));
    } catch {
      continue;
    }
    const fromChild = typeof row.child_session === "string";
    const r = (fromChild ? obj(row.record) : row) as RawAttribution;
    const owner = obj(r.owner);
    const ownerType = typeof owner.owner_type === "string" ? owner.owner_type : "unknown";
    if (r.usage_family !== "provider") continue;
    if (fromChild ? PARENT_OWNERS.has(ownerType) : owner.run_id !== runId) continue;
    if (typeof r.usage_id === "string") {
      if (ids.has(r.usage_id)) continue;
      ids.add(r.usage_id);
    }
    const model = fromChild && typeof row.model === "string" && row.model ? row.model : runModel;
    const known = (fromChild ? CHILD_OWNERS : PARENT_OWNERS).has(ownerType);
    const tally = !known ? unknown : ownerType === "main_root" ? main : children;
    if (tally !== main) (known ? owners : unknownOwners).add(ownerType);
    const q = obj(r.quantity);
    const t = tally.get(model) ?? { calls: 0, input: 0, cached: 0, output: 0 };
    t.calls++;
    t.input += num(q.input_tokens);
    t.cached += num(q.cached_tokens);
    t.output += num(q.output_tokens);
    tally.set(model, t);
  }
  return {
    runId,
    found: Boolean(runId && head.session_log),
    main: priced(main),
    children: { ...priced(children), owners: [...owners].sort() },
    unknown: { ...priced(unknown), owners: [...unknownOwners].sort() },
  };
}

const OWNER_LABELS: Record<string, string> = {
  reminder_child: "reminders",
  native_child: "subagents",
  workflow_child: "workflow agents",
  side_session: "side sessions",
};

/** What `owners` (from parseSessionUsage) were, in words: "reminders", "reminders and subagents". */
export function ownersLabel(owners: string[]): string {
  const order = Object.keys(OWNER_LABELS);
  const rank = (o: string) => (order.includes(o) ? order.indexOf(o) : order.length);
  const labels = [...new Set([...owners].sort((a, b) => rank(a) - rank(b)).map((o) => OWNER_LABELS[o] ?? "helper agents"))];
  if (labels.length <= 1) return labels[0] ?? "helper agents";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** A build-room line for the child agents' usage, which run.usage's line leaves out. */
export function childUsageLine(children: SessionUsage["children"]): MuseLogLine {
  const label = ownersLabel(children.owners);
  return { kind: "status", text: `Muse Code's ${label} also made ${usageText(children.usage, children.calls)}` };
}

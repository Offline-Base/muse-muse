import { usageCost } from "@/lib/meta/pricing";
import type { ModelUsage, MuseLogLine } from "@/lib/types";
import { defaultModel } from "@/lib/meta/spark";

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
  /**
   * Priced usage from the run.usage events seen, or empty. One `muse exec` can hold more than one run: a workflow's
   * completion arrives as a second run with its own run.usage, so they are summed per model.
   */
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
 * The build-room text for the workflow tool's JSON reply (Muse Code 1.4.14, Oct 30): `{"entryId":"echo-workflow-ok",
 * "message":"Workflow launched: ...",...}` when it starts one in the background. Null to keep the raw first line.
 */
export function workflowText(tool: string, text: unknown): string | null {
  if (tool !== "workflow" || typeof text !== "string" || !text.trim().startsWith("{")) return null;
  let reply: Record<string, unknown>;
  try {
    reply = obj(JSON.parse(text));
  } catch {
    return null;
  }
  const name = typeof reply.entryId === "string" ? reply.entryId.trim() : "";
  if (typeof reply.message === "string" && /^workflow launched/i.test(reply.message)) {
    return name ? `Muse Code started a workflow: ${name}` : "Muse Code started a workflow";
  }
  return null;
}

/** Adds priced usage into `into`, model by model. */
function addUsage(into: ModelUsage[], more: ModelUsage[]): ModelUsage[] {
  const out = into.map((u) => ({ ...u }));
  for (const u of more) {
    const same = out.find((o) => o.model === u.model);
    if (!same) {
      out.push({ ...u });
      continue;
    }
    same.inputTokens += u.inputTokens;
    same.cachedInputTokens += u.cachedInputTokens;
    same.outputTokens += u.outputTokens;
    same.costUsd = usageCost(same);
  }
  return out;
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
        (ok && (subagentText(tool, p.text) || workflowText(tool, p.text))) ||
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
      const usage = priceMuseUsage(models);
      out.usage = addUsage(out.usage, usage);
      // One run that leaves its children out is enough for the session log's child calls to be charged.
      out.childrenIncluded = (out.childrenIncluded ?? true) && p.children_included !== false;
      const calls = num(p.calls) || models.reduce((s, m) => s + num(m.calls), 0);
      out.lines.push({ kind: "usage", text: usageText(usage, calls) });
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
 * Prints one round's usage records from Muse Code's session logs, as JSON lines. Muse Code writes a
 * goal_usage_attribution record per provider call, while run.usage counts only the main agent (children_included:
 * false). Measured on Muse Code 1.4.14 (Oct 27 and 30):
 * - The parent session log has the main agent's calls (owner main_root) and every reminder agent's (reminder_child),
 *   all with owner.run_id set to the run.
 * - A subagent's calls (native_child) and a workflow child's (workflow_child) are only in the child's own log,
 *   subagent/<child session>/session.jsonl, under its own run id. Children's own children nest the same way.
 * - A reminder agent's own log, also under subagent/, repeats the call its host's log already has, under another usage
 *   id. Such a copy names its own log's session as owner.owner_id; parseSessionUsage drops it.
 * - A subagent resumed by a later run (a fix round, a refinement) keeps writing to the log it started in.
 * - One `muse exec` can hold more than one run: a workflow's completion arrives as a second run. On the session bridge,
 *   each turn is a run whose id is its turn id.
 *
 * So every subagent/**\/session.jsonl under the parent session is read, and only its records from the round's start
 * on count: the recorded_at of the round's first record in the parent log, which uses the same clock.
 *
 * argv[1] is the round's own log: a `muse exec --json` stream, or the session bridge's log (BridgeLogRecord lines,
 * lib/sandbox/bridge-protocol.ts). Output: first `{ session_id, run_id, run_ids, reported, model, session_log }`, with
 * every run the log names and the ones whose run.usage it holds. Then each parent record that names one of the runs,
 * from the round's first line on, then `{ child_session, model, record }` for each record from the round's start on in
 * a log under subagent/. Runs with `node -e`, so the whole read is one sandbox command. It runs when the round has
 * ended and before the next one starts, so "from the start on" is the round itself.
 */
export const SESSION_USAGE_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const head = { session_id: null, run_id: null, run_ids: [], reported: [], model: null, session_log: null };
const lines = (file) => readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
const addRun = (id) => { if (typeof id === "string" && id && !head.run_ids.includes(id)) head.run_ids.push(id); };
async function readRound(file) {
  for await (const line of lines(file)) {
    if (line.startsWith('{"t":')) {
      // The session bridge's log: its session, each turn that ran, and the model the session opened on.
      if (!line.includes('"kind":"bridge"') && !line.includes('"turn/started"') && !line.includes('"kind":"call"')) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.kind === "bridge" && r.event === "session" && !head.session_id) head.session_id = r.sessionId || null;
      if (r.kind === "note" && r.method === "turn/started" && r.params) { addRun(r.params.turnId); addRun(r.params.commandId); }
      const session = r.kind === "call" && r.ok && (r.method === "session/start" || r.method === "session/resume") && r.result && r.result.session;
      if (session && !head.model && typeof session.modelId === "string") head.model = session.modelId;
      continue;
    }
    // muse exec --json: every event names its run in command_id.
    const id = /"command_id":"([^"]+)"/.exec(line);
    if (id) addRun(id[1]);
    if (head.session_id && head.model && !line.includes('"run.usage"')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== "object") continue;
    const p = ev.payload || {};
    if (!head.session_id && ev.stream && ev.stream.kind === "session") head.session_id = ev.stream.id;
    if (ev.payload_type === "run.model.configured" && typeof p.model_id === "string" && !head.model) head.model = p.model_id;
    if (ev.payload_type === "run.usage" && typeof p.command_id === "string" && !head.reported.includes(p.command_id)) head.reported.push(p.command_id);
  }
  head.run_id = head.run_ids[0] || null;
}
const root = path.join(process.env.XDG_DATA_HOME || path.join(process.env.HOME || "", ".local/share"), "muse/sessions");
const ls = (dir) => { try { return fs.readdirSync(dir).filter((f) => !f.startsWith(".")); } catch { return []; } };
// Every record on a log line. A retained frame holds whole records as JSON strings.
const recordsOn = (line) => {
  let o; try { o = JSON.parse(line); } catch { return []; }
  if (!o || !o.retained_frame) return [o];
  return (o.children || []).map((c) => { try { return JSON.parse(c.record_json); } catch { return null; } });
};
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
  await readRound(process.argv[1]);
  // Sessions live in YYYY/MM/DD/<id>/ under the day they were created.
  for (const y of ls(root)) for (const m of ls(path.join(root, y))) for (const d of ls(path.join(root, y, m))) {
    const file = path.join(root, y, m, d, String(head.session_id), "session.jsonl");
    if (!head.session_log && head.session_id && fs.existsSync(file)) head.session_log = file;
  }
  console.log(JSON.stringify(head));
  if (!head.session_log || !head.run_ids.length) return;
  const names = (line) => head.run_ids.some((id) => line.includes(id));
  let inRun = false;
  let start = null;
  for await (const line of lines(head.session_log)) {
    // Runs in one session never overlap, so everything from the round's first line on is this round's.
    if (!inRun && !names(line)) continue;
    inRun = true;
    if (start === null) for (const r of recordsOn(line)) if (r && Number.isFinite(r.recorded_at)) { start = r.recorded_at; break; }
    if (!line.includes("goal_usage_attribution") || !names(line)) continue;
    for (const r of recordsOn(line)) {
      const p = (r && r.payload) || {};
      if (p.event && p.event.kind === "goal_usage_attribution" && p.event.record) console.log(JSON.stringify(p.event.record));
    }
  }
  // Without a start, a child record can't be placed in this round, so none count.
  if (start === null) return;
  for (const file of logsUnder(path.join(path.dirname(head.session_log), "subagent"))) {
    // recorded_at is in microseconds. A log nobody wrote to since the round started has nothing from it.
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
  owner?: { owner_type?: unknown; run_id?: unknown; owner_id?: unknown };
  quantity?: { input_tokens?: unknown; cached_tokens?: unknown; output_tokens?: unknown };
}

export interface UsageGroup {
  /** Provider calls. */
  calls: number;
  /** Priced, one entry per model. Empty when there were no calls. */
  usage: ModelUsage[];
}

export interface SessionUsage {
  /** The round's first run. */
  runId: string | null;
  /** False when the session log wasn't found or the stream named no run, so nothing could be counted. */
  found: boolean;
  /** The main agent (owner main_root), in every run of the round. Each run's run.usage reports its share. */
  main: UsageGroup;
  /**
   * The part of `main` in runs whose run.usage never appeared in the round's log: a run stopped at its cap, and every
   * run on the session bridge, which has no run.usage. Charged from here, so no call is charged twice or left out.
   */
  unreported: UsageGroup;
  /** Reminder agents, subagents and workflow agents: what run.usage leaves out when it says children_included: false. */
  children: UsageGroup & { owners: string[] };
  /**
   * Calls by owner types that were never measured (side sessions, anything new), or a known type found where it wasn't
   * expected. Never charged, since run.usage or another log may already count them.
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
 * Where each owner type's calls are charged from, as measured on Muse Code 1.4.14 (see SESSION_USAGE_SCRIPT): the
 * main agent and its reminders from the parent log, a subagent's and a workflow child's from the child's own log.
 */
const PARENT_OWNERS = new Set(["main_root", "reminder_child"]);
const CHILD_OWNERS = new Set(["native_child", "workflow_child", "reminder_child"]);

function add(tally: Tally, model: string, quantity: unknown): void {
  const q = obj(quantity);
  const t = tally.get(model) ?? { calls: 0, input: 0, cached: 0, output: 0 };
  t.calls++;
  t.input += num(q.input_tokens);
  t.cached += num(q.cached_tokens);
  t.output += num(q.output_tokens);
  tally.set(model, t);
}

/**
 * Sums SESSION_USAGE_SCRIPT output for its round: provider records only (tool records are all zero), and every usage_id
 * once across the parent and all child logs. Parent records count only when they name one of the round's runs. In a
 * child log, a main_root record repeats the parent's, and so does a reminder_child record that names the log's own
 * session as its owner (the reminder's own log): both are dropped. Any other reminder_child there is a reminder that ran
 * inside that child, and counts. Owner types outside PARENT_OWNERS and CHILD_OWNERS go to `unknown`, which is logged
 * and not charged. Records carry no model: reminder agents run on "same-as-main", so parent records are priced at the
 * round's model (or `fallbackModel` when its log didn't say), and a child's at its own run's model.
 */
export function parseSessionUsage(stdout: string, fallbackModel: string = defaultModel()): SessionUsage {
  const [first = "", ...rest] = stdout.split("\n");
  let head: Record<string, unknown> = {};
  try {
    head = obj(JSON.parse(first));
  } catch {
    // No header: nothing to count.
  }
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s !== "") : []);
  const firstRun = typeof head.run_id === "string" && head.run_id ? head.run_id : null;
  const runs = new Set(strings(head.run_ids).length ? strings(head.run_ids) : firstRun ? [firstRun] : []);
  const reported = new Set(strings(head.reported));
  const runModel = typeof head.model === "string" && head.model ? head.model : fallbackModel;
  const main: Tally = new Map();
  const unreported: Tally = new Map();
  const children: Tally = new Map();
  const unknown: Tally = new Map();
  const owners = new Set<string>();
  const unknownOwners = new Set<string>();
  const ids = new Set<string>();
  for (const line of rest) {
    if (!runs.size || !line.trim().startsWith("{")) continue;
    let row: Record<string, unknown>;
    try {
      row = obj(JSON.parse(line));
    } catch {
      continue;
    }
    const child = typeof row.child_session === "string" ? row.child_session : null;
    const r = (child !== null ? obj(row.record) : row) as RawAttribution;
    const owner = obj(r.owner);
    const ownerType = typeof owner.owner_type === "string" ? owner.owner_type : "unknown";
    if (r.usage_family !== "provider") continue;
    if (child === null && !(typeof owner.run_id === "string" && runs.has(owner.run_id))) continue;
    // A copy of a call its host's log already has, under another usage id.
    if (child !== null && (ownerType === "main_root" || (ownerType === "reminder_child" && owner.owner_id === child))) continue;
    if (typeof r.usage_id === "string") {
      if (ids.has(r.usage_id)) continue;
      ids.add(r.usage_id);
    }
    const model = child !== null && typeof row.model === "string" && row.model ? row.model : runModel;
    const known = (child !== null ? CHILD_OWNERS : PARENT_OWNERS).has(ownerType);
    const tally = !known ? unknown : ownerType === "main_root" ? main : children;
    if (tally !== main) (known ? owners : unknownOwners).add(ownerType);
    add(tally, model, r.quantity);
    if (tally === main && !reported.has(owner.run_id as string)) add(unreported, model, r.quantity);
  }
  return {
    runId: firstRun ?? [...runs][0] ?? null,
    found: Boolean(runs.size && head.session_log),
    main: priced(main),
    unreported: priced(unreported),
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

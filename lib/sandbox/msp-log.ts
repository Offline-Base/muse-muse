/**
 * Condenses the session bridge's JSONL log (`BridgeLogRecord` lines, lib/sandbox/bridge-protocol.ts) into build-room
 * lines, the run's final text and its exit, the way lib/sandbox/muse-log.ts condenses `muse exec` JSONL
 * (docs/MUSE_CODE_FULL.md, "The build room shows all of it"). Pure, so tests feed it recorded logs
 * (lib/sandbox/__tests__/msp-log.test.ts).
 *
 * A line made from a protocol item carries the item's id, and a later line with the same id replaces it in the build
 * room: a tool call is one line that turns from running to done. Each poll emits an item's line once, and only when it
 * changed since the poll before. The goal, the todo list, a question and an owner command get fixed ids the same way.
 * A tool call that changed files also gets an edit line, `<item id>#patch`, which belongs just before the call's line
 * (subLineOf).
 */
import { usageCost } from "@/lib/meta/pricing";
import type { BridgeLogRecord } from "@/lib/sandbox/bridge-protocol";
import { reminderName, subagentText } from "@/lib/sandbox/muse-log";
import type { ModelUsage, MuseLineDetail, MuseLogLine } from "@/lib/types";

/** What one poll carries to the next: items already shown (by id, with their last text), and what was announced. */
export interface BridgeCondenseState {
  /**
   * itemId -> the last line shown for it, so an update replaces rather than repeats. Open items only: an entry goes
   * once the item's finished line is out, so the state stays small however long the run is.
   */
  shown: Record<string, string>;
  /** Keys announced once per run (an observer's first run, a hook's first run). */
  announced: string[];
  /** This run's model calls so far, by model, from session/tokenUsage: the usage line when the bridge exits. */
  tokens?: Record<string, { calls: number; input: number; cached: number; output: number }>;
  /** The end of the host's stderr, which shows only when the bridge exits non-zero. */
  stderr?: string;
}

export function emptyBridgeState(): BridgeCondenseState {
  return { shown: {}, announced: [] };
}

export interface BridgeCondensed {
  lines: MuseLogLine[];
  state: BridgeCondenseState;
  /**
   * Always empty: the engine charges a bridge run from Muse Code's session logs, which count every agent once. The
   * main agent's calls show as the usage line when the bridge exits.
   */
  usage: ModelUsage[];
  /** The last agent message, once the bridge has exited. */
  finalText: string | null;
  /** Present once the bridge wrote its exit record. */
  exit: { code: number; reason?: string } | null;
}

const MAX_TEXT = 240;
/** At most this many announced keys are carried between polls, as in muse-log.ts. Past it, a key is announced once per poll. */
const MAX_ANNOUNCED = 32;
/** At most this many open items are carried between polls. Past it the oldest go, and their next update shows again. */
const MAX_SHOWN = 200;
/** How much of the host's stderr is kept for an exit that needs it. */
const MAX_STDERR = 4000;
/** An owner's note shows whole, up to this many characters. */
const MAX_NOTE = 2000;

const GOAL_ID = "goal";
const TODOS_ID = "todos";
const KINDS = new Set(["note", "call", "command", "stderr", "bridge"]);

type Delivery = NonNullable<MuseLineDetail["delivery"]>;
type Tally = { calls: number; input: number; cached: number; output: number };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function firstLine(text: unknown): string {
  if (typeof text !== "string") return "";
  return cut((text.split("\n").find((l) => l.trim()) ?? "").trim(), MAX_TEXT);
}

function upperFirst(s: string): string {
  return s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s;
}

function k(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** The item a sub-line belongs just before, such as a tool call's edit line (`<item id>#patch`), or null. */
export function subLineOf(itemId: string): string | null {
  const at = itemId.lastIndexOf("#");
  return at > 0 ? itemId.slice(0, at) : null;
}

/** Parses raw JSONL lines into records, skipping any that aren't JSON objects with a known `kind`. */
export function parseBridgeLines(lines: readonly string[]): BridgeLogRecord[] {
  const out: BridgeLogRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as BridgeLogRecord;
      if (v && typeof v === "object" && KINDS.has((v as { kind?: unknown }).kind as string)) out.push(v);
    } catch {
      // A torn or foreign line: skip it.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// One line per kind of item

/** muse-log.ts's usage line, from session/tokenUsage. */
function usageLine(tokens: Record<string, Tally>): MuseLogLine | null {
  const usage = Object.entries(tokens).map(([model, t]) => {
    const u = { model, inputTokens: t.input, cachedInputTokens: t.cached, outputTokens: t.output };
    return { ...u, costUsd: usageCost(u) };
  });
  const calls = Object.values(tokens).reduce((s, t) => s + t.calls, 0);
  if (!calls) return null;
  const input = usage.reduce((s, u) => s + u.inputTokens, 0);
  const cached = usage.reduce((s, u) => s + u.cachedInputTokens, 0);
  const output = usage.reduce((s, u) => s + u.outputTokens, 0);
  const cost = usage.reduce((s, u) => s + u.costUsd, 0);
  return {
    kind: "usage",
    text: `${calls} model call${calls === 1 ? "" : "s"}, ${k(input)} input tokens (${k(cached)} cached), ${k(output)} output tokens, about $${cost.toFixed(3)}`,
  };
}

const GOAL_WORDS: Record<string, string> = { active: "Goal", complete: "Goal met", blocked: "Goal blocked", paused: "Goal paused" };

/** session/goalChanged's goal, or the exit record's. `null` clears it. */
function goalLine(g: unknown): MuseLogLine {
  if (!g || typeof g !== "object") {
    return { kind: "goal", itemId: GOAL_ID, text: "Goal cleared", detail: { goal: { objective: "", status: "cleared" } } };
  }
  const o = obj(g);
  const objective = str(o.objective).trim();
  const status = str(o.status) || "active";
  const pct = num(o.percentComplete);
  return {
    kind: "goal",
    itemId: GOAL_ID,
    text: `${GOAL_WORDS[status] ?? `Goal ${status}`}: ${firstLine(objective)}`,
    detail: { goal: { objective, status, ...(pct === undefined ? {} : { percentComplete: pct }) } },
  };
}

function todoLine(items: unknown): MuseLogLine {
  const todos = arr(items)
    .map(obj)
    .map((t) => ({ text: str(t.text).trim(), status: str(t.status) || "pending" }))
    .filter((t) => t.text);
  const done = todos.filter((t) => t.status === "completed").length;
  return {
    kind: "todo",
    itemId: TODOS_ID,
    text: todos.length ? `Todo list: ${done} of ${todos.length} done` : "Todo list cleared",
    detail: { todos },
  };
}

/** What a tool's visible output says. Shell tools answer a JSON object with the exit code and the output inside. */
function readOutput(v: unknown): { raw: string; text: string; failed: boolean; exitCode?: number } {
  const raw = str(v);
  if (raw.trim().startsWith("{")) {
    try {
      const o = obj(JSON.parse(raw));
      const exitCode = num(o.exit_code);
      if (exitCode !== undefined || typeof o.terminal_status === "string") {
        const failed = (exitCode !== undefined && exitCode !== 0) || (typeof o.terminal_status === "string" && o.terminal_status !== "completed");
        return { raw, text: str(o.output), failed, ...(exitCode === undefined ? {} : { exitCode }) };
      }
      // Other JSON replies read badly as a first line, so the tool's name or arguments speak instead.
      return { raw, text: "", failed: false };
    } catch {
      // Not JSON after all.
    }
  }
  return { raw, text: raw, failed: false };
}

function parseArgs(v: unknown): Record<string, unknown> {
  if (typeof v !== "string" || !v.trim().startsWith("{")) return {};
  try {
    return obj(JSON.parse(v));
  } catch {
    return {};
  }
}

/** Finished tools without a label or a readable reply, in plain words. */
const TOOL_DONE: Record<string, string> = {
  create_goal: "Set the goal",
  update_goal: "Updated the goal",
  get_goal: "Read the goal",
  write_todos: "Updated the todo list",
  report_progress: "Reported progress",
  read_memory: "Read its memory",
  add_memory: "Saved a memory",
  edit_memory: "Edited its memory",
  read_skill: "Read a skill",
  snooze_reminder: "Snoozed an observer",
  workflow: "Started a workflow",
};

function toolText(tool: string, it: Record<string, unknown>, status: string, output: ReturnType<typeof readOutput>): string {
  const label = obj(it.displayLabel);
  const own = firstLine(status === "inProgress" ? label.active : status === "completed" ? label.done : label.neutral);
  if (own) return own;
  const done = status !== "inProgress";
  const reason = firstLine(it.failureReason);
  if (done && status !== "completed" && reason) return reason;
  const args = parseArgs(it.args);
  const path = firstLine(args.path);
  if (tool === "bash" || output.exitCode !== undefined) {
    const what = firstLine(args.description) || firstLine(args.command) || tool;
    if (!output.failed) return what;
    return `${what}: ${firstLine(output.text) || (output.exitCode === undefined ? "it failed" : `exit code ${output.exitCode}`)}`;
  }
  if (path && (it.patchSummary || tool === "write_file" || tool === "edit_file")) return `${done ? "Edited" : "Editing"} \`${path}\``;
  if (path && tool === "read_file") return `${done ? "Read" : "Reading"} \`${path}\``;
  if (done && status === "completed") {
    const named = subagentText(tool, output.raw) ?? TOOL_DONE[tool];
    if (named) return named;
  }
  if (done && output.text) return firstLine(output.text);
  return firstLine(args.description) || (path ? `\`${path}\`` : "") || tool;
}

/** A tool call: its line, and an edit line beside it when it changed files. */
function toolLines(id: string, it: Record<string, unknown>, status: string): MuseLogLine[] {
  const tool = str(it.tool) || "tool";
  const output = readOutput(it.visibleOutput);
  const done = status !== "inProgress";
  const ok = done ? status === "completed" && !output.failed : undefined;
  const lines: MuseLogLine[] = [];
  const patch = obj(it.patchSummary);
  if (Object.keys(patch).length) {
    const files = num(patch.files) ?? 0;
    const added = num(patch.added) ?? 0;
    const removed = num(patch.removed) ?? 0;
    lines.push({
      kind: "edit",
      itemId: `${id}#patch`,
      files,
      added,
      removed,
      text: `Edited ${files} file${files === 1 ? "" : "s"} (+${added} −${removed})`,
    });
  }
  lines.push({ kind: "tool", itemId: id, tool, ...(ok === undefined ? {} : { ok }), text: toolText(tool, it, status, output), detail: { status } });
  return lines;
}

/** A command the owner ran in the session's shell (the TUI's `!`). */
function shellLine(id: string, it: Record<string, unknown>, status: string): MuseLogLine {
  const code = num(it.exitCode);
  const ok = status === "inProgress" ? undefined : status === "completed" && (code === undefined || code === 0);
  return { kind: "tool", itemId: id, tool: "shell", ...(ok === undefined ? {} : { ok }), text: firstLine(it.commandText) || "Shell command", detail: { status } };
}

/** The task name in an agent path: the last segment that isn't a number, such as "scout" in main/scout/1. */
export function agentName(path: string): string {
  return path.split("/").filter((s) => s && s !== "main" && !/^\d+$/.test(s)).pop() ?? "";
}

/** The generic ending for a finished item: done, failed with its reason, stopped, or the status as it came. */
function ending(status: string, reason: string, words: { done: string; stopped: string }): string {
  if (status === "completed") return words.done;
  if (status === "cancelled" || status === "rejected") return words.stopped;
  if (status === "timedOut") return "timed out";
  if (status === "failed") return `failed${reason ? `: ${reason}` : ""}`;
  return `ended (${status})`;
}

function okFor(status: string): { ok?: boolean } {
  if (status === "completed") return { ok: true };
  if (status === "failed" || status === "timedOut") return { ok: false };
  return {};
}

function subagentLine(id: string, it: Record<string, unknown>, status: string): MuseLogLine {
  const path = str(it.agentPath);
  const name = agentName(path) || firstLine(it.role);
  const who = name ? `Subagent ${name}` : "A subagent";
  // A child whose result is ready has done its work, though its item stays open until the parent reads the result.
  const control = str(it.controlStatus);
  const shown = status === "inProgress" && (control === "resultReady" || control === "closing" || control === "closed") ? "completed" : status;
  const result = obj(it.result);
  const summary = firstLine(result.summary) || firstLine(result.text);
  const objective = firstLine(it.objective);
  const text =
    shown === "inProgress"
      ? `${who} is working${objective ? `: ${objective}` : ""}`
      : `${who} ${ending(shown, firstLine(it.failureReason) || firstLine(result.errorKind), { done: `finished${summary ? `: ${summary}` : ""}`, stopped: "stopped" })}`;
  const detail: MuseLineDetail = { status: shown };
  if (path) detail.agentPath = path;
  if (name) detail.label = name;
  if (str(it.childSessionId)) detail.childSessionId = str(it.childSessionId);
  if (str(it.workflowRunId)) detail.workflowRunId = str(it.workflowRunId);
  return { kind: "subagent", itemId: id, text, ...okFor(shown), detail };
}

function workflowLine(id: string, it: Record<string, unknown>, status: string): MuseLogLine {
  const name = firstLine(it.entryId) || firstLine(it.scriptId);
  const who = name ? `Workflow ${name}` : "A workflow";
  // Children are keyed by (childId, attempt) and re-sent whole: keep each child's latest attempt, in launch order.
  const latest = new Map<string, Record<string, unknown>>();
  for (const c of arr(it.children).map(obj)) {
    const key = str(c.childId) || str(c.label);
    const prev = latest.get(key);
    if (!prev || (num(c.attempt) ?? 0) >= (num(prev.attempt) ?? 0)) latest.set(key, c);
  }
  const children = [...latest.values()].map((c) => {
    const s = str(c.terminal) || str(c.status) || "pending";
    // "completed" with a failure kind means the attempt failed.
    return { label: firstLine(c.label) || firstLine(c.childId) || "Child", status: s === "completed" && str(c.failureKind) ? "failed" : s };
  });
  // The declared phase arrives at the end; while it runs, the newest child's phase says where it is.
  const phase = firstLine(it.declaredPhase) || [...latest.values()].map((c) => firstLine(c.phase)).filter(Boolean).pop() || "";
  const shown = status === "inProgress" && it.paused === true ? "paused" : status;
  const summary = firstLine(it.finalSummary) || firstLine(it.message);
  const text =
    shown === "paused"
      ? `${who} is paused`
      : shown === "inProgress"
        ? `${who} is running`
        : `${who} ${ending(shown, firstLine(it.failureReason) || summary, { done: `finished${summary ? `: ${summary}` : ""}`, stopped: "was cancelled" })}`;
  const detail: MuseLineDetail = { status: shown, children };
  if (name) detail.label = name;
  if (phase) detail.phase = phase;
  if (str(it.workflowRunId)) detail.workflowRunId = str(it.workflowRunId);
  return { kind: "workflow", itemId: id, text, ...okFor(shown), detail };
}

/** What each observer (Muse Code's reminder agents) does, while it runs and once it has. */
const OBSERVER_WORDS: Record<string, { active: string; done: string }> = {
  verify: { active: "is checking the work", done: "checked the work" },
  goal: { active: "is checking progress on the goal", done: "checked progress on the goal" },
  skill: { active: "is looking for skills that fit", done: "looked for skills that fit" },
  todo: { active: "is checking the todo list", done: "checked the todo list" },
  memory: { active: "is looking for things to remember", done: "looked for things to remember" },
  scope: { active: "is checking the scope", done: "checked the scope" },
};

function observerLine(id: string, it: Record<string, unknown>, status: string, name: string | null): MuseLogLine {
  const words = name ? OBSERVER_WORDS[name] : undefined;
  const who = name ? `${upperFirst(name)} observer` : "An observer";
  const summary = firstLine(obj(it.result).summary);
  let text: string;
  if (!name && firstLine(it.fallbackText)) text = firstLine(it.fallbackText);
  else if (status === "inProgress") text = `${who} ${words?.active ?? "is running"}`;
  else if (status === "completed" && summary) text = `${who}: ${summary}`;
  else text = `${who} ${ending(status, firstLine(it.failureReason), { done: words?.done ?? "ran", stopped: "stopped" })}`;
  return { kind: "reminder", itemId: id, text, ...okFor(status), detail: { ...(name ? { reminder: name } : {}), status } };
}

/** `outcome` is the hook run's durable outcome when it has one, else the item's status. */
function hookLine(id: string, it: Record<string, unknown>, outcome: string): MuseLogLine {
  const event = str(it.event);
  const label = firstLine(it.label);
  const who = `${event ? `${upperFirst(event)} hook` : "A hook"}${label ? ` (${cut(label, 60)})` : ""}`;
  const reason = firstLine(it.reason);
  const text =
    outcome === "inProgress"
      ? `${who} is running`
      : outcome === "blocked"
        ? `${who} blocked${reason ? `: ${reason}` : ""}`
        : `${who} ${ending(outcome, reason, { done: "ran", stopped: "was cancelled" })}`;
  const detail: MuseLineDetail = { status: outcome };
  if (event) detail.hookEvent = event;
  if (str(it.hookKey)) detail.hookKey = str(it.hookKey);
  return { kind: "hook", itemId: id, text, ...(outcome === "blocked" ? { ok: false } : okFor(outcome)), detail };
}

function compactionLine(id: string, it: Record<string, unknown>, status: string): MuseLogLine {
  const outcome = status === "inProgress" ? status : str(it.outcome) || (status === "completed" ? "compacted" : status);
  const before = num(it.tokensBefore);
  const after = num(it.tokensAfter);
  const text =
    outcome === "inProgress"
      ? "Muse Code is compacting its context"
      : outcome === "compacted"
        ? `Muse Code compacted its context${before !== undefined && after !== undefined ? ` from ${k(before)} to ${k(after)} tokens` : ""}`
        : outcome === "noop"
          ? "Muse Code had nothing to compact"
          : `Context compaction ${ending(outcome, firstLine(it.reason), { done: "finished", stopped: "was cancelled" })}`;
  return { kind: "compaction", itemId: id, text, detail: { status: outcome } };
}

/** Kinds this build room has no view of, in words, when the server sent no summary of its own. */
const KIND_WORDS: Record<string, string> = { webSearch: "Web search", monitorFeed: "A monitor reported back" };

/** One answer per question, as the owner gave it: the free text, or the labels picked. */
function answersText(answers: unknown): string {
  return arr(answers)
    .map(obj)
    .map((a) => str(a.freeText).trim() || str(a.selectedLabel) || arr(a.selectedLabels).map(str).filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
}

function questionLine(p: Record<string, unknown>): MuseLogLine | null {
  const userInputId = str(p.userInputId);
  if (!userInputId) return null;
  const questions = arr(p.questions)
    .map(obj)
    .map((q) => {
      const options = arr(q.options).map(obj).filter((o) => str(o.label));
      const selection = obj(q.selection);
      const multiple = selection.mode === "multiple";
      const min = num(selection.minSelections);
      const max = num(selection.maxSelections);
      const header = firstLine(q.header);
      return {
        id: str(q.id),
        text: str(q.question).trim() || header,
        options: options.map((o) => str(o.label)),
        ...(header ? { header } : {}),
        ...(options.some((o) => str(o.description)) ? { descriptions: options.map((o) => str(o.description)) } : {}),
        ...(multiple ? { multiple: true } : {}),
        ...(multiple && min !== undefined ? { min } : {}),
        ...(multiple && max !== undefined ? { max } : {}),
      };
    })
    .filter((q) => q.id && q.text);
  if (!questions.length) return null;
  return {
    kind: "question",
    itemId: `question:${userInputId}`,
    text: `Muse Code asks: ${firstLine(questions[0]!.text)}`,
    detail: { question: { userInputId, questions } },
  };
}

const SETTLED_WORDS: Record<string, string> = {
  timedOut: "Nobody answered in time, so Muse Code went on without an answer.",
  cancelled: "The question was withdrawn.",
  interrupted: "The question was interrupted.",
  clarified: "Muse Code was asked to explain the question.",
};

/** userInput/settled, which takes the question's place. `asked` is the question's line, when it was shown. */
function settledLine(p: Record<string, unknown>, asked: MuseLogLine | null): MuseLogLine | null {
  const userInputId = str(p.userInputId);
  if (!userInputId) return null;
  const outcome = str(p.outcome) || "settled";
  const answers = answersText(p.answers);
  const reason = firstLine(p.reason);
  const said =
    outcome === "answered"
      ? `Answered${answers ? `: ${answers}` : ""}.`
      : outcome === "aborted"
        ? `The question was closed${reason ? `: ${reason}` : ""}.`
        : (SETTLED_WORDS[outcome] ?? `The question ended (${outcome}).`);
  const question = firstLine(asked?.detail?.question?.questions[0]?.text);
  return { kind: "status", itemId: `question:${userInputId}`, text: question ? `${question} ${said}` : said, detail: { status: outcome } };
}

const GOAL_COMMANDS: Record<string, string> = { pause: "Pause the goal.", resume: "Resume the goal.", clear: "Clear the goal." };
const WORKFLOW_COMMANDS: Record<string, string> = { pause: "Pause the workflow.", resume: "Resume the workflow.", cancel: "Cancel the workflow." };

/** A mailbox command in the owner's words, and how it reached Muse Code. */
function describeCommand(c: Record<string, unknown>): { text: string; delivery?: Delivery } {
  const text = cut(str(c.text).trim(), MAX_NOTE);
  const action = str(c.action);
  switch (c.type) {
    case "steer":
      return { delivery: "steer", text: text || "A note for Muse Code." };
    case "queue":
      return { delivery: "queue", text: text || "A note for after this turn." };
    case "interrupt":
      return { delivery: "interrupt", text: "Stop the current turn." };
    case "goal": {
      const objective = cut(str(c.objective).trim(), MAX_NOTE);
      if (action === "set") return { delivery: "goal", text: `New goal: ${objective}` };
      if (action === "edit") return { delivery: "goal", text: `Change the goal to: ${objective}` };
      return { delivery: "goal", text: GOAL_COMMANDS[action] ?? "Change the goal." };
    }
    case "answer":
      return { delivery: "answer", text: answersText(c.answers) || "An answer." };
    case "workflow":
      return { delivery: "workflow", text: WORKFLOW_COMMANDS[action] ?? "Change the workflow." };
    case "subagent":
      if (action === "message") return { delivery: "subagent", text: `Tell the subagent: ${text}` };
      return { delivery: "subagent", text: action === "interrupt" ? "Interrupt the subagent." : "Stop the subagent." };
    case "end": {
      const reason = firstLine(c.reason);
      return { delivery: "end", text: reason ? `End the run: ${reason}` : "End the run." };
    }
    default:
      return { text: "A command." };
  }
}

/** Requests made for owner commands, which their `command` records already report. */
const COMMAND_CALL = /^(turn\/(steer|interrupt|cancel)|userInput\/|workflow\/|subagent\/)/;

/**
 * Why the bridge stopped, with the last of the host's stderr. The sandbox notices and the host's own "exit reason
 * recorded: stdin_closed" (the bridge closing it) say nothing about what went wrong.
 */
function stoppedText(code: number, reason: string, stderr: string): string {
  const said = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/bubblewrap|bwrap|exit reason recorded/i.test(l))
    .slice(-3)
    .join(" ");
  return `Muse Code stopped (${reason || `exit code ${code}`})${said ? `: ${cut(said, 600)}` : ""}`;
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Condenses complete JSONL lines from the bridge log. Lines that don't parse are skipped. `state` is the previous
 * call's `state` for the same run: it carries open items so their updates replace their lines, which observers and
 * hooks were announced (each observer and each hook gets one line per run, its first run's, while a hook that blocks
 * or fails always shows), the run's token counts and the host's stderr.
 */
export function condenseBridgeLines(lines: readonly string[], state: BridgeCondenseState = emptyBridgeState()): BridgeCondensed {
  const records = parseBridgeLines(lines);
  // Maps, so an id like "__proto__" is only ever a key.
  const shown = new Map(Object.entries(obj(state.shown)).filter((e): e is [string, string] => typeof e[1] === "string"));
  const announced = arr(state.announced).filter((a): a is string => typeof a === "string");
  const seen = new Set(announced);
  /** True the first time a key is seen in this run. */
  const announce = (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (announced.length < MAX_ANNOUNCED) announced.push(key);
    return true;
  };
  const tokens = new Map<string, Tally>(
    Object.entries(obj(state.tokens)).map(([model, v]) => {
      const t = obj(v);
      return [model, { calls: num(t.calls) ?? 0, input: num(t.input) ?? 0, cached: num(t.cached) ?? 0, output: num(t.output) ?? 0 }];
    }),
  );
  let stderr = str(state.stderr);
  let finalText: string | null = null;
  let exit: BridgeCondensed["exit"] = null;

  const out: MuseLogLine[] = [];
  /** itemId -> where its line sits in `out`: a later line for the same item in this poll takes its place. */
  const slot = new Map<string, number>();
  /** Items that finished in this poll. Their `shown` entries go once their lines are out. */
  const finished = new Set<string>();
  /** Agent message text so far, by item, for item/delta. */
  const texts = new Map<string, string>();
  /** Item kinds seen in this poll, so text deltas land only on messages. */
  const kinds = new Map<string, string>();

  /** Adds a line, or replaces this poll's line for the same item. A new sub-line goes just before its item's line. */
  const put = (line: MuseLogLine, done = false) => {
    if (!line.itemId) {
      out.push(line);
      return;
    }
    const at = slot.get(line.itemId);
    const before = subLineOf(line.itemId);
    const under = at === undefined && before !== null ? slot.get(before) : undefined;
    if (at !== undefined) out[at] = line;
    else if (under === undefined) {
      slot.set(line.itemId, out.length);
      out.push(line);
    } else {
      out.splice(under, 0, line);
      for (const [key, i] of slot) if (i >= under) slot.set(key, i + 1);
      slot.set(line.itemId, under);
    }
    if (done) finished.add(line.itemId);
    else finished.delete(line.itemId);
  };
  /** The line already shown for an id, in this poll or an earlier one. */
  const known = (id: string): MuseLogLine | null => {
    const at = slot.get(id);
    if (at !== undefined) return out[at]!;
    const json = shown.get(id);
    if (json === undefined) return null;
    try {
      return JSON.parse(json) as MuseLogLine;
    } catch {
      return null;
    }
  };

  const item = (it: Record<string, unknown>) => {
    const id = str(it.itemId);
    if (!id) return;
    const kind = str(it.kind);
    const status = str(it.status) || "inProgress";
    const done = status !== "inProgress";
    kinds.set(id, kind);
    switch (kind) {
      case "agentMessage": {
        const prior = known(id);
        const text = str(it.text) || texts.get(id) || (prior?.kind === "say" ? prior.text : "");
        texts.set(id, text);
        if (text.trim()) put({ kind: "say", itemId: id, text }, done);
        else if (done) finished.add(id);
        return;
      }
      case "reasoning": {
        const summary = arr(it.summary).map(str).filter((s) => s.trim()).join("\n\n").trim();
        if (summary) put({ kind: "reasoning", itemId: id, text: summary }, done);
        else if (done) finished.add(id);
        return;
      }
      case "toolCall":
        for (const line of toolLines(id, it, status)) put(line, done);
        return;
      case "userShell":
        put(shellLine(id, it, status), done);
        return;
      case "subagent":
        put(subagentLine(id, it, status), done);
        return;
      case "workflow":
        put(workflowLine(id, it, status), done);
        return;
      case "compaction":
        put(compactionLine(id, it, status), done);
        return;
      case "reminderChild": {
        const name = reminderName(`reminder.agent.${str(it.reminderAgentId)}`);
        // The skill observer runs after every model step: each observer shows its first run, which updates replace.
        if (!known(id) && !announce(`observer:${name ?? "other"}`)) return;
        put(observerLine(id, it, status, name), done);
        return;
      }
      case "hookRun": {
        const outcome = str(it.runStatus) || status;
        const loud = outcome === "blocked" || outcome === "failed" || outcome === "timedOut";
        if (!known(id) && !announce(`hook:${str(it.hookKey) || str(it.event) || "other"}`) && !loud) return;
        put(hookLine(id, it, outcome), done);
        return;
      }
      case "userMessage":
        // The prompt, and the owner's notes, which show from their command records.
        if (done) finished.add(id);
        return;
      default:
        put(
          {
            kind: "status",
            itemId: id,
            text: firstLine(it.fallbackText) || firstLine(it.monitorDescription) || KIND_WORDS[kind] || `${kind || "Item"}: ${status}`,
          },
          done,
        );
    }
  };

  const delta = (p: Record<string, unknown>) => {
    const id = str(p.itemId);
    if (!id || (str(p.field) || "text") !== "text" || typeof p.delta !== "string") return;
    // Reasoning summaries and tool output also stream; they show once their item carries them whole.
    const prior = known(id);
    const kind = kinds.get(id);
    if (kind ? kind !== "agentMessage" : prior !== null && prior.kind !== "say") return;
    const text = (texts.get(id) ?? (prior?.kind === "say" ? prior.text : "")) + p.delta;
    texts.set(id, text);
    kinds.set(id, "agentMessage");
    if (text.trim()) put({ kind: "say", itemId: id, text });
  };

  const note = (method: string, p: Record<string, unknown>) => {
    switch (method) {
      case "item/started":
      case "item/updated":
      case "item/completed":
        item(obj(p.item));
        return;
      case "item/delta":
        delta(p);
        return;
      case "session/goalChanged":
        put(goalLine(p.goal));
        return;
      case "session/todoListChanged":
        put(todoLine(p.items));
        return;
      case "userInput/requested": {
        const line = questionLine(p);
        if (line) put(line);
        return;
      }
      case "userInput/settled": {
        const line = settledLine(p, known(`question:${str(p.userInputId)}`));
        if (line) put(line, true);
        return;
      }
      case "session/tokenUsage": {
        const model = str(p.modelId) || "unknown";
        const u = obj(p.usage);
        const t = tokens.get(model) ?? { calls: 0, input: 0, cached: 0, output: 0 };
        t.calls++;
        // promptTokens is counted once under the provider's cache convention; cached tokens are inside it.
        t.input += num(p.promptTokens) ?? num(u.inputTokens) ?? 0;
        t.cached += num(u.cachedTokens) ?? num(u.cacheReadTokens) ?? 0;
        t.output += num(u.outputTokens) ?? 0;
        tokens.set(model, t);
        return;
      }
      case "turn/completed": {
        const terminal = str(p.terminal);
        const reason = firstLine(obj(p.error).message) || firstLine(p.reason);
        if (terminal === "failed") put({ kind: "error", ok: false, text: `The turn failed${reason ? `: ${reason}` : ""}` });
        else if (terminal === "cancelled") put({ kind: "status", text: "The turn was stopped" });
        return;
      }
      case "turn/retryScheduled":
      case "turn/modelRetryScheduled": {
        // Retries explain a slow stretch, as exec's "attempt 2/5" lines do.
        const next = num(p.nextAttempt);
        const max = num(p.maxAttempts);
        const http = num(p.httpStatus);
        put({
          kind: "status",
          text: `Retrying a model call${next && max ? ` (attempt ${next} of ${max})` : ""}${http ? ` after HTTP ${http}` : ""}`,
        });
        return;
      }
    }
  };

  for (const r of records) {
    switch (r.kind) {
      case "note":
        note(str(r.method), obj(r.params));
        break;
      case "call": {
        if (r.ok !== false || COMMAND_CALL.test(str(r.method))) break;
        const message = firstLine(obj(r.error).message);
        put({ kind: "status", text: `Muse Code refused ${str(r.method) || "a request"}${message ? `: ${message}` : ""}` });
        break;
      }
      case "command": {
        const { text, delivery } = describeCommand(obj(r.command));
        const ok = r.ok === true;
        const error = ok ? "" : firstLine(r.error);
        put(
          {
            kind: "steer",
            itemId: `command:${str(r.id) || String(r.t)}`,
            text,
            ok,
            detail: { ...(delivery ? { delivery } : {}), status: ok ? "delivered" : "refused", ...(error ? { error } : {}) },
          },
          true,
        );
        break;
      }
      case "stderr":
        stderr = (stderr + str(r.text)).slice(-MAX_STDERR);
        break;
      case "bridge": {
        if (r.event === "started") put({ kind: "start", text: "Started" });
        if (r.event !== "exit") break;
        const code = num(r.exitCode) ?? 1;
        const reason = firstLine(r.reason);
        exit = { code, ...(reason ? { reason } : {}) };
        finalText = str(r.finalText).trim() ? str(r.finalText) : null;
        if (r.goal) put(goalLine(r.goal));
        const usage = usageLine(Object.fromEntries(tokens));
        if (usage) put(usage);
        if (code === 0) {
          const line = firstLine(finalText);
          put({ kind: "done", ok: true, text: !line ? "Done" : /^done\b/i.test(line) ? line : `Done. ${line}` });
        } else put({ kind: "error", ok: false, text: stoppedText(code, reason, stderr) });
        break;
      }
    }
  }

  // Drop lines that didn't change since the last poll, and remember open items' lines for the next one.
  const fresh = out.filter((l) => {
    if (!l.itemId) return true;
    const json = JSON.stringify(l);
    const same = shown.get(l.itemId) === json;
    // Re-added at the end, so the open items that went longest without news are the first to go past the cap.
    shown.delete(l.itemId);
    if (!finished.has(l.itemId)) shown.set(l.itemId, json);
    return !same;
  });
  for (const id of finished) shown.delete(id);
  for (const id of shown.keys()) {
    if (shown.size <= MAX_SHOWN) break;
    shown.delete(id);
  }

  const next: BridgeCondenseState = { shown: Object.fromEntries(shown), announced };
  if (tokens.size) next.tokens = Object.fromEntries(tokens);
  if (stderr) next.stderr = stderr;
  return { lines: fresh, state: next, usage: [], finalText, exit };
}

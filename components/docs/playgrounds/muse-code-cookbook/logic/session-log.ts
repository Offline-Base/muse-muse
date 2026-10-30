/**
 * Reads a Muse Code session log the way the audit recipe (cookbook/audit-agent-sessions) walks it: one envelope per
 * line ({sequence, recorded_at, record_type, durability, payload_type, payload}), the event kind from
 * `payload.event.kind`, else `payload_type`. From the records it builds what the recipe shows: a timeline in lanes
 * (model calls, tool runs, edits, approvals), the ledger of every side_effect_intent and how it was authorized, the
 * approval chain threaded by pending_action_id, and what `muse resume` would find after a crash at any point: effects
 * whose terminal record committed, and effects announced but never confirmed. Pure and synchronous, so the demo and
 * the tests share it.
 */

export type Json = Record<string, unknown>;

export type Lane = "model" | "tool" | "edit" | "approval" | "reminder" | "run" | "output" | "session" | "bookkeeping";

export interface LogRecord {
  /** The 1-based line in the file. */
  line: number;
  sequence: number;
  /** The stream's kind ("session", "exec.usage") and id. */
  stream: string;
  streamId: string;
  /** recorded_at in microseconds, or null. */
  at: number | null;
  recordType: string;
  durability: string;
  payloadType: string | null;
  /** What the record is, normalized: payload.event.kind, else the payload's own kind, else payload_type. */
  kind: string;
  /** The recipe's jq view of the kind, `(.payload.event.kind // .payload_type)`; null when both are missing. */
  jqKind: string | null;
  lane: Lane;
  taskId: string | null;
  /** The task kind from its `proposed` record (tool.read_file, model.meta.response, reminder.agent.skill-reminder). */
  taskKind: string | null;
  operation: string | null;
  policyDecision: string | null;
  idempotencyKey: string | null;
  pendingActionId: string | null;
  summary: string;
  raw: Json;
}

export interface ParsedLog {
  records: LogRecord[];
  /** Lines that weren't a JSON object (the export's diagnostics count these). */
  unparseable: number[];
  blankLines: number;
}

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

const TERMINAL_TASK_KINDS = new Set(["completed", "failed", "cancelled", "canceled", "rejected"]);

/** The lane a record belongs to, from its kind, payload type and the task it is part of. */
function laneOf(kind: string, payloadType: string | null, taskKind: string | null, operation: string | null, toolName: string | null): Lane {
  const pt = payloadType ?? "";
  if (toolName === "edit_file" || toolName === "write_file") return "edit";
  if (pt.startsWith("approval") || ["requested", "decision_applied", "stage_requirement_resolved"].includes(kind)) return "approval";
  if (pt === "run.output.delta") return "output";
  if (pt.startsWith("session.") && pt !== "session.run.linked") return "session";
  if (kind === "session_end" || kind === "session_resumed") return "session";
  const op = operation ?? (taskKind ? taskKind.replace(/^tool\./, "tool:") : "");
  if (op === "tool:edit_file" || op === "tool:write_file" || kind === "tool_output_ref") return "edit";
  if (op.startsWith("tool:") || pt.startsWith("tool_batch") || pt === "tool.result") return "tool";
  if (op.startsWith("model.") || op === "model") return "model";
  if (op.startsWith("reminder")) return "reminder";
  if (pt.startsWith("run.") || pt === "turn.input.user") return "run";
  return "bookkeeping";
}

/** One line a reader can scan: what this record says happened. */
function summarize(kind: string, pt: string | null, payload: Json, event: Json | null, taskKind: string | null): string {
  const e = event ?? {};
  switch (kind) {
    case "command_accepted":
      return `Command accepted: ${str(payload.command_kind) ?? "command"}`;
    case "session_run_linked":
      return "Run stream linked to the session";
    case "run_model_configured":
      return `Model configured: ${str(payload.model_id) ?? "?"} (${str(payload.provider_id) ?? "provider"}, ${str(payload.source) ?? "config"})`;
    case "turn_input_user":
      return `User prompt: ${firstLine(str(payload.prompt) ?? "")}`;
    case "run_started":
      return "Run started";
    case "task_stream_linked":
      return "Task stream linked";
    case "proposed":
      return `Proposed ${str(e.task_kind) ?? taskKind ?? "a task"}`;
    case "accepted":
      return "Accepted";
    case "scheduled":
      return "Scheduled";
    case "side_effect_intent":
      return `Intent: ${str(e.operation) ?? "?"}, authorized ${str(e.policy_decision) ?? "?"}`;
    case "started":
      return pt?.startsWith("tool_batch") ? "Effect started" : "Started";
    case "status":
      return str(e.message) ?? "Status";
    case "output":
      return `Output: ${firstLine(str(e.chunk) ?? "")}`;
    case "tool_output_ref": {
      const s = obj(obj(e.output_ref)?.patch_summary);
      return s ? `Patch: ${num(s.files) ?? 0} file(s), +${num(s.added) ?? 0} -${num(s.removed) ?? 0}` : "Tool output stored";
    }
    case "completed":
      return "Completed";
    case "rejected":
      return `Rejected: ${str(e.reason) ?? "no reason given"}`;
    case "tool_result": {
      const facts = obj(payload.correlation_facts);
      return `${str(facts?.tool_name) ?? "tool"} ${str(facts?.outcome) ?? ""}: ${firstLine(str(payload.text) ?? "")}`.replace(/\s+:/, ":");
    }
    case "run_output_delta":
      return `Streaming text: ${JSON.stringify(str(payload.text) ?? "")}`;
    case "run_usage": {
      const models = Array.isArray(payload.models) ? (payload.models as unknown[]).map(obj).filter(Boolean) as Json[] : [];
      const m = models[0];
      return m
        ? `Usage: ${num(payload.calls) ?? 0} model calls, ${num(m.input_tokens) ?? 0} in (${num(m.cached_tokens) ?? 0} cached), ${num(m.output_tokens) ?? 0} out`
        : "Usage";
    }
    case "run_terminal":
      return `Run ${str(payload.terminal) ?? "ended"}: ${firstLine(str(payload.text) ?? "")}`;
    case "requested": {
      const subject = obj(e.approval_subject);
      return `Review requested: ${str(subject?.raw_command) ?? str(e.action) ?? "an action"}`;
    }
    case "stage_requirement_resolved":
      return `Stage requirement resolved: ${str(e.resolution) ?? str(e.outcome) ?? "resolved"}`;
    case "decision_applied": {
      const source = obj(e.decision_source);
      return `Decision: ${str(e.decision) ?? "?"} (${str(e.policy_result) ?? "?"}) by ${str(source?.kind) ?? "?"}`;
    }
    case "session_end":
      return `Session end: ${str(obj(payload.record)?.exit_reason) ?? str(e.exit_reason) ?? "ended"}`;
    case "session_resumed": {
      const rec = obj(payload.record) ?? obj(e.record);
      return `Session resumed from sequence ${num(rec?.resumed_from_sequence) ?? "?"}`;
    }
    default:
      if (pt === "approval_wait.effect.started") return "Waiting for approval: the tool has not run";
      if (pt === "approval_wait.effect.terminal") return `Approval wait ended: ${str(e.outcome) ?? str(payload.outcome) ?? "done"}`;
      if (pt === "tool_batch.effect.started") return "Effect started: only now does the tool run";
      if (pt === "tool_batch.effect.terminal") return "Effect finished";
      return pt ?? kind;
  }
}

/** Parses JSONL text (or lines) into records. Blank lines are skipped; anything else that isn't an object is counted. */
export function parseSessionLog(input: string | readonly string[]): ParsedLog {
  const lines = typeof input === "string" ? input.split(/\r?\n/) : input;
  const records: LogRecord[] = [];
  const unparseable: number[] = [];
  let blankLines = 0;
  const taskKinds = new Map<string, string>();

  lines.forEach((text, i) => {
    if (!text.trim()) {
      blankLines++;
      return;
    }
    let raw: Json | null = null;
    try {
      raw = obj(JSON.parse(text));
    } catch {
      raw = null;
    }
    if (!raw || typeof raw.sequence !== "number") {
      unparseable.push(i + 1);
      return;
    }
    const payload = obj(raw.payload) ?? {};
    const event = obj(payload.event);
    const pt = str(raw.payload_type);
    const ownKind = str(payload.kind);
    // The event's kind first (proposed, side_effect_intent), then the payload's own (tool_result, session_resumed),
    // then the dotted payload type for stream facts that carry neither (approval_wait.effect.started).
    const effectiveKind = str(event?.kind) ?? (ownKind && ownKind !== "task_lifecycle" ? ownKind : null) ?? pt ?? "unknown";
    const toolName = str(obj(payload.correlation_facts)?.tool_name);
    const taskId = str(event?.task_id) ?? str(payload.task_id);
    if (taskId && str(event?.task_kind)) taskKinds.set(taskId, str(event?.task_kind)!);
    const taskKind = taskId ? (taskKinds.get(taskId) ?? null) : null;
    const operation = str(event?.operation);
    const stream = obj(raw.stream);
    records.push({
      line: i + 1,
      sequence: raw.sequence as number,
      stream: str(stream?.kind) ?? "session",
      streamId: str(stream?.id) ?? "",
      at: num(raw.recorded_at),
      recordType: str(raw.record_type) ?? "",
      durability: str(raw.durability) ?? "",
      payloadType: pt,
      kind: effectiveKind,
      jqKind: str(event?.kind) ?? pt,
      lane: laneOf(effectiveKind, pt, taskKind, operation, toolName),
      taskId,
      taskKind,
      operation,
      policyDecision: str(event?.policy_decision),
      idempotencyKey: str(event?.idempotency_key),
      pendingActionId: str(event?.pending_action_id) ?? str(payload.pending_action_id),
      summary: summarize(effectiveKind, pt, payload, event, taskKind),
      raw,
    });
  });
  return { records, unparseable, blankLines };
}

/** Seconds since the first timestamped record, as the recipe's ledger prints them ("+ 16.9s"). */
export function offsetSeconds(records: readonly LogRecord[], r: LogRecord): number | null {
  const first = records.find((x) => x.at !== null)?.at;
  if (first === undefined || first === null || r.at === null) return null;
  return (r.at - first) / 1e6;
}

/** What each policy_decision value means, in the recipe's words where it gives them. */
export function explainDecision(decision: string | null): string {
  if (!decision) return "No decision recorded";
  if (decision === "allow:policy") return "Allowed by static policy";
  if (decision === "allow:llm_judge") return "Allowed by the reviewer (an LLM judge standing in for the interactive prompt)";
  if (decision === "allow:approved") return "Allowed after a person approved the held stage";
  if (decision === "not_applicable") return "A model call: no authorization applies";
  if (decision.includes("auto_approval")) return "Auto-approved: a read-only reminder agent";
  if (decision.startsWith("deny")) return "Denied";
  return "As recorded";
}

export interface LedgerRow {
  sequence: number;
  offset: number | null;
  /** "model call", "tool run", "edit", "approval", "reminder". */
  what: string;
  /** The tool or operation: bash, edit_file, model.meta.response; for approvals REQUESTED or APPROVED. */
  name: string;
  /** auth=allow:policy, or for approvals the command or the authorizer. */
  detail: string;
  lane: Lane;
}

function ledgerName(r: LogRecord): string {
  const op = r.operation ?? "";
  return op.startsWith("tool:") ? op.slice(5) : op || r.kind;
}

/**
 * The ledger build_ledger.py prints from an export: one row per journaled action, each with how it was authorized,
 * plus the approval moments (requested, then the verdict and who gave it).
 */
export function buildLedger(records: readonly LogRecord[]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const r of records) {
    const offset = offsetSeconds(records, r);
    if (r.kind === "side_effect_intent") {
      const what = r.lane === "model" ? "model call" : r.lane === "edit" ? "edit" : r.lane === "reminder" ? "reminder" : "tool run";
      rows.push({ sequence: r.sequence, offset, what, name: ledgerName(r), detail: `auth=${r.policyDecision ?? "?"}`, lane: r.lane });
    } else if (r.kind === "requested") {
      const subject = obj(obj(obj(r.raw.payload)?.event)?.approval_subject);
      const cmd = str(subject?.raw_command) ?? "";
      const tool = str(subject?.kind) === "shell_command" ? "bash" : (str(subject?.kind) ?? "action");
      rows.push({ sequence: r.sequence, offset, what: "approval", name: "REQUESTED", detail: `${tool}: ${cmd}`, lane: "approval" });
    } else if (r.kind === "decision_applied") {
      const e = obj(obj(r.raw.payload)?.event) ?? {};
      const decision = (str(e.decision) ?? "?").toUpperCase();
      const by = str(obj(e.decision_source)?.kind) ?? "?";
      rows.push({ sequence: r.sequence, offset, what: "approval", name: decision, detail: `by ${by}`, lane: "approval" });
    }
  }
  return rows;
}

/**
 * The ledger as build_ledger.py --plain prints it, column for column: sequence, offset, what, then the tool and its
 * authorization, or the approval moment.
 */
export function ledgerPlain(sessionId: string, records: readonly LogRecord[], rows: readonly LedgerRow[], termination: string, withModel = false): string {
  const shown = rows.filter((r) => withModel || r.lane !== "model");
  const head = `audit ledger  ${sessionId || "(no session id)"}  (${records.length} events, termination: ${termination})`;
  const lines = shown.map((r) => {
    const seq = String(r.sequence).padStart(4);
    const off = r.offset === null ? "        " : `+ ${r.offset.toFixed(1).padStart(5)}s`;
    const rest = r.what === "approval" ? `${r.name}  ${r.detail}` : `${r.name.padEnd(10)} ${r.detail}`;
    return `${seq}  ${off}  ${r.what.padEnd(10)} ${rest}`;
  });
  return [head, ...lines].join("\n");
}

export interface AuthSummary {
  decision: string;
  count: number;
  meaning: string;
}

/** How many intents each policy_decision covers: the audit answer to "who allowed each action". */
export function authorizationSummary(records: readonly LogRecord[]): AuthSummary[] {
  const counts = new Map<string, number>();
  for (const r of records) if (r.kind === "side_effect_intent") counts.set(r.policyDecision ?? "?", (counts.get(r.policyDecision ?? "?") ?? 0) + 1);
  return [...counts.entries()].map(([decision, count]) => ({ decision, count, meaning: explainDecision(decision) }));
}

export interface ApprovalChain {
  pendingActionId: string;
  steps: LogRecord[];
  /** The command under review, when the request names it. */
  command: string | null;
  decision: string | null;
  authorizer: Json | null;
  /** The intent that carries the authorization, when it landed. */
  intent: LogRecord | null;
}

/** Each approval, as the causal chain the recipe walks: requested, the wait, the verdict, the intent, the run. */
export function approvalChains(records: readonly LogRecord[]): ApprovalChain[] {
  const byId = new Map<string, LogRecord[]>();
  for (const r of records) {
    if (!r.pendingActionId) continue;
    const list = byId.get(r.pendingActionId) ?? [];
    list.push(r);
    byId.set(r.pendingActionId, list);
  }
  return [...byId.entries()].map(([id, steps]) => {
    const request = steps.find((s) => s.kind === "requested");
    const verdict = steps.find((s) => s.kind === "decision_applied");
    const event = verdict ? obj(obj(verdict.raw.payload)?.event) : null;
    const taskId = steps.find((s) => s.taskId)?.taskId ?? null;
    const intent = records.find((r) => r.kind === "side_effect_intent" && (r.pendingActionId === id || (taskId && r.taskId === taskId))) ?? null;
    const subject = request ? obj(obj(obj(request.raw.payload)?.event)?.approval_subject) : null;
    return {
      pendingActionId: id,
      steps,
      command: str(subject?.raw_command),
      decision: str(event?.decision),
      authorizer: obj(event?.decision_source),
      intent,
    };
  });
}

export interface EffectState {
  intent: LogRecord;
  /** The record that closed the effect, or null when it never confirmed. */
  terminal: LogRecord | null;
}

function isTerminalFor(r: LogRecord, intent: LogRecord): boolean {
  const sameTask = intent.taskId !== null && r.taskId === intent.taskId;
  const samePending = intent.pendingActionId !== null && r.pendingActionId === intent.pendingActionId && r.payloadType === "tool_batch.effect.terminal";
  if (!sameTask && !samePending) return false;
  return r.payloadType === "tool_batch.effect.terminal" || TERMINAL_TASK_KINDS.has(r.kind);
}

/** Every intent and the terminal record that committed it, if one landed. */
export function effects(records: readonly LogRecord[]): EffectState[] {
  return records
    .filter((r) => r.kind === "side_effect_intent")
    .map((intent) => ({ intent, terminal: records.find((r) => r.line > intent.line && isTerminalFor(r, intent)) ?? null }));
}

export interface ResumeReport {
  /** The records on disk at the cut, in file order. */
  kept: number;
  lastSequence: number | null;
  committed: EffectState[];
  /** Announced but never confirmed: the resumed turn reports these as unknown instead of retrying them. */
  inFlight: EffectState[];
  /** Idempotency keys written by more than one intent (the recipe's `sort | uniq -d`), which should be none. */
  duplicateKeys: string[];
  /** True when the run or session recorded an orderly end before the cut. */
  orderlyEnd: boolean;
  /** How the log says it ended: clean (session.end), crash_inferred, completed (run.terminal), or none. */
  ending: string;
  /** A session.resumed record, if the log already holds one. */
  resumedFrom: number | null;
}

/** What `muse resume` finds in the log as it stands after `keep` records (the whole log when keep is undefined). */
export function resumeReport(records: readonly LogRecord[], keep?: number): ResumeReport {
  const kept = keep === undefined ? records : records.slice(0, Math.max(0, keep));
  const states = effects(kept);
  const keys = new Map<string, number>();
  for (const r of kept) if (r.kind === "side_effect_intent" && r.idempotencyKey) keys.set(r.idempotencyKey, (keys.get(r.idempotencyKey) ?? 0) + 1);
  const end = [...kept].reverse().find((r) => r.kind === "session_end");
  const endReason = end ? (str(obj(obj(end.raw.payload)?.record)?.exit_reason) ?? str(obj(obj(end.raw.payload)?.event)?.exit_reason) ?? "ended") : null;
  const terminalRun = kept.find((r) => r.kind === "run_terminal");
  const resumed = [...kept].reverse().find((r) => r.kind === "session_resumed");
  const resumedRec = resumed ? (obj(obj(resumed.raw.payload)?.record) ?? obj(obj(resumed.raw.payload)?.event)) : null;
  return {
    kept: kept.length,
    lastSequence: kept.length ? kept[kept.length - 1].sequence : null,
    committed: states.filter((s) => s.terminal),
    inFlight: states.filter((s) => !s.terminal),
    duplicateKeys: [...keys.entries()].filter(([, n]) => n > 1).map(([k]) => k),
    orderlyEnd: endReason === "clean",
    ending: endReason ?? (terminalRun ? `run ${str(obj(terminalRun.raw.payload)?.terminal) ?? "ended"}` : "none"),
    resumedFrom: num(resumedRec?.resumed_from_sequence),
  };
}

/** The export's diagnostics block, with the recipe's keys in its order. */
export interface Diagnostics {
  unparseable_lines: number;
  /** Envelopes whose kind this page's parser doesn't know (Muse Code's exporter counts against its own list). */
  unknown_payload_kinds: number;
  /** Places where a stream's sequence numbers jump. */
  gaps: number;
  /** Markers for live-only records (streaming deltas) the writer left out of the durable log. */
  omitted_live_only: number;
  duplicate_records: number;
}

/** Every kind the parser reads, from payload.event.kind, the payload's own kind, or the payload type. */
const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "command_accepted", "session_run_linked", "run_model_configured", "turn_input_user", "run_started", "task_stream_linked",
  "proposed", "accepted", "scheduled", "side_effect_intent", "started", "status", "output", "tool_output_ref", "completed",
  "failed", "cancelled", "canceled", "rejected", "tool_result", "run_output_delta", "run_usage", "run_terminal", "requested",
  "stage_requirement_resolved", "decision_applied", "session_end", "session_resumed",
  "approval_wait.effect.started", "approval_wait.effect.terminal", "tool_batch.effect.started", "tool_batch.effect.terminal",
]);

/** A marker the writer leaves where it dropped a live-only record. The recipe doesn't show one, so match by name. */
function isLiveOnlyMarker(r: LogRecord): boolean {
  return /omitted|live[_.-]?only/i.test(`${r.payloadType ?? ""} ${r.kind}`);
}

/** Records the session writes for live viewers only: streaming deltas and status, kept inline in a --json stream. */
export function liveOnlyRecords(parsed: ParsedLog): number {
  return parsed.records.filter((r) => r.durability === "ephemeral").length;
}

/** Tolerance counters like the export's diagnostics block, computed from this log. */
export function diagnostics(parsed: ParsedLog): Diagnostics {
  const byStream = new Map<string, number[]>();
  const ids = new Map<string, number>();
  for (const r of parsed.records) {
    const key = `${r.stream}:${r.streamId}`;
    byStream.set(key, [...(byStream.get(key) ?? []), r.sequence]);
    const id = str(r.raw.id);
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  let gaps = 0;
  for (const seqs of byStream.values()) {
    const sorted = [...new Set(seqs)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > 1) gaps++;
  }
  return {
    unparseable_lines: parsed.unparseable.length,
    unknown_payload_kinds: parsed.records.filter((r) => !KNOWN_KINDS.has(r.kind)).length,
    gaps,
    omitted_live_only: parsed.records.filter(isLiveOnlyMarker).length,
    duplicate_records: [...ids.values()].filter((n) => n > 1).length,
  };
}

/** One session stream's summary for the export: its turns, its records, and how it ended. */
export interface SessionSummary {
  session_id: string | null;
  /** User turns: the stream's run.lifecycle.started records (one per prompt). */
  turn_count: number;
  /** The stream's records. */
  step_count: number;
  /** The session.end record's facts ({ exit_reason, uptime_ms }), or null when the log has none. */
  session_end: Json | null;
}

/** The export's sessions block: one summary per session stream in the log. */
export function sessionSummaries(records: readonly LogRecord[]): SessionSummary[] {
  const ids = [...new Set(records.filter((r) => r.stream === "session").map((r) => r.streamId))];
  return ids.map((id) => {
    const own = records.filter((r) => r.stream === "session" && r.streamId === id);
    const end = [...own].reverse().find((r) => r.kind === "session_end");
    return {
      session_id: id || null,
      turn_count: own.filter((r) => r.kind === "run_started").length,
      step_count: own.length,
      session_end: end ? (obj(obj(end.raw.payload)?.record) ?? obj(obj(end.raw.payload)?.event) ?? {}) : null,
    };
  });
}

/** The session id the log is about: the first session stream's id. */
export function sessionIdOf(records: readonly LogRecord[]): string {
  return records.find((r) => r.stream === "session" && r.streamId)?.streamId ?? "";
}

// ---------------------------------------------------------------------------------------------------------------
// Redaction (`muse export --redacted`)

const REDACTIONS: ReadonlyArray<{ name: string; re: RegExp; to: string }> = [
  { name: "PEM block", re: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, to: "[REDACTED PEM]" },
  { name: "authorization header", re: /(authorization\s*[:=]\s*)("?)[^\s"',}]+(?:\s+[^\s"',}]+)?/gi, to: "$1$2[REDACTED]" },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, to: "Bearer [REDACTED]" },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, to: "[REDACTED JWT]" },
  { name: "provider token", re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, to: "[REDACTED TOKEN]" },
  {
    name: "secret-keyed assignment",
    re: /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*[=:]\s*)(["']?)(?!\[REDACTED)[^\s"']{4,}\2/gi,
    to: "$1$2[REDACTED]$2",
  },
];

/** One string through the redaction rules: what `--redacted` does to every payload string. */
export function redactString(text: string): { text: string; hits: string[] } {
  let out = text;
  const hits: string[] = [];
  for (const rule of REDACTIONS) {
    const next = out.replace(rule.re, rule.to);
    if (next !== out) hits.push(rule.name);
    out = next;
  }
  return { text: out, hits };
}

/** A copy of a value with every string redacted, and the rules that fired. */
export function redactValue(value: unknown): { value: unknown; hits: string[] } {
  const hits: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactString(v);
      hits.push(...r.hits);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Json).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), hits };
}

// ---------------------------------------------------------------------------------------------------------------
// jq, the way the recipe reads a log

/** The recipe's approval-window query, aimed at a raw session.jsonl, and the lines it would print. */
export function jqWindow(records: readonly LogRecord[], from: number, to: number): { command: string; output: string[] } {
  const command = `jq -c 'select(.sequence>=${from} and .sequence<=${to})\n    | {seq:.sequence, kind:(.payload.event.kind // .payload_type)}' session.jsonl`;
  const output = records
    .filter((r) => r.stream === "session" && r.sequence >= from && r.sequence <= to)
    .map((r) => JSON.stringify({ seq: r.sequence, kind: r.jqKind }));
  return { command, output };
}

/** The recipe's duplicate check: idempotency keys that fired more than once (no output means none). */
export function jqDuplicateKeys(records: readonly LogRecord[]): { command: string; output: string[] } {
  return {
    command: `jq -r 'select((.payload.event.kind // "")=="side_effect_intent")\n  | .payload.event.idempotency_key' session.jsonl | sort | uniq -d`,
    output: resumeReport(records).duplicateKeys,
  };
}

/** The recipe's crash-and-resume spine: intents, effect terminals, session.end and session.resumed, one line each. */
export function jqSpine(records: readonly LogRecord[]): { command: string; output: string[] } {
  const command = [
    "jq -r '((.payload.event.kind // .payload_type) // \"\") as $k",
    '  | select($k | test("^(side_effect_intent|tool_batch\\\\.effect\\\\.terminal|session\\\\.end|session\\\\.resumed)"))',
    '  | "\\(.sequence)  \\($k)  \\(.payload.event.operation // .payload.record.exit_reason // "")"\' "$F"',
  ].join("\n");
  const output = records
    .filter((r) => r.stream === "session" && /^(side_effect_intent|tool_batch\.effect\.terminal|session\.end|session\.resumed)/.test(r.jqKind ?? ""))
    .map((r) => {
      const payload = obj(r.raw.payload);
      const extra = r.operation ?? str(obj(payload?.record)?.exit_reason) ?? "";
      return `${r.sequence}  ${r.jqKind}  ${extra}`.trimEnd();
    });
  return { command, output };
}

/**
 * What the audit demo hands a reviewer model: the ledger (model calls included), the effects a resume would find in
 * flight, how the log ends and any approvals. Derived data only, never the raw log, and redacted before it's sent.
 */
export function ledgerSummary(records: readonly LogRecord[], keep: number = records.length): string {
  const kept = records.slice(0, keep);
  const sessionId = sessionIdOf(records);
  const report = resumeReport(records, keep);
  const termination = report.orderlyEnd ? "clean" : report.ending === "none" ? "no orderly end" : report.ending;
  const text = [
    `Session ${sessionId || "(unknown)"}: ${kept.length} records${keep < records.length ? `, the process was killed after sequence ${report.lastSequence}` : ""}.`,
    "",
    ledgerPlain(sessionId, kept, buildLedger(kept), termination, true),
    "",
    `Effects with a terminal record: ${report.committed.length}. Announced but never confirmed: ${report.inFlight.map((s) => `${s.intent.sequence} ${s.intent.operation}`).join(", ") || "none"}.`,
    `Ending: ${termination}. Duplicate idempotency keys: ${report.duplicateKeys.length ? report.duplicateKeys.join(", ") : "none"}.`,
    ...approvalChains(kept).map((c) => `Approval ${c.pendingActionId}: ${c.command ?? "an action"}, decision ${c.decision ?? "none yet"} by ${String(c.authorizer?.kind ?? "?")}.`),
  ].join("\n");
  return redactString(text).text;
}

/**
 * The export document for a log as it stands after `keep` records, rebuilt from the raw lines: a pure function of the
 * log bytes and the flags, which is what makes two exports of one log byte-identical. The header uses the recipe's
 * keys, in its order, with what this page can compute: Muse Code's exporter also stamps exporter_version and
 * session_build, and its own counts may differ (see SessionSummary and Diagnostics for how these are counted).
 */
export function exportDocument(lines: string | readonly string[], keep: number | undefined, redacted: boolean): Record<string, unknown> {
  const parsed = parseSessionLog(lines);
  const kept = keep === undefined ? parsed.records : parsed.records.slice(0, keep);
  const report = resumeReport(parsed.records, keep);
  const doc = {
    export_schema_version: 1,
    redaction: redacted ? "redacted" : "raw",
    session_terminated_abnormally: !report.orderlyEnd,
    sessions: sessionSummaries(kept),
    diagnostics: diagnostics({ ...parsed, records: kept }),
    events: kept.map((r) => ({ kind: "record", envelope: r.raw })),
  };
  return redacted ? (redactValue(doc).value as Record<string, unknown>) : doc;
}

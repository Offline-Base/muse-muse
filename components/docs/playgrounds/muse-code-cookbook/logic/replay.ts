/**
 * A stand-in for `muse trace inspect --fixture` and the recipe's replay_gate.sh (cookbook/deterministic-replay),
 * written from the recipe's description: a golden fixture (schema_version 1, a name, focused run_records and the
 * expected_model_context they should reduce to) is projected again, offline, and compared field by field. Zero diffs
 * pass; any diff fails the gate, even though inspect itself exits zero. Muse Code's real projection is richer; this
 * one covers the payload kinds the recipe shows (started, tool_result, assistant_message_committed, model_completed,
 * terminal), which is enough to watch the gate catch drift.
 */

export type Json = Record<string, unknown>;

export interface ContextMessage {
  role: "user" | "tool" | "assistant";
  text: string;
  call_id?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

export interface ModelContext {
  messages: ContextMessage[];
  assistant_text: string | null;
  terminal: string | null;
  usage?: Usage;
}

export interface Diff {
  scope: "model_context";
  path: string;
  expected: unknown;
  actual: unknown;
}

export interface LoadError {
  category: string;
  message: string;
}

export interface InspectReport {
  trace: string;
  source: string;
  result: string;
  records: { run: number; task: number };
  load_status: "complete" | "partial";
  errors: LoadError[];
  diffs: Diff[];
}

/** The recipe's committed fixture, with its four payloads plus the boundaries it says to keep (model_response_created, and model_completed because usage is part of the expectation). */
export const CHECKOUT_PROBE: Json = {
  schema_version: 1,
  name: "checkout_probe",
  run_records: [
    {
      payload: {
        kind: "started",
        prompt: "Read tariff.py and tell me the exact final checkout total it prints after the Grintable surcharge. Give the number.",
      },
    },
    { payload: { kind: "tool_result", call_id: "c1", text: "Final total: 138.00" } },
    { payload: { kind: "model_response_created", response_id: "resp_1" } },
    {
      payload: {
        kind: "assistant_message_committed",
        text: "Final total: 138.00",
        message_id: "018f0000-0000-7000-8000-000000000301",
        response_id: "resp_1",
      },
    },
    { payload: { kind: "model_completed", response_id: "resp_1", usage: { input_tokens: 41, output_tokens: 18, cached_tokens: 0 } } },
    { payload: { kind: "terminal", terminal: "completed", reason: null } },
  ],
  expected_model_context: {
    messages: [
      { role: "user", text: "Read tariff.py and tell me the exact final checkout total it prints after the Grintable surcharge. Give the number." },
      { role: "tool", call_id: "c1", text: "Final total: 138.00" },
      { role: "assistant", text: "Final total: 138.00" },
    ],
    assistant_text: "Final total: 138.00",
    terminal: "completed",
    usage: { input_tokens: 41, output_tokens: 18, cached_tokens: 0 },
  },
};

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A record's payload: a full envelope keeps it under `payload`, an abbreviated one is `{ payload }` too. */
function payloadOf(record: unknown): Json | null {
  return obj(obj(record)?.payload);
}

/**
 * The model-visible context the records reduce to: the user prompt, each tool result, each committed assistant
 * message, the last assistant text, the terminal state, and usage summed over model_completed records.
 */
export function project(records: readonly unknown[]): ModelContext {
  const messages: ContextMessage[] = [];
  let assistant: string | null = null;
  let terminal: string | null = null;
  let usage: Usage | undefined;
  for (const record of records) {
    const p = payloadOf(record);
    if (!p) continue;
    switch (p.kind) {
      case "started":
        messages.push({ role: "user", text: str(p.prompt) ?? "" });
        break;
      case "tool_result":
        messages.push({ role: "tool", call_id: str(p.call_id) ?? "", text: str(p.text) ?? "" });
        break;
      case "assistant_message_committed":
        assistant = str(p.text) ?? "";
        messages.push({ role: "assistant", text: assistant });
        break;
      case "model_completed": {
        const u = obj(p.usage);
        usage = {
          input_tokens: (usage?.input_tokens ?? 0) + num(u?.input_tokens),
          output_tokens: (usage?.output_tokens ?? 0) + num(u?.output_tokens),
          cached_tokens: (usage?.cached_tokens ?? 0) + num(u?.cached_tokens),
        };
        break;
      }
      case "terminal":
        terminal = str(p.terminal);
        break;
    }
  }
  return { messages, assistant_text: assistant, terminal, ...(usage ? { usage } : {}) };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Field-by-field differences, named the way the recipe prints them (model_context.assistant_text). */
export function diffContext(expected: unknown, actual: unknown, path = "model_context"): Diff[] {
  if (same(expected, actual)) return [];
  const e = obj(expected);
  const a = obj(actual);
  if (e && a) {
    const keys = [...new Set([...Object.keys(e), ...Object.keys(a)])];
    return keys.flatMap((k) => diffContext(e[k], a[k], `${path}.${k}`));
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const n = Math.max(expected.length, actual.length);
    const out: Diff[] = [];
    for (let i = 0; i < n; i++) out.push(...diffContext(expected[i], actual[i], `${path}[${i}]`));
    return out;
  }
  return [{ scope: "model_context", path, expected: expected === undefined ? null : expected, actual: actual === undefined ? null : actual }];
}

/**
 * The final assistant message and assistant_text carry the same text, so one changed answer would show twice. It
 * shows once, under assistant_text, the way the recipe's report prints the drift.
 */
function collapseAssistantEcho(diffs: Diff[], actual: ModelContext): Diff[] {
  const lastAssistant = actual.messages.map((m) => m.role).lastIndexOf("assistant");
  const answer = diffs.find((d) => d.path === "model_context.assistant_text");
  if (!answer || lastAssistant < 0) return diffs;
  return diffs.filter(
    (d) => !(d.path === `model_context.messages[${lastAssistant}].text` && same(d.expected, answer.expected) && same(d.actual, answer.actual)),
  );
}

/** What inspect prints for a --fixture argument that names no file: the recipe's "Result: unknown" with run=0. */
export function unknownReport(arg: string): InspectReport {
  return { trace: arg, source: arg, result: "unknown", records: { run: 0, task: 0 }, load_status: "complete", errors: [], diffs: [] };
}

/** Loads and replays one fixture: what `muse trace inspect --fixture <file> --format json` reports about it. */
export function inspectFixture(fixture: unknown, source = "fixture"): InspectReport {
  const f = obj(fixture);
  const name = str(f?.name) ?? source.replace(/^.*\//, "").replace(/\.json$/, "");
  const base = { trace: name, source };
  if (!f) {
    return { ...base, result: "unknown", records: { run: 0, task: 0 }, load_status: "partial", errors: [{ category: "replay_schema", message: "the fixture is not a JSON object" }], diffs: [] };
  }
  const version = f.schema_version;
  if (version !== 1) {
    return {
      ...base,
      result: "unknown",
      records: { run: 0, task: 0 },
      load_status: "partial",
      errors: [{ category: "replay_schema", message: `unsupported fixture schema version ${version === undefined ? "(missing)" : JSON.stringify(version)}` }],
      diffs: [],
    };
  }
  const records = Array.isArray(f.run_records) ? f.run_records : [];
  const tasks = Array.isArray(f.task_records) ? f.task_records : [];
  const actual = project(records);
  const expected = obj(f.expected_model_context);
  const diffs = expected ? collapseAssistantEcho(diffContext(expected, actual), actual) : [];
  return {
    ...base,
    result: actual.terminal ?? "unknown",
    records: { run: records.length, task: tasks.length },
    load_status: "complete",
    errors: expected ? [] : [{ category: "replay_schema", message: "expected_model_context is missing" }],
    diffs,
  };
}

function show(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** The compact text report, as the recipe's terminal shows it. */
export function reportText(r: InspectReport): string {
  const lines = [`Trace: ${r.trace}`];
  if (r.result === "unknown" && !r.records.run) lines.push(`Source: ${r.source}`);
  lines.push(`Result: ${r.result}`, `Records: run=${r.records.run} task=${r.records.task}`);
  if (r.load_status !== "complete") {
    lines.push(`load_status: ${r.load_status}`, ...r.errors.map((e) => `error [${e.category}]: ${e.message}`));
    return lines.join("\n");
  }
  lines.push("Diffs:");
  if (!r.diffs.length) lines.push("  none");
  for (const d of r.diffs) lines.push(`  [${d.scope}] ${d.path}`, `    expected: ${show(d.expected)}`, `    actual:   ${show(d.actual)}`);
  return lines.join("\n");
}

/** The JSON report the gate reads: `jq '.diffs | length'`. Stable key order, so equal inputs give equal bytes. */
export function reportJson(r: InspectReport): string {
  return JSON.stringify(r, null, 2);
}

export interface GateResult {
  lines: string[];
  exitCode: 0 | 1;
}

/** replay_gate.sh over a set of fixtures: PASS or FAIL per fixture, exit 1 on any diff or load failure. */
export function gate(reports: readonly InspectReport[]): GateResult {
  const lines: string[] = [];
  let failed = false;
  for (const r of reports) {
    if (r.load_status !== "complete" || r.errors.length) {
      failed = true;
      lines.push(`FAIL  ${r.trace}: load ${r.load_status}`, ...r.errors.map((e) => `        ${e.category}: ${e.message}`));
    } else if (r.diffs.length) {
      failed = true;
      lines.push(`FAIL  ${r.trace}: ${r.diffs.length} projection diff(s)`, ...r.diffs.map((d) => `        ${d.path}: expected ${show(d.expected)}, actual ${show(d.actual)}`));
    } else {
      lines.push(`PASS  ${r.trace}`);
    }
  }
  return { lines, exitCode: failed ? 1 : 0 };
}

/**
 * What `--fixture <arg>` finds: the file name with its extension, or a path into the trace directory. A bare stem
 * finds nothing and reports Result: unknown with run=0, the recipe's "Fixture Path Reports An Unknown Result".
 */
export function resolveFixtureArg(arg: string, name: string, dir = "golden-traces"): "found" | "unknown" {
  const a = arg.trim().replace(/^\.\//, "");
  return a === `${name}.json` || a === `${dir}/${name}.json` ? "found" : "unknown";
}

/** The recipe's drift: change the committed assistant event and leave the expectation alone (its jq edit). */
export function withAssistantText(fixture: Json, text: string): Json {
  const copy = JSON.parse(JSON.stringify(fixture)) as Json;
  for (const r of Array.isArray(copy.run_records) ? copy.run_records : []) {
    const p = payloadOf(r);
    if (p?.kind === "assistant_message_committed") p.text = text;
  }
  return copy;
}

/** A copy with one top-level field set, for the preset failures (schema_version 2). */
export function withField(fixture: Json, key: string, value: unknown): Json {
  return { ...(JSON.parse(JSON.stringify(fixture)) as Json), [key]: value };
}

/** A copy with the run records of one kind removed (a fixture that lost its terminal boundary). */
export function withoutKind(fixture: Json, kind: string): Json {
  const copy = JSON.parse(JSON.stringify(fixture)) as Json;
  copy.run_records = (Array.isArray(copy.run_records) ? copy.run_records : []).filter((r) => payloadOf(r)?.kind !== kind);
  return copy;
}

export interface RecordedRun {
  prompt: string;
  toolOutput: string;
  answer: string;
  responseId: string;
  usage: Usage;
}

/**
 * Turns a recorded run into a focused fixture the way the recipe says to author one: the relevant events numbered in
 * projection order, and the expected context set to what they reduce to, for a person to review before committing.
 */
export function authorFixture(name: string, run: RecordedRun): Json {
  const run_records = [
    { payload: { kind: "started", prompt: run.prompt } },
    { payload: { kind: "tool_result", call_id: "c1", text: run.toolOutput } },
    { payload: { kind: "model_response_created", response_id: run.responseId } },
    { payload: { kind: "assistant_message_committed", text: run.answer, response_id: run.responseId } },
    { payload: { kind: "model_completed", response_id: run.responseId, usage: run.usage } },
    { payload: { kind: "terminal", terminal: "completed", reason: null } },
  ];
  return { schema_version: 1, name, run_records, expected_model_context: project(run_records) };
}

/** SHA-256 of a string as hex, for the byte-determinism check (two runs, one hash). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

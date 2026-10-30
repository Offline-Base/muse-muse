import type { ResolvedTool } from "@/lib/docs/client/tools";
import type { LoopStep, ModelStep } from "@/lib/docs/client/toolloop";
import { requestedCalls } from "@/lib/docs/client/toolloop";
import { tokenUsage } from "@/lib/docs/client/cost";
import { diffLines, diffStats } from "@/components/docs/playgrounds/cookbook-fundamentals/diff";
import { applyEdit, resolvePath } from "@/components/docs/playgrounds/cookbook-fundamentals/edits";
import { callbackSpots, type ProjectFiles } from "@/components/docs/playgrounds/cookbook-fundamentals/projects";
import { formatReport, type TestReport } from "@/components/docs/playgrounds/cookbook-fundamentals/sandbox";

/**
 * The agent demos' tools and bookkeeping (basic-agent-loop, interleaved-reasoning-tool-use): a project kept in the
 * page that the model reads, edits and tests through function tools, the guards that end a stuck run (the
 * basic-agent-loop recipe's "max iterations, token budget, stuck detection, user interrupt"), and the trace in the
 * recipes' formats. The tools run here in the page; the tests run in sandbox.ts's locked-down worker.
 */

/** The project the model works on: its files now, the files it started with, and every write. */
export class ProjectFs {
  readonly original: ProjectFiles;
  files: ProjectFiles;
  writes = 0;

  constructor(files: ProjectFiles) {
    this.original = { ...files };
    this.files = { ...files };
  }

  /** Paths whose content differs from the start, plus new files. */
  changed(): string[] {
    const paths = new Set([...Object.keys(this.original), ...Object.keys(this.files)]);
    return [...paths].filter((p) => this.original[p] !== this.files[p]).sort();
  }
}

type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

function fileList(fs: ProjectFs): string {
  return Object.keys(fs.files).sort().join("\n");
}

function noFile(fs: ProjectFs, path: string) {
  return { error: `No such file: ${path}. The project has:\n${fileList(fs)}` };
}

const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const PATH = { type: "string", description: "The file's path from the project root, such as src/pagination.js." };

function tool(def: ResolvedTool["def"], run: (args: Args) => unknown | Promise<unknown>): ResolvedTool {
  return { def, builtIn: false, source: "mock", run: async (args) => run(args) };
}

export type TestRunner = (files: ProjectFiles, only?: string | null) => Promise<TestReport>;

function lineChange(before: string | undefined, after: string): string {
  const { added, removed } = diffStats(diffLines(before ?? "", after));
  return `+${added} / -${removed} lines`;
}

/** list_files, read_file, write_file and run_tests: the basic loop's tools. */
export function loopTools(fs: ProjectFs, runTests: TestRunner): ResolvedTool[] {
  return [
    tool(
      { name: "list_files", description: "List every file in the project, one path per line.", parameters: schema({}, []) },
      () => fileList(fs),
    ),
    tool(
      { name: "read_file", description: "Read a file from the project. Returns its full text.", parameters: schema({ path: PATH }, ["path"]) },
      (args) => {
        const path = resolvePath(fs.files, str(args, "path"));
        return Object.prototype.hasOwnProperty.call(fs.files, path) ? fs.files[path] : noFile(fs, path);
      },
    ),
    tool(
      {
        name: "write_file",
        description: "Replace a file's whole content (or create the file). Send the complete new text of the file.",
        parameters: schema({ path: PATH, content: { type: "string", description: "The complete new file content." } }, ["path", "content"]),
      },
      (args) => {
        const path = resolvePath(fs.files, str(args, "path"));
        if (!path) return { error: "write_file needs a path." };
        const before = fs.files[path];
        const content = str(args, "content");
        fs.files = { ...fs.files, [path]: content };
        fs.writes++;
        return `Wrote ${path}: ${lineChange(before, content)}.`;
      },
    ),
    tool(
      {
        name: "run_tests",
        description: "Run the project's tests and return the results. Pass path to run one test file, or leave it out to run them all.",
        parameters: schema({ path: { type: "string", description: "One test file, such as tests/test_pagination.js. Optional." } }, []),
      },
      async (args) => {
        const only = str(args, "path").trim();
        const path = only ? resolvePath(fs.files, only) : null;
        return formatReport(await runTests(fs.files, path));
      },
    ),
  ];
}

/** The migration demo's tools: the loop's read and write, plus grep, an exact-match edit, and checks for leftover callbacks. */
export function migrationTools(fs: ProjectFs, runTests: TestRunner, migrate: () => readonly string[]): ResolvedTool[] {
  const [list, read, write] = loopTools(fs, runTests);
  return [
    list,
    read,
    tool(
      {
        name: "grep",
        description: "Find lines that contain a piece of text, across every file. Returns path:line: text for each match.",
        parameters: schema({ pattern: { type: "string", description: "The text to look for (plain text, not a regex)." } }, ["pattern"]),
      },
      (args) => {
        const pattern = str(args, "pattern");
        if (!pattern) return { error: "grep needs a pattern." };
        const hits: string[] = [];
        for (const [path, text] of Object.entries(fs.files).sort()) {
          text.split("\n").forEach((line, i) => {
            if (line.includes(pattern)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
          });
        }
        return hits.length ? hits.slice(0, 60).join("\n") : `No line contains ${JSON.stringify(pattern)}.`;
      },
    ),
    tool(
      {
        name: "edit_file",
        description:
          "Replace text in a file. old_string must match the file exactly once (copy it from read_file, indentation included); new_string replaces it.",
        parameters: schema(
          {
            path: PATH,
            old_string: { type: "string", description: "The exact text to replace." },
            new_string: { type: "string", description: "The text to put in its place." },
          },
          ["path", "old_string", "new_string"],
        ),
      },
      (args) => {
        const result = applyEdit(fs.files, { tool: "edit", filePath: str(args, "path"), oldString: str(args, "old_string"), newString: str(args, "new_string") });
        if (!result.ok) return { error: result.message };
        fs.files = { ...fs.files, [result.path]: result.after };
        fs.writes++;
        return `Edited ${result.path}: ${lineChange(result.before ?? "", result.after)}.`;
      },
    ),
    write,
    tool(
      {
        name: "run_checks",
        description: "Run every test, then check the files this task migrates for callback-style code that's left. The task is done when both pass.",
        parameters: schema({}, []),
      },
      async () => {
        const report = formatReport(await runTests(fs.files, null));
        return `${report}\n${callbackReport(fs.files, migrate())}`;
      },
    ),
  ];
}

const TEST_FILE = /^tests?\/.*\.js$/;

/**
 * What the oracle runs: the agent's code with the project's own tests, as they were before the run, and the task's
 * own tests (`overrides`, AgentTask.oracleTests) where a task changes an API on purpose. Tests the agent edited, added
 * or deleted don't count (the recipes' oracle is the suite that defined "done"); the edited ones are named so the
 * verdict can say so, except the overridden ones, which the task asked the agent to rewrite.
 */
export function oracleFiles(original: ProjectFiles, current: ProjectFiles, overrides: ProjectFiles = {}): { files: ProjectFiles; changedTests: string[] } {
  const files: ProjectFiles = {};
  for (const [path, text] of Object.entries(current)) if (!TEST_FILE.test(path)) files[path] = text;
  for (const [path, text] of Object.entries(original)) if (TEST_FILE.test(path)) files[path] = text;
  Object.assign(files, overrides);
  const paths = new Set([...Object.keys(original), ...Object.keys(current)]);
  const changedTests = [...paths].filter((p) => TEST_FILE.test(p) && original[p] !== current[p] && !(p in overrides)).sort();
  return { files, changedTests };
}

/** "No callback-style code left in ..." or each spot that still takes or hands over an error-first callback. */
export function callbackReport(files: ProjectFiles, paths: readonly string[]): string {
  const lines: string[] = [];
  for (const path of paths) {
    const spots = Object.prototype.hasOwnProperty.call(files, path) ? callbackSpots(files[path]) : [];
    for (const s of spots) lines.push(`  ${path}:${s.line}: ${s.text}`);
  }
  return lines.length
    ? `Callback-style code left (${lines.length}):\n${lines.join("\n")}`
    : `No callback-style code left in ${paths.join(", ")}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Guards and the trace

export interface ToolTurn {
  /** 1-based model call. */
  turn: number;
  model: ModelStep;
  /** The calls the model made and what each returned, once they've run. */
  calls: Array<{ name: string; args: string; output: string | null; ok: boolean | null; callId: string }>;
  /** Reasoning tokens this call spent, from its usage. */
  reasoningTokens: number;
  totalTokens: number;
  /** The model's own words this turn: the reasoning summary, else its narration. */
  thought: string;
  /** The turn ended the loop: no tool call, or an error. */
  final: boolean;
}

/** The steps grouped into turns: a model call and the tools it asked for. */
export function turnsOf(steps: readonly LoopStep[]): ToolTurn[] {
  const turns: ToolTurn[] = [];
  steps.forEach((s, i) => {
    if (s.kind !== "model") return;
    const next = steps[i + 1];
    const results = next?.kind === "tools" ? next.results : [];
    const calls = requestedCalls(s).map((c) => {
      const r = results.find((x) => x.call.callId === c.callId);
      return { name: c.name, args: c.arguments, output: r?.run?.output ?? null, ok: r?.run ? r.run.ok : null, callId: c.callId };
    });
    const usage = tokenUsage(s.collected?.usage);
    const reasoning = (s.collected?.reasoning ?? "").trim();
    const text = (s.collected?.text ?? "").trim();
    turns.push({
      turn: s.call,
      model: s,
      calls,
      reasoningTokens: usage?.reasoning ?? 0,
      totalTokens: usage?.total ?? 0,
      thought: reasoning || (calls.length ? text : ""),
      final: !!s.collected?.done && (!calls.length || !!s.collected.error),
    });
  });
  return turns;
}

/** A call's identity for stuck detection: the tool and its arguments, with the JSON's spacing evened out. */
export function callKey(name: string, args: string): string {
  let norm = args.trim();
  try {
    norm = JSON.stringify(JSON.parse(args));
  } catch {
    // Arguments that aren't JSON are compared as they are.
  }
  return `${name}(${norm})`;
}

export interface Guards {
  /** Stop when the run's tokens (all calls together) pass this. */
  tokenBudget?: number;
  /** Stop when one exact call repeats this many times. The recipe uses three. */
  repeats?: number;
}

/** Why the loop must stop before its next model call, or null to go on. */
export function guardStop(steps: readonly LoopStep[], guards: Guards): string | null {
  const turns = turnsOf(steps);
  if (guards.tokenBudget) {
    const used = turns.reduce((n, t) => n + t.totalTokens, 0);
    if (used >= guards.tokenBudget) return `Token budget spent: ${used.toLocaleString("en-US")} of ${guards.tokenBudget.toLocaleString("en-US")} tokens.`;
  }
  if (guards.repeats) {
    const seen = new Map<string, number>();
    for (const t of turns) {
      for (const c of t.calls) {
        const key = callKey(c.name, c.args);
        const n = (seen.get(key) ?? 0) + 1;
        seen.set(key, n);
        if (n >= guards.repeats) return `Stuck: ${shortCall(c.name, c.args)} ran ${n} times with the same arguments.`;
      }
    }
  }
  return null;
}

/** read_file(tests/test_pagination.js), write_file(src/pagination.js), run_tests(): a call as the traces print it. */
export function shortCall(name: string, args: string): string {
  let parsed: Args = {};
  try {
    const v = JSON.parse(args || "{}") as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Args;
  } catch {
    return `${name}(${args.slice(0, 60)})`;
  }
  const path = typeof parsed.path === "string" ? parsed.path : typeof parsed.filePath === "string" ? parsed.filePath : null;
  if (path) return `${name}(${path})`;
  const values = Object.values(parsed).filter((v) => typeof v === "string" || typeof v === "number") as Array<string | number>;
  if (!values.length) return `${name}()`;
  const shown = values.map((v) => (typeof v === "string" ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v) : String(v))).join(", ");
  return `${name}(${shown})`;
}

/** What a tool's result comes to, in the trace's few words. */
export function resultSummary(name: string, output: string | null, ok: boolean | null): string {
  if (output === null) return "(running)";
  if (ok === false) {
    try {
      const v = JSON.parse(output) as { error?: unknown };
      if (typeof v.error === "string") return `error: ${v.error.split("\n")[0]}`;
    } catch {
      // Not JSON: fall through to the text.
    }
  }
  const lines = output.split("\n");
  if (name === "read_file") return `(file read, ${lines.length} lines)`;
  if (name === "list_files") return `${lines.filter(Boolean).length} files`;
  if (name === "grep") return output.startsWith("No line") ? "no matches" : `${lines.length} match${lines.length === 1 ? "" : "es"}`;
  if (name === "run_tests" || name === "run_checks") {
    const summary = lines.find((l) => /passed, \d+ failed|No tests ran|timed out/.test(l)) ?? lines[lines.length - 1];
    const left = lines.find((l) => l.startsWith("Callback-style code left") || l.startsWith("No callback-style"));
    return left ? `${summary}; ${left.replace(/:$/, "")}` : summary;
  }
  const change = /\+\d+ \/ -\d+ lines/.exec(output);
  if (change) return change[0];
  return lines[0].slice(0, 100);
}

function firstLine(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** The basic-agent-loop recipe's trace: THINK, ACT, RESULT and EVAL per turn, then DONE. */
export function loopTrace(steps: readonly LoopStep[], stopped?: string | null): string {
  const out: string[] = [];
  for (const t of turnsOf(steps)) {
    const pad = " ".repeat(`[Turn ${t.turn}] `.length);
    const lines: string[] = [];
    if (t.thought) lines.push(`THINK: ${firstLine(t.thought)}`);
    if (t.model.collected?.error) lines.push(`ERROR: ${firstLine(t.model.collected.error.message)}`);
    for (const c of t.calls) {
      lines.push(`ACT:   ${shortCall(c.name, c.args)}`);
      lines.push(`RESULT: ${resultSummary(c.name, c.output, c.ok)}`);
    }
    if (!t.calls.length && !t.model.collected?.error && t.model.collected?.done) lines.push(`ANSWER: ${firstLine(t.model.collected.text || "(no text)")}`);
    lines.push(`EVAL:  ${t.model.collected?.done ? (t.calls.length && !t.model.collected.error ? "continue" : "done") : "running"}`);
    out.push(lines.map((l, i) => (i === 0 ? `[Turn ${t.turn}] ${l}` : `${pad}${l}`)).join("\n"));
  }
  if (stopped) out.push(`STOPPED: ${stopped}`);
  return out.join("\n\n");
}

/** The interleaved-reasoning recipe's trace: each turn's thought with its reasoning tokens, then the actions. */
export function interleavedTrace(steps: readonly LoopStep[]): string {
  return turnsOf(steps)
    .map((t) => {
      const head = `◇ turn ${t.turn} · thought (${t.reasoningTokens} tok)${t.thought ? `: ${firstLine(t.thought, 110)}` : ""}`;
      const acts = t.calls.map((c) => `     → ${shortCall(c.name, c.args)}`);
      if (!t.calls.length && t.model.collected?.done) acts.push(`     ✓ ${firstLine(t.model.collected.text || t.model.collected.error?.message || "(no text)", 110)}`);
      return [head, ...acts].join("\n");
    })
    .join("\n");
}

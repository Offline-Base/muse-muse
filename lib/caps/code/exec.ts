import { capError } from "@/lib/caps/gate";
import { EXEC_LIMITS } from "@/lib/caps/code/limits";
import type { CodeSession } from "@/lib/caps/code/session";

/**
 * What {GATEWAY_URL}/exec runs and how (docs/CAPABILITIES.md, section 15): one program, Python or Node, in a fresh
 * sandbox with no network and no secrets, 15 seconds at most, with stdout and stderr cut at 64 KB each.
 */

export const EXEC_LANGUAGES = ["python", "node"] as const;
export type ExecLanguage = (typeof EXEC_LANGUAGES)[number];

export interface ExecFile {
  name: string;
  content: Buffer;
}

export interface ExecArgs {
  language: ExecLanguage;
  code: string;
  stdin: string;
  files: ExecFile[];
}

export type ExecStatus = "ok" | "error" | "timeout";

export interface ExecOutcome {
  status: ExecStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when stdout or stderr was cut at 64 KB. */
  truncated: boolean;
  /** The program's own run, not the sandbox's start. */
  ms: number;
}

/** A file's name: one plain name, no folders, no leading dot. */
export const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const RESERVED_NAMES = new Set(["main.py", "main.mjs"]);

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** The request's arguments, checked: the refusal names the first problem in plain words. */
export function readExecArgs(body: Record<string, unknown>): ExecArgs | Response {
  const extra = Object.keys(body).filter((k) => !["language", "code", "stdin", "files"].includes(k));
  if (extra.length) return capError("invalid_arguments", `Unknown ${extra.length === 1 ? "field" : "fields"}: ${extra.slice(0, 5).join(", ")}.`);
  if (!EXEC_LANGUAGES.includes(body.language as ExecLanguage)) return capError("invalid_arguments", 'language is "python" or "node".');
  if (typeof body.code !== "string" || !body.code.trim()) return capError("invalid_arguments", "Send the program as code.");
  if (bytes(body.code) > EXEC_LIMITS.codeMaxBytes) return capError("invalid_arguments", `A program can be at most ${EXEC_LIMITS.codeMaxBytes / 1024} KB.`);
  const stdin = body.stdin === undefined || body.stdin === null ? "" : body.stdin;
  if (typeof stdin !== "string") return capError("invalid_arguments", "stdin is text.");
  if (bytes(stdin) > EXEC_LIMITS.stdinMaxBytes) return capError("invalid_arguments", `stdin can be at most ${EXEC_LIMITS.stdinMaxBytes / 1024} KB.`);
  const files: ExecFile[] = [];
  if (body.files !== undefined && body.files !== null) {
    if (!Array.isArray(body.files)) return capError("invalid_arguments", "files is a list of {name, text} or {name, base64}.");
    if (body.files.length > EXEC_LIMITS.filesMax) return capError("invalid_arguments", `At most ${EXEC_LIMITS.filesMax} files.`);
    let total = 0;
    const seen = new Set<string>();
    for (const f of body.files as unknown[]) {
      if (!f || typeof f !== "object" || Array.isArray(f)) return capError("invalid_arguments", "Each file is {name, text} or {name, base64}.");
      const { name, text, base64, ...rest } = f as Record<string, unknown>;
      if (Object.keys(rest).length) return capError("invalid_arguments", "A file has a name and either text or base64, nothing else.");
      if (typeof name !== "string" || !FILE_NAME.test(name) || RESERVED_NAMES.has(name)) return capError("invalid_arguments", "A file's name is one plain name of letters, digits, dots, dashes and underscores, not main.py or main.mjs.");
      if (seen.has(name)) return capError("invalid_arguments", `Two files are called ${name}.`);
      seen.add(name);
      let content: Buffer;
      if (typeof text === "string" && base64 === undefined) content = Buffer.from(text, "utf8");
      else if (typeof base64 === "string" && text === undefined && /^[A-Za-z0-9+/]*={0,2}$/.test(base64) && base64.length % 4 === 0) content = Buffer.from(base64, "base64");
      else return capError("invalid_arguments", `${name} needs either text or base64.`);
      total += content.length;
      if (total > EXEC_LIMITS.filesMaxBytes) return capError("invalid_arguments", `Files can add up to at most ${EXEC_LIMITS.filesMaxBytes / 1024 / 1024} MB.`);
      files.push({ name, content });
    }
  }
  return { language: body.language as ExecLanguage, code: body.code, stdin, files };
}

/** Where a run's files go in its sandbox. The program runs in WORK, and nothing outside RUN_DIR is the platform's. */
export const RUN_DIR = "/tmp/mm-exec";
const WORK = `${RUN_DIR}/work`;
const MAIN: Record<ExecLanguage, string> = { python: `${RUN_DIR}/main.py`, node: `${RUN_DIR}/main.mjs` };
const INTERPRETER: Record<ExecLanguage, string> = { python: "python3", node: "node" };

/**
 * The one shell line a run is. bash, for PIPESTATUS and process substitution: each stream goes through `head -c`, so a
 * program that prints forever fills nothing and is cut, and `timeout -s KILL` ends it at the limit. The exit code and
 * the program's own time go in files beside the output. ulimit keeps a run from filling the disk or forking without end.
 */
export function execScript(language: ExecLanguage, seconds = EXEC_LIMITS.runSeconds, cap = EXEC_LIMITS.outputMaxBytes): string {
  const keep = cap + 1;
  return [
    "ulimit -f 65536 2>/dev/null",
    "ulimit -u 256 2>/dev/null",
    `cd ${WORK}`,
    "start=$(date +%s%3N)",
    `timeout -s KILL ${seconds} ${INTERPRETER[language]} ${MAIN[language]} < ${RUN_DIR}/stdin 2> >(head -c ${keep} > ${RUN_DIR}/err) | head -c ${keep} > ${RUN_DIR}/out`,
    `echo "\${PIPESTATUS[0]} $(( $(date +%s%3N) - start ))" > ${RUN_DIR}/status`,
    // Wait for the stderr reader to finish writing.
    "wait",
  ].join("\n");
}

/** The files a run writes before it starts. */
export function execFiles(args: ExecArgs): Array<{ path: string; content: Buffer }> {
  return [
    { path: MAIN[args.language], content: Buffer.from(args.code, "utf8") },
    { path: `${RUN_DIR}/stdin`, content: Buffer.from(args.stdin, "utf8") },
    { path: `${RUN_DIR}/run.sh`, content: Buffer.from(execScript(args.language), "utf8") },
    // An empty file keeps WORK there when no files were sent.
    { path: `${WORK}/.keep`, content: Buffer.alloc(0) },
    ...args.files.map((f) => ({ path: `${WORK}/${f.name}`, content: f.content })),
  ];
}

function cut(buf: Buffer | null, cap: number): { text: string; truncated: boolean } {
  if (!buf) return { text: "", truncated: false };
  const truncated = buf.length > cap;
  // A cut can split a character; TextDecoder replaces the broken end rather than throwing.
  return { text: new TextDecoder().decode(truncated ? buf.subarray(0, cap) : buf), truncated };
}

/** Runs the program in a session that is already up. The caller starts and stops the session. */
export async function runExec(session: CodeSession, args: ExecArgs): Promise<ExecOutcome> {
  await session.writeFiles(execFiles(args));
  // The sandbox's own kill is the backstop for the shell line's timeout.
  await session.run("bash", [`${RUN_DIR}/run.sh`], { timeoutMs: (EXEC_LIMITS.runSeconds + 10) * 1000 });
  const [out, err, status] = await Promise.all([session.readFile(`${RUN_DIR}/out`), session.readFile(`${RUN_DIR}/err`), session.readFile(`${RUN_DIR}/status`)]);
  return outcomeOf(out, err, status);
}

/** The outcome from the run's three files. A run with no status file was killed before it could write one. */
export function outcomeOf(out: Buffer | null, err: Buffer | null, status: Buffer | null): ExecOutcome {
  const stdout = cut(out, EXEC_LIMITS.outputMaxBytes);
  const stderr = cut(err, EXEC_LIMITS.outputMaxBytes);
  const [codeText, msText] = (status?.toString("utf8").trim() ?? "").split(/\s+/);
  const exitCode = codeText !== undefined && /^\d+$/.test(codeText) ? Number(codeText) : null;
  const ms = msText !== undefined && /^\d+$/.test(msText) ? Number(msText) : EXEC_LIMITS.runSeconds * 1000;
  // timeout(1) answers 124, and 137 when it had to send SIGKILL.
  const timedOut = exitCode === null || exitCode === 124 || exitCode === 137;
  return {
    status: timedOut ? "timeout" : exitCode === 0 ? "ok" : "error",
    exitCode: timedOut ? null : exitCode,
    stdout: stdout.text,
    stderr: timedOut && !stderr.text ? `The program was stopped after ${EXEC_LIMITS.runSeconds} seconds.` : stderr.text,
    truncated: stdout.truncated || stderr.truncated,
    ms: Math.min(ms, EXEC_LIMITS.runSeconds * 1000),
  };
}

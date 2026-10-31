/**
 * Muse Code at full strength, in platform-owned config (docs/MUSE_CODE_FULL.md, section 2), behind MUSE_FULL=1: the
 * per-run settings (`-c` on both engines), the project hooks in .muse/hooks.json with their scripts under HOOKS_DIR,
 * outside the product, and the build MCP server in .mcp.json. builder.ts writes all of it before every Muse Code start,
 * replacing whatever is there. Pure: the hook scripts are strings that Muse Code runs with node, and the tests run them
 * in real node with their paths pointed at a temporary folder.
 */
import { LOG_DIR, PLATFORM_FILES, PRODUCT_DIR, WORK_DIR } from "@/lib/sandbox/paths";

/** The hook scripts, outside the product so the agent never trips over them and they are never deployed. */
export const HOOKS_DIR = `${WORK_DIR}/hooks`;
/**
 * Owner notes for rounds on the exec engine, which has no session to steer: sendMuseCommand (builder.ts) writes one
 * `<at>-<id>.json` file per steer or queue, and the notes hook hands each unread one to Muse Code after a tool call.
 */
export const NOTES_DIR = `${WORK_DIR}/notes`;
/** Holds the exec round's session id, so notes reach the main agent and never a subagent. */
export const NOTES_SESSION_FILE = `${NOTES_DIR}/.session`;
/** One JSON line per subagent, compaction and stop-failure event, from the event logger hook. */
export const HOOK_LOG = `${LOG_DIR}/hooks.jsonl`;
/** Relative to PRODUCT_DIR. */
export const HOOKS_FILE = ".muse/hooks.json";
export const MCP_FILE = ".mcp.json";

/** The Muse Code version the settings and hooks here were checked on (docs/MUSE_CODE_FULL.md, Oct 30). */
export const CHECKED_MUSE_VERSION = "1.4.14";

export const DEFAULT_AGENT_CAPACITY = 6;
/** agents.execution_capacity outside this range makes Muse Code's settings malformed. */
const CAPACITY_RANGE = { min: 1, max: 64 } as const;

/** MUSE_AGENT_CAPACITY as Muse Code takes it: a whole number held to 1 through 64, and the default when unset or not a number. */
export function agentCapacity(raw: string | undefined): number {
  const text = raw?.trim();
  const value = text ? Math.floor(Number(text)) : NaN;
  if (!Number.isFinite(value)) return DEFAULT_AGENT_CAPACITY;
  return Math.min(CAPACITY_RANGE.max, Math.max(CAPACITY_RANGE.min, value));
}

/** Muse Code's reminder agents. All six are turned on: memory, todo and scope are off by default. */
export const REMINDER_IDS = ["skill", "goal", "verify", "memory", "todo", "scope"] as const;

/** How many times in a row the Stop gate may send the agent back to work before Muse Code lets it stop. */
export const STOP_HOOK_CONTINUATIONS = 3;

/**
 * The `-c` settings for `muse exec` and `muse serve`, each "key=jsonValue". The reminders go in one
 * runtime_capabilities object, since a key given twice refuses the run. Unknown keys refuse it too (exit 2), so these
 * are only passed to the Muse Code they were checked on (CHECKED_MUSE_VERSION).
 */
export function museSettings(capacity: number): string[] {
  const reminders = Object.fromEntries(REMINDER_IDS.map((id) => [`plugin:tbh-reminders:reminder:${id}-reminder`, { enabled: true }]));
  return [
    `agents.execution_capacity=${agentCapacity(String(capacity))}`,
    `runtime_capabilities=${JSON.stringify(reminders)}`,
    `max_consecutive_stop_hook_continuations=${STOP_HOOK_CONTINUATIONS}`,
  ];
}

/**
 * Bash for a runner prelude: turns the bundled workflow-authoring skill back on, which setup.ts turns off for plain
 * builds (DISABLED_BUNDLED_SKILLS). A Muse Code without the skill or the command just goes on without it.
 */
export const WORKFLOW_SKILL_PRELUDE = "muse skills enable bundled:workflow-authoring --scope built-in --json >/dev/null 2>&1 || true";

// ---------------------------------------------------------------------------------------------------------------
// Hooks

/**
 * Hook scripts. Each reads the hook's JSON on stdin and never fails the run: on any error of its own it prints nothing
 * and exits 0. Paths can be moved with MUSEMUSE_* variables for the tests; Muse Code gives hooks only HOME, LANG, PATH,
 * PWD, SHELL, SHLVL, TRACEPARENT and its own MUSE_* variables, so in a build they are always the defaults.
 */
/** A reader that went away before the answer was written must not turn into an error the run sees. */
const STDOUT_GUARD = "process.stdout.on('error', () => {});";

const GUARD_HOOK = [
  "// Written by the Muse Muse platform. PreToolUse: refuses writes and edits to the platform's files.",
  'import { readFileSync } from "node:fs";',
  'import path from "node:path";',
  `const PRODUCT = process.env.MUSEMUSE_PRODUCT_DIR || ${JSON.stringify(PRODUCT_DIR)};`,
  `const WORK = process.env.MUSEMUSE_WORK_DIR || ${JSON.stringify(WORK_DIR)};`,
  `const PLATFORM = new Set(${JSON.stringify(PLATFORM_FILES)});`,
  "const WRITE_TOOLS = /^(write_file|edit_file|apply_patch|multi_edit|create_file|delete_file|move_file)$/;",
  "const inside = (root, abs) => { const rel = path.relative(root, abs); return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null; };",
  "function refusal(abs) {",
  "  let rel = inside(PRODUCT, abs);",
  "  if (rel === null) return inside(WORK, abs) === null ? null : abs + ' belongs to the Muse Muse platform, so this build can\\'t change it.';",
  "  // A subagent's worktree is a copy of the product: the same files are the platform's there.",
  "  const tree = /^\\.muse\\/worktrees\\/[^/]+\\/(.+)$/.exec(rel);",
  "  if (tree) rel = tree[1];",
  "  else if (rel === '.muse' || rel.startsWith('.muse/') || rel === '.mcp.json') return rel + ' is the Muse Muse platform\\'s Muse Code config, so this build can\\'t change it.';",
  "  if (PLATFORM.has(rel)) return rel + ' belongs to the Muse Muse platform, so this build can\\'t change it. Leave it as it is.';",
  "  if (path.posix.basename(rel).startsWith('.env')) return rel + ' holds the build\\'s settings, so this build can\\'t change it.';",
  "  return null;",
  "}",
  STDOUT_GUARD,
  "try {",
  "  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');",
  "  const tool = String(input.tool_name ?? input.tool ?? '');",
  "  if (WRITE_TOOLS.test(tool)) {",
  "    let args = input.tool_input ?? input.input ?? input.arguments ?? input.args ?? {};",
  "    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }",
  "    const named = [args.path, args.file_path, args.filePath, args.target, args.destination, ...(Array.isArray(args.paths) ? args.paths : [])];",
  "    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : PRODUCT;",
  "    for (const p of named) {",
  "      if (typeof p !== 'string' || !p) continue;",
  "      const reason = refusal(path.resolve(cwd, p));",
  "      if (!reason) continue;",
  "      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));",
  "      break;",
  "    }",
  "  }",
  "} catch {",
  "  // Never fail the run.",
  "}",
  "",
].join("\n");

const NOTES_HOOK = [
  "// Written by the Muse Muse platform. PostToolUse and PostToolBatch: hands the build owner's unread notes to Muse Code.",
  'import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";',
  `const NOTES = process.env.MUSEMUSE_NOTES_DIR || ${JSON.stringify(NOTES_DIR)};`,
  STDOUT_GUARD,
  "try {",
  "  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');",
  "  const event = typeof input.hook_event_name === 'string' && input.hook_event_name ? input.hook_event_name : 'PostToolUse';",
  "  // Notes are for the main agent: a subagent's tool calls run this hook under their own session id.",
  "  const main = existsSync(NOTES + '/.session') ? readFileSync(NOTES + '/.session', 'utf8').trim() : '';",
  "  if (!main || typeof input.session_id !== 'string' || input.session_id === main) {",
  "    const texts = [];",
  "    const names = readdirSync(NOTES).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();",
  "    if (names.length) mkdirSync(NOTES + '/read', { recursive: true });",
  "    for (const name of names) {",
  "      // Moving a note claims it, so two hooks running at once never hand over the same one.",
  "      try { renameSync(NOTES + '/' + name, NOTES + '/read/' + name); } catch { continue; }",
  "      try {",
  "        const note = JSON.parse(readFileSync(NOTES + '/read/' + name, 'utf8'));",
  "        if (typeof note.text === 'string' && note.text.trim()) texts.push(\"A note from this build's owner: \" + note.text.trim());",
  "      } catch {",
  "        // An unreadable note is skipped.",
  "      }",
  "    }",
  "    if (texts.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: texts.join('\\n\\n') } }));",
  "  }",
  "} catch {",
  "  // Never fail the run.",
  "}",
  "",
].join("\n");

/** How long the Stop gate's typecheck may take in all, next typegen included. */
export const STOP_GATE_BUDGET_MS = 90_000;

const STOP_HOOK = [
  "// Written by the Muse Muse platform. Stop: runs the product's typecheck and sends Muse Code back to work while it fails.",
  'import { spawnSync } from "node:child_process";',
  'import { existsSync, readFileSync } from "node:fs";',
  `const PRODUCT = process.env.MUSEMUSE_PRODUCT_DIR || ${JSON.stringify(PRODUCT_DIR)};`,
  `const BUDGET_MS = Number(process.env.MUSEMUSE_STOP_GATE_MS) || ${STOP_GATE_BUDGET_MS};`,
  STDOUT_GUARD,
  "try {",
  "  readFileSync(0, 'utf8');",
  "  const bin = (name) => PRODUCT + '/node_modules/.bin/' + name;",
  "  if (existsSync(bin('tsc'))) {",
  "    const started = Date.now();",
  "    // As verify's typecheck does: route types first, so a fresh product's typed routes resolve.",
  "    if (existsSync(bin('next'))) spawnSync(bin('next'), ['typegen'], { cwd: PRODUCT, timeout: Math.floor(BUDGET_MS / 2), stdio: 'ignore' });",
  "    const left = BUDGET_MS - (Date.now() - started);",
  "    const tsc = left > 1000 ? spawnSync(bin('tsc'), ['--noEmit', '-p', '.'], { cwd: PRODUCT, timeout: left, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) : null;",
  "    // A typecheck that ran out of time or didn't start says nothing about the product.",
  "    if (tsc && !tsc.error && tsc.signal === null && tsc.status !== 0) {",
  "      // Errors in a subagent's worktree copy aren't the product's.",
  "      const errors = ((tsc.stdout || '') + (tsc.stderr || '')).split('\\n').filter((l) => /error TS\\d+/.test(l) && !l.startsWith('.muse/'));",
  "      if (errors.length) {",
  "        const first = errors.slice(0, 15).join('\\n').slice(0, 3000);",
  "        const count = errors.length === 1 ? '1 type error' : errors.length + ' type errors';",
  "        process.stdout.write(JSON.stringify({ decision: 'block', reason: 'The product does not typecheck yet (' + count + '). Fix these, then check again before you stop:\\n' + first }));",
  "      }",
  "    }",
  "  }",
  "} catch {",
  "  // Never fail the run.",
  "}",
  "",
].join("\n");

const LOG_HOOK = [
  "// Written by the Muse Muse platform. Subagent, compaction and stop-failure events: one JSON line each in the hook log.",
  'import { appendFileSync, mkdirSync, readFileSync } from "node:fs";',
  'import path from "node:path";',
  `const LOG = process.env.MUSEMUSE_HOOK_LOG || ${JSON.stringify(HOOK_LOG)};`,
  "const DROP = new Set(['messages', 'tools']);",
  STDOUT_GUARD,
  "try {",
  "  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');",
  "  if (input && typeof input === 'object' && !Array.isArray(input)) {",
  "    const out = { t: Date.now() };",
  "    for (const [k, v] of Object.entries(input)) {",
  "      if (DROP.has(k)) continue;",
  "      out[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v;",
  "    }",
  "    let line = JSON.stringify(out);",
  "    if (line.length > 16000) line = JSON.stringify({ t: out.t, hook_event_name: input.hook_event_name, session_id: input.session_id, truncated: true });",
  "    mkdirSync(path.dirname(LOG), { recursive: true });",
  "    appendFileSync(LOG, line + '\\n');",
  "  }",
  "} catch {",
  "  // Never fail the run.",
  "}",
  "",
].join("\n");

/** Every hook script, by its file name in HOOKS_DIR. */
export const HOOK_SCRIPTS: Readonly<Record<"guard.mjs" | "notes.mjs" | "stop-gate.mjs" | "log.mjs", string>> = {
  "guard.mjs": GUARD_HOOK,
  "notes.mjs": NOTES_HOOK,
  "stop-gate.mjs": STOP_HOOK,
  "log.mjs": LOG_HOOK,
};

/** Events whose groups take a matcher. UserPromptSubmit and Stop take none: Muse Code skips a group that has one. */
const MATCH_ALL = ".*";

/**
 * .muse/hooks.json in Claude Code's shape, as the Oct 30 spike verified: a matcher on the tool events, none on Stop or
 * the loggers. Each hook runs `node <script>` from HOOKS_DIR.
 */
export function hooksConfig(dir: string = HOOKS_DIR) {
  const run = (script: keyof typeof HOOK_SCRIPTS) => [{ type: "command", command: `node ${dir}/${script}` }];
  return {
    hooks: {
      PreToolUse: [{ matcher: MATCH_ALL, hooks: run("guard.mjs") }],
      PostToolUse: [{ matcher: MATCH_ALL, hooks: run("notes.mjs") }],
      PostToolBatch: [{ matcher: MATCH_ALL, hooks: run("notes.mjs") }],
      Stop: [{ hooks: run("stop-gate.mjs") }],
      SubagentStart: [{ hooks: run("log.mjs") }],
      SubagentStop: [{ hooks: run("log.mjs") }],
      PreCompact: [{ hooks: run("log.mjs") }],
      PostCompact: [{ hooks: run("log.mjs") }],
      StopFailure: [{ hooks: run("log.mjs") }],
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The build MCP server

/** The Muse Code runner exports the build's MCP token under this name. Nothing else in the sandbox has it. */
export const BUILD_MCP_TOKEN_ENV = "MUSEMUSE_BUILD_MCP_TOKEN";
/** The server's name in .mcp.json, so its tools show as mcp__musemuse__<tool>. */
export const BUILD_MCP_SERVER = "musemuse";
/** The platform route that serves it (app/api/build-mcp). */
export const BUILD_MCP_PATH = "/api/build-mcp";

/**
 * .mcp.json in Claude's shape: the build MCP over streamable HTTP, optional, so a build whose platform can't be
 * reached runs on without it. The token stays a ${VAR} reference: only the runner's environment holds the value.
 */
export function mcpConfig(url: string) {
  return {
    mcpServers: {
      [BUILD_MCP_SERVER]: { type: "http", url, headers: { Authorization: `Bearer \${${BUILD_MCP_TOKEN_ENV}}` }, mode: "optional" },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Writing it all

export interface MuseConfigFiles {
  /** Removed first, whatever they are, so the agent's own version (or a symlink in its place) never survives. */
  remove: string[];
  /** Then written. Absolute paths. */
  write: Array<{ path: string; content: string }>;
  /** Folders the writes need. */
  dirs: string[];
}

/**
 * The platform's Muse Code config for one start: the hook scripts, .muse/hooks.json, and .mcp.json when `mcpUrl` is
 * set (the sandbox can reach the platform and the build has a token), else .mcp.json removed.
 */
export function museConfigFiles(opts: { mcpUrl: string | null }): MuseConfigFiles {
  const hooksJson = `${PRODUCT_DIR}/${HOOKS_FILE}`;
  const mcpJson = `${PRODUCT_DIR}/${MCP_FILE}`;
  const scripts = Object.entries(HOOK_SCRIPTS).map(([name, content]) => ({ path: `${HOOKS_DIR}/${name}`, content }));
  return {
    remove: [hooksJson, mcpJson, ...scripts.map((s) => s.path)],
    dirs: [HOOKS_DIR, `${PRODUCT_DIR}/.muse`, NOTES_DIR],
    write: [
      ...scripts,
      { path: hooksJson, content: `${JSON.stringify(hooksConfig(), null, 2)}\n` },
      ...(opts.mcpUrl ? [{ path: mcpJson, content: `${JSON.stringify(mcpConfig(opts.mcpUrl), null, 2)}\n` }] : []),
    ],
  };
}

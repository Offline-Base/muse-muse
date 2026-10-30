import { parseJsonText } from "@/lib/docs/client/json";
import { commandLine } from "@/components/docs/playgrounds/muse-code/shell";

/**
 * Configuration and context (content/meta-docs/pages/muse-code/configuration.md) as builders and checks: the user
 * settings file with only keys the Muse Code pages document (schema_version must be 1), a validator for a pasted
 * settings.json, how instruction files load (AGENTS.md, CLAUDE.md, .agents/AGENTS.md, .claude/CLAUDE.md per level, up
 * to the .git boundary, project over user, deeper over shallower, project rules only after trust), memory layout,
 * and the two launch surfaces' flags.
 */

export const SETTINGS_PATH = "~/.config/muse/settings.json";

/** Profile ids the docs give (the changelog's :ask-me, :auto-review and :unrestricted). */
export const PROFILE_IDS = [":ask-me", ":auto-review", ":unrestricted"] as const;

export type Transport = "stdio" | "streamable_http";

export interface McpServerDraft {
  name: string;
  transport: Transport;
  command: string;
  /** Space-separated arguments. */
  args: string;
  /** KEY=value per line. */
  env: string;
  url: string;
  /** Name: value per line. */
  headers: string;
  enabled: boolean;
  mode: "required" | "optional";
  toolTimeoutSec: number | null;
  startupTimeoutSec: number | null;
}

export interface SettingsDraft {
  schemaVersion: boolean;
  defaultProfile: "" | (typeof PROFILE_IDS)[number];
  retentionDays: number | null;
  showReasoning: boolean;
  terminalBackground: "" | "auto" | "light" | "dark";
  executionCapacity: number | null;
  managedHooksPath: string;
  /** false writes mcp_oauth_dynamic_client_registration: false. */
  oauthDynamicRegistration: boolean;
  mcpServers: McpServerDraft[];
}

export const EMPTY_SERVER: McpServerDraft = {
  name: "docs",
  transport: "stdio",
  command: "my-mcp-server",
  args: "",
  env: "",
  url: "https://mcp.example.com/mcp",
  headers: "Authorization: Bearer ${DOCS_TOKEN}",
  enabled: true,
  mode: "required",
  toolTimeoutSec: null,
  startupTimeoutSec: null,
};

function pairs(text: string, sep: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = sep.exec(line);
    if (m && m[1].trim()) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

export function serverJson(s: McpServerDraft): Record<string, unknown> {
  const base: Record<string, unknown> = { transport: s.transport };
  if (s.transport === "stdio") {
    base.command = s.command.trim();
    base.args = s.args.trim() ? s.args.trim().split(/\s+/) : [];
    const env = pairs(s.env, /^([^=]+)=(.*)$/);
    if (Object.keys(env).length) base.env = env;
  } else {
    base.url = s.url.trim();
    const headers = pairs(s.headers, /^([^:]+):(.*)$/);
    if (Object.keys(headers).length) base.headers = headers;
  }
  if (!s.enabled) base.enabled = false;
  if (s.mode === "optional") base.mode = "optional";
  if (s.toolTimeoutSec !== null) base.tool_timeout_sec = s.toolTimeoutSec;
  if (s.startupTimeoutSec !== null) base.startup_timeout_sec = s.startupTimeoutSec;
  return base;
}

/** The settings object for a draft: only what's set, so a missing key keeps Muse Code's default. */
export function buildSettings(d: SettingsDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (d.schemaVersion) out.schema_version = 1;
  if (d.defaultProfile) out.permissions = { default_profile: d.defaultProfile };
  if (d.retentionDays !== null) out.session_retention_days = d.retentionDays;
  if (d.showReasoning) out.show_reasoning = true;
  if (d.terminalBackground) out.tui = { terminal_background: d.terminalBackground };
  if (d.executionCapacity !== null) out.agents = { execution_capacity: d.executionCapacity };
  if (d.managedHooksPath.trim()) out.managed_hooks_path = d.managedHooksPath.trim();
  if (!d.oauthDynamicRegistration) out.mcp_oauth_dynamic_client_registration = false;
  const servers = d.mcpServers.filter((s) => s.name.trim());
  if (servers.length) out.mcp_servers = Object.fromEntries(servers.map((s) => [s.name.trim(), serverJson(s)]));
  return out;
}

export interface Check {
  errors: string[];
  warnings: string[];
}

/** Top-level keys the Muse Code pages name, in the settings file or its changelog. Others get a warning, not an error. */
const KNOWN_KEYS = new Set([
  "schema_version",
  "permissions",
  "session_retention_days",
  "show_reasoning",
  "tui",
  "agents",
  "mcp_servers",
  "mcpServers",
  "hooks",
  "managed_hooks_path",
  "runtime_capabilities",
  "mcp_oauth_dynamic_client_registration",
  "run",
  "skills",
  "composer",
  "context_compaction",
  "local_session_messaging",
  "endpoint_transport",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const SECRET_LIKE = /(sk-|ghp_|xox[bp]-|Bearer\s+(?!\$\{)[A-Za-z0-9._-]{12,})/;

/** Checks a settings object the way Muse Code's startup does, as far as the pages say. */
export function checkSettings(value: unknown): Check {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(value)) return { errors: ["The settings file must be a JSON object."], warnings };
  if (!("schema_version" in value)) {
    errors.push('No "schema_version": every command fails at startup with "malformed settings file". Add "schema_version": 1.');
  } else if (value.schema_version !== 1) {
    errors.push(`"schema_version" is ${JSON.stringify(value.schema_version)}: anything but 1 fails with "unsupported settings schema version".`);
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`"${key}" isn't a key these pages document. Check it against your Muse Code version.`);
  }
  const perms = value.permissions;
  if (perms !== undefined) {
    if (!isObj(perms)) errors.push('"permissions" must be an object.');
    else if (perms.default_profile !== undefined && !(PROFILE_IDS as readonly unknown[]).includes(perms.default_profile)) {
      warnings.push(`permissions.default_profile ${JSON.stringify(perms.default_profile)} isn't one of the ids the docs give (${PROFILE_IDS.join(", ")}). A profile the session can't enforce is refused when it's chosen.`);
    }
  }
  const days = value.session_retention_days;
  if (days !== undefined && !(typeof days === "number" && Number.isInteger(days) && days > 0)) {
    warnings.push("session_retention_days should be a whole number of days. Leave it out to keep sessions forever.");
  }
  if (value.show_reasoning !== undefined && typeof value.show_reasoning !== "boolean") warnings.push("show_reasoning is on or off: true or false.");
  const tui = value.tui;
  if (isObj(tui) && tui.terminal_background !== undefined && !["auto", "light", "dark"].includes(String(tui.terminal_background))) {
    warnings.push("tui.terminal_background takes auto, light or dark.");
  }
  const agents = value.agents;
  if (isObj(agents) && agents.execution_capacity !== undefined) {
    const n = agents.execution_capacity;
    if (!(typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 64)) errors.push("agents.execution_capacity must be a whole number from 1 through 64.");
  }
  const servers = value.mcp_servers ?? value.mcpServers;
  if (servers !== undefined) {
    if (!isObj(servers)) errors.push("mcp_servers must be an object of named servers.");
    else {
      for (const [name, raw] of Object.entries(servers)) {
        if (!isObj(raw)) {
          errors.push(`MCP server "${name}" must be an object.`);
          continue;
        }
        const t = raw.transport ?? (raw.type === "http" ? "streamable_http" : undefined);
        if (t !== "stdio" && t !== "streamable_http") {
          errors.push(`MCP server "${name}" needs a transport: "stdio" (command, args, env) or "streamable_http" (url, headers).`);
          continue;
        }
        if (t === "stdio" && typeof raw.command !== "string") errors.push(`MCP server "${name}" (stdio) needs a command.`);
        if (t === "streamable_http" && typeof raw.url !== "string") errors.push(`MCP server "${name}" (streamable_http) needs a url.`);
        // The page: "A non-default framing value on streamable_http fails validation." It doesn't name the default, so
        // any value here may be the one that fails: a warning, not an error.
        if (t === "streamable_http" && raw.framing !== undefined) warnings.push(`MCP server "${name}": framing is for stdio. A non-default framing value on streamable_http fails validation, and the docs don't name the default, so leave it out.`);
        if (raw.mode !== undefined && raw.mode !== "required" && raw.mode !== "optional") errors.push(`MCP server "${name}": mode is "required" (the default) or "optional".`);
        if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") warnings.push(`MCP server "${name}": enabled is true or false.`);
        const text = JSON.stringify(raw);
        if (SECRET_LIKE.test(text)) warnings.push(`MCP server "${name}" seems to hold a literal secret. Use \${VAR} interpolation so the file can stay out of your secrets.`);
      }
    }
  }
  if (value.hooks !== undefined && !isObj(value.hooks)) errors.push('"hooks" must be an object: a malformed user settings file fails settings validation.');
  return { errors, warnings };
}

/** Parses pasted text and checks it, with JSON errors at their line and column. */
export function checkSettingsText(text: string): Check & { value: unknown } {
  if (!text.trim()) return { errors: [], warnings: ["An empty or missing file is fine: Muse Code applies defaults. Create it only when you have something to set."], value: null };
  const parsed = parseJsonText(text);
  if (!parsed.ok) return { errors: [`Not valid JSON: ${parsed.line ? `line ${parsed.line}, column ${parsed.column}: ` : ""}${parsed.message}`], warnings: [], value: null };
  return { ...checkSettings(parsed.value), value: parsed.value };
}

export function draftWarnings(d: SettingsDraft): string[] {
  const out: string[] = [];
  if (d.retentionDays !== null) out.push("Retention works on macOS and Linux only for now. For one run: muse -c session_retention_days=N.");
  if (d.executionCapacity !== null && d.executionCapacity > 8) out.push("More concurrent agents means more model calls at once, and more token use.");
  if (d.defaultProfile === ":unrestricted") out.push("Unrestricted is the same posture as --yolo: no approval, no sandbox, workspace trusted. Use it only in an isolated environment.");
  if (d.managedHooksPath.trim()) out.push("Managed hooks run without a project-trust step, so whoever controls that file controls what executes.");
  for (const s of d.mcpServers) {
    if (s.mode === "required") out.push(`MCP server "${s.name || "(unnamed)"}" is required: if it fails to start, the whole run aborts. Set mode to optional to skip it with a warning instead.`);
  }
  if (d.mcpServers.length) out.push("MCP tools aren't sandboxed: only connect servers you trust.");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Instruction files

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".agents/AGENTS.md", ".claude/CLAUDE.md"] as const;
export type InstructionFile = (typeof INSTRUCTION_FILES)[number];

export interface Level {
  /** A directory between the repo root (the .git boundary) and the workspace root. */
  dir: string;
  present: InstructionFile[];
}

export interface Resolved {
  /** What loads, highest precedence first. */
  loaded: Array<{ path: string; why: string }>;
  ignored: Array<{ path: string; why: string }>;
}

/** Levels are listed from the repo root down to the workspace root. */
export function resolveInstructions(levels: Level[], trusted: boolean, userRules: boolean): Resolved {
  const loaded: Resolved["loaded"] = [];
  const ignored: Resolved["ignored"] = [];
  const winners: Array<{ path: string; depth: number }> = [];
  levels.forEach((level, depth) => {
    const order = INSTRUCTION_FILES.filter((f) => level.present.includes(f));
    order.forEach((f, i) => {
      const path = `${level.dir.replace(/\/$/, "")}/${f}`;
      if (i === 0) {
        if (trusted) winners.push({ path, depth });
        else ignored.push({ path, why: "Project rules load only after you trust the workspace." });
      } else {
        ignored.push({ path, why: `${order[0]} comes first at this level (AGENTS.md, CLAUDE.md, .agents/AGENTS.md, then .claude/CLAUDE.md), so it wins here.` });
      }
    });
  });
  winners
    .sort((a, b) => b.depth - a.depth)
    .forEach((w, i, all) => loaded.push({ path: w.path, why: i === 0 && all.length > 1 ? "The deepest project file wins when guidance conflicts." : "A project rule: it wins over user rules." }));
  if (userRules) loaded.push({ path: "Your machine-wide user rules", why: "Always load, and lose to project rules when guidance conflicts." });
  return { loaded, ignored };
}

export interface Template {
  id: string;
  label: string;
  body: string;
}

export const AGENTS_TEMPLATES: readonly Template[] = [
  {
    id: "web",
    label: "Web app (TypeScript)",
    body: `# AGENTS.md

## Project
A TypeScript web app. Source in src/, tests next to the code as *.test.ts.

## Commands
- Install: npm ci
- Dev server: npm run dev
- Tests: npm test
- Typecheck: npx tsc --noEmit
- Lint: npm run lint

## Conventions
- Strict TypeScript; no any without a comment saying why.
- Small modules with one job; shared helpers go in src/lib/.
- New behavior comes with a test.

## Before you finish
- Run the tests and the typecheck, and say what you ran.
- Don't commit or push unless I ask.
`,
  },
  {
    id: "python",
    label: "Python package",
    body: `# AGENTS.md

## Project
A Python package in src/<package>/ with tests in tests/.

## Commands
- Set up: python -m venv .venv && . .venv/bin/activate && pip install -e ".[dev]"
- Tests: pytest -q
- Lint and format: ruff check . && ruff format --check .
- Types: mypy src

## Conventions
- Type hints on public functions.
- Keep I/O at the edges; keep core logic pure and tested.

## Before you finish
- Run pytest and ruff, and report the results.
- Don't commit or push unless I ask.
`,
  },
  {
    id: "monorepo",
    label: "Monorepo package",
    body: `# AGENTS.md (packages/<name>)

## Scope
This file covers packages/<name>. The repo root AGENTS.md covers the rest; this deeper file wins where they conflict.

## Commands
- Tests for this package only: npm test --workspace packages/<name>
- Build: npm run build --workspace packages/<name>

## Boundaries
- Don't edit other packages from here; describe the change they need instead.
- Shared types live in packages/shared.

## Before you finish
- Run this package's tests and build.
`,
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Memory

export type MemoryScope = "personal-project" | "project" | "personal";

export const MEMORY_SCOPES: ReadonlyArray<{ value: MemoryScope; label: string; where: string }> = [
  { value: "personal-project", label: "Personal project memory (default)", where: "On your machine, outside the repo, private to you, for this project" },
  { value: "project", label: "Project memory", where: "Committed under <repo>/.agents/memory/, shared with everyone who clones it" },
  { value: "personal", label: "Personal memory", where: "Your machine-wide notes, across all projects" },
];

export const MEMORY_INDEX_LIMIT = 48;

export function slugTopic(topic: string): string {
  return (
    topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "note"
  );
}

/** The MEMORY.md index and the file list for topics ("Deploy: how we ship" per line). */
export function memoryLayout(lines: string[], scope: MemoryScope): { tree: string; index: string; warnings: string[] } {
  const topics = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, ...rest] = l.split(":");
      return { file: `${slugTopic(name)}.md`, title: name.trim(), summary: rest.join(":").trim() };
    });
  const root = scope === "project" ? ".agents/memory/" : scope === "personal" ? "(your personal memory)/" : "(this project's personal memory)/";
  const tree = [root, `├── MEMORY.md${" ".repeat(Math.max(1, 14 - "MEMORY.md".length))}# index: one line per topic file`, ...topics.map((t, i) => `${i === topics.length - 1 ? "└──" : "├──"} ${t.file}`)].join("\n");
  const index = ["# Memory", "", ...topics.map((t) => `- [${t.title}](${t.file})${t.summary ? `: ${t.summary}` : ""}`)].join("\n");
  const warnings: string[] = [];
  if (topics.length + 1 > MEMORY_INDEX_LIMIT) warnings.push(`At session start Muse Code injects MEMORY.md and a list of up to ${MEMORY_INDEX_LIMIT} files: with ${topics.length + 1}, some won't be listed.`);
  if (scope === "project") warnings.push("Committed project memory loads into the model's context even in an untrusted workspace. Treat a repo's MEMORY.md as a prompt-injection surface and review it on checkouts you don't control.");
  return { tree, index, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// Launch flags

export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type MuseEffort = (typeof EFFORT_LEVELS)[number];

export interface LaunchDraft {
  surface: "interactive" | "headless";
  model: string;
  /** "" leaves the default (high). */
  effort: "" | MuseEffort;
  approvalMode: "" | "on-request" | "untrusted" | "never";
  approvalJudge: "" | "on" | "off";
  sandboxNetwork: "" | "proxy-only" | "restricted" | "unrestricted";
  disableSandbox: boolean;
  disableApproval: boolean;
  yolo: boolean;
  trustWorkspace: boolean;
  workspace: string;
  noSessionLog: boolean;
  contributor: "" | "on" | "off";
  json: boolean;
  promptFile: string;
  maxSteps: number | null;
  prompt: string;
  trace: boolean;
  retentionDays: number | null;
}

export function buildLaunch(d: LaunchDraft): { command: string; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parts: string[] = ["muse"];
  if (d.surface === "headless") parts.push("exec");
  if (d.retentionDays !== null) parts.push("-c", `session_retention_days=${d.retentionDays}`);
  if (d.model.trim()) parts.push("--model", d.model.trim());
  if (d.effort) parts.push("--reasoning-effort", d.effort);
  if (d.approvalMode) parts.push("--approval-mode", d.approvalMode);
  if (d.approvalJudge) parts.push("--approval-judge", d.approvalJudge);
  if (d.sandboxNetwork) parts.push("--sandbox-network", d.sandboxNetwork);
  if (d.yolo) parts.push("--yolo");
  if (d.disableApproval) parts.push("--disable-approval");
  if (d.disableSandbox) parts.push("--disable-sandbox");
  if (d.trustWorkspace) parts.push("--trust-workspace");
  if (d.workspace.trim()) parts.push("--workspace", d.workspace.trim());
  if (d.noSessionLog) parts.push("--no-session-log");
  if (d.contributor) parts.push("--contributor-mode", d.contributor);
  if (d.surface === "headless") {
    if (d.json) parts.push("--json");
    if (d.maxSteps !== null) parts.push("--max-model-steps", String(d.maxSteps));
    if (d.promptFile.trim()) parts.push("--prompt-file", d.promptFile.trim());
    else parts.push(d.prompt.trim() || "Run the tests and summarize failures.");
  } else if (d.json || d.promptFile.trim() || d.maxSteps !== null) {
    errors.push("--json, --prompt-file and --max-model-steps are headless only: use them with muse exec.");
  }

  if (d.effort === "none") warnings.push("The Meta provider doesn't accept none; other providers can.");
  if (d.effort === "ultra") warnings.push("ultra is client-side: it maps to the provider's highest supported level (xhigh where ultra isn't supported) and can make Muse Code delegate more aggressively.");
  if (d.effort === "xhigh" || d.effort === "max") warnings.push(`${d.effort} is a premium level${d.effort === "max" ? ", the deepest, available in both Standard and Contributor mode" : ""}.`);
  if (d.yolo && (d.disableApproval || d.disableSandbox)) warnings.push("--yolo already disables approval and the sandbox, and trusts the workspace.");
  if (d.disableSandbox && d.sandboxNetwork) warnings.push("--disable-sandbox forces full network egress and overrides --sandbox-network. It also lets write_file and edit_file write anywhere.");
  if (d.surface === "headless" && !d.yolo && !d.disableApproval && d.approvalMode !== "never") {
    warnings.push("muse exec has no UI to answer an approval prompt: pick a policy that can finish unattended, or a held action stays unresolved.");
  }
  if (d.noSessionLog) warnings.push("--no-session-log gives up resume, trajectory export and reattach, automatic naming and peer messaging, and retained workflow recovery.");
  if (d.yolo) warnings.push("--yolo trusts the workspace and loads its AGENTS.md, rules and skills. Use it only where you trust the code and the environment.");

  // MUSE_TRANSPORT_TRACE=1 prints raw provider request and response lines to stderr, credentials scrubbed.
  const command = `${d.trace ? "MUSE_TRANSPORT_TRACE=1 " : ""}${commandLine(parts)}`;
  return { command, errors, warnings };
}

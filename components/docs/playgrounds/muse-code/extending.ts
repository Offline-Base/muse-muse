/**
 * Extending and automating (content/meta-docs/pages/muse-code/extending.md) as builders: subagent capacity (eight agents
 * per tree by default, the root included; agents.execution_capacity 1 to 64; spawns past the limit are rejected, not
 * queued), skill files and commands, the hook lifecycle events and where hooks come from, the MCP named-toolset
 * matcher, and the headless resume and export commands. Pure, for the builders and their tests.
 */

// ---------------------------------------------------------------------------------------------------------------
// Subagents

export type RootEffort = "default" | "ultra" | "max";

export interface CapacityPlan {
  capacity: number;
  /** Where the number comes from. */
  source: string;
  /** Children that can run at once next to the root. */
  childSlots: number;
  running: number;
  rejected: number;
}

/** How many of `wanted` children (grandchildren included) can be running at once, by the page's rules. */
export function subagentCapacity(configured: number | null, effort: RootEffort, wanted: number): CapacityPlan {
  let capacity: number;
  let source: string;
  if (configured !== null) {
    capacity = Math.max(1, Math.min(64, Math.floor(configured)));
    source = "agents.execution_capacity in settings.json";
  } else if (effort === "ultra") {
    capacity = 64;
    source = "an unconfigured ultra root uses 64";
  } else if (effort === "max") {
    capacity = 64;
    source = "new sessions at max effort allow 64, matching ultra (changelog 1.4.0)";
  } else {
    capacity = 8;
    source = "the default: eight agents at once, the root included";
  }
  const childSlots = capacity - 1;
  const n = Math.max(0, Math.floor(wanted) || 0);
  return { capacity, source, childSlots, running: Math.min(n, childSlots), rejected: Math.max(0, n - childSlots) };
}

export interface LeadInput {
  task: string;
  children: Array<{ task: string; writes: boolean }>;
}

/** A lead prompt that hands each child one bounded task and asks for worktrees only where children write. */
export function leadPrompt(input: LeadInput): string {
  const kids = input.children.filter((c) => c.task.trim());
  const lines = [
    `${input.task.trim() || "Split this job across subagents"}.`,
    "",
    ...kids.map((c, i) => `${i + 1}. A subagent ${c.task.trim().replace(/\.$/, "")}${c.writes ? ", in an isolated worktree, and commits its changes when done" : ", read-only in the shared checkout"}.`),
    "",
    "Keep managing them while they run, and verify each one's result before you report back.",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Skills

export type SkillScope = "project" | "user";

export function skillId(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "my-skill"
  );
}

export interface SkillFiles {
  dir: string;
  skillMd: string;
  commands: string;
}

/**
 * The SKILL.md and the commands for it, with every path pointing at the same folder. A project skill is written where
 * it loads (<repo>/.agents/skills/<id>), validated there and committed. A user skill is authored in a working folder
 * and installed with --scope user, the way the page's own commands do it (validate ./my-skill, install ./my-skill).
 */
export function skillFiles(id: string, scope: SkillScope, description: string, body: string, displayName = ""): SkillFiles {
  const dir = scope === "project" ? `.agents/skills/${id}` : `./${id}`;
  const front = ["---", `name: ${id}`, `description: ${description.trim().replace(/\n+/g, " ") || "What the skill does, and when to use it."}`];
  if (displayName.trim()) front.push("metadata:", `  display-name: ${displayName.trim()}`);
  front.push("---");
  const skillMd = [...front, "", body.trim() || "# Steps\n\n1. ...", ""].join("\n");
  const commands = (
    scope === "project"
      ? [
          `muse skills validate ./${dir}   # check it before you commit`,
          `# Commit ${dir}/SKILL.md; anyone who clones the repo gets it.`,
          `muse skills enable ${id} --scope project`,
        ]
      : [`muse skills validate ${dir}      # check it before installing`, `muse skills install ${dir} --scope user   # into your user skills, for every project`]
  )
    .concat(["muse skills list                    # every skill, all sources", `muse skills inspect ${id}`])
    .join("\n");
  return { dir, skillMd, commands };
}

export const SKILL_SOURCES: ReadonlyArray<{ source: string; where: string }> = [
  { source: "Built-in", where: "Ships with Muse Code: /plan, /grill, /taste, /threejs, and the migrate skill (/migrate)." },
  { source: "User", where: "$XDG_CONFIG_HOME/muse/skills and ~/.agents/skills, in every project. Also ~/.claude/skills and $CODEX_HOME/skills (or ~/.codex/skills), unless a preference turns those off." },
  { source: "Project", where: "<repo>/.agents/skills/<skill-id>/SKILL.md, shared with anyone who clones it. Repo-local .codex/skills and .claude/skills are scanned too." },
  { source: "Plugin", where: "Skills from enabled plugin bundles." },
];

// ---------------------------------------------------------------------------------------------------------------
// Hooks

export interface HookEvent {
  name: string;
  /** When it fires; from the page where it says, otherwise what the event's name states. */
  when: string;
  /** What its result can do, where the page says. */
  power?: string;
}

export const HOOK_EVENTS: readonly HookEvent[] = [
  { name: "SessionStart", when: "A session starts. Changelog: it reports its source (startup, resume, fork, clear or compact)." },
  { name: "UserPromptSubmit", when: "You submit a prompt." },
  { name: "PreToolUse", when: "Before a tool call runs." },
  { name: "PermissionRequest", when: "A tool call asks for permission." },
  { name: "PostToolUse", when: "After a tool call runs." },
  { name: "PostToolUseFailure", when: "A tool call fails or crashes." },
  { name: "PostToolBatch", when: "Once after each committed batch of tool calls, with the calls in order.", power: "Can block the batch with a reason, stop the turn, or add context." },
  { name: "PreLLMCall", when: "Before a model call." },
  { name: "PostLLMCall", when: "After a model call." },
  { name: "PreCompact", when: "Before compaction (manual /compact or automatic)." },
  { name: "PostCompact", when: "After compaction." },
  { name: "SubagentStart", when: "A subagent starts." },
  { name: "SubagentStop", when: "A subagent stops." },
  { name: "Notification", when: "The agent needs your approval.", power: "Lets a hook alert you." },
  { name: "Stop", when: "A turn ends." },
  { name: "StopFailure", when: "Once, when a turn ends in a final model failure.", power: "Receives the failure category and safe details." },
  { name: "SessionEnd", when: "During orderly session termination.", power: "Observational only: it can't block termination, inject context for a later request, or stop the session." },
];

export type HookSource = "project" | "user" | "managed";

export const HOOK_SOURCES: Record<HookSource, { where: string; trust: string; malformed: string }> = {
  project: {
    where: "<project-root>/.muse/hooks.json, committed to the repo",
    trust: "Runs only after you trust the project folder.",
    malformed: "A malformed file contributes no handlers from this source and shows a startup warning.",
  },
  user: {
    where: "The hooks block of your settings file (~/.config/muse/settings.json)",
    trust: "Runs from your own settings with no separate hook-level trust step.",
    malformed: "A malformed user settings file fails settings validation.",
  },
  managed: {
    where: "The file the managed_hooks_path setting points to",
    trust: "Runs without a project-trust step, so whoever controls that file controls what executes.",
    malformed: "A malformed file contributes no handlers from this source and shows a startup warning.",
  },
};

// ---------------------------------------------------------------------------------------------------------------
// MCP named toolsets

export interface ToolsetResult {
  tools: Array<{ tool: string; matchedBy: string | null }>;
  /** Exact names in the toolset that no connected server offers: the run stops before contacting the model. */
  missing: string[];
  /** Patterns that aren't MCP tool names (mcp__<server>__<tool>, or a trailing *). */
  invalid: string[];
}

const MCP_NAME = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]*\*?$/;

export function toolsetMatch(patterns: string[], tools: string[]): ToolsetResult {
  const pats = patterns.map((p) => p.trim()).filter(Boolean);
  const invalid = pats.filter((p) => !MCP_NAME.test(p) || (p.endsWith("*") && p.indexOf("*") !== p.length - 1));
  const valid = pats.filter((p) => !invalid.includes(p));
  const list = tools.map((t) => t.trim()).filter(Boolean);
  const matches = (p: string, t: string) => (p.endsWith("*") ? t.startsWith(p.slice(0, -1)) : t === p);
  return {
    tools: list.map((tool) => ({ tool, matchedBy: valid.find((p) => matches(p, tool)) ?? null })),
    missing: valid.filter((p) => !p.endsWith("*") && !list.includes(p)),
    invalid,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Headless: resume and audit

export function resumeCommands(sessionId: string, out: string, switchWorkspace: boolean): string {
  const id = sessionId.trim() || "<uuid>";
  return [
    `muse exec --session-id ${id}${switchWorkspace ? " --allow-workspace-switch" : ""} "Continue the task."`,
    `muse export --session ${id} --out ${out.trim() || "run.json"}`,
  ].join("\n");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionIdProblem(id: string): string | null {
  if (!id.trim()) return null;
  return UUID.test(id.trim()) ? null : "A session id is a full UUID, such as 6f1c2b7a-41d2-4e8b-9a3c-0d5e7f9a1b24.";
}

// ---------------------------------------------------------------------------------------------------------------
// Reviewing a hook's command

/** The parts of a classified shell stage (permissions.ts) a hook review needs. */
export interface StageRisk {
  kind: "read" | "write" | "dangerous" | "external" | "unknown";
  network: string | null;
  writes: string[];
}

/**
 * What one stage of a hook's command would do, said for hooks: they run straight through your shell, outside the
 * sandbox and approval, so nothing holds or contains the stage.
 */
export function hookRisk(info: StageRisk): string {
  const parts: string[] = [];
  if (info.kind === "dangerous") parts.push("destructive, and no approval will hold it");
  else if (info.kind === "external") parts.push("runs code the shell can't review, and no approval will hold it");
  else if (info.kind === "unknown") parts.push("not a command this check recognizes: read what it does first");
  else if (info.kind === "write") parts.push("changes files");
  else parts.push("read-only");
  if (info.network !== null) parts.push(`reaches ${info.network || "the network"} directly`);
  if (info.writes.length) parts.push(`writes ${info.writes.join(", ")} with nothing confining it`);
  const text = parts.join("; ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

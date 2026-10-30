/**
 * Every command and shortcut on "Working with the agent" (content/meta-docs/pages/muse-code/interactive.md), plus the
 * slash commands the other Muse Code pages name (/settings, /models, /login, /mcp, the built-in skills), each with
 * the page and section that documents it. The explorer searches and filters this list.
 */

export type CommandKind = "slash" | "key" | "cli" | "setting";

export type Group =
  | "Steer a turn"
  | "Sessions"
  | "Side conversations"
  | "Context"
  | "Goals and loops"
  | "Background work"
  | "Workflows"
  | "Questions and plans"
  | "Voice and images"
  | "Reasoning and logs"
  | "Settings and account"
  | "Skills and tools"
  | "Help";

export interface Command {
  name: string;
  /** Other spellings and arguments. */
  forms?: string[];
  kind: CommandKind;
  group: Group;
  summary: string;
  details?: string[];
  /** Docs path with the section anchor. */
  href: string;
  /** Inside a side conversation: unavailable, or works differently. */
  sideChat?: "unavailable" | "works";
  keywords?: string[];
}

const I = "/docs/muse-code/interactive";

export const COMMANDS: readonly Command[] = [
  { name: "/help", kind: "slash", group: "Help", summary: "See the full set of built-in commands in your workspace.", href: `${I}#slash-commands` },
  { name: "/keymap", kind: "slash", group: "Help", summary: "See the keyboard shortcuts.", href: `${I}#slash-commands`, keywords: ["keys", "shortcuts"] },

  { name: "Enter", kind: "key", group: "Steer a turn", summary: "While a turn runs: steer it. Your text is injected into the turn in progress, and the agent applies it on its next step.", href: `${I}#steering`, keywords: ["steer", "inject"] },
  { name: "Alt+Enter", kind: "key", group: "Steer a turn", summary: "Queue: hold your text for the next turn instead of the current one.", href: `${I}#steering`, keywords: ["queue", "next turn"] },
  {
    name: "Esc",
    kind: "key",
    group: "Steer a turn",
    summary: "Interrupt: cancel the current turn.",
    details: [
      "It stops the turn only, not background terminals or subagents. If background work is still running, Muse Code sets a reminder to run /stop.",
      "An unfinished goal pauses; /goal resume restarts it.",
    ],
    href: `${I}#steering`,
    keywords: ["interrupt", "cancel"],
  },
  {
    name: "Esc (empty composer)",
    kind: "key",
    group: "Steer a turn",
    summary: "Retract: pull the most recently queued instruction back into the composer to edit or drop it. Repeat to retract older ones.",
    details: ["Only the newest eligible item can be retracted at a time."],
    href: `${I}#steering`,
    keywords: ["retract", "queued"],
  },
  { name: "Ctrl+C", kind: "key", group: "Steer a turn", summary: "Interrupts too, but only from an empty composer. With text in the composer it clears the input instead.", href: `${I}#steering`, keywords: ["interrupt", "clear"] },
  {
    name: "Esc Esc",
    kind: "key",
    group: "Sessions",
    summary: "From an idle, empty composer: open the rewind picker. The first Esc shows Esc again to rewind.",
    href: "/docs/muse-code/rewind#rewind",
    keywords: ["rewind", "branch", "double"],
  },

  {
    name: "/new",
    kind: "slash",
    group: "Sessions",
    summary: "Start a fresh session and keep the terminal scrollback.",
    details: ["The conversation, in-session context, token counts, goal and tasks all reset. On-disk memory and rules don't change."],
    href: `${I}#sessions`,
    sideChat: "unavailable",
  },
  { name: "/clear", kind: "slash", group: "Sessions", summary: "Start a fresh session and wipe the scrollback. Otherwise the same as /new.", href: `${I}#sessions`, sideChat: "unavailable" },
  {
    name: "/name",
    forms: ["/name <name>"],
    kind: "slash",
    group: "Sessions",
    summary: "Show the session's name, or rename it. A stable name lets other live sessions find this one through session messaging.",
    href: `${I}#sessions`,
    keywords: ["rename", "messaging"],
  },
  {
    name: "/resume",
    forms: ["/resume --last"],
    kind: "slash",
    group: "Sessions",
    summary: "Pick a retained session in this workspace and continue it; --last resumes the most recent one.",
    details: ["It relaunches the session rather than swapping it in place, so expect a brief transition. An interrupted or crashed run replays cleanly."],
    href: `${I}#sessions`,
    sideChat: "unavailable",
  },
  {
    name: "/fork",
    kind: "slash",
    group: "Sessions",
    summary: "Branch a new session from the current session's latest stable point. The source stays active and unchanged, and the fork doesn't take over your view.",
    href: `${I}#sessions`,
    sideChat: "unavailable",
    keywords: ["branch"],
  },
  { name: "muse resume <fork-id>", kind: "cli", group: "Sessions", summary: "Continue a fork later, from your shell.", href: `${I}#sessions` },
  {
    name: "/rewind",
    kind: "slash",
    group: "Sessions",
    summary: "Branch from an earlier user message: it comes back as an unsent draft in a new retained session, and workspace files are left unchanged.",
    href: "/docs/muse-code/rewind",
    keywords: ["branch", "undo", "earlier message"],
  },

  {
    name: "/side",
    forms: ["/side <prompt>", "/btw <prompt>"],
    kind: "slash",
    group: "Side conversations",
    summary: "Open a short parallel conversation seeded from the main history, without changing the main thread. Ctrl+C returns to it, restored exactly.",
    details: ["One side conversation at a time. Inside it, /side, /fork, /new, /clear and /resume are unavailable."],
    href: `${I}#side-chats`,
    sideChat: "unavailable",
    keywords: ["btw", "parallel"],
  },

  {
    name: "/compact",
    kind: "slash",
    group: "Context",
    summary: "Replace earlier model-visible history with a generated summary to reclaim context room. Lossy for the model, but your scrollback stays.",
    details: ["Muse Code also compacts automatically when context fills; a manual /compact never counts against the auto-compaction budget.", "Fires the PreCompact and PostCompact hooks."],
    href: `${I}#context`,
    keywords: ["summarize", "context window"],
  },
  {
    name: "/recap",
    kind: "slash",
    group: "Context",
    summary: "Show a short summary of what happened since the last recap. Needs new activity, and runs between turns, not during one.",
    details: ["It appears on its own when you come back after 2 minutes away, once the session has at least 2 of your messages.", "A recap is a summary cell only: it doesn't change the model's context."],
    href: `${I}#context`,
  },
  {
    name: "/export",
    forms: ["/export transcript", "/export trajectory", "--out <path>", "--redacted"],
    kind: "slash",
    group: "Context",
    summary: "Save the session: transcript writes the on-screen conversation to conversation-<stamp>.txt, trajectory the full session log as JSON. Bare /export opens a chooser.",
    details: ["--out <path> picks a location; --redacted scrubs secret-shaped strings.", "The trajectory is the same document muse export produces."],
    href: `${I}#context`,
    keywords: ["save", "json", "log"],
  },
  { name: "/copy", kind: "slash", group: "Context", summary: "Copy the markdown of the last completed response to your clipboard.", href: `${I}#context`, sideChat: "works", details: ["In a side conversation it copies the side transcript."] },

  {
    name: "/goal",
    forms: ["/goal <objective>", "/goal edit <objective>", "/goal pause", "/goal resume", "/goal clear"],
    kind: "slash",
    group: "Goals and loops",
    summary: "Set, show, revise, pause, resume or drop the session goal, and the runtime holds the agent to it.",
    details: [
      "After each turn the runtime queues a follow-up for unfinished work, and prompts report_progress if about 10 model steps pass without one.",
      "It holds the agent to a requirement-by-requirement check before it declares the goal done. Esc pauses an unfinished goal.",
    ],
    href: `${I}#goals-loops`,
    keywords: ["objective", "long-running"],
  },
  {
    name: "/loop",
    forms: ["/loop 10m /run-tests", '/loop "0 9 * * 1-5" standup'],
    kind: "slash",
    group: "Goals and loops",
    summary: "Schedule a recurring prompt as a cron job: a shorthand interval (5m, 1h, 2d) or a 5-field cron expression in local time. With no cadence, every 10 minutes.",
    details: ["Occurrences that land during an active run are skipped, not queued (fire_when_active_run: false).", "Recurring jobs auto-expire after 7 days. The prompt can be plain text or a /skill."],
    href: `${I}#goals-loops`,
    keywords: ["cron", "schedule", "recurring"],
  },

  { name: "/tasks", kind: "slash", group: "Background work", summary: "Open the Tasks drawer for background tasks and direct subagents, with controls for the selected row.", href: `${I}#tasks` },
  { name: "/subagents", kind: "slash", group: "Background work", summary: "View running and completed subagents and their descendants.", href: `${I}#tasks` },
  {
    name: "/stop",
    kind: "slash",
    group: "Background work",
    summary: "Stop applicable background tasks and terminals. It doesn't blanket-cancel direct subagents; manage those in /tasks.",
    details: ["Different from Esc, which only ends the current turn."],
    href: `${I}#stop`,
  },

  {
    name: "/workflows",
    kind: "slash",
    group: "Workflows",
    summary: "When workflows are available: browse active and completed workflow runs with phases, child progress, elapsed time, tokens, errors and results.",
    details: ["Pause, resume, cancel, skip or restart a selected running child from the control room."],
    href: "/docs/muse-code/workflows#monitor",
  },

  {
    name: "Clarifying questions",
    kind: "key",
    group: "Questions and plans",
    summary: "When the agent pauses with one to three questions: number keys pick, Space toggles a multi-select option, Tab adds a note, Left and Right move between questions, Enter submits after a review step.",
    details: ["Esc interrupts instead of answering. Answers steer the next steps; they grant no filesystem, shell, network or approval authority."],
    href: `${I}#clarify`,
    keywords: ["questions", "answer"],
  },
  { name: "/plan", kind: "slash", group: "Questions and plans", summary: "A built-in skill: turn a task into a grounded, decision-complete plan, then stop for your approval before building.", href: "/docs/muse-code/extending#skills", keywords: ["skill"] },

  {
    name: "Alt+V",
    forms: ["option-V on macOS"],
    kind: "key",
    group: "Voice and images",
    summary: "Start or stop voice input. Muse Code transcribes into the composer, and Enter submits it.",
    details: ["Voice is on by default on macOS, off by default on Linux, and unavailable on Windows. Turn it on or off in /settings, not with /voice on."],
    href: `${I}#voice`,
    keywords: ["dictate", "speech"],
  },
  { name: "/voice", forms: ["/voice status", "/voice debug"], kind: "slash", group: "Voice and images", summary: "Show voice status, or toggle voice diagnostics. It inspects state only.", href: `${I}#voice` },
  {
    name: "[Image #N]",
    kind: "key",
    group: "Voice and images",
    summary: "Paste or drop an image into the composer and refer to it by its number, such as \"what's the error in [Image #2]?\".",
    details: ["The labels and their source paths survive resume, fork and rewind."],
    href: `${I}#images`,
    keywords: ["paste", "screenshot"],
  },

  {
    name: "show_reasoning",
    kind: "setting",
    group: "Reasoning and logs",
    summary: "A setting that commits the model's full reasoning into your transcript. Off by default, and separate from the live one-line reasoning summary, which is on.",
    href: `${I}#reasoning`,
  },
  {
    name: "/effort",
    forms: ["--reasoning-effort <level>"],
    kind: "slash",
    group: "Reasoning and logs",
    summary: "Change how much reasoning the model produces: none, minimal, low, medium, high (default), xhigh, max, ultra. The Meta provider doesn't accept none.",
    href: "/docs/muse-code/configuration#reasoning-effort",
  },
  { name: "muse trace inspect", kind: "cli", group: "Reasoning and logs", summary: "Inspect a session's event log after the fact.", href: `${I}#session-model`, keywords: ["debug", "log"] },
  {
    name: "--no-session-log",
    forms: ["muse --no-session-log", "muse exec --no-session-log"],
    kind: "cli",
    group: "Reasoning and logs",
    summary: "Run without a retained log. You give up resume, trajectory export and reattach, automatic session naming and peer messaging, and retained workflow recovery.",
    href: `${I}#session-model`,
  },

  { name: "/settings", kind: "slash", group: "Settings and account", summary: "Open settings: the Contributor mode row under Model, Tools > Workflows, Tools > Session messaging, voice and more.", href: "/docs/muse-code/configuration#settings-file" },
  { name: "/models", kind: "slash", group: "Settings and account", summary: "Switch the model mid-session. The default is muse-spark-1.2; --model overrides it per run.", href: "/docs/muse-code/configuration#model" },
  { name: "/theme", kind: "slash", group: "Settings and account", summary: "Set the terminal theme, saved as tui.terminal_background.", href: "/docs/muse-code/configuration#settings-file" },
  { name: "/login", kind: "slash", group: "Settings and account", summary: "Reopen the sign-in options: browser sign-in or an API key.", href: "/docs/muse-code/auth#sign-in" },
  { name: "/upgrade", kind: "slash", group: "Settings and account", summary: "Open Accounts Center in your browser to change your plan.", href: "/docs/muse-code/subscriptions#change-or-cancel" },

  { name: "/mcp", kind: "slash", group: "Skills and tools", summary: "A live inventory of connected MCP servers and their tools.", href: "/docs/muse-code/extending#mcp" },
  { name: "/grill", kind: "slash", group: "Skills and tools", summary: "A built-in skill that stress-tests a plan or design before you build, recording each settled decision and a scope contract in your project docs.", href: "/docs/muse-code/extending#skills" },
  { name: "/taste", kind: "slash", group: "Skills and tools", summary: "A built-in skill: a design-quality gate for frontend work.", href: "/docs/muse-code/extending#skills" },
  { name: "/threejs", kind: "slash", group: "Skills and tools", summary: "A built-in skill with references for building Three.js scenes.", href: "/docs/muse-code/extending#skills" },
  { name: "/migrate", kind: "slash", group: "Skills and tools", summary: "The bundled migrate skill: import your Claude Code or Codex memory notes and MCP servers into Muse Code.", href: "/docs/muse-code/extending#skills" },
];

export const GROUPS: readonly Group[] = [
  "Steer a turn",
  "Sessions",
  "Side conversations",
  "Context",
  "Goals and loops",
  "Background work",
  "Workflows",
  "Questions and plans",
  "Voice and images",
  "Reasoning and logs",
  "Settings and account",
  "Skills and tools",
  "Help",
];

function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Commands matching every word of the query (in the name, forms, summary, details or keywords), names first. */
export function searchCommands(query: string, group: Group | "all" = "all", list: readonly Command[] = COMMANDS): Command[] {
  const words = norm(query).split(" ").filter(Boolean);
  const inGroup = group === "all" ? list : list.filter((c) => c.group === group);
  if (!words.length) return [...inGroup];
  const scored = inGroup
    .map((c) => {
      const name = norm([c.name, ...(c.forms ?? [])].join(" "));
      const hay = norm([c.name, ...(c.forms ?? []), c.summary, ...(c.details ?? []), ...(c.keywords ?? []), c.group].join(" "));
      if (!words.every((w) => hay.includes(w))) return null;
      const score = words.reduce((s, w) => s + (name.startsWith(w) || name.includes(` ${w}`) || name.includes(w) ? 2 : 0), 0);
      return { c, score };
    })
    .filter((x): x is { c: Command; score: number } => x !== null);
  return scored.sort((a, b) => b.score - a.score).map((x) => x.c);
}

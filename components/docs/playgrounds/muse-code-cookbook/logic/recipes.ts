/**
 * The ten Muse Code recipes on the cookbook's "Building with Muse Code" page, with the facts each recipe page gives:
 * its time to complete, the commands and flags it drives, and the guarantee it proves. The themes follow the index
 * page's lead (safety, recovery, orchestration). The recommender's strict schema takes its slugs from here, so the
 * model can only pick a recipe that exists.
 */

export type Theme = "safety" | "recovery" | "orchestration";

export const THEME_LABEL: Record<Theme, string> = {
  safety: "Safety",
  recovery: "Audit and recovery",
  orchestration: "Orchestration",
};

export interface Recipe {
  slug: string;
  title: string;
  /** The index page's one-line description. */
  blurb: string;
  theme: Theme;
  minutes: number;
  commands: string[];
  /** The guarantee or rule the recipe states in bold. */
  proves: string;
}

export const RECIPES: readonly Recipe[] = [
  {
    slug: "audit-agent-sessions",
    title: "Audit and resume agent sessions",
    blurb: "Replay any session exactly as it ran from an append-only event log, show who authorized each action, then kill the run mid-task and resume with no duplicate side effects.",
    theme: "recovery",
    minutes: 35,
    commands: ["muse export --last", "muse export --session <id> --out trajectory.json", "muse export --redacted --out share.json", "muse resume --last"],
    proves: "The intent, and the authorization it carries, is durable before the effect is externally visible.",
  },
  {
    slug: "deterministic-replay",
    title: "Deterministic replay in CI",
    blurb: "Turn recorded events into a golden fixture and replay its model-context projection as a merge-blocking CI check.",
    theme: "recovery",
    minutes: 20,
    commands: ["muse trace inspect --fixture golden-traces/checkout_probe.json", "muse trace inspect --fixture <file> --format json", "./artifacts/replay_gate.sh golden-traces"],
    proves: "Zero diffs pass; any diff blocks the merge.",
  },
  {
    slug: "staged-approvals",
    title: "Staged approvals",
    blurb: "Split a compound shell command into stages so safe ones auto-resolve while risky ones hold for review.",
    theme: "safety",
    minutes: 20,
    commands: ["muse", "muse --approval-mode untrusted"],
    proves: "Fail-closed: a rejected stage denies the whole action, and the command runs only after every stage clears.",
  },
  {
    slug: "contained-execution",
    title: "Contained execution",
    blurb: "Run every command in an OS sandbox that refuses to proceed unless containment is proven live.",
    theme: "safety",
    minutes: 20,
    commands: ["muse --disable-approval --trust-workspace", "muse --disable-sandbox", "muse --yolo"],
    proves: "The harness verifies enforcement with a live probe before it trusts the sandbox.",
  },
  {
    slug: "immutable-guardrails",
    title: "Immutable guardrails",
    blurb: "The agent can't rewrite its own rules: guardrail edits stop for review and a shell write to the same path fails read-only at the sandbox.",
    theme: "safety",
    minutes: 20,
    commands: ["muse --trust-workspace", "muse --disable-approval --trust-workspace"],
    proves: "A write to a guardrail file stops for a human or fails at the sandbox, and the review can't record a standing permission for it.",
  },
  {
    slug: "subagent-fanout",
    title: "Subagent fanout",
    blurb: "Fan one job out to parallel subagents, each in its own isolated git worktree.",
    theme: "orchestration",
    minutes: 25,
    commands: ["muse --subagent-worktree-isolation", "subagent_spawn, subagent_status, subagent_send_message, subagent_cancel, subagent_wait"],
    proves: "Each child edits only its own worktree; the parent's repository is untouched.",
  },
  {
    slug: "goal-tracking",
    title: "Goal tracking",
    blurb: "Pin an objective once and the harness audits the work against acceptance checks before the goal can close.",
    theme: "orchestration",
    minutes: 20,
    commands: ["/goal <objective, with its finish line>", "update_goal (gated by the completion audit)"],
    proves: "The goal closes only when every deliverable you asked for is present.",
  },
  {
    slug: "bundled-skills",
    title: "Bundled skills",
    blurb: "Drive the built-in /plan, /grilling, /grill-with-docs, and /taste skills to plan, pressure-test, and build.",
    theme: "orchestration",
    minutes: 25,
    commands: ["muse skills list", "/plan", "/grilling", "/grill-with-docs", "/taste"],
    proves: "A skill runs on explicit invocation only, loads its full body on demand, and applies to that turn only.",
  },
  {
    slug: "loop-and-cron",
    title: "Loop and cron",
    blurb: "Schedule recurring or one-time agent work in natural language, then view, change, or cancel it from the same chat.",
    theme: "orchestration",
    minutes: 20,
    commands: ["/loop every morning at 8am, triage new bugs ...", "List my scheduled jobs.", "Cancel scheduled job <id>"],
    proves: "Jobs run in local time while Muse Code runs, belong to their session, and recurring ones expire after seven days.",
  },
  {
    slug: "side-chats",
    title: "Side chats",
    blurb: "Branch off the main thread for a side conversation that never enters the main history.",
    theme: "orchestration",
    minutes: 15,
    commands: ["/side <question>", "/btw <question>", "Ctrl+C to return"],
    proves: "The side chat reads the main thread, the main thread never sees the side chat, and the main run keeps going.",
  },
];

export const RECIPE_SLUGS: readonly string[] = RECIPES.map((r) => r.slug);

export function recipeBySlug(slug: string): Recipe | undefined {
  return RECIPES.find((r) => r.slug === slug);
}

/** Recipes matching a theme filter and a search, by title, description, commands and guarantee. */
export function filterRecipes(theme: Theme | "all", query: string): Recipe[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return RECIPES.filter((r) => {
    if (theme !== "all" && r.theme !== theme) return false;
    const hay = `${r.title} ${r.blurb} ${r.commands.join(" ")} ${r.proves}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The recommender's strict schema: up to three picks, each a known slug with a reason. */
export const RECOMMEND_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slug: { type: "string", enum: [...RECIPE_SLUGS] },
          why: { type: "string" },
        },
        required: ["slug", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
};

/** The recommender's instructions: the catalog in one line per recipe, so its answer stays inside it. */
export function recommendInstructions(): string {
  return [
    "You match a developer's need to Muse Code cookbook recipes. Pick one to three recipes from this catalog, best first, and say in one sentence each how it answers the need. Use only these slugs. Write plain sentences without em dashes.",
    ...RECIPES.map((r) => `- ${r.slug}: ${r.blurb} Guarantee: ${r.proves}`),
  ].join("\n");
}

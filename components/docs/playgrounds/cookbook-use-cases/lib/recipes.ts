/**
 * The use-case recipes Meta's cookbook lists on cookbook/use-cases, with the facts each recipe's own page states in
 * its header table (time, harness, language) and what it needs. The browser filters on these; the "which recipe
 * fits" call picks from the slugs, so it can't name a recipe that doesn't exist.
 */

export type Capability = "vision" | "tools" | "computer-use" | "web-search" | "code-exec" | "voice" | "multi-agent" | "approval" | "structured";

export interface Recipe {
  slug: string;
  title: string;
  summary: string;
  harness: string;
  time: string;
  model: string;
  capabilities: Capability[];
  /** What the recipe needs before you start, from its prerequisites. */
  needs: string;
  /** What this mirror's "Try it live" card does on that page. */
  demo: string;
}

export const CAPABILITY_LABEL: Record<Capability, string> = {
  vision: "Vision",
  tools: "Tool calling",
  "computer-use": "Computer use",
  "web-search": "Web search",
  "code-exec": "Runs code",
  voice: "Voice",
  "multi-agent": "Multi-agent",
  approval: "Human approval",
  structured: "Structured output",
};

export const RECIPES: readonly Recipe[] = [
  {
    slug: "perception-chart-analysis",
    title: "Chart analysis",
    summary: "Read charts and extract structured data from images.",
    harness: "OpenClaw",
    time: "~30 min",
    model: "muse-spark-1.3",
    capabilities: ["vision", "structured"],
    needs: "OpenClaw with the Meta provider; the macOS app for Canvas",
    demo: "Reads the sample bar chart into JSON, checks every number against the chart's known values, and redraws it.",
  },
  {
    slug: "perception-error-screenshot-fix",
    title: "Error screenshot fix",
    summary: "Diagnose a bug from a screenshot and ship the fix.",
    harness: "OpenCode",
    time: "under 30 min",
    model: "muse-spark-1.3",
    capabilities: ["vision", "tools"],
    needs: "Python 3.10+, OpenCode, a MODEL_API_KEY",
    demo: "Plans from two screenshots of one bug (one names no file) over a sample repo, asks you the fix scope, then writes the diff.",
  },
  {
    slug: "rayban-openclaw",
    title: "Smart glasses with OpenClaw",
    summary: "Look, ask out loud, and hear the answer, hands-free on Ray-Ban Meta glasses.",
    harness: "OpenClaw",
    time: "~30 min",
    model: "muse-spark-1.3",
    capabilities: ["vision", "voice"],
    needs: "An OpenClaw gateway, Xcode 26.6+, an iPhone or Ray-Ban Meta glasses",
    demo: "Takes a photo and a spoken question, transcribes it, answers with vision and reads the answer aloud.",
  },
  {
    slug: "generating-slides",
    title: "Generating slides",
    summary: "Generate a slide deck from a prompt or source content.",
    harness: "Python script",
    time: "~20 min",
    model: "muse-spark-1.3",
    capabilities: ["web-search", "structured"],
    needs: "Python and a MODEL_API_KEY",
    demo: "Researches a topic with web search, writes the JSON outline, and shows the deck as slides.",
  },
  {
    slug: "browser-verified-web-design",
    title: "Browser-verified web design",
    summary: "Build a website with a coding agent that checks its own work in a real browser.",
    harness: "OpenCode + Playwright MCP",
    time: "~30 min",
    model: "muse-spark-1.3",
    capabilities: ["vision", "tools"],
    needs: "OpenCode, Node.js 18+ for the Playwright MCP",
    demo: "Builds the page, screenshots it in a sandbox with the cursor over the logo, and has the model review and fix it.",
  },
  {
    slug: "iterative-game-dev",
    title: "Iterative game dev",
    summary: "Build a browser game end-to-end with a coding agent, verified in a real browser.",
    harness: "OpenCode + Playwright MCP",
    time: "~30 min",
    model: "muse-spark-1.3",
    capabilities: ["vision", "tools", "code-exec"],
    needs: "OpenCode, Node.js 18+, curl and unzip",
    demo: "Builds a game, plays it with held keys in a sandbox, then sends the frame and console back for a fix pass.",
  },
  {
    slug: "sandboxed-execution",
    title: "Sandboxed execution",
    summary: "Execute model-generated code in a sandbox.",
    harness: "Python scaffold + Docker",
    time: "a few minutes per run",
    model: "muse-spark-1.3",
    capabilities: ["tools", "code-exec"],
    needs: "Docker, Python 3.11+",
    demo: "Lets Muse Spark reproduce, fix and test a bug in a throwaway browser sandbox with run and write_file.",
  },
  {
    slug: "multi-agent-orchestration",
    title: "Multi-agent orchestration",
    summary: "Orchestrate a team of specialists that coordinate through a shared Kanban board.",
    harness: "Hermes",
    time: "~45 min",
    model: "muse-spark-1.3",
    capabilities: ["multi-agent", "tools"],
    needs: "macOS or Linux, tmux, ffmpeg, about 6 GB of disk",
    demo: "Runs a PM and three specialists on a live board: clarify questions, tasks, blocks and comments.",
  },
  {
    slug: "one-shot-game-dev",
    title: "One-shot game dev",
    summary: "Build a complete 3D browser game in one pass, one structured prompt, no iteration loop.",
    harness: "OpenCode",
    time: "~20 min",
    model: "muse-spark-1.3",
    capabilities: ["code-exec"],
    needs: "OpenCode; the Kenney asset packs are optional",
    demo: "Builds the recipe's structured prompt and AGENTS.md, generates a single-file game, and plays it in a sandbox.",
  },
  {
    slug: "perception-grounding",
    title: "Perception grounding",
    summary: "Pin interactive dots at object pixel locations and generate a self-contained HTML overlay.",
    harness: "Python script",
    time: "~10 min",
    model: "muse-spark-1.3",
    capabilities: ["vision", "structured"],
    needs: "Python and a MODEL_API_KEY",
    demo: "Pins color-coded, scored dots on the fridge photo and builds the downloadable HTML overlay.",
  },
  {
    slug: "github-agent",
    title: "GitHub agent",
    summary: "Run an autonomous GitHub Actions bot for triage, PR review, and bug-fix PRs on OpenCode and Muse Spark.",
    harness: "OpenCode + GitHub Actions",
    time: "~15 min for Phase 1",
    model: "muse-spark-1.3",
    capabilities: ["tools", "multi-agent"],
    needs: "A GitHub repo you can add secrets and workflows to",
    demo: "Routes sample GitHub events to the recipe's agents and runs them over a mock repo with a fake gh.",
  },
  {
    slug: "computer-use",
    title: "Computer use",
    summary: "Control a desktop from screenshots with a computer-use agent.",
    harness: "OpenCode + Cua MCP",
    time: "~20 min",
    model: "muse-spark-1.3",
    capabilities: ["vision", "computer-use", "tools"],
    needs: "Docker, Python 3.11+, OpenCode",
    demo: "Has Muse Spark find and play Mines on a simulated Linux desktop through the cua_* tools.",
  },
  {
    slug: "computer-use-macos",
    title: "Computer use on macOS",
    summary: "Drive a real Mac from screenshots with native mouse and keyboard events.",
    harness: "metacua (Swift or Python)",
    time: "~15 min",
    model: "muse-spark-1.3",
    capabilities: ["vision", "computer-use", "tools"],
    needs: "macOS 12+, Swift 5.9+ or Python 3.9+",
    demo: "Plays tic-tac-toe on a simulated Mac with computer.computer and computer.stop on 0 to 1000 coordinates.",
  },
  {
    slug: "glimmer-api-agent",
    title: "Local agent that asks first",
    summary: "Run Muse Glimmer locally and escalate to Muse Spark only after you approve the text the tool is about to send.",
    harness: "Hermes",
    time: "~40 min",
    model: "muse-glimmer-30b locally, muse-spark-1.3 remotely",
    capabilities: ["approval", "tools"],
    needs: "Hermes, Muse Glimmer on a local runtime, a Meta Model API key",
    demo: "Shows the approval gate: every escalation waits for Approve or Deny, and the ledger keeps no content.",
  },
];

export function recipeBySlug(slug: string): Recipe | null {
  return RECIPES.find((r) => r.slug === slug) ?? null;
}

/** Recipes that have every capability in `caps` and match the search words in their title, summary or harness. */
export function filterRecipes(caps: readonly Capability[], query: string, harness: string | null): Recipe[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return RECIPES.filter((r) => {
    if (caps.some((c) => !r.capabilities.includes(c))) return false;
    if (harness && !r.harness.toLowerCase().includes(harness.toLowerCase())) return false;
    const hay = `${r.title} ${r.summary} ${r.harness} ${r.demo}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The harness families to filter by, in the order the page's recipes use them. */
export const HARNESSES = ["OpenCode", "OpenClaw", "Hermes", "metacua", "Python"] as const;

/** The JSON Schema the "which recipe fits" call answers with: up to three picks from the real slugs. */
export function pickSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["picks", "first_step"],
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slug", "why"],
          properties: { slug: { type: "string", enum: RECIPES.map((r) => r.slug) }, why: { type: "string" } },
        },
      },
      first_step: { type: "string" },
    },
  };
}

/** The instructions for that call: the catalog, one line per recipe. */
export function pickInstructions(): string {
  return [
    "You help a developer choose a recipe from Meta's Model API cookbook (use cases section).",
    "Pick the one to three recipes that fit their project best, best first, and say why in one sentence each, citing what the recipe actually does.",
    "Then give one concrete first step from the best recipe. Only pick from this list:",
    ...RECIPES.map((r) => `- ${r.slug}: ${r.title}. ${r.summary} Harness: ${r.harness}. Needs: ${r.needs}.`),
  ].join("\n");
}

import type { CapId } from "@/lib/caps/ids";
import { env } from "@/lib/env";
import generated from "@/lib/recipes/generated.json";

/**
 * Recipes (docs/RECIPES.md): skills the platform writes into a product at provision, so a build can use a pattern from
 * Meta's cookbook, or make a long-running case agent, with no new builder snapshot. Off with RECIPES_ENABLED unset, and
 * then nothing here reaches a brief, a prompt, a token or a sandbox.
 */

export interface Recipe {
  id: string;
  /** What the brief writer reads when choosing. */
  oneLine: string;
  /** The honest limit, repeated in the build prompt. */
  limit: string;
  /** Needs AGENT_LONG_RUNS, and gets the long run limits and its own daily budget. */
  longRun: boolean;
  /** The cap it can't work without. Offered only while that cap is served. */
  needs?: CapId;
  /** Models the recipe always calls, added to the product's tokens even if the writer left one out of capabilities. */
  models?: readonly string[];
}

export const RECIPES: readonly Recipe[] = [
  {
    id: "recipe-api",
    oneLine: "Model API patterns: the Files API for long documents, streaming, tool calling, caching, reasoning, long context, retries, and web search with footnotes.",
    limit: "Long documents are read at a practical size per call, footnotes list what a search returned, and one run stays within the product's daily budget.",
    longRun: false,
  },
  {
    id: "recipe-agent-patterns",
    oneLine: "Short agent patterns in TypeScript: validated find-and-replace edits, a triage copilot with memory on the page, side chats off a main conversation, and a downloadable repo-agent kit the person runs with their own key.",
    limit: "A run has a few turns and works on what the person brings. The product never writes to GitHub or anyone's repository.",
    longRun: false,
  },
  {
    id: "recipe-code-sessions",
    oneLine: "Coding tasks run by Muse Code from a product: fix failing tests, a staged migration, a screenshot bug fix, chained sessions, small fan-outs, an audit ledger.",
    limit: "Only the product's owner can start a session. Each has at most $1 and 15 minutes, works on small uploaded projects, and can't reach remote URLs.",
    longRun: false,
    needs: "code",
  },
  {
    id: "recipe-visual-reports",
    oneLine: "A chart explainer with its numbers checked, research into slides with sources, a polished page checked by screenshots at desktop size, and clickable points placed on a photo.",
    limit: "Numbers read from images can be wrong. It explains and never advises, and points on a photo are approximate.",
    longRun: false,
  },
  {
    id: "recipe-games",
    oneLine: "A 3D browser game with three.js, with its rules written first, built in one pass or in rounds, and tested by holding keys.",
    limit: "Simple shapes only, with no downloaded models, and one player.",
    longRun: false,
  },
  {
    id: "recipe-image",
    oneLine: "Muse Image conversations: editing a person's photo in turns, generation grounded by search, a consistent series from anchor images, and careful region edits.",
    limit: "Text inside images can come out wrong, size sets only the aspect ratio, and search-grounded images are illustrations.",
    longRun: false,
  },
  {
    id: "recipe-voice",
    oneLine: "Recorded speech with speaker labels, keywords and language hints, push-to-talk voice chess on the page, and a see-and-ask page using a phone's camera.",
    limit: "It works on recordings of at most 10 minutes or 32 MB, not a live microphone. Speaker labels are anonymous and can be wrong or missing, and it doesn't control other apps.",
    longRun: false,
  },
  {
    id: "recipe-sam-media",
    oneLine: "SAM 3.1 video patterns: masks over clips, transparent animated sticker packs, and speech bubble captions that follow each speaker, drawn in the browser.",
    limit: "Clips stay short. Stickers are one object per pack, and captions export as WebM recorded in real time, not H.264 MP4.",
    longRun: false,
  },
  {
    id: "recipe-simulated-loops",
    oneLine: "A long model loop on a labeled simulation, run in stretches from the open page: computer use on a simulated screen, fixing a bundled project, a role-based team board, a simulated robot arm, an approval gate with a ledger, staged command approvals.",
    limit: "It acts only on a simulation and does not control your computer. Closing the tab pauses a run, and the run is saved in this browser only. A run costs dollars, not cents.",
    longRun: true,
  },
  {
    id: "recipe-case-agent",
    oneLine: "A legal case agent on a new fictional dispute: it reads a file of documents, drafts a checklist, proves each item with exact page quotes, asks a person for evidence when stuck, and files a memo the person signs off, with every turn shown live. Use it for any note that names a legal case agent or meta-models/legal-agent-workshop.",
    limit: "The case is made up and this isn't legal advice. Closing the tab pauses a run, and the run is saved in this browser only. A full run costs dollars, not cents.",
    longRun: true,
    models: ["muse-wonder-1.0", "sam-3.1"],
  },
];

/** The sample note for docs/RECIPES.md and the tests: what a person types to get the case agent. */
export const CASE_AGENT_SAMPLE_NOTE =
  "Build a legal case agent like meta-models/legal-agent-workshop. It reads a fictional dispute file, drafts a checklist, proves each item with exact page quotes, asks me for evidence when it is stuck, and files a memo I sign off. Show every turn live.";

export interface RecipeFile {
  path: string;
  content: string;
}

const SKILLS = (generated as { skills: Record<string, { files: RecipeFile[] } | undefined> }).skills;

/**
 * The recipes a new brief may pick, with these caps served: none with RECIPES_ENABLED off, no long ones with
 * AGENT_LONG_RUNS off, and none whose skill isn't in generated.json yet.
 */
export function availableRecipes(caps: readonly CapId[] = env.servedCaps): Recipe[] {
  if (!env.recipesEnabled) return [];
  return RECIPES.filter((r) => SKILLS[r.id] && (!r.longRun || env.agentLongRuns) && (!r.needs || caps.includes(r.needs)));
}

/**
 * The recipes this stored brief gets now. An id no longer known or no longer available counts as never picked, so a
 * brief survives a removed recipe, and turning a flag off takes the recipe's skill, prompt lines and limits away together.
 */
export function pickedRecipes(brief: { recipes?: readonly string[] | null } | null | undefined): Recipe[] {
  if (!brief?.recipes?.length) return [];
  const available = availableRecipes();
  return available.filter((r) => brief.recipes?.includes(r.id));
}

/** True when this brief's product gets the long run limits and its own daily budget. */
export function isLongRunBrief(brief: { recipes?: readonly string[] | null } | null | undefined): boolean {
  return pickedRecipes(brief).some((r) => r.longRun);
}

/** The files a brief's recipes add to its product. */
export function recipeExtraFiles(brief: { recipes?: readonly string[] | null } | null | undefined): RecipeFile[] {
  return pickedRecipes(brief).flatMap((r) => (SKILLS[r.id]?.files ?? []).map((f) => ({ path: `.agents/skills/${r.id}/${f.path}`, content: f.content })));
}

/** What the build and change prompts say about a brief's recipes (render.ts stays pure and takes this as an option). */
export function recipeNotes(brief: { recipes?: readonly string[] | null } | null | undefined): Array<{ id: string; limit: string }> {
  return pickedRecipes(brief).map((r) => ({ id: r.id, limit: r.limit }));
}

/** The catalog's recipe block. Empty with none available, so the catalog stays as it was. */
export function recipesCatalogLines(caps: readonly CapId[]): string[] {
  const available = availableRecipes(caps);
  if (!available.length) return [];
  return ["", "Recipes, skills a build can read for a pattern the starter template doesn't have:", ...available.map((r) => `- ${r.id}: ${r.oneLine}`)];
}

/** The writer's rules for recipes. Empty with none available, so the instructions stay as they were. */
export function recipesWriterRules(caps: readonly CapId[]): string {
  const available = availableRecipes(caps);
  if (!available.length) return "";
  const lines = [
    "",
    "",
    "Recipes",
    "- recipes lists at most 3 ids from the Recipes list above, only when the note or the references need that pattern. Otherwise it is null. Most muses need none.",
    "- A repo URL or repo name in a note can't be read or cloned. Treat it as inspiration: make a fresh version with new names and new content, say so in limits in words for the product's users, and never ask to clone it or copy from it.",
    "- Agent loops are written in TypeScript, even when the note points at a Python repo.",
    "- When the original needs something a hosted product can't do, the product is a stand-in: verdict is \"partly\" and a limit names it as a stand-in in plain words for its users.",
  ];
  lines.push(
    "- Some cookbook recipes can't be products: contained execution with bubblewrap and immutable guardrails (04/04, 04/05) can't run in a hosted product, so say so in limits, and scheduled loops (04/09) need the jobs service from the catalog. MCP security tooling that probes other people's systems (04/11) is refused.",
  );
  if (available.some((r) => r.longRun)) {
    lines.push(
      `- A long recipe (${available.filter((r) => r.longRun).map((r) => r.id).join(", ")}) is the exception to one run costing cents: it has its own daily budget, and estimatedCostPerRunUsd and costNotes count its turns honestly, in dollars. complexity is "complex". Don't add the agent target for one: it writes its own loop.`,
    );
  }
  if (available.some((r) => r.id === "recipe-case-agent")) {
    lines.push(
      "- With recipe-case-agent, capabilities list muse-wonder-1.0 and sam-3.1, and fixtures include two image fixtures: one made-up name signed by hand in dark ink on plain white paper, and the same name signed in a visibly different hand. Neither shows a real name, firm or seal.",
    );
  }
  return lines.join("\n");
}

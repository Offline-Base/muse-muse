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
    oneLine: "Responses API patterns: the Files API for long documents, structured output, tool calling, long context.",
    limit: "Documents and tools stay within the gateway's limits, and one run stays within the product's daily budget.",
    longRun: false,
  },
  {
    id: "recipe-agent-patterns",
    oneLine: "Hand-written agent loops in TypeScript: tool calling, memory across turns, planner and worker splits, a reviewer step, for a few turns per run.",
    limit: "A run has at most a few turns, and closing the page ends it.",
    longRun: false,
  },
  {
    id: "recipe-code-sessions",
    oneLine: "A product that starts Muse Code sessions on behalf of its owner, through the code service.",
    limit: "Only the product's owner can start a session, and a session has its own time and dollar limits.",
    longRun: false,
    needs: "code",
  },
  {
    id: "recipe-visual-reports",
    oneLine: "A model writes a structured report and the page draws it: charts, tables, timelines, printable pages.",
    limit: "Numbers come from what the person gave. The model's reading of them can be wrong.",
    longRun: false,
  },
  {
    id: "recipe-games",
    oneLine: "A playable browser game with a model as narrator, opponent or level maker, including drawn sprites and scenes.",
    limit: "Model turns take seconds, so play is turn based or paced around them.",
    longRun: false,
  },
  {
    id: "recipe-image",
    oneLine: "Advanced Muse Image patterns: consistent characters, editing one region found with SAM, combining several images, image sets.",
    limit: "Text inside generated images can come out wrong, and size sets only the aspect ratio.",
    longRun: false,
  },
  {
    id: "recipe-voice",
    oneLine: "Transcript products: speaker labels, keywords, long recordings in pieces, meeting notes and captions from a recording.",
    limit: "It works on recorded files, not live speech, and speaker labels can be wrong.",
    longRun: false,
  },
  {
    id: "recipe-sam-media",
    oneLine: "SAM 3.1 media patterns: cutouts, stickers, animated WebP and GIF, captions and tracked effects on a video, drawn in the product's own code.",
    limit: "Outputs are made in the browser or on the server within the 4.5 MB request limit, so clips stay short.",
    longRun: false,
  },
  {
    id: "recipe-simulated-loops",
    oneLine: "A long multi-turn loop that runs in stretches from the open page, with a saved record: for work the cookbook does with background agents or long sessions, as a labeled stand-in.",
    limit: "Closing the tab pauses a run, and the run is saved in this browser only. A run costs dollars, not cents.",
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

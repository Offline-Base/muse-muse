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
  /** Needs VERIFY_AGENTS, and the agent target whose kit it builds on. */
  verifyAgents?: boolean;
}

export const RECIPES: readonly Recipe[] = [
  {
    id: "recipe-api",
    oneLine: "Model API patterns: a first chat with standing rules and history, streaming with a Stop button, tool calling with a tool log, JSON that matches a schema, prompt caching with a cache ledger, reasoning effort and its tokens, photos, long documents and the Files API, retries with a ledger, and web search with footnotes.",
    limit: "Long documents are read at a practical size per call, footnotes list what a search returned, and one run stays within the product's daily budget.",
    longRun: false,
    // Every section calls Muse Wonder, so a writer that leaves it out of capabilities doesn't ship calls that 404 (the Nov 2 fix for image, voice and SAM).
    models: ["muse-wonder-1.0"],
  },
  {
    id: "recipe-agent-patterns",
    oneLine: "Short agent patterns in TypeScript, driven from the page: an agent loop that fixes a bundled project's failing tests with the tests run in the browser, a callback-to-async migration with reasoning effort per turn, a running STATE.md across requirement changes, validated find-and-replace edits, an alert triage copilot with memory on the page, side chats off a main conversation, an approval gate before text leaves the page, and a downloadable repo-agent kit the person runs with their own key.",
    limit: "A run has at most about 15 turns on a small bundled sample or on what the person brings, and tests run in the browser in JavaScript. No model runs on the person's device, and the product never writes to GitHub or anyone's repository.",
    longRun: false,
    models: ["muse-wonder-1.0"],
  },
  {
    // No `needs: "code"` since the cookbook pass (Nov 3): without the builder-only code cap a build uses Part 2 of the skill, labeled stand-ins on the product's own agent.
    id: "recipe-code-sessions",
    oneLine: "Meta's Muse Code cookbook patterns. With the code cap, real Muse Code sessions: fix failing tests, a staged migration, a screenshot bug fix, chained sessions, small fan-outs. Without it, labeled stand-ins on the product's own agent loop: an append-only audit log with export and crash resume, a replay gate, staged command approvals on a simulated shell, protected rules files, a fan-out board, a goal that can't close early, plan and grill playbooks, and session schedules.",
    limit: "With the code cap, only the product's owner can start a session, each with at most $1 and 15 minutes on small uploaded projects and no remote URLs. Without it, the product is a labeled stand-in for Muse Code's harness on its own agent and a sample workspace in the page, and it doesn't run Muse Code.",
    longRun: false,
    models: ["muse-wonder-1.0"],
  },
  {
    id: "recipe-visual-reports",
    oneLine: "A chart explainer with its numbers checked, a bug found from a screenshot and fixed on a bundled page with the fix checked in code, research turned into a slide deck with sources that pages with the arrow keys, a polished page checked by screenshots at desktop size, and clickable points placed on a photo.",
    limit: "Numbers read from images can be wrong. It explains and never advises, points on a photo are approximate, and a screenshot fix works on one small bundled or pasted page, not a whole project.",
    longRun: false,
    models: ["muse-wonder-1.0"],
  },
  {
    id: "recipe-games",
    oneLine: "A 3D browser game with three.js, such as a kart racer on a loop or a lane-crossing arcade game, with its rules written first, built in one pass or in rounds, and tested by holding keys and by idling until the level ends.",
    limit: "Simple shapes only, with no downloaded models, and one player.",
    longRun: false,
  },
  {
    id: "recipe-image",
    oneLine: "Muse Image conversations: generate, refine and compose with reference images, generation grounded by search, a consistent series from anchor images, and tagging then updating a listing photo across turns.",
    limit: "Text inside images can come out wrong, size sets only the aspect ratio, search-grounded images are illustrations, and a series of more than four panels is the person's run, not the build's.",
    longRun: false,
    models: ["muse-image-1.0"],
  },
  {
    id: "recipe-voice",
    oneLine: "Recorded speech with speaker labels, keywords and language hints, push-to-talk voice chess on the page with Meta's exact \"Move E2 to E4\" grammar, and a see-and-ask page using a phone's camera.",
    limit: "It transcribes finished recordings of at most 10 minutes or 32 MB, not a live stream from the microphone. Speaker labels are anonymous and can be wrong or missing, and it doesn't control other apps.",
    longRun: false,
    models: ["muse-voice-transcribe-1.0"],
  },
  {
    id: "recipe-sam-media",
    oneLine: "SAM 3.1 video patterns: masks over clips, transparent animated sticker packs, and speech bubble captions that follow each speaker, drawn in the browser.",
    limit: "Clips stay short. Stickers are one object per pack, and captions export as WebM recorded in real time, not H.264 MP4.",
    longRun: false,
    // Captions put the transcriber's speaker turns on the tracked people, so both models.
    models: ["sam-3.1", "muse-voice-transcribe-1.0"],
  },
  {
    // Staged command approvals left this oneLine in the cookbook pass: recipe-code-sessions does them short, for cents.
    id: "recipe-simulated-loops",
    oneLine: "A long model loop on a labeled simulation, run in stretches from the open page: computer use on a simulated Linux desktop or Mac (Mines, tic-tac-toe, a sign-up form with an approval gate), fixing a bundled Python project in the browser, a team of role agents on a shared board, a simulated robot arm, an approval gate with a ledger.",
    limit: "It acts only on a simulation and does not control your computer. Closing the tab pauses a run, and the run is saved in this browser only. A run costs dollars, not cents.",
    longRun: true,
    models: ["muse-wonder-1.0"],
  },
  {
    id: "recipe-case-agent",
    oneLine: "A legal case agent on a new fictional dispute: it reads a file of documents, drafts a checklist, proves each item with exact page quotes, asks a person for evidence when stuck, and files a memo the person signs off, with every turn shown live. Use it for any note that names a legal case agent or meta-models/legal-agent-workshop.",
    limit: "The case is made up and this isn't legal advice. Closing the tab pauses a run, and the run is saved in this browser only. A full run costs dollars, not cents.",
    longRun: true,
    models: ["muse-wonder-1.0", "sam-3.1"],
  },
  {
    id: "recipe-verified-agent",
    oneLine: "An agent whose answer someone will act on: code checks each quote against the source it read, a separate model call reviews the claims, the answer can't finish without passing, and it stops to ask a person when evidence is missing. Not for a quick lookup, and not for web research: its checks need source text the product holds.",
    limit: "A pass means the quotes are in the sources and a model read the claims as backed by them, not that the answer is true. Web pages seen only through search can't be checked by code.",
    longRun: false,
    verifyAgents: true,
  },
  {
    id: "recipe-open-weights",
    oneLine: "Kits for Muse open weights on a person's own machines: a Mac Studio cluster setup kit for Muse Spark Open with a log doctor, an SFT data studio that checks, splits and exports TorchTitan conversations, and a reward spread check that samples groups and scores them before a GRPO run.",
    limit: "The product runs no GPU, downloads no weights, trains nothing and serves no open model: it writes and checks files the person runs on their own hardware. Hosted answers stand in for the open model.",
    longRun: false,
    models: ["muse-wonder-1.0"],
  },
];

/** The sample note for docs/RECIPES.md and the tests: what a person types to get the case agent. */
export const CASE_AGENT_SAMPLE_NOTE =
  "Build a legal case agent like meta-models/legal-agent-workshop. It reads a fictional dispute file, drafts a checklist, proves each item with exact page quotes, asks me for evidence when it is stuck, and files a memo I sign off. Show every turn live.";

type RecipeBrief = { recipes?: readonly string[] | null; targets?: ReadonlyArray<{ id: unknown }> | null } | null | undefined;

export interface RecipeFile {
  path: string;
  content: string;
}

const SKILLS = (generated as { skills: Record<string, { files: RecipeFile[] } | undefined> }).skills;

/**
 * The recipes a new brief may pick, with these caps served: none with RECIPES_ENABLED off, no long ones with
 * AGENT_LONG_RUNS off, no verified agent without VERIFY_AGENTS and AGENTS_ENABLED, and none whose skill isn't in generated.json yet.
 */
export function availableRecipes(caps: readonly CapId[] = env.servedCaps): Recipe[] {
  if (!env.recipesEnabled) return [];
  return RECIPES.filter((r) => SKILLS[r.id] && (!r.longRun || env.agentLongRuns) && (!r.needs || caps.includes(r.needs)) && (!r.verifyAgents || (env.verifyAgents && env.agentsEnabled)));
}

/**
 * The recipes this stored brief gets now. An id no longer known or no longer available counts as never picked, so a
 * brief survives a removed recipe, and turning a flag off takes the recipe's skill, prompt lines and limits away together.
 */
export function pickedRecipes(brief: RecipeBrief): Recipe[] {
  if (!brief?.recipes?.length) return [];
  const available = availableRecipes();
  // A verified agent builds on the agent kit, so code holds the writer's rule: with no agent target it counts as never picked.
  const hasAgent = brief.targets?.some((t) => t?.id === "agent") ?? false;
  return available.filter((r) => brief.recipes?.includes(r.id) && (!r.verifyAgents || hasAgent));
}

/** True when this brief's product gets the long run limits and its own daily budget. */
export function isLongRunBrief(brief: RecipeBrief): boolean {
  return pickedRecipes(brief).some((r) => r.longRun);
}

/** The files a brief's recipes add to its product. */
export function recipeExtraFiles(brief: RecipeBrief): RecipeFile[] {
  return pickedRecipes(brief).flatMap((r) => (SKILLS[r.id]?.files ?? []).map((f) => ({ path: `.agents/skills/${r.id}/${f.path}`, content: f.content })));
}

/** What the build and change prompts say about a brief's recipes (render.ts stays pure and takes this as an option). */
export function recipeNotes(brief: RecipeBrief): Array<{ id: string; limit: string }> {
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
  ];
  if (available.some((r) => r.id === "recipe-agent-patterns")) {
    lines.push(
      "- A note that asks for an agent loop that fixes failing tests, a migration in dependency order, reasoning effort per turn, a running STATE.md across changes, or an approval gate before a question goes to a cloud model (Meta's glimmer-api-agent) picks recipe-agent-patterns, not recipe-code-sessions or recipe-simulated-loops, unless the note asks for Muse Code sessions or a long simulated run. Its loops run on a sample project the product bundles, and its gate's local half is a stand-in, said in limits.",
    );
  }
  lines.push("- When the original needs something a hosted product can't do, the product is a stand-in: verdict is \"partly\" and a limit names it as a stand-in in plain words for its users.");
  lines.push(
    "- Some cookbook recipes can't be products: contained execution with bubblewrap (04/04) needs an OS sandbox on the person's own machine, so say so in limits. Muse Code's other harness patterns (04/01 to 04/03, 04/05 to 04/09) are recipe-code-sessions: without the code cap they are labeled stand-ins, so verdict is \"partly\" and a limit says it isn't Muse Code. Scheduled loops (04/09) run while the page is open, or on the jobs service when the catalog serves it. MCP security tooling that probes other people's systems (04/11) is refused.",
  );
  if (available.some((r) => r.id === "recipe-visual-reports")) {
    lines.push(
      caps.includes("code")
        ? "- A note about fixing a bug from a screenshot in a whole project picks recipe-code-sessions, which runs it in a Muse Code workspace. For one small page, recipe-visual-reports has a bundled-page stand-in."
        : "- A note about fixing a bug from a screenshot picks recipe-visual-reports (its bundled-page stand-in): the code cap isn't served, so Muse Code can't run it in a workspace.",
    );
  }
  if (available.some((r) => r.longRun)) {
    lines.push(
      `- A long recipe (${available.filter((r) => r.longRun).map((r) => r.id).join(", ")}) is the exception to one run costing cents: it has its own daily budget, and costItems count its turns honestly, in dollars. complexity is "complex". Don't add the agent target for one: it writes its own loop.`,
    );
  }
  if (available.some((r) => r.id === "recipe-sam-media")) {
    lines.push(
      "- With recipe-sam-media, unless the person gave their own clip, fixtures include one image fixture (fromUserSample false): a realistic photo of the subject the product tracks, whole and clearly in frame, like a dog standing on grass, or for speaker captions two made-up people sitting side by side facing the camera. The build turns it into the sample clip. Never a drawing, a test pattern or shapes.",
    );
  }
  if (available.some((r) => r.id === "recipe-image")) {
    lines.push(
      "- With recipe-image, unless the person gave their own photos, fixtures include the photos the flow starts from (fromUserSample false, at most 3): the space to furnish, the items laid out for a listing, or the reference objects to compose, each a realistic photo with no text or logos.",
    );
  }
  if (available.some((r) => r.id === "recipe-api")) {
    lines.push(
      "- With recipe-api and a note about caching or a long document, the text fixture is a seed under 1,000 characters that names the document's sections. The build writes the full sample into fixtures/ itself: at least about 8,000 characters for caching, 40,000 to 80,000 for a long document, many sections, each with its own made-up facts.",
    );
  }
  if (available.some((r) => r.id === "recipe-case-agent")) {
    lines.push(
      "- With recipe-case-agent, capabilities list muse-wonder-1.0 and sam-3.1, and fixtures include two image fixtures: one made-up name signed by hand in dark ink on plain white paper, and the same name signed in a visibly different hand. Neither shows a real name, firm or seal.",
    );
  }
  if (available.some((r) => r.id === "recipe-verified-agent")) {
    lines.push("- With recipe-verified-agent, targets include agent, and agent is written. Pick it only when someone will act on the answer and the product holds the source text: an upload, a paste, its own data or bundled files. Never for research on the web, even with citations and a \"couldn't confirm\" list: the agent target's deep research does that, in a few turns.");
  }
  if (available.some((r) => r.id === "recipe-open-weights")) {
    lines.push(
      "- With recipe-open-weights, for notes about running, serving, fine-tuning (SFT) or RL training Muse Spark Open or other open weights on the person's own machines (Mac Studios, mlx, TorchTitan, GRPO): verdict is \"partly\", and limits say in plain words that the product runs no GPU and trains or serves nothing itself. capabilities list muse-wonder-1.0, and muse-spark-open only when it is offered.",
    );
  }
  return lines.join("\n");
}

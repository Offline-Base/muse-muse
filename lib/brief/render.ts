import { targetLabel } from "@/lib/format";
import { buildTokenBudgetFor } from "@/lib/gateway/policy";
import { RUN_LIMITS } from "@/lib/gateway/runs";
import type { Brief, TargetId } from "@/lib/brief/schema";
import { briefTargets, isOwnerToolsOnly } from "@/lib/native/targets";
import { isToolId, PERSONAL_TOOL_IDS, toolLabel } from "@/lib/tools/ids";
// ---------- Wave 3 hooks (docs/CAPABILITIES.md, 2.6), unit 2 ----------
import { capsBuildLines, capsMarkdown, capsRefineLines } from "@/lib/caps/render";
import { trustBuildLines } from "@/lib/trust/prompt";
import type { Milestone } from "@/lib/engine/milestones";
import { engineBudgetLines, milestoneBuildLines } from "@/lib/engine/prompts";
// ---------- end Wave 3 hooks ----------
import type { JudgeVerdict, RebuildTarget, VerifySummary } from "@/lib/types";

/**
 * CONTRACT (owned by the brief agent). Pure functions that render prompts 2, 3 and 5 from docs/PROMPTS.md.
 */

const SKILLS: Record<Brief["capabilities"][number]["model"], string> = {
  "muse-spark-1.3": ".agents/skills/meta-reasoning",
  "muse-wonder-1.0": ".agents/skills/meta-reasoning",
  "muse-image-1.0": ".agents/skills/meta-image",
  "sam-3.1": ".agents/skills/meta-sam",
  "muse-voice-transcribe-1.0": ".agents/skills/meta-voice",
  "muse-glimmer": ".agents/skills/meta-glimmer",
  "muse-gadget": ".agents/skills/muse-gadget",
};

/** The skill that goes with a target. */
const TARGET_SKILLS: Record<Exclude<TargetId, "web">, string> = {
  phone: ".agents/skills/muse-native",
  desktop: ".agents/skills/muse-native",
  vr: ".agents/skills/muse-vr",
  glasses: ".agents/skills/muse-glasses",
  agent: ".agents/skills/muse-agent",
};

/** What each target asks of the build, on top of its skill. */
const TARGET_RULES: Record<Exclude<TargetId, "web">, string[]> = {
  phone: [
    "The same web product opens in the phone app and as an iPhone home screen icon, so design it for a phone first, at 390x844.",
    "Respect the safe-area insets, make every target at least 44 px, and keep popups and new windows out of the main flow.",
    "Use `lib/native/bridge.ts` for haptics, sharing, the camera and notifications. It falls back to web APIs in a browser.",
    "If you have `preview_devices` and `native_run` tools, check the product with them before you finish.",
  ],
  desktop: [
    "The same web product opens in a Mac and a Windows app window, so it must work from 900x600 up to a full 1920x1080 screen.",
    "Make the main flow work with a keyboard, and keep popups and new windows out of it.",
    "Use `lib/native/bridge.ts` for notifications. Haptics, sharing and the camera fall back to web APIs in the desktop app too.",
    "If you have `preview_devices` and `native_run` tools, check the product with them before you finish.",
  ],
  vr: [
    "The product opens from its link in Quest Browser. Collect text, photos and files on the page before entering VR. Inside VR there are buttons, hands and at most one short spoken request.",
    "The smoke test enters VR with `xr.enter(page)` from `tests/xr.ts` and saves at least one judge screenshot inside it, then the final result.",
    "Stay inside the skill's performance budget: at most 100 draw calls and 100k triangles, no post-processing, no remote assets.",
    "On a computer it runs in a simulated headset, and on a phone it shows a 3D preview. Both have to work, because that is where it gets tested.",
  ],
  glasses: [
    "The wearer sees nothing in the glasses, so every answer is one to three short sentences to be spoken, and the phone shows the photo and the answer.",
    "Build it from the parts in `components/glasses/` and `useGlasses` in `lib/glasses/client.ts`. Without the Muse Muse app it must still work with the phone's camera or a sample view.",
    "The smoke test uses the fake bridge in `tests/glasses.ts`, as the skill shows.",
  ],
  agent: [
    "One person starts each run and sees its steps and any sources as they arrive, in the parts the skill lists. Never show raw tool output.",
    "See the Agent section below for the task, the tools and the limits.",
  ],
};

const FIT_MEANING: Record<RebuildTarget["rebuild"]["fit"], string> = {
  clean: "the same demo, built on current models",
  reframe: "the goal still matters, but the method changed",
  partial: "part of it needs something outside Muse Muse",
};

/** A code fence longer than any backtick run inside the text. */
function fence(text: string, lang = "text"): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\s+$/, "")}\n${ticks}`;
}

/** Capitalized, ending with a period. */
function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return `${t[0].toUpperCase()}${t.slice(1)}${/[.!?)]$/.test(t) ? "" : "."}`;
}

function bullets(items: string[], empty = "None."): string {
  return items.length ? items.map((s) => `- ${s}`).join("\n") : empty;
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function uniqueModels(brief: Brief): Brief["capabilities"][number]["model"][] {
  return [...new Set(brief.capabilities.map((c) => c.model))];
}

/** The targets a brief adds to web. Empty for a web-only brief, which renders as it always did. */
function addedTargets(brief: Pick<Brief, "targets">): Exclude<TargetId, "web">[] {
  return briefTargets(brief).filter((t): t is Exclude<TargetId, "web"> => t !== "web");
}

/** The build prompt's "Where it runs", from the brief's targets. */
function whereItRunsLines(brief: Brief): string[] {
  const added = addedTargets(brief);
  if (!added.length) return [];
  const why = new Map((brief.targets ?? []).map((t) => [t.id, t.why]));
  const out = ["", "## Where it runs", "", "One web product, on these too. Read each skill named here before you write code."];
  for (const t of added) {
    out.push("", `### ${targetLabel(t)}`, "", `${sentence(why.get(t) ?? "The brief picked it")} Skill: \`${TARGET_SKILLS[t]}\`.`, "", bullets(TARGET_RULES[t]));
  }
  return out;
}

/** The build prompt's "Agent" section. */
function agentLines(brief: Brief): string[] {
  const agent = brief.agent;
  if (!agent || !briefTargets(brief).includes("agent")) return [];
  const live = RUN_LIMITS.liveAgent;
  const build = RUN_LIMITS.build;
  const personal = agent.tools.filter((t) => (PERSONAL_TOOL_IDS as readonly string[]).includes(t.id));
  return [
    "",
    "## Agent",
    "",
    `Task for one run: ${sentence(agent.task)}`,
    "",
    "Tools, and only these. The gateway refuses any other:",
    "",
    bullets(agent.tools.map((t) => `\`${t.id}\` (${isToolId(t.id) ? toolLabel(t.id) : "unknown tool"}): ${sentence(t.need)} Why: ${sentence(t.why)}`)),
    "",
    personal.length
      ? `Connections: only the product's owner can connect an account for ${personal.map((t) => toolLabel(t.id)).join(", ")} for now, and every visitor needs a clear message saying so. Show a connect card until it's connected.`
      : "Connections: none. Everything works for everyone who opens the product.",
    `Steps: about ${agent.stepsPerRun} model turns per run. A live run stops at ${live.turns} turns, ${live.toolCalls} built-in tool calls or $${live.usd.toFixed(2)}, so handle that stop and offer Keep going. A build's run stops at ${build.turns} turns, ${build.toolCalls} built-in tool calls or $${build.usd.toFixed(2)}.`,
    isOwnerToolsOnly(agent)
      ? "During this build, its tools return sample results and connections show a sample account. Test the structure (a finished step, a card with what it found or did on the account), never the sample's words. It has no web sources, so don't show or test source links."
      : "During this build, tools other than web search return sample results with `example.com` links and connections show a sample account. Test the structure (a finished step, a source link, the answer card), never the sample's words.",
  ];
}

function money(usd: number): string {
  return usd >= 0.1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;
}

function extensionKind(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif", "svg"].includes(ext)) return "image";
  if (["mp4", "mov"].includes(ext)) return "video";
  if (ext === "wav") return "audio";
  if (ext === "pdf") return "pdf";
  return "text";
}

/**
 * The goal Muse Code is held to on the session bridge (MSP `goal/set`, docs/MUSE_CODE_FULL.md): the build prompt's
 * "Done means", written as one objective with its test oracle, so the goal and verify observers keep the agent going
 * until each part is really done. At most 1,000 characters.
 */
export function goalObjective(brief: Pick<Brief, "name" | "slug">): string {
  const name = brief.name.replace(/\s+/g, " ").trim().slice(0, 120);
  return [
    `Build ${name} (slug ${brief.slug}) as brief.md describes, in this workspace.`,
    "The goal is complete only when all three hold:",
    "1. `npm run verify` exits 0 (run it and read its output; don't assume).",
    "2. `musemuse.json` is filled in from the brief and valid against `musemuse.schema.json`.",
    "3. `BUILD_NOTES.md` says what you built, what you took from the inspo, which Meta models it calls and where, its limits, and anything from the brief you couldn't do.",
  ].join("\n");
}

/**
 * What a run's prompt can say about the session around it (docs/MUSE_CODE_FULL.md). All off for plain `muse exec`, so
 * its prompts stay as they are. The playbook lives here, not in template/AGENTS.md: every build reads that file, flags
 * or not, and a product's sandbox keeps the copy it was built with.
 */
interface SessionNotes {
  /** The session bridge set the run's goal from Done means (goalObjective), so `get_goal` shows it. */
  goalSet?: boolean;
  /** The build's owner can send notes while the run works (docs/MUSE_CODE_FULL.md, "The owner steers"). */
  ownerNotes?: boolean;
  /**
   * How to use subagents and workflows (docs/MUSE_CODE_FULL.md, "Every capability on"): on a build, a scout and
   * isolated writers for a complex brief, fan-out checks and a reviewer at the end; on every run, the limits each child
   * keeps to.
   */
  playbook?: boolean;
}

/**
 * Which look a product follows (docs/BRAND.md). Unset is meta-ui, the template's own, and every prompt stays as it was.
 * With MUSE_APP_LOOK the product gets the muse-app overlay at provision, so the prompts name its muse-app-ui skill. A fix
 * or a change may reach a product from before the flag, so those name both and let the product's files decide.
 */
interface LookNote {
  museAppLook?: boolean;
}

/** The skill a build prompt sends Muse Code to for the look. */
function lookSkill(note: LookNote): string {
  return note.museAppLook ? "muse-app-ui" : "meta-ui";
}

/** The person's own words asking for a look, when the muse-app look is on and the brief carries one. */
export function askedLookOf(brief: Pick<Brief, "askedLook">, note: LookNote): string | null {
  const asked = note.museAppLook ? brief.askedLook?.trim() : "";
  return asked ? asked : null;
}

/**
 * The build prompt's look line. The UI guidelines (the look's skill) hold unless the person asked for a look in their
 * own words (askedLook, docs/BRAND.md "Unless the person asks"): then their colors, fonts and mood win, set through the
 * tokens, and everything else still comes from the skill.
 */
function lookLine(brief: Brief, note: LookNote): string {
  const asked = askedLookOf(brief, note);
  if (asked) {
    return [
      `The person asked for their own look: "${asked}". Follow that ask for colors, fonts and mood by changing the tokens in \`app/muse-app.css\` for light and dark, and keep everything else from the muse-app-ui skill: the screen patterns, the parts, spacing, states, readable contrast and focus rings.`,
      "Anything the ask doesn't mention stays as the skill has it. The inspo's mood shows only in the copy, the samples and any images the product makes.",
    ].join(" ");
  }
  return `${note.museAppLook ? "The look always comes from the muse-app-ui skill and its tokens in `app/muse-app.css`." : "The look always comes from the meta-ui skill, in Meta blue."} The inspo's mood shows only in the copy, the samples and any images the product makes, never as decoration, colors or fonts.`;
}

/** The fix and change prompts' look line, up to its last sentence. */
function keepLookLine(note: LookNote): string {
  return note.museAppLook
    ? "- Keep the product's current look: the tokens and parts in `app/globals.css`, with `app/muse-app.css` and `.agents/skills/muse-app-ui` when the product has them, or else `.agents/skills/meta-ui` if it exists."
    : "- Keep the product's current look: the tokens and parts in `app/globals.css`, and `.agents/skills/meta-ui` if it exists.";
}

/** The run a prompt starts: the first build, a fix round or a change to a shipped product. */
type Run = "build" | "fix" | "change";

const GOAL_LINE: Record<Run, string> = {
  build:
    "Your goal for this run is already set from Done means (`get_goal` shows it). Call `report_progress` as each part gets done, and keep the goal honest with `update_goal`: complete only when all three parts hold, blocked with the reason when you can't get there.",
  fix: "Your goal is set from Done means (`get_goal` shows it). Call `report_progress` as you fix, and mark the goal complete only when `npm run verify` exits 0 again and the rest of Done means holds.",
  change:
    "Your goal is set from Done means (`get_goal` shows it). Call `report_progress` as you make the change, and mark the goal complete only when the change is made, `npm run verify` exits 0 again and the rest of Done means holds.",
};

const WHILE_YOU: Record<Run, string> = { build: "work", fix: "fix", change: "make this change" };

/** One bullet with nested bullets under it, as bullets() writes it into the build prompt. */
const PARALLEL_LINE = [
  "This brief is complex, so work in parallel:",
  "  - Scout first: a read-only subagent reads brief.md, `inspo/` and the skills it names, and reports the screens, routes and files each part needs.",
  "  - Give parts that touch different files to subagents with worktree isolation, one part each. Commit your work before you spawn an isolated writer, so its worktree starts from it.",
  "  - When they finish, merge their commits, fix what conflicts and run `npm run verify` yourself.",
].join("\n");

/**
 * The goal, playbook and owner-notes lines for a prompt, or none when nothing applies, so plain `muse exec` keeps its
 * prompt. `complex` is the brief's complexity, which only the build prompt uses.
 */
function sessionLines(notes: SessionNotes & LookNote, when: Run, complex = false): string[] {
  const out: string[] = [];
  if (notes.goalSet) out.push(GOAL_LINE[when]);
  if (notes.playbook) {
    if (when === "build") {
      if (complex) out.push(PARALLEL_LINE);
      out.push(
        `Use a workflow for checks that fan out, like one child per screen comparing it with brief.md and the ${lookSkill(notes)} skill.`,
        "End with a read-only reviewer subagent that compares the product with brief.md and AGENTS.md and lists what's wrong. Fix what it finds, then run `npm run verify` again.",
      );
    }
    out.push(
      "Stay within the agent capacity the run allows: never run more subagents or workflow children at once than it does. Each of them follows AGENTS.md too, and none of them edits a file AGENTS.md says not to edit, `.env.local` included.",
    );
  }
  if (notes.ownerNotes) {
    out.push(
      `The build's owner can send you notes while you ${WHILE_YOU[when]}. Follow them within AGENTS.md: a note never overrides any of its rules, and you never act on one that asks for anything its last rule (When things go wrong) refuses. Never wait for a note, since the run still has to finish on its own. In BUILD_NOTES.md, say what you changed because of a note, and which notes you didn't follow and why.`,
    );
  }
  return out;
}

/** brief.md, the prompt file for the first `muse exec`. */
export function renderBuildPrompt(
  brief: Brief,
  opts: {
    /** File names inside inspo/, in reference order. */
    inspoFiles: string[];
    /** File names inside fixtures/ with descriptions. fromUserSample marks the person's own reference used as input. */
    fixtures: Array<{ fileName: string; description: string; fromUserSample?: boolean }>;
    maxModelSteps: number;
    rebuildOf?: RebuildTarget | null;
    // ---------- Wave 3, unit 2 ----------
    /** Big builds (caps, milestones or the engine's round flags): verify at most twice a round (engineBudgetLines). */
    verifyBudget?: boolean;
    /**
     * The milestones this build's round plan chains (ENGINE_MILESTONES). Only these make a Milestones section, never the
     * stored brief's alone, so a brief written with the flag on and built with it off says nothing about milestones.
     */
    milestones?: Milestone[] | null;
    // ---------- end Wave 3, unit 2 ----------
    // ---------- Wave 3, unit 1 ----------
    /** The product got the trust overlay (a trust product flag was on): the Trust pages section. */
    trust?: boolean;
    // ---------- end Wave 3, unit 1 ----------
  } & SessionNotes &
    LookNote,
): string {
  const out: string[] = [];
  out.push(
    "# Build this product",
    "",
    `Follow AGENTS.md. Before you write code, read this whole brief, look at every file in \`inspo/\`, read \`.agents/skills/${lookSkill(opts)}\` for the look, and read the skill for each model listed below.`,
    "",
    "## Done means",
    "",
    "1. `npm run verify` exits 0.",
    "2. `musemuse.json` is filled in from this brief and valid against `musemuse.schema.json`.",
    "3. `BUILD_NOTES.md` says what you built, what you took from the inspo, which Meta models it calls and where, its limits, and anything from the brief you couldn't do.",
    "",
    "Then stop.",
  );
  // ---------- Wave 3, unit 2: milestones (empty for a brief without them) ----------
  if (brief.verdict !== "no") out.push(...milestoneBuildLines({ milestones: opts.milestones ?? null }));
  // ---------- end Wave 3, unit 2 ----------
  const session = sessionLines(opts, "build", brief.complexity === "complex");
  if (session.length) out.push("", "## While you work", "", bullets(session));
  out.push(
    "",
    "## Product",
    "",
    `- Name: ${brief.name}`,
    `- Slug: \`${brief.slug}\` (use it in musemuse.json)`,
    `- Tagline: ${brief.tagline}`,
    `- For: ${brief.user}`,
    `- Complexity: ${brief.complexity}`,
  );
  if (brief.verdict === "partly") {
    out.push("- Scope: the models can make the core of this, not all of it. Build the core well and show the limits below in the UI.");
  }
  if (brief.verdict === "no") {
    out.push("", `This muse was refused. ${sentence(brief.refusal ?? "It can't be built with the listed models")} Don't build it. Write the reason in BUILD_NOTES.md and stop.`);
    return out.join("\n") + "\n";
  }

  out.push(...whereItRunsLines(brief));

  out.push(
    "",
    "## Primary flow",
    "",
    "Build this first and make it work end to end with the files in `fixtures/`. Extra screens come after that, if at all.",
    "",
    ...brief.primaryFlow.map((step, i) => `${i + 1}. ${step}`),
    "",
    `The smoke test's judge screenshots must prove the tagline ("${brief.tagline}"): each feature it or these steps name shown working at least once, and the last step's result finished on the final screen (verify skill, Screenshots for the judge).`,
  );
  if (brief.screens.length) {
    out.push("", "## Screens", "", bullets(brief.screens.map((s) => `**${s.name}**: ${s.purpose}`)));
  }

  out.push(
    "",
    "## Meta models",
    "",
    "Use only these. The gateway rejects any other model. Call them through the helpers in `lib/meta/`.",
    "",
    bullets(brief.capabilities.map((c) => `\`${c.model}\`: ${sentence(c.need)} Why: ${sentence(c.why)} Skill: \`${SKILLS[c.model]}\`.`)),
    ...agentLines(brief),
  );
  // ---------- Wave 3, unit 2: platform services, right after the agent (empty for a brief with no cap blocks) ----------
  out.push(...capsBuildLines(brief));
  // ---------- end Wave 3, unit 2 ----------
  // ---------- Wave 3, unit 1: the trust overlay's pages (empty without it) ----------
  out.push(...trustBuildLines(opts.trust));
  // ---------- end Wave 3, unit 1 ----------

  out.push(
    "",
    "## Inputs",
    "",
    bullets(brief.inputs.map((i) => `${i.kind}${i.required ? " (required)" : " (optional)"}: ${i.notes}`), "None beyond the page itself."),
    "",
    "## Outputs",
    "",
    bullets(brief.outputs.map((o) => `${o.kind}: ${o.notes}`)),
  );

  out.push(
    "",
    "## Actions",
    "",
    "Serve each one as `POST /api/actions/<name>` with JSON in and JSON out. List it in `musemuse.json` with input and output JSON schemas and an example input, and have the UI call the same route.",
    "",
    bullets(brief.actions.map((a) => `\`${a.name}\`: ${a.description}`), "None listed. Expose the primary flow's main step as one action."),
  );

  out.push(
    "",
    "## Limits",
    "",
    "Show each limit a user would run into once in the UI, next to the thing it limits, in plain words for this product's users, and list them all in `musemuse.json`.",
    "",
    bullets(brief.limits),
    "",
    "## Cost",
    "",
    `About ${money(brief.estimatedCostPerRunUsd)} per run (estimate). ${brief.costNotes}`.trim(),
    brief.agent && briefTargets(brief).includes("agent")
      ? "Put this number in `musemuse.json` as `estimatedCostPerRunUsd`. Keep all the tests to at most 3 agent runs, each with `maxTurns` 3 or 4."
      : "Put this number in `musemuse.json` as `estimatedCostPerRunUsd`, and keep the smoke test under 5 model calls.",
  );

  out.push("", "## Inspiration", "", brief.inspiration.summary);
  if (opts.inspoFiles.length) {
    out.push("", "The user's references are in `inspo/`. Here's what each one shows:");
    opts.inspoFiles.forEach((file, i) => {
      const ref = brief.inspiration.references.find((r) => r.index === i);
      out.push("", `### \`inspo/${file}\`${ref ? ` (${ref.kind})` : ""}`, "", ref?.describes ?? "Not described in the brief. Open the file and look at it.");
    });
  } else {
    out.push("", "There are no reference files. Work from this brief.");
  }
  const userSamples = opts.fixtures.filter((f) => f.fromUserSample);
  out.push(
    "",
    "Take from them:",
    "",
    bullets(brief.inspiration.borrow),
    "",
    lookLine(brief, opts),
    "",
    "Leave out:",
    "",
    bullets([
      ...brief.inspiration.dontCopy,
      "Always: names, logos, characters, copyrighted text, artwork and photos from the inspo, and the exact look of a real product (AGENTS.md).",
      ...(userSamples.length
        ? [
            `Except the person's own samples in \`fixtures/\` (${userSamples.map((f) => `\`fixtures/${f.fileName}\``).join(", ")}). They are test inputs: the smoke test feeds them in, and the result screen may show them as the input or inside the result. Never use them as decoration.`,
          ]
        : []),
    ]),
  );

  const rebuild = opts.rebuildOf;
  if (rebuild) {
    out.push(
      "",
      "## Rebuild of one of Meta's videos",
      "",
      `This product rebuilds "${rebuild.title}" (${rebuild.url}), a ${rebuild.era}-era video that demonstrates: ${rebuild.demonstrates}.`,
      "",
      `- Fit: ${rebuild.rebuild.fit}, meaning ${FIT_MEANING[rebuild.rebuild.fit]}. The fit and the plan are for you, not for the UI.`,
      `- Plan: ${rebuild.rebuild.plan}`,
      "- The product stands on its own. Never write \"rebuild\", the fit, the plan, the video's title, or what you left out or didn't copy anywhere in the UI. Say what it can't do as plain limits for its users.",
      `- Credit the video once, with the footer's credit line: \`<Footer credit="${rebuild.url}" />\` in app/layout.tsx. Never embed, download or copy it, and don't use Meta's or Llama's names or logos in the product's look.`,
    );
  }

  out.push("", "## Sample files", "");
  if (opts.fixtures.length) {
    out.push(
      "These are in `fixtures/`. The smoke test must use them.",
      "",
      bullets(opts.fixtures.map((f) => `\`fixtures/${f.fileName}\`${f.fromUserSample ? " (the person's own sample)" : ""}: ${f.description}`)),
    );
  } else {
    out.push("None were prepared.");
  }
  const preparedKinds = new Set(opts.fixtures.map((f) => extensionKind(f.fileName)));
  const toMake = brief.fixtures.filter((f) => !preparedKinds.has(f.kind));
  if (toMake.length) {
    out.push(
      "",
      "Make these yourself, small, in `fixtures/` (AGENTS.md), and use them in the smoke test:",
      "",
      bullets(toMake.map((f) => `${f.kind}: ${f.description}`)),
    );
  }

  const models = uniqueModels(brief);
  out.push(
    "",
    "## Budget",
    "",
    `Stay under ${opts.maxModelSteps} steps. If an approach fails twice, pick a simpler one and write the limit in BUILD_NOTES.md.`,
    models.includes("muse-wonder-1.0")
      ? "Muse Wonder is in preview and bills its reasoning as output, so even a short answer spends a few hundred output tokens."
      : "",
    `The product's model calls during this build, every verify, fix round and the demo recording, share one $${buildTokenBudgetFor(models).toFixed(2)} Meta budget, and the gateway reserves each call's max_output_tokens up front. Keep those caps close to what an answer needs. If the gateway says the budget is used up, it stays used up for this build: never wait for it, retry it or schedule anything, since nothing runs after your session ends. Make the calls cheaper or stop and say so in BUILD_NOTES.md.`,
  );
  // ---------- Wave 3, unit 2: big-build budget lines (empty unless verifyBudget) ----------
  out.push(...engineBudgetLines(opts.verifyBudget === true));
  // ---------- end Wave 3, unit 2 ----------
  return out.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n").trim() + "\n";
}

const STEP_LABELS: Record<string, string> = {
  typecheck: "Typecheck (`tsc --noEmit`)",
  build: "Build (`next build`)",
  start: "Start (the built app on port 3100, `/` must return 200)",
  console: "Console (no errors in the browser console on `/`)",
  smoke: "Smoke test (`tests/smoke.spec.ts`)",
  // ---------- Wave 3, unit 2: platform services' fixed checks (only products with musemuse.caps.json have this step) ----------
  caps: "Platform services (`scripts/caps-check.mjs`: what the smoke test recorded with `tests/caps` and what the gateway saw)",
  // ---------- end Wave 3, unit 2 ----------
  manifest: "Manifest (`musemuse.json` against `musemuse.schema.json`)",
};

/** fix.md for a fix round, run with --session-id so Muse Code keeps its context. */
export function renderFixPrompt(
  input: {
    verify: VerifySummary | null;
    judge: JudgeVerdict | null;
    round: number;
    /** The judge's screenshots as attached to this run with --image, as paths in the product, in order. */
    screenshots?: string[];
  } & SessionNotes &
    LookNote,
): string {
  const { verify, judge, round } = input;
  const screenshots = input.screenshots ?? [];
  const verifyFailed = verify !== null && !verify.passed;
  const judgeFailed = judge !== null && !judge.pass;
  const what = [verifyFailed ? "`npm run verify` failed" : "", judgeFailed ? "the screenshot judge failed the product" : ""]
    .filter(Boolean)
    .join(", and ");

  const out: string[] = [
    `# Fix round ${round}`,
    "",
    `${what ? what[0].toUpperCase() + what.slice(1) : "The checks failed"}. Fix the cause in the product code.`,
    "",
    "- Don't delete, skip, weaken or loosen tests to make them pass, and don't mock or stub Meta calls. Fix the product instead.",
    "- If a model call fails, check the request against the skill for that model before changing anything else.",
    "- Keep the primary flow from brief.md working, and keep the footer.",
    `${keepLookLine(input)} Fix what the judge saw with those, not with new colors, fonts or styles.`,
    "- When you're done, run `npm run verify` again until it exits 0, and update BUILD_NOTES.md.",
    ...sessionLines(input, "fix").map((line) => `- ${line}`),
  ];

  if (verify) {
    const failing = verify.steps.filter((s) => !s.ok);
    out.push("", "## Verify steps", "");
    if (verify.steps.length) {
      out.push(
        bullets(
          verify.steps.map((s) => {
            const label = STEP_LABELS[s.name] ?? s.name;
            const time = typeof s.ms === "number" ? ` (${(s.ms / 1000).toFixed(1)} s)` : "";
            const detail = !s.ok && s.detail ? `: ${s.detail.replace(/\s+/g, " ").slice(0, 300)}` : "";
            return `${s.ok ? "passed" : "FAILED"}: ${label}${time}${detail}`;
          }),
        ),
      );
    } else {
      out.push(verify.passed ? "All passed." : "No step results were reported. The output below is all there is.");
    }
    if (failing.length > 1) {
      out.push("", "Later failures often follow from the first one, so fix the first one first.");
    }
    if (verify.failureOutput.trim()) {
      out.push("", "## Output (trimmed to the failing parts)", "", fence(verify.failureOutput));
    }
  }

  if (judge && (judgeFailed || judge.mismatches.length)) {
    out.push(
      "",
      judgeFailed ? "## Judge notes (it failed the screenshots)" : "## Judge notes (it passed, with these mismatches)",
      "",
      "The judge looked at the screenshots your smoke test saved in `test-results/judge/` and compared them with brief.md and inspo/.",
    );
    if (screenshots.length) {
      const which = screenshots.length === 1 ? "screenshot it judged is" : `${screenshots.length} screenshots it judged are`;
      const files = screenshots.map((s) => `\`${s}\``).join(", ");
      out.push(
        "",
        `The ${which} attached to this message as images, in order: ${files}. They are copies for you to look at. Don't move them into the product, link to them or commit them.`,
      );
    }
    if (judge.reasons.length) out.push("", "Reasons:", "", bullets(judge.reasons));
    if (judge.mismatches.length) out.push("", "Mismatches with the brief:", "", bullets(judge.mismatches));
    out.push(
      "",
      "Change the product so the screens show what the brief promises. The last screenshot must show the finished result, with no error, invalid field, spinner or empty state anywhere on it. Keep saving 2 to 4 numbered screenshots as the verify skill says.",
    );
  }
  return out.join("\n") + "\n";
}

/** A change keeps the product working everywhere it runs, which the session may no longer have in mind. */
function refineTargetLines(brief: Pick<Brief, "targets"> | null | undefined): string[] {
  const added = brief ? addedTargets(brief) : [];
  if (!added.length) return [];
  const skills = [...new Set(added.map((t) => TARGET_SKILLS[t]))].map((s) => `\`${s}\``).join(", ");
  return [`- This product also runs on: ${added.map(targetLabel).join(", ")}. Keep it working there, and follow ${skills}.`];
}

/**
 * The prompt for a user's follow-up change to a shipped product. Its sandbox keeps the AGENTS.md it was built with, so
 * the session lines come with every change, whatever that copy says.
 */
export function renderRefinePrompt(
  input: {
    message: string;
    newReferences: Array<{ fileName: string; describes: string }>;
    /** The product's brief, for where it runs and its platform services. Left out for a brief with none, whose prompt stays as it was. */
    brief?: Brief | null;
  } & SessionNotes &
    LookNote,
): string {
  const out: string[] = ["# Change request", "", "The user asked for this change to the live product:", "", quote(input.message)];
  if (input.newReferences.length) {
    out.push(
      "",
      "New inspiration is in `inspo/`. Use it under the same rules as before (AGENTS.md, Using the inspo):",
      "",
      bullets(input.newReferences.map((r) => `\`inspo/${r.fileName}\`: ${r.describes}`)),
    );
  }
  out.push(
    "",
    "## What to do",
    "",
    "- Make the change and keep the primary flow working.",
    `${keepLookLine(input)} Don't restyle what the request doesn't change.`,
    ...refineTargetLines(input.brief),
    // ---------- Wave 3, unit 2: platform services' change lines, bullets (none for a product with no cap blocks) ----------
    ...(input.brief ? capsRefineLines(input.brief) : []),
    // ---------- end Wave 3, unit 2 ----------
    "- Use only the models the product already lists in `musemuse.json`. The gateway rejects others.",
    "- Update `musemuse.json` if actions, limits or cost changed.",
    "- If the flow changed, update `tests/smoke.spec.ts` to cover it and its judge screenshots. Never weaken or skip a test.",
    "- If the request is something AGENTS.md says not to build, change nothing. Write the reason in BUILD_NOTES.md and stop.",
    "- If no listed model can do part of it, build the closest useful version, say so in the UI, and write the limit in BUILD_NOTES.md.",
    "- Add a short entry to BUILD_NOTES.md, then run `npm run verify` until it exits 0.",
    ...sessionLines(input, "change").map((line) => `- ${line}`),
  );
  return out.join("\n") + "\n";
}

/** The brief as readable markdown for the product page's "what it was asked to make". */
export function briefToMarkdown(brief: Brief): string {
  const verdict = { yes: "Can be made", partly: "Can be made, with limits", no: "Refused" }[brief.verdict];
  const out: string[] = [`# ${brief.name}`, "", brief.tagline, "", `**For:** ${brief.user}`, "", `**Verdict:** ${verdict}`];
  if (brief.verdict === "no" && brief.refusal) out.push("", quote(brief.refusal));

  out.push("", "## Inspiration", "", brief.inspiration.summary);
  if (brief.inspiration.references.length) {
    out.push("", ...brief.inspiration.references.map((r) => `- **Reference ${r.index + 1}** (${r.kind}): ${r.describes}`));
  }
  if (brief.inspiration.borrow.length) out.push("", "**Takes from it:**", "", bullets(brief.inspiration.borrow));
  if (brief.inspiration.dontCopy.length) out.push("", "**Leaves out:**", "", bullets(brief.inspiration.dontCopy));
  if (brief.askedLook?.trim()) out.push("", `**The look they asked for:** ${brief.askedLook.trim()}`);
  if (brief.verdict === "no") return out.join("\n") + "\n";

  const samples = brief.fixtures.filter((f) => f.fromUserSample);
  if (samples.length) {
    out.push(
      "",
      "**Test inputs:**",
      "",
      bullets(
        samples.map((f) => {
          const which = typeof f.referenceIndex === "number" ? `Reference ${f.referenceIndex + 1}, the person's own ${f.kind}` : `The person's own ${f.kind}`;
          return `${which}: ${f.description}`;
        }),
      ),
      "",
      "The test feeds these to the product. Showing them as the input or inside the result is expected.",
    );
  }

  out.push("", "## How it works", "", ...brief.primaryFlow.map((s, i) => `${i + 1}. ${s}`));
  if (brief.screens.length) out.push("", "## Screens", "", bullets(brief.screens.map((s) => `**${s.name}**: ${s.purpose}`)));

  const added = addedTargets(brief);
  if (added.length) {
    const why = new Map((brief.targets ?? []).map((t) => [t.id, t.why]));
    out.push("", "## Where it runs", "", bullets(["web", ...added].map((t) => `**${targetLabel(t as TargetId)}**: ${why.get(t as TargetId) ?? "Every product runs on the web."}`)));
  }
  if (brief.agent && added.includes("agent")) {
    out.push(
      "",
      "## Agent",
      "",
      brief.agent.task,
      "",
      bullets(brief.agent.tools.map((t) => `**${toolLabel(t.id)}**: ${t.need}`)),
    );
  }
  // ---------- Wave 3, unit 2: platform services, after the Agent section (empty for a brief with no cap blocks) ----------
  out.push(...capsMarkdown(brief));
  // ---------- end Wave 3, unit 2 ----------

  out.push(
    "",
    "## Meta models",
    "",
    "| Need | Model | Why |",
    "| --- | --- | --- |",
    ...brief.capabilities.map((c) => `| ${cell(c.need)} | \`${c.model}\` | ${cell(c.why)} |`),
  );
  if (brief.inputs.length) {
    out.push("", "## Inputs", "", bullets(brief.inputs.map((i) => `**${i.kind}**${i.required ? "" : " (optional)"}: ${i.notes}`)));
  }
  if (brief.outputs.length) out.push("", "## Outputs", "", bullets(brief.outputs.map((o) => `**${o.kind}**: ${o.notes}`)));
  if (brief.actions.length) out.push("", "## Actions", "", bullets(brief.actions.map((a) => `\`${a.name}\`: ${a.description}`)));
  out.push(
    "",
    "## Limits",
    "",
    bullets(brief.limits),
    "",
    "## Cost",
    "",
    `About ${money(brief.estimatedCostPerRunUsd)} per run (estimate). ${brief.costNotes}`.trim(),
    "",
    `Complexity: ${brief.complexity}.`,
  );
  return out.join("\n") + "\n";
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

import { targetLabel } from "@/lib/format";
import { buildTokenBudgetFor } from "@/lib/gateway/policy";
import { RUN_LIMITS } from "@/lib/gateway/runs";
import { costSentence } from "@/lib/brief/cost";
import type { Brief, TargetId } from "@/lib/brief/schema";
import { NOTE_REPLY_PREFIX } from "@/lib/pipeline/control";
import { briefTargets, isOwnerToolsOnly } from "@/lib/native/targets";
import { isToolId, PERSONAL_TOOL_IDS, toolLabel } from "@/lib/tools/ids";
// ---------- Wave 3 hooks (docs/CAPABILITIES.md, 2.6), unit 2 ----------
import { capsBuildLines, capsMarkdown, capsRefineLines } from "@/lib/caps/render";
import { trustBuildLines } from "@/lib/trust/prompt";
import type { Milestone } from "@/lib/engine/milestones";
import { engineBudgetLines, milestoneBuildLines } from "@/lib/engine/prompts";
import { jobsBlock } from "@/lib/caps/jobs/brief";
import { JOBS_BUDGET_LINE } from "@/lib/caps/jobs/render";
// ---------- end Wave 3 hooks ----------
import { CHAIN_BUILD_LINES } from "@/lib/chain/plan";
import { FULL_COST_LINE, FULL_DONE_LINE, FULL_FIX_SHOTS, FULL_FLOW_LINE, FULL_GOAL_LINE, FULL_SCOPE_LINE, fullBuildLines } from "@/lib/full/prompts";
import { briefRequirements, fullMilestones } from "@/lib/full/requirements";
import { TARGET_CHECK_HOW, targetCheckedRequirements } from "@/lib/full/target-checks";
import { fastAgentLines } from "@/lib/fast/fast";
import { RANGE_AGENT_LINES, RANGE_AGENTS_NOTES, RANGE_COST_LINE, RANGE_DEPTH_LINES, RANGE_FIX_AGENT_LINE, RANGE_FIX_LOOK, RANGE_FIX_SHOTS, RANGE_FLOW_LINE, RANGE_LOOK_LINE, RANGE_READ_FIRST, RANGE_SHOTS_LINE, RANGE_SIMPLER_LINE, rangeDirectionLines } from "@/lib/range/prompts";
import type { JudgeVerdict, RebuildTarget, VerifySummary } from "@/lib/types";
import { CONTRIBUTOR_PRODUCT_LINE } from "@/lib/meta/spark";
import { contributorBuildsOn, env } from "@/lib/env";

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
  "jetson-fleet": ".agents/skills/jetson-fleet",
  "muse-spark-open": ".agents/skills/meta-spark-open",
};

/** The skill that goes with a target. */
const TARGET_SKILLS: Record<Exclude<TargetId, "web">, string> = {
  phone: ".agents/skills/muse-native",
  desktop: ".agents/skills/muse-native",
  vr: ".agents/skills/muse-vr",
  glasses: ".agents/skills/muse-glasses",
  agent: ".agents/skills/muse-agent",
  edge: ".agents/skills/muse-edge",
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
    "When the wearer asks a question, send the recording to `muse-voice-transcribe-1.0` with `transcribeFile` and answer what it says. Never drop the recording for a typed question.",
    "The spoken answer and the phone's card use the same prices, counts and names as the text the product read from the photo. Build both from one parsed result, never from two model answers.",
  ],
  agent: [
    "One person starts each run and sees its steps and any sources as they arrive, in the parts the skill lists. Never show raw tool output.",
    "See the Agent section below for the task, the tools and the limits.",
  ],
  edge: [
    "Ask for the product's main answer through `respondJsonOrEdge` in `lib/meta/edge.ts`, with a small flat schema, and show its `label` next to every answer, word for word.",
    "When both sides are down, show its `message` on the page and keep the person's input. Never log an expected fallback with console.error.",
    "Write `edge-drill.json` naming that route and a simulated body. After verify, the build runs four simulated outage drills against it (cloud refused, cloud hung, both down, a tampered reply), and a failed drill fails the checks.",
    "Label invented data \"Simulated\". Never say the product works offline, and never call a board answer private or on-device.",
    "A screen, tab or section named for the board, a board preview, a backup or offline mode shows only an answer labeled from a board, or says plainly that no board is connected. Never put a cloud answer under it.",
  ],
};

/** The edge rules a brief that looks with SAM 3.1 adds, so the build calls the board's SAM and drills it. */
const EDGE_SAM_RULES = [
  "This product looks at photos, so every SAM 3.1 call goes through `segmentOrEdge` in `lib/meta/edge.ts`, never the meta-sam skill's cloud call. It asks the cloud's `sam-3.1` first and Meta SAM 3.1 on the board at `EDGE_SAM_URL` second. Show its `label` word for word next to every result, and its `message` on the page when it can't see.",
  "Send the photo from a route handler as a JPEG data URL from `resizeImage` (`maxSide` 1024) and `blobToDataUrl`, with one short noun phrase per call. Draw its `objects` boxes, fractions of the photo, over the photo, and say the count in words. Offer a photo picker, and a camera button when the brief asks for one.",
  "Add `\"sam\": { \"path\": \"<that route>\", \"body\": { ..., \"photo\": \"SIMULATED_PHOTO\" } }` to `edge-drill.json`; the drill puts a small simulated photo in place of `SIMULATED_PHOTO`. The build then runs four more simulated drills against that route (cloud refused, cloud hung, both down, a tampered board reply), and a failed one fails the checks. If the product's main answer is the look itself, `edge-drill.json` needs only `sam`.",
];

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

/**
 * The targets a brief adds to web. Empty for a web-only brief, which renders as it always did. Edge counts only while
 * EDGE_ENABLED is on (isEdgeBuild): a stored or imported brief that lists it gets no edge files without the flags, so
 * nothing here may name its skill or ask for its drill.
 */
function addedTargets(brief: Pick<Brief, "targets">): Exclude<TargetId, "web">[] {
  return briefTargets(brief).filter((t): t is Exclude<TargetId, "web"> => t !== "web" && (t !== "edge" || env.edgeEnabled));
}

/** The build prompt's "Where it runs", from the brief's targets. */
function whereItRunsLines(brief: Brief): string[] {
  const added = addedTargets(brief);
  if (!added.length) return [];
  const why = new Map((brief.targets ?? []).map((t) => [t.id, t.why]));
  const out = ["", "## Where it runs", "", "One web product, on these too. Read each skill named here before you write code."];
  for (const t of added) {
    const rules = t === "edge" && uniqueModels(brief).includes("sam-3.1") ? [...TARGET_RULES.edge, ...EDGE_SAM_RULES] : TARGET_RULES[t];
    out.push("", `### ${targetLabel(t)}`, "", `${sentence(why.get(t) ?? "The brief picked it")} Skill: \`${TARGET_SKILLS[t]}\`.`, "", bullets(rules));
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
export function goalObjective(brief: Pick<Brief, "name" | "slug">, opts: { fullBuild?: boolean; requiredAgents?: boolean } = {}): string {
  const name = brief.name.replace(/\s+/g, " ").trim().slice(0, 120);
  return [
    `Build ${name} (slug ${brief.slug}) as brief.md describes, in this workspace.`,
    `The goal is complete only when all ${opts.fullBuild ? "four" : "three"} hold:`,
    "1. `npm run verify` exits 0 (run it and read its output; don't assume).",
    "2. `musemuse.json` is filled in from the brief and valid against `musemuse.schema.json`.",
    `3. \`BUILD_NOTES.md\` says what you built, what you took from the inspo, which Meta models it calls and where, its limits, and anything from the brief you couldn't do${opts.requiredAgents ? RANGE_AGENTS_NOTES : ""}.`,
    ...(opts.fullBuild ? [FULL_GOAL_LINE] : []),
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
  /** STEER_CHAT: the owner reads the reply to a note in the feed, on a line that starts with NOTE_REPLY_PREFIX. */
  noteReplies?: boolean;
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
  /** BUILD_RANGE (docs/BUILD_RANGE.md): the brief's direction drives the look, and a complex build must use its agents. */
  buildRange?: boolean;
  /**
   * META_UI_ONLY (owner, Nov 3): every new product on meta-ui. BUILD_RANGE keeps its depth, agents and limits on any brief,
   * but its direction never sets the look, and a fix or change keeps the look the product's own files have.
   */
  metaUiOnly?: boolean;
  /** FAST_BUILDS on a complex build: the run's agent capacity, for How you must work. */
  fastCapacity?: number;
}

/**
 * Whether BUILD_RANGE's depth, agents and limits reach this prompt: the flag on, a brief that isn't refused, and its
 * direction. With META_UI_ONLY no new brief has a direction, so any brief.
 */
function rangeOn(brief: Brief, note: LookNote): boolean {
  return note.buildRange === true && brief.verdict !== "no" && (note.metaUiOnly === true || brief.direction != null);
}

/** The direction this prompt follows for the look: BUILD_RANGE on, a brief that has one and isn't refused, never with META_UI_ONLY. */
function rangeDirection(brief: Brief, note: LookNote): NonNullable<Brief["direction"]> | null {
  return rangeOn(brief, note) && !note.metaUiOnly ? (brief.direction ?? null) : null;
}

/** What RANGE_AGENT_LINES' per-screen workflow compares each screen with, when the brief has a Design direction. */
const RANGE_AGENT_DIRECTION = "brief.md and the Design direction";

/**
 * RANGE_AGENT_LINES for a brief with no Design direction (META_UI_ONLY): the per-screen workflow compares each screen with
 * brief.md and the look's skill instead of a section brief.md doesn't have.
 */
function rangeAgentLinesFor(skill: string): string[] {
  if (RANGE_AGENT_LINES.filter((l) => l.includes(RANGE_AGENT_DIRECTION)).length !== 1) throw new Error("RANGE_AGENT_LINES changed: update rangeAgentLinesFor in lib/brief/render.ts.");
  return RANGE_AGENT_LINES.map((l) => l.replace(RANGE_AGENT_DIRECTION, `brief.md and the ${skill} skill`));
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
  // META_UI_ONLY: a product from before it may have the muse-app look, so its own files decide, as with MUSE_APP_LOOK.
  return note.museAppLook || note.metaUiOnly
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
function sessionLines(notes: SessionNotes & LookNote, when: Run, complex = false, requiredAgents = false): string[] {
  const out: string[] = [];
  if (notes.goalSet) out.push(GOAL_LINE[when]);
  if (notes.playbook) {
    // BUILD_RANGE's How you must work holds these as required steps on a complex build.
    if (when === "build" && !requiredAgents) {
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
    if (notes.noteReplies) {
      out.push(
        `A note outranks brief.md on the name, words, look, screens and features, so a note that differs from the brief is a change to make, not a reason to refuse. It never adds spend or time, and your limits stay as they are. Answer each one on a line that starts with "${NOTE_REPLY_PREFIX}" before your next tool call: what you'll do, or plainly that you can't, or can do only part of it. Repeat one such line per note, each on its own line, in your last message, saying what you ended up doing. If you run out of time before finishing a note, say so in your last message.`,
      );
    }
  }
  return out;
}

/**
 * The smoke test walks the sample path as a person would. Audit, Nov 3: "Try the sample" filled the box but didn't
 * save it, so the next button opened an empty state, and the tests only covered pressing Save first.
 */
export const SAMPLE_PATH_LINE =
  "When the product offers a sample (a Try the sample button, sample photos), the smoke test also walks that path exactly as a person would: load the sample, then press each next button the page offers, in order, with no extra clicks such as Save in between, and expect a non-empty result. If that path lands on an empty state, fix the product, not the test: loading the sample leaves it ready for the next button.";

/**
 * Every shipped sample shows the brief's hard parts, and every counter it names really moves. Audit, Nov 3: a "long"
 * policy of 349 characters, so "from cache" stayed 0; a "noisy" feed of 9 clean alerts; a chart with no printed total.
 */
export const SAMPLE_LINES = [
  'Every sample the product ships, in `fixtures/` and behind any sample button, must exercise every requirement and every word in this brief that says what the input is like. A "long" policy is several thousand characters across many sections. A "noisy" feed has one entry per line, with repeats, junk lines and out-of-order times among the real ones. A totals check needs a printed total that doesn\'t match its rows. "Several speakers" means at least three named voices. Repeats, junk and a wrong total that the brief asks for are the sample doing its job, not the bad sample data AGENTS.md warns about. If a sample here is shorter or cleaner than that, make a fuller one in `fixtures/` yourself and ship it as the product\'s sample too. When exact numbers matter, as on a chart, draw the sample in code, such as an SVG rendered to PNG with Playwright, rather than asking for a picture.',
  "A counter or meter the brief names (cached tokens, tokens used, a totals check) must show a value the sample really produces, and a test asserts it: the cached tokens on a second call with the same long text, a totals check that finds the mismatch. Put the long, stable text first in the prompt and the question last, so a repeat call can hit the cache. If a value still stays at 0, say so on screen next to it and in BUILD_NOTES.md. A counter stuck at 0, or a check with nothing to check, proves nothing.",
];

/** Overlays line up with what they mark. Audit, Nov 3: boxes in 0 to 1000 units were divided by 10 again and drawn in a corner. */
export const OVERLAY_LINE =
  "Overlays: convert the model's coordinates (0 to 1000, or fractions of the photo) to the drawn image's size in one helper, and use it for every dot, box and mask. The smoke test asserts that each box sits inside the photo, within a few pixels, and lines up with its own dot or label (the dot inside the box, the label touching it), from their `boundingBox()`.";

/** How to analyze a chart or a table. Audit, Nov 3: "biggest mover" compared South Q1 with North Q3, as if bar order were time. */
export const CHART_ANALYSIS_LINES = [
  "Identify the series and the categories first: what each color, group or line is, and what the labels along the axis are. Have the model return them before any comparison.",
  "Compare values only within one series. North from Q1 to Q4 is a change. South Q1 against North Q3 is not, and two series at the same category are a comparison, never a move.",
  "Treat category order as time only when the axis says it is time (dates, months, quarters, years). Otherwise there is no trend, only ranks and gaps.",
  "Work out sums, totals, differences and the biggest mover in code from the table, and give the model those numbers to explain.",
];

const CHART_WORDS = /\b(?:charts?|graphs?|spreadsheets?|csv|tables?|bars|axis|axes)\b/i;
const ANALYSIS_WORDS = /\b(?:reads?|explains?|analy[sz]es?|analysis|compares?|summar\w*|trends?|movers?|changed?|changes|insights?)\b/i;

/** A brief whose product reads or explains a chart or a table: one of its own lines says both. */
export function analysesCharts(brief: Pick<Brief, "tagline" | "primaryFlow" | "inputs" | "outputs" | "capabilities"> & Partial<Pick<Brief, "requirements">>): boolean {
  const lines = [brief.tagline, ...brief.primaryFlow, ...brief.inputs.map((i) => i.notes), ...brief.outputs.map((o) => o.notes), ...brief.capabilities.map((c) => c.need), ...briefRequirements(brief).map((r) => r.text)];
  return lines.some((l) => CHART_WORDS.test(l) && ANALYSIS_WORDS.test(l));
}

/**
 * Follow-up actions keep their context. Audit, Nov 3: a redirect sent only the agent and the note, with no idea or
 * board, and came back with a card about another product.
 */
export const FOLLOW_UP_LINE =
  "Follow-up actions (redirect a run, resume it, explain or redo one item) send the run id or the record they act on, and the route reads the rest from it: the idea, the board, the item and what came before. Never send only the new note, or the output drifts off topic. The smoke test checks that a follow-up's output is about the same thing as the run it came from.";

/** What the model returns reaches the screen. Audit, Nov 3: the model named the speakers, and the name fields stayed empty. */
export const PREFILL_LINE =
  "When a model returns a value for a field the UI lets the person fill in (speaker names, a title, tags), pre-fill that field with it, still editable. Never drop a field the model returned that the screen has a place for.";

/** The final screen comes after every gate. Audit, Nov 3: the judge saw the screen before an approval, not what the approval did. */
export const GATE_LINE =
  "When the flow reaches an approval gate or a pause (approve, answer, sign off, resume), the smoke test resolves each one as a person would, waits for what follows, and takes the final judge screenshot only after the last one. A shot of the gate itself may come before it. What happens after an approval must fit what the person asked for.";

/** A level ends without the player's help. Audit, Nov 3: a missed quota left the boat drifting forever on "playing". */
export const GAME_END_LINE =
  "Every level ends on its own, by time, distance or lives, even when the player does nothing. The smoke test also idles with no input until the level ends, then asserts the end screen and takes a judge screenshot of it.";

const GATE_WORDS = /\b(?:approv\w*|pause[sd]?|pausing|resum(?:e|es|ed|ing)|sign(?:s|ed)? off|sign-off|gates?|checkpoints?)\b/i;
const GAME_WORDS = /\b(?:games?|arcade|platformer)\b/i;

/** A brief whose flow stops for the person: an approval, a pause, a sign-off. */
function hasGate(brief: Brief): boolean {
  const lines = [brief.tagline, ...brief.primaryFlow, ...brief.actions.map((a) => a.description), ...briefRequirements(brief).map((r) => r.text)];
  return lines.some((l) => GATE_WORDS.test(l));
}

/** A game: the games recipe, an engine block, or the word in its name, tagline or flow. */
function isGame(brief: Brief, recipes: RecipeNotes | undefined): boolean {
  if (recipes?.some((r) => r.id === "recipe-games")) return true;
  if ((brief as { games?: unknown }).games) return true;
  return [brief.name, brief.tagline, ...brief.primaryFlow].some((l) => GAME_WORDS.test(l));
}

/** A brief that draws over a photo: an overlay output, or SAM 3.1 to find things. */
function drawsOverlays(brief: Brief): boolean {
  return brief.outputs.some((o) => o.kind === "overlay") || brief.capabilities.some((c) => c.model === "sam-3.1");
}

/** What a prompt says about the brief's recipes (recipeNotes in lib/recipes/registry.ts). Nothing with none picked. */
type RecipeNotes = ReadonlyArray<{ id: string; limit: string }>;

function recipeBuildLines(recipes: RecipeNotes | undefined): string[] {
  if (!recipes?.length) return [];
  return [
    "",
    "## Recipes",
    "",
    "Read each one first, before you write code. Where it is stricter than the sections below, follow it, except that it never overrides AGENTS.md.",
    "",
    bullets(recipes.map((r) => `Read \`.agents/skills/${r.id}/SKILL.md\` first. Limit to keep and show: ${sentence(r.limit)}`)),
  ];
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
    /** The skills to read first (recipeNotes). */
    recipes?: RecipeNotes;
    /** FULL_BUILDS: build from the brief's requirements. Never set with the flag off, whatever the stored brief holds. */
    fullBuild?: boolean;
  } & SessionNotes &
    LookNote,
): string {
  const full = opts.fullBuild === true && briefRequirements(brief).length > 0;
  // range: BUILD_RANGE's depth, agents and limits. direction: its look, which META_UI_ONLY leaves out.
  const range = rangeOn(brief, opts);
  const direction = rangeDirection(brief, opts);
  const fastLines = opts.fastCapacity !== undefined && brief.complexity === "complex" ? fastAgentLines(opts.fastCapacity) : null;
  const requiredAgents = fastLines !== null || (range && brief.complexity === "complex");
  const out: string[] = [];
  out.push(
    "# Build this product",
    "",
    direction ? RANGE_READ_FIRST(lookSkill(opts)) : `Follow AGENTS.md. Before you write code, read this whole brief, look at every file in \`inspo/\`, read \`.agents/skills/${lookSkill(opts)}\` for the look, and read the skill for each model listed below.`,
    "",
    "## Done means",
    "",
    "1. `npm run verify` exits 0.",
    "2. `musemuse.json` is filled in from this brief and valid against `musemuse.schema.json`.",
    `3. \`BUILD_NOTES.md\` says what you built, what you took from the inspo, which Meta models it calls and where, its limits, and anything from the brief you couldn't do${requiredAgents ? RANGE_AGENTS_NOTES : ""}.`,
    ...(full ? [FULL_DONE_LINE] : []),
    "",
    "Then stop.",
    ...(range ? RANGE_DEPTH_LINES : []),
    ...(fastLines ?? (requiredAgents ? (direction ? RANGE_AGENT_LINES : rangeAgentLinesFor(lookSkill(opts))) : [])),
  );
  if (full && brief.verdict !== "no") out.push(...fullBuildLines(briefRequirements(brief), fullMilestones(brief), targetCheckedRequirements(brief).map((c) => ({ id: c.requirement.id, how: TARGET_CHECK_HOW[c.kind] }))), ...(brief.chained === true ? CHAIN_BUILD_LINES : []));
  // ---------- Wave 3, unit 2: milestones (empty for a brief without them) ----------
  if (brief.verdict !== "no" && !full) out.push(...milestoneBuildLines({ milestones: opts.milestones ?? null }));
  // ---------- end Wave 3, unit 2 ----------
  const session = sessionLines(opts, "build", brief.complexity === "complex", requiredAgents).map((l) => (full ? l.replace("all three parts", "all four parts") : l));
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
    out.push(full ? FULL_SCOPE_LINE : "- Scope: the models can make the core of this, not all of it. Build the core well and show the limits below in the UI.");
  }
  if (brief.verdict === "no") {
    out.push("", `This muse was refused. ${sentence(brief.refusal ?? "It can't be built with the listed models")} Don't build it. Write the reason in BUILD_NOTES.md and stop.`);
    return out.join("\n") + "\n";
  }

  if (direction) out.push(...rangeDirectionLines(direction, askedLookOf(brief, opts)));
  out.push(...whereItRunsLines(brief));

  out.push(
    "",
    "## Primary flow",
    "",
    full ? FULL_FLOW_LINE : range ? RANGE_FLOW_LINE : "Build this first and make it work end to end with the files in `fixtures/`. Extra screens come after that, if at all.",
    "",
    ...brief.primaryFlow.map((step, i) => `${i + 1}. ${step}`),
    "",
    `The smoke test's judge screenshots must prove the tagline ("${brief.tagline}"): each feature it or these steps name shown working at least once, and the last step's result finished on the final screen (verify skill, Screenshots for the judge).`,
    "",
    SAMPLE_PATH_LINE,
    ...(hasGate(brief) ? ["", GATE_LINE] : []),
    ...(isGame(brief, opts.recipes) ? ["", GAME_END_LINE] : []),
    ...(drawsOverlays(brief) ? ["", OVERLAY_LINE] : []),
    ...(range && !full ? ["", RANGE_SHOTS_LINE] : []),
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
  out.push(...recipeBuildLines(opts.recipes));

  out.push(
    "",
    "## Inputs",
    "",
    bullets(brief.inputs.map((i) => `${i.kind}${i.required ? " (required)" : " (optional)"}: ${i.notes}`), "None beyond the page itself."),
    "",
    "## Outputs",
    "",
    bullets(brief.outputs.map((o) => `${o.kind}: ${o.notes}`)),
    "",
    PREFILL_LINE,
  );
  if (analysesCharts(brief)) out.push("", "## Reading charts and tables", "", bullets(CHART_ANALYSIS_LINES));

  out.push(
    "",
    "## Actions",
    "",
    "Serve each one as `POST /api/actions/<name>` with JSON in and JSON out. List it in `musemuse.json` with input and output JSON schemas and an example input, and have the UI call the same route.",
    "",
    bullets(brief.actions.map((a) => `\`${a.name}\`: ${a.description}`), "None listed. Expose the primary flow's main step as one action."),
    ...(brief.actions.length > 1 ? ["", FOLLOW_UP_LINE] : []),
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
    costSentence(brief),
    brief.agent && briefTargets(brief).includes("agent")
      ? "Put this number in `musemuse.json` as `estimatedCostPerRunUsd`. Keep all the tests to at most 3 agent runs, each with `maxTurns` 3 or 4."
      : full
        ? FULL_COST_LINE
        : range
          ? RANGE_COST_LINE
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
    direction ? RANGE_LOOK_LINE : lookLine(brief, opts),
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
      "Make these yourself in `fixtures/` (AGENTS.md), small but full enough to show what this brief asks of them, and use them in the smoke test:",
      "",
      bullets(toMake.map((f) => `${f.kind}: ${f.description}`)),
    );
  }
  out.push("", SAMPLE_LINES[0], "", SAMPLE_LINES[1]);

  const models = uniqueModels(brief);
  out.push(
    "",
    "## Budget",
    "",
    `Stay under ${opts.maxModelSteps} steps. ${range ? RANGE_SIMPLER_LINE : "If an approach fails twice, pick a simpler one and write the limit in BUILD_NOTES.md."}`,
    models.includes("muse-wonder-1.0")
      ? contributorBuildsOn() ? CONTRIBUTOR_PRODUCT_LINE : "Muse Wonder is in preview and bills its reasoning as output, so even a short answer spends a few hundred output tokens."
      : "",
    `The product's model calls during this build, every verify, fix round and the demo recording, share one $${buildTokenBudgetFor(models).toFixed(2)} Meta budget, and the gateway reserves each call's max_output_tokens up front. Keep those caps close to what an answer needs. If the gateway says the budget is used up, it stays used up for this build: ${jobsBlock(brief) ? JOBS_BUDGET_LINE : "never wait for it, retry it or schedule anything, since nothing runs after your session ends."} Make the calls cheaper or stop and say so in BUILD_NOTES.md.`,
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
  requirements: "Requirements (one passing test per requirement in `tests/requirements.spec.ts`, as `.agents/skills/full-product/SKILL.md` says)",
  // ---------- Wave 3, unit 2: platform services' fixed checks (only products with musemuse.caps.json have this step) ----------
  caps: "Platform services (`scripts/caps-check.mjs`: what the smoke test recorded with `tests/caps` and what the gateway saw)",
  // ---------- end Wave 3, unit 2 ----------
  manifest: "Manifest (`musemuse.json` against `musemuse.schema.json`)",
  // BUILD_SHARED_KEYS (docs/BUILD_KEYS.md): only a build with the owner's shared accounts has this step.
  keys: "Shared keys (no value of the owner's keys in the product's files, `public/` or `.next/static`; read them from `process.env` in server code)",
};

/** fix.md for a fix round, run with --session-id so Muse Code keeps its context. */
export function renderFixPrompt(
  input: {
    verify: VerifySummary | null;
    judge: JudgeVerdict | null;
    round: number;
    /** The judge's screenshots as attached to this run with --image, as paths in the product, in order. */
    screenshots?: string[];
    /** FULL_BUILDS: this build holds one screenshot per requirement. */
    fullBuild?: boolean;
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
    `${keepLookLine(input)} ${input.buildRange && !input.metaUiOnly ? RANGE_FIX_LOOK : "Fix what the judge saw with those, not with new colors, fonts or styles."}`,
    "- When you're done, run `npm run verify` again until it exits 0, and update BUILD_NOTES.md.",
    ...(input.buildRange ? [`- ${RANGE_FIX_AGENT_LINE}`] : []),
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
      input.fullBuild
        ? FULL_FIX_SHOTS
        : input.buildRange
          ? RANGE_FIX_SHOTS
          : "Change the product so the screens show what the brief promises. The last screenshot must show the finished result, with no error, invalid field, spinner or empty state anywhere on it. Keep saving 2 to 4 numbered screenshots as the verify skill says.",
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
    /** The skills this product was built from (recipeNotes). */
    recipes?: RecipeNotes;
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
    ...(input.recipes ?? []).map((r) => `- Follow \`.agents/skills/${r.id}/SKILL.md\` and keep its limit: ${sentence(r.limit)}`),
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
  if (brief.direction) out.push("", `**Design direction:** ${brief.direction.summary}`);
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

  const reqs = briefRequirements(brief);
  // A requirement only a target can prove says so, for the judge and the build alike (lib/full/target-checks.ts).
  const byTarget = new Set(targetCheckedRequirements(brief).map((c) => c.requirement.id));
  if (reqs.length) out.push("", "## What it must do", "", bullets(reqs.map((r) => `**${r.id}**: ${r.text}${r.canDo ? (byTarget.has(r.id) ? " (checked from the target, not from a screenshot)" : "") : ` (can't be done: ${r.cantDoWhy ?? "not possible yet"})`}`)));
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
    costSentence(brief),
    "",
    `Complexity: ${brief.complexity}.`,
  );
  return out.join("\n") + "\n";
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

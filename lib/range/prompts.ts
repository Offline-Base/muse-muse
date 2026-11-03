import type { Direction, RecentDirection } from "@/lib/range/direction";
import { RANGE_LIMITS } from "@/lib/range/direction";

/**
 * BUILD_RANGE's prompt text (docs/BUILD_RANGE.md). Pure, and only read with the flag on and a brief that has a direction,
 * so with it off every prompt is byte for byte what it was.
 */

// ---------- The brief writer ----------

export const RANGE_REFERENCE_COLORS =
  "Name each main color by its role and an approximate hex value (a dark header, about #1c2b24), since the design direction may draw on them.";

export const RANGE_BORROW_LINE =
  "- borrow lists what the product takes from the inspo: the job it does, the flow, layout ideas, the mood, the kinds of colors and type. The mood may show in colors, fonts and decoration. It never copies a real brand's logo, characters, artwork or exact look.";

export const RANGE_FLOW_LINES = [
  `- primaryFlow is the main path through the product, in as many short steps as it takes (at most ${RANGE_LIMITS.primaryFlow}), ending with the result they see.`,
  `- screens lists the screens a real product needs for this muse, each with a purpose (at most ${RANGE_LIMITS.screens}). Think past the first run: what people come back to, compare, browse, save or share. A single screen is right only when the job truly is one screen.`,
].join("\n");

export const RANGE_CAPABILITIES_LINE =
  "- capabilities: one entry per job a model does. Use every listed model that makes this product clearly better, and say why each one is needed. A product needs at least one model.";

/** The writer's own section. `start` is one of DIRECTION_STARTS, and `recent` is what other products just used. */
export function rangeWriterSection(start: string, recent: readonly RecentDirection[]): string {
  const lines = [
    "",
    "",
    "Design direction",
    "direction is this product's own look. Muse Muse products should not look alike, and a white page with hairline cards, Inter and one blue is not a default: use it only if the person asks. Choose from what the product is, who it's for and what the inspo feels like.",
    "- summary is the idea in one or two plain sentences, and why it fits this product.",
    "- scheme is light, dark or both. One fixed scheme is fine when it suits the product.",
    "- palette holds #rrggbb colors: background, surface (cards or panels), text, mutedText, accent (actions), onAccent (text on the accent) and secondary (a second color that does real work). text on background and on surface, mutedText on background, and onAccent on accent must each reach a 4.5 contrast ratio.",
    "- displayFont and bodyFont are a type pairing from npm: package is @fontsource/<name> or @fontsource-variable/<name>, family is its CSS font-family name. They may be one face when it can carry both jobs. Prefer a face with character over Inter, and use only packages you are sure exist.",
    "- density says how much fits on a screen. layout says how pages are arranged on a phone and on a wide desktop: columns, panes, boards, a full-bleed grid, sections without cards. shape covers corners, lines and shadows. motion says what moves and how. imagery says what pictures, patterns, charts or drawn shapes the product uses, made with Muse Image or drawn in code.",
    `- Start from this idea and bend it as far as the product needs, or leave it when the inspo clearly points elsewhere: ${start}.`,
    ...(start.startsWith("Look: ") ? [`- If you keep this look, begin summary with "${start.slice(0, start.indexOf(".") + 1)}" so the build opens that look's file, and take the palette and fonts it describes unless the product needs others.`] : []),
    "- When askedLook is set, the direction follows it. Never name a real product or company in the direction, and never aim for a real product's exact look.",
  ];
  if (recent.length) {
    lines.push(`- Other products were just made with these. Look different from them: ${recent.map((r) => `${r.displayFamily} with ${r.accent} on ${r.background}`).join("; ")}.`);
  }
  return lines.join("\n");
}

// ---------- The build prompt ----------

export const RANGE_READ_FIRST = (lookSkill: string) =>
  `Follow AGENTS.md. Before you write code, read this whole brief, look at every file in \`inspo/\`, read \`.agents/skills/${lookSkill}\` for the parts and states, and read the skill for each model listed below. The look comes from the Design direction section.`;

export const RANGE_DEPTH_LINES = [
  "",
  "## Depth",
  "",
  "Build a real product someone would keep using, not the smallest thing that passes the checks. Passing `npm run verify` is the floor. Give each screen real content and believable data, the details that make this product its own, and the extra touches its users would expect. Go past the brief where that clearly serves its users, within the listed models and the budget.",
];

/** brief.md's Design direction section. */
export function rangeDirectionLines(d: Direction, asked: string | null): string[] {
  const p = d.palette;
  return [
    "",
    "## Design direction",
    "",
    d.summary,
    "",
    ...(asked ? [`The person asked for their own look: "${asked}". Where it and this direction differ, the ask wins.`, ""] : []),
    `- Scheme: ${d.scheme}. Set the tokens in \`app/muse-app.css\` for both color modes: with one fixed scheme, both get the same values.`,
    `- Palette: background ${p.background}, surface ${p.surface}, text ${p.text}, muted text ${p.mutedText}, accent ${p.accent}, text on accent ${p.onAccent}, secondary ${p.secondary}. Add tints and status colors that fit, and keep readable contrast.`,
    `- Type: ${d.displayFont.family} (\`${d.displayFont.package}\`) for display and ${d.bodyFont.family} (\`${d.bodyFont.package}\`) for body. Install them with npm and import them in \`app/layout.tsx\`. If a package doesn't exist, pick the closest one that does and say so in BUILD_NOTES.md.`,
    `- Density: ${d.density}`,
    `- Layout: ${d.layout}`,
    `- Shape: ${d.shape}`,
    `- Motion: ${d.motion}`,
    `- Imagery: ${d.imagery}`,
    "",
    "This drives the tokens and the page layout. The kit still supplies the parts, the four states, labels, focus rings, contrast and the footer. Restyle the parts through tokens and your own CSS rather than leaving them looking stock. A reader should be able to tell this product from any other Muse Muse product at a glance.",
  ];
}

export const RANGE_LOOK_LINE =
  "The inspo's mood may show in colors, fonts, decoration and imagery, as the Design direction says. It never copies a real brand's logo, characters, artwork or exact look.";

/** Added to Done means' third item, in the prompt and the goal, on a complex build. */
export const RANGE_AGENTS_NOTES = ", and which subagents and workflows ran and what each did";

/**
 * The required way of working for a complex build. The tools were always there and went unused because this was a list
 * of suggestions in one prompt, with a reviewer last in a round that got cut off (docs/BUILD_RANGE.md).
 */
export const RANGE_AGENT_LINES = [
  "",
  "## How you must work",
  "",
  "This build is complex, so these steps are required, not suggestions. They use the `subagent_spawn`, `subagent_wait`, `subagent_read_result` and `workflow` tools, and `read_skill` on `workflow-authoring` shows how to write a workflow. They win over any line elsewhere that has you read or plan alone.",
  "",
  "1. **Scout first.** Your first tool call after reading this file is `subagent_spawn` for a read-only scout. It reads `inspo/` and the skills this brief names, and reports the routes, data and files each part needs. Plan from its report, instead of reading all of it yourself.",
  "2. **Split the writing.** Build the shared parts yourself (tokens, fonts, layout, data layer) and commit. Then give parts that touch different files to at least two writer subagents with worktree isolation, one part each, even when this run covers only one milestone. Merge their commits, fix what conflicts and run `npm run verify` yourself.",
  "3. **Check with a workflow.** Once the main path passes, run one `workflow` with a read-only child per screen, comparing it with brief.md and the Design direction. Fix what they find.",
  "4. **Review early.** A round can be cut off at its time limit without warning, so don't leave this for last: as soon as the main path passes, start a read-only reviewer subagent that compares the product with brief.md and AGENTS.md. Fix what it finds.",
  "5. **Write it down.** In BUILD_NOTES.md, list each subagent and workflow you ran and what it did. If a tool refuses, write the reason there and go on without it.",
  "",
  "Never run more at once than the agent capacity allows. Each child follows AGENTS.md too.",
];

/** Every other round on a complex build. A milestone or fix prompt is all that round reads about how to work. */
export const RANGE_MILESTONE_AGENT_LINES = [
  "",
  "## How you must work",
  "",
  "brief.md's How you must work section still applies, and these steps are required. Start with `subagent_spawn` for a read-only scout of what this milestone touches. Give parts that touch different files to at least two writer subagents with worktree isolation, then merge them and run `npm run verify` yourself. As soon as the new work passes, start a read-only reviewer subagent, since a round can be cut off without warning. Add what each one did to BUILD_NOTES.md.",
];

export const RANGE_FIX_AGENT_LINE =
  "When what failed sits in different parts of the product, give each part to a subagent with worktree isolation and merge their commits, within the agent capacity. List them in BUILD_NOTES.md.";

export const RANGE_FIX_LOOK = "Keep the Design direction in brief.md when it has one. Change colors, fonts, spacing or layout when that is the real fix, within that direction.";

export const RANGE_SIMPLER_LINE = "If an approach really fails three times, try a different one of the same ambition first. Pick a simpler one only after that, and write the limit in BUILD_NOTES.md.";

export const RANGE_FLOW_LINE = "Build this first and make it work end to end with the files in `fixtures/`. Then build every other screen, each to the same standard.";

export const RANGE_COST_LINE = "Put this number in `musemuse.json` as `estimatedCostPerRunUsd`, and keep the tests to at most 10 model calls.";

export const RANGE_SHOTS_LINE = "Take a judge screenshot of each main screen, at most 8, whatever the verify skill says about 2 to 4. The last still shows the final result.";

export const RANGE_FIX_SHOTS = "Change the product so the screens show what the brief promises. The last screenshot must show the finished result, with no error, invalid field, spinner or empty state anywhere on it. Keep at most 8 numbered screenshots.";

// ---------- The judge ----------

export const RANGE_HOUSE_STYLE =
  "Every Muse Muse product has its own design direction, chosen for it and given below, so it isn't expected to look like any other Muse Muse product. Bold colors, display fonts, shadows, dark themes, wide layouts and pages without cards are all fine. That is expected:";

/** How to judge the look: its craft and its fit to the direction. Rules about real products and Meta's marks stay above. */
export function rangeJudgeNote(d: Direction): string {
  return [
    `This product's design direction: ${d.summary} Palette: background ${d.palette.background}, text ${d.palette.text}, accent ${d.palette.accent}. Type: ${d.displayFont.family} and ${d.bodyFont.family}. Layout: ${d.layout}`,
    "Judge the look on craft and on fit to this direction, never on how close it is to a house style.",
    "- Fail it when the craft is poor: unreadable contrast, controls that look broken or unstyled, a layout that collides or leaves a screen looking unfinished.",
    "- Fail it when the screens plainly ignore the direction, like a stock white page with blue buttons when the direction says otherwise. Say what differs in mismatches. Small differences in color or spacing are not a reason to fail.",
    "- These are not blocking by themselves.",
  ].join("\n");
}

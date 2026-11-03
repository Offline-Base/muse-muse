import { briefMilestones, type Milestone } from "@/lib/engine/milestones";
import { RANGE_MILESTONE_AGENT_LINES } from "@/lib/range/prompts";
import type { VerifySummary } from "@/lib/types";

/**
 * The engine's prompt text (docs/CAPABILITIES.md, section 8): the brief writer's rules for big builds and exact logic,
 * brief.md's Milestones section and budget lines, and milestone-<n>.md. Pure functions. Each returns nothing when its
 * flag is off, so every prompt stays as it is today.
 */

/** A main claim that must be exact is code, not a model call (ENGINE_EXACT_LOGIC). */
export const EXACT_LOGIC_RULE =
  "- When the product's main promise depends on exact logic, such as a guard that must be deterministic, a level that must be solvable, a total that must add up or a file that must be valid, that logic is plain code the product runs: a parser, a solver, a validator or a rules table, written in the product. Say so in primaryFlow and in the action that does it. A model may read the input or explain the result, but it never makes the call the product says is exact. Example: a guard that promises to block unsafe SQL every time parses the query with code and checks it against fixed rules, and only the plain-words explanation comes from Muse Wonder.";

/** When the writer fills milestones (ENGINE_MILESTONES). */
export const MILESTONES_RULE =
  "- milestones is null for most briefs. Fill it only when the product needs 3 or more platform services, or is complex with 3 or more screens. Then give 2 or 3 milestones in build order, the first being the primary flow working end to end. Each has a title of at most 60 characters and doneMeans of at most 300 characters saying what runs at its end. Each milestone ends with something that runs.";

/** The writer's extra rules, appended to the "Writing the brief" list. Empty with both flags off. */
export function engineWriterRules(opts: { milestones: boolean; exactLogic: boolean }): string {
  const lines = [...(opts.exactLogic ? [EXACT_LOGIC_RULE] : []), ...(opts.milestones ? [MILESTONES_RULE] : [])];
  return lines.length ? `\n${lines.join("\n")}` : "";
}

/** brief.md's Milestones section, right after Done means. Empty for a brief without milestones. */
export function milestoneBuildLines(brief: { milestones?: Milestone[] | null }): string[] {
  const list = briefMilestones(brief);
  if (!list.length) return [];
  return [
    "",
    "## Milestones",
    "",
    `This product is built in ${list.length} milestones, in order, all in this session. This run builds only milestone 1, and Done means applies to it: \`npm run verify\` exits 0 with what milestone 1 makes. After you stop, the platform checks it and sends you the next milestone.`,
    "",
    ...list.map((m, i) => `${i + 1}. **${m.title}**: ${m.doneMeans}`),
    "",
    "Build milestone 1 so later milestones can be added without rewriting it, and keep `tests/smoke.spec.ts` covering what each milestone makes.",
  ];
}

/**
 * Budget lines for big builds, after brief.md's Budget section (docs/CAPABILITIES.md, section 8). A round that runs
 * `npm run verify` three or four times fills its time, and a test that waits on many generated items is slow and flaky.
 */
export function engineBudgetLines(on: boolean): string[] {
  if (!on) return [];
  return [
    "Run `npm run verify` once, when the round's work is done. The platform runs it again after you stop. Before that, check with `npx tsc --noEmit` and run only the tests you just wrote (`npx playwright test -g \"R3\"`).",
    "When the product makes something that must pass a check (a solvable level, valid code), test one generated item for real and the rest with fixtures.",
    // Nov 3 audit: builds ended rounds with "Snoozed until the run lands" (6 times in one build), losing the round.
    "Never end your turn to wait for something running in the background: ending it ends this round, and what you were waiting for is lost. Wait inside the turn instead: give `bash` a long `yield_time_ms` (up to 300000) for verify and test runs, and use `subagent_wait` for helpers. Don't use `snooze_reminder` to pause.",
  ];
}

function bullets(items: string[]): string {
  return items.map((s) => `- ${s}`).join("\n");
}

/** milestone-<n>.md: the next milestone, with what the last verify found. Resumed in the same Muse Code session. */
export function renderMilestonePrompt(input: {
  index: number;
  of: number;
  milestone: Milestone;
  /** The strict verify run after the last milestone, or null when it couldn't run. */
  verify: VerifySummary | null;
  /** BUILD_RANGE on a complex build: subagents are required in this round too. */
  requiredAgents?: boolean;
}): string {
  const { index, of, milestone, verify } = input;
  const out: string[] = [
    `# Milestone ${index} of ${of}: ${milestone.title}`,
    "",
    `Add milestone ${index} to the product you built in this session, as brief.md's Milestones section lists it.`,
    "",
    `Done means for this milestone: ${milestone.doneMeans}`,
    "",
    bullets([
      "Keep everything the earlier milestones made working, and keep the footer and the product's look.",
      "Extend `tests/smoke.spec.ts` to cover what this milestone makes, with judge screenshots that show it.",
      "Don't delete, skip or weaken tests, and don't mock or stub Meta calls.",
      `Run \`npm run verify\` until it exits 0, at most twice in this round, then update BUILD_NOTES.md and stop.${index < of ? " The platform sends the next milestone after that." : ""}`,
    ]),
    ...(input.requiredAgents ? RANGE_MILESTONE_AGENT_LINES : []),
  ];
  if (verify && !verify.passed) {
    const failing = verify.steps.filter((s) => !s.ok);
    out.push(
      "",
      "## What the last check found",
      "",
      `\`npm run verify\` failed after milestone ${index - 1}. Fix this first, then build milestone ${index}.`,
      "",
      failing.length
        ? bullets(failing.map((s) => `FAILED: ${s.name}${s.detail ? `: ${s.detail.replace(/\s+/g, " ").slice(0, 300)}` : ""}`))
        : "No step results were reported.",
    );
    const tail = verify.failureOutput.trim();
    if (tail) out.push("", "```text", tail.slice(-3000).replace(/```/g, "'''"), "```");
  }
  return `${out.join("\n")}\n`;
}

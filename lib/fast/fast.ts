import type { VerifySummary } from "@/lib/types";

/**
 * FAST_BUILDS (docs/FAST_BUILDS.md). Pure, and only read with the flag on, so with it off every prompt is byte for byte
 * what it was.
 */

/** A complex build's required way of working: all of it in one round, with writers side by side. */
export function fastAgentLines(capacity: number): string[] {
  return [
    "",
    "## How you must work",
    "",
    "This build is complex and has to finish fast, so these steps are required, not suggestions. All the requirements are built in this one round. They use the `subagent_spawn`, `subagent_wait`, `subagent_cancel`, `subagent_read_result` and `workflow` tools, and `read_skill` on `workflow-authoring` shows how to write a workflow. They win over any line elsewhere that has you read, plan or write alone.",
    "",
    "1. **Scout first.** Your first tool call after reading this file is `subagent_spawn` for a read-only scout. It reads `inspo/` and the skills this brief names, then splits the work into shared parts (types, tokens, fonts, layout, navigation, data layer) and one part per screen or feature, naming the exact files each part owns. No file belongs to two parts.",
    "2. **Shared parts next.** Build the shared parts yourself, with a route stub for each screen, and commit, before any writer starts.",
    `3. **Writers side by side.** Spawn one write-capable subagent per screen or feature, each with \`worktree_isolation: true\`, all in one turn, up to ${capacity} at once. Start any part left over as a slot frees. Each writer changes only its own files and commits in its worktree. It runs the typecheck and its own tests, never the full \`npm run verify\`.`,
    "4. **Merge as each one finishes, and never wait long.** Call `subagent_wait` with a deadline of 10 minutes at most for each writer. Merge a finished writer's commit right away. If a writer fails or passes its deadline, use `subagent_cancel`, keep what it committed and finish that part yourself, so one slow writer never holds up the build.",
    "5. **Check with a workflow.** Once the main path passes, run one `workflow` with a read-only child per screen or group of requirements, comparing it with brief.md. Fix what they find.",
    "6. **Write it down.** In BUILD_NOTES.md, list each subagent and workflow you ran and what it did. If a tool refuses, write the reason there and go on without it.",
    "",
    "Each child follows AGENTS.md too.",
  ];
}

/**
 * The requirements a fix round can recheck alone: only when requirement tests are all that failed. Anything else (the
 * typecheck, the build, the main path's own problems) returns none, so the next check is the full one.
 */
export function recheckIds(summary: Pick<VerifySummary, "steps" | "requirements">): string[] {
  const other = summary.steps.some((s) => !s.ok && s.name !== "smoke" && s.name !== "requirements");
  if (other) return [];
  return (summary.requirements ?? []).filter((r) => !r.ok).map((r) => r.id).filter((id) => /^R\d+$/.test(id));
}

export interface HelperCount {
  /** Writers running, as far as the log says. */
  active: number;
  /** Writers started since none were running. */
  wave: number;
  /** The most this wave has announced. */
  said: number;
}

export const NO_HELPERS: HelperCount = { active: 0, wave: 0, said: 0 };

/** Keeps count of the writers from Muse Code's log lines. `line` is the story's sentence when there is a new one to say. */
export function countHelpers(prev: HelperCount, lines: ReadonlyArray<{ tool?: string; text?: string }>): HelperCount & { line?: string } {
  let { active, wave, said } = prev;
  for (const l of lines) {
    if (l.tool === "subagent_spawn" && /started a subagent/.test(l.text ?? "") && !/scout|review|check/i.test(l.text ?? "")) {
      active += 1;
      wave += 1;
    } else if (l.tool === "subagent_wait" && /subagent finished/.test(l.text ?? "") && active > 0) {
      active -= 1;
      if (active === 0) wave = said = 0;
    }
  }
  if (wave >= 2 && wave > said) return { active, wave, said: wave, line: `${wave} helpers are building your screens` };
  return { active, wave, said };
}

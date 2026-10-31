/**
 * The Prove it workflow (docs/PRODUCT_OUTPUTS.md): after a product is live, runs each thing it comes with for real
 * against the live product and records a video of each that worked.
 *
 *   proveProduct: copy the sandbox -> MCP server, CLI, Claude plugin, skill file checks -> Muse Code uses the skill,
 *                 step-capped -> Demo Studio records each in a terminal scene -> upload -> charge -> delete the copy
 *
 * The build's workflow starts it after writing its final status, so nothing here can delay or fail Live. Everything here
 * only orchestrates: side effects are in ./prove-steps.ts, and long work starts detached and is polled between durable
 * sleeps. Start it with start() from "workflow/api". Never call it directly.
 */
import { sleep } from "workflow";
import { killStep, pollTaskStep } from "@/lib/pipeline/build-steps";
import { pollTimedOut } from "@/lib/pipeline/logic";
import {
  proveAbandonStep,
  proveChecksOverCapStep,
  proveCloseStep,
  proveCollectChecksStep,
  proveFailStep,
  proveFinishRecordStep,
  proveFinishSkillStep,
  proveOpenStep,
  provePollSkillStep,
  proveStartChecksStep,
  proveStartRecordStep,
  proveStartSkillStep,
  type ProveCtx,
  type ProveSummary,
} from "@/lib/pipeline/prove-steps";
import type { ProveInput } from "@/lib/pipeline/prove-types";
import type { ProvedOutput, ProveStopped } from "@/lib/outputs/prove";

const MIN = 60_000;
const POLL_MS = 5_000;
const SKILL_POLL_MS = 10_000;
/** The checks call the product's actions, each with a 120 s limit, up to six times. */
const CHECKS_CAP_MS = 14 * MIN;
/** The skill test is one read and one call, and its step cap should end it well before this. */
const SKILL_CAP_MS = 6 * MIN;
/** Four recordings and renders, each with its own limit in the sandbox. */
const RECORD_CAP_MS = 20 * MIN;

/**
 * Polls a detached command until it ends, reaches its time cap, or, when given a run to watch, reaches that run's budget.
 * A command that hits either limit is killed. Null when it ended by itself. A call already under way when the budget runs
 * out still finishes, so a run can pass its cap by that one call.
 */
async function waitFor(copy: string, cmdId: string, capMs: number, budgetOf?: ProveCtx): Promise<ProveStopped | null> {
  const startedAt = Date.now();
  for (let polls = 1; ; polls++) {
    await sleep(POLL_MS);
    const poll = await pollTaskStep(copy, cmdId);
    if (poll.done) return null;
    if (budgetOf && (await proveChecksOverCapStep(budgetOf))) {
      await killStep(copy, cmdId);
      return "budget";
    }
    if (pollTimedOut({ startedAt, now: Date.now(), capMs, intervalMs: POLL_MS, polls })) {
      await killStep(copy, cmdId);
      return "time";
    }
  }
}

/** Runs the skill test to its end, its cap, or the money's end. Returns what the scene needs and how it ended. */
async function skillTest(ctx: ProveCtx, checks: Parameters<typeof proveStartSkillStep>[1]) {
  const run = await proveStartSkillStep(ctx, checks);
  if (!run) return null;
  const startedAt = Date.now();
  let state = { offset: 0, announced: [] as string[], childrenIncluded: null as boolean | null };
  let finalText: string | null = null;
  let exitCode: number | null = null;
  let timedOut = false;
  for (let polls = 1; ; polls++) {
    await sleep(SKILL_POLL_MS);
    const poll = await provePollSkillStep(ctx, run, state);
    state = { offset: poll.offset, announced: poll.announced, childrenIncluded: poll.childrenIncluded };
    finalText = poll.finalText ?? finalText;
    if (poll.done) {
      exitCode = poll.exitCode;
      break;
    }
    if (poll.overCap || pollTimedOut({ startedAt, now: Date.now(), capMs: SKILL_CAP_MS, intervalMs: SKILL_POLL_MS, polls })) {
      timedOut = true;
      await killStep(ctx.copy, run.cmdId);
      // Reads what it wrote on its way out, so what it spent is still charged.
      await provePollSkillStep(ctx, run, state);
      break;
    }
  }
  const finished = await proveFinishSkillStep(ctx, run, { exitCode, timedOut });
  return { ...finished, scene: { lines: finished.lines, finalText, command: run.command, seconds: (Date.now() - startedAt) / 1000 } };
}

export async function proveProduct(input: ProveInput): Promise<{ ran: boolean }> {
  "use workflow";
  let ctx: ProveCtx | null = null;
  try {
    ctx = await proveOpenStep(input);
  } catch (err) {
    await proveAbandonStep(input, `The sandbox copy couldn't be made. ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false };
  }
  if (!ctx) return { ran: false };
  try {
    const cmdId = await proveStartChecksStep(ctx);
    const stopped = await waitFor(ctx.copy, cmdId, CHECKS_CAP_MS, ctx);
    const checks = await proveCollectChecksStep(ctx, stopped);
    const summaries: Partial<Record<ProvedOutput, ProveSummary>> = { ...checks.summaries };
    const passed = [...checks.passed];

    const skill = await skillTest(ctx, checks);
    if (skill) {
      summaries.skill = skill.summary;
      if (skill.ok) passed.push("skill");
    }

    if (ctx.record && passed.length) {
      const recording = await proveStartRecordStep(ctx, { passed, resultsHash: checks.resultsHash, skill: skill?.scene ?? null });
      if (recording) {
        await waitFor(ctx.copy, recording, RECORD_CAP_MS);
        await proveFinishRecordStep(ctx, { passed, summaries });
      }
    }
    await proveCloseStep(ctx);
    return { ran: true };
  } catch (err) {
    await proveFailStep(ctx, err);
    return { ran: false };
  }
}

/**
 * The durable workflow of a tuning loop (docs/TRAINING.md "Tuning loop"). It only orchestrates; every side effect is a
 * step in ./loop-steps.ts. Each round: decide from the last verdict (the target, the round limit, the cap) -> write more
 * examples aimed at its weak prompts -> merge them into a new dataset -> the usual examples check -> train a new adapter
 * from the base -> wait for its judging. Start it with start() from "workflow/api" (app/api/train/loops).
 */
import { sleep } from "workflow";
import { TUNE_LAUNCH_WINDOW_MS, TUNE_RETRY_MS } from "@/lib/train/tune/marks";
import { LOOP_MAX_ROUNDS } from "@/lib/train/tune/loop";
import { loopEndStep, loopJobEndedStep, loopLaunchStep, loopMergeStep, loopNextStep, loopWriterStep, type LoopLaunch } from "@/lib/train/tune/loop-steps";
import { checkExamplesStep } from "@/lib/train/tune/run-steps";

const WRITER_POLL_MS = 30_000;
const JOB_POLL_MS = 2 * 60_000;
/** A job the sweep hasn't ended by now is not coming back. Its limits are far under this. */
const JOB_GIVE_UP_MS = 12 * 60 * 60_000;

export async function tuneLoop(input: { loopId: string }): Promise<{ status: string }> {
  "use workflow";
  const { loopId } = input;
  try {
    // One past the most rounds: that last pass only judges the final round and ends the loop.
    for (let round = 1; round <= LOOP_MAX_ROUNDS + 1; round++) {
      const next = await loopNextStep(loopId, round);
      if (next.kind === "stop") return { status: next.code };

      for (;;) {
        const w = await loopWriterStep(loopId, round);
        if (w.kind === "stop") return { status: w.code };
        if (w.kind === "ready") break;
        await sleep(WRITER_POLL_MS);
      }

      const merged = await loopMergeStep(loopId, round);
      if (!merged.ok) return { status: merged.code };

      const check = await checkExamplesStep(merged.datasetId);
      if (!check.ok) {
        await loopEndStep(loopId, "check_failed");
        return { status: "check_failed" };
      }

      const giveUpAt = Date.now() + TUNE_LAUNCH_WINDOW_MS;
      let launched: Extract<LoopLaunch, { kind: "launched" }> | null = null;
      while (!launched) {
        const r: LoopLaunch = await loopLaunchStep(loopId, round);
        if (r.kind === "stop") return { status: r.code };
        if (r.kind === "launched") launched = r;
        else if (Date.now() + TUNE_RETRY_MS > giveUpAt) {
          await loopEndStep(loopId, "no_gpu");
          return { status: "no_gpu" };
        } else await sleep(TUNE_RETRY_MS);
      }

      const jobGiveUpAt = Date.now() + JOB_GIVE_UP_MS;
      while (!(await loopJobEndedStep(launched.jobId))) {
        if (Date.now() > jobGiveUpAt) {
          await loopEndStep(loopId, "error");
          return { status: "error" };
        }
        await sleep(JOB_POLL_MS);
      }
    }
    await loopEndStep(loopId, "round_limit");
    return { status: "round_limit" };
  } catch {
    try {
      await loopEndStep(loopId, "error");
    } catch {
      // Still down. Stop on the loop's page ends it and frees the run.
    }
    return { status: "error" };
  }
}

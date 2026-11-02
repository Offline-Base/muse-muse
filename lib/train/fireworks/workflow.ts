/**
 * Training on Fireworks (docs/TRAINING.md "Train on Fireworks"): the examples go up, a managed job trains, base and
 * tuned answer the kept-aside prompts as batch jobs, the existing judge scores them, and the files are cleaned up. It
 * polls: a protected Preview can't take callbacks. The job's time limit bounds both the training and the answering.
 */
import { sleep } from "workflow";
import { fwAbandonStep, fwAnswerCheckStep, fwAnswerStartStep, fwCheckStep, fwCleanupStep, fwCreateStep, fwFinishStep } from "@/lib/train/fireworks/steps";
import { judgePlanStep, judgeStep, saveEvalSummaryStep } from "@/lib/train/judge";
import type { JudgedItem } from "@/lib/train/logic";

const POLL_MS = 60_000;
const JUDGE_CONCURRENCY = 4;

export async function fireworksTrain(input: { jobId: string }): Promise<{ status: "succeeded" | "failed" | "stopped" }> {
  "use workflow";
  const { jobId } = input;
  let usd = 0;
  let note: string | null = null;
  let ending: { status: "succeeded" | "failed" | "stopped"; reason: string } = { status: "failed", reason: "The job ended before it was checked." };
  let sent = false;
  try {
    const made = await fwCreateStep(jobId);
    if (made.action === "end") {
      ending = made;
    } else {
      sent = true;
      const stopAt = Date.now() + made.maxMinutes * 60_000;
      let percent = 0;
      let trained = false;
      while (!trained) {
        if (Date.now() >= stopAt) {
          await fwAbandonStep(jobId);
          ending = { status: "failed", reason: `Fireworks didn't finish within the job's ${made.maxMinutes}-minute limit, so it was removed.` };
          break;
        }
        await sleep(POLL_MS);
        let check: Awaited<ReturnType<typeof fwCheckStep>>;
        try {
          check = await fwCheckStep(jobId, percent);
        } catch {
          continue;
        }
        if (check.action === "end") {
          ending = check;
          break;
        }
        if (check.action === "trained") trained = true;
        else percent = check.percent;
      }
      if (trained) {
        ending = { status: "succeeded", reason: "Fireworks finished training." };
        const answering = await fwAnswerStartStep(jobId);
        if (answering.action === "skip") {
          note = answering.note;
        } else {
          for (;;) {
            if (Date.now() >= stopAt) {
              note = "Not scored: Fireworks didn't finish answering within the job's time limit.";
              usd = Number.NaN;
              break;
            }
            await sleep(POLL_MS);
            let check: Awaited<ReturnType<typeof fwAnswerCheckStep>>;
            try {
              check = await fwAnswerCheckStep(jobId);
            } catch {
              continue;
            }
            if (check.action === "done") {
              usd = check.usd;
              note = check.note;
              break;
            }
          }
        }
      }
    }
  } catch {
    ending = { status: "failed", reason: "Talking to Fireworks failed." };
  }
  // Abandoned answers may have billed: the sentinel makes the finish count the job's whole hold (see below).
  await fwFinishStep(jobId, { status: ending.status, reason: ending.reason, usd: Number.isNaN(usd) ? -1 : usd, note });
  if (sent || ending.status !== "stopped") {
    try {
      await fwCleanupStep(jobId, ending.status === "succeeded");
    } catch {
      // Nothing left on Fireworks bills by the hour, and an admin can remove it from the job's route.
    }
  }
  if (ending.status === "succeeded" && !note) {
    try {
      const plan = await judgePlanStep(jobId);
      if (plan.indexes.length) {
        const items: JudgedItem[] = [];
        for (let i = 0; i < plan.indexes.length; i += JUDGE_CONCURRENCY) {
          const batch = plan.indexes.slice(i, i + JUDGE_CONCURRENCY);
          const judged = await Promise.allSettled(batch.map((index) => judgeStep(jobId, index, plan.task)));
          for (const r of judged) if (r.status === "fulfilled" && r.value) items.push(r.value);
        }
        await saveEvalSummaryStep(jobId, items, plan.indexes.length);
      }
    } catch {
      // Like the Lambda path's judging, an extra: the job's status is settled.
    }
  }
  return { status: ending.status };
}

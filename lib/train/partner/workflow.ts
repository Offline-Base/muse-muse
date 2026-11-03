/**
 * A partner eval of one tuned job (PARTNER_EVALS, docs/TRAINING.md "Evaluate on a partner"). It only orchestrates: every
 * side effect is a step in ./steps.ts.
 *
 *   plan (flag, the hosting checks, the budget; records "started" or "skipped")
 *   -> deploy through the hosting code, its stop time set from PARTNER_EVAL_MAX_USD and PARTNER_EVAL_MAX_MINUTES
 *   -> every 30 s, ask whether it is ready, up to readyMinutes
 *   -> answer each held-out prompt with base and tuned, PARTNER_CONCURRENCY at a time, a waking endpoint retried
 *   -> stop it (and again every minute, 5 times; then the 5-minute hosting sweep, which also stops it at its stop time)
 *   -> judge the pairs with the job's own judge, after the GPU is down, so judging never keeps it billing
 *   -> record "done" or "failed" with scores, latency and cost
 *
 * It runs apart from the training job's workflow (started by startPartnerEvalStep, or by an admin), so nothing here can
 * change the job's status, its eval summary or its own scores. Start it with start() from "workflow/api". Never call it
 * directly; tests call runPartnerEval with a fake clock.
 */
import { sleep } from "workflow";
import { PARTNER_CONCURRENCY, PARTNER_TAIL_MINUTES, partnerSummary, reasonText, type PartnerAnswer } from "@/lib/train/partner/logic";
import {
  partnerAnswerStep,
  partnerDeployStep,
  partnerJudgeStep,
  partnerPlanStep,
  partnerSaveStep,
  partnerStopStep,
  partnerWaitStep,
  type PartnerEvalInput,
  type PartnerPlan,
} from "@/lib/train/partner/steps";
import type { JudgedItem } from "@/lib/train/logic";
import type { PartnerEvalBody } from "@/lib/train/types";

export type { PartnerEvalInput };

const READY_POLL_MS = 30_000;
const STOP_TRIES = 5;
const STOP_PAUSE_MS = 60_000;

export interface PartnerClock {
  wait(ms: number): Promise<unknown>;
  now(): number;
}

export async function partnerEvalJob(input: PartnerEvalInput): Promise<{ status: PartnerEvalBody["status"] }> {
  "use workflow";
  return runPartnerEval(input, { wait: (ms) => sleep(ms), now: () => Date.now() });
}

type Texts = Map<number, { base?: string; tuned?: string }>;

/** Answers one prompt with both models. Returns a reason when the endpoint can take nothing more. */
async function answerBoth(jobId: string, endpointId: string, plan: PartnerPlan, index: number, answerBy: number, clock: PartnerClock, texts: Texts, answers: PartnerAnswer[]): Promise<string | null> {
  for (const variant of ["base", "tuned"] as const) {
    for (;;) {
      if (clock.now() >= answerBy) return "It ran out of its time before every prompt was answered.";
      const r = await partnerAnswerStep({ jobId, endpointId, index, variant, system: plan.system, baseRepo: plan.baseRepo });
      if (r.ok) {
        texts.set(index, { ...texts.get(index), [variant]: r.text });
        answers.push({ index, variant, ms: r.ms });
        break;
      }
      if (r.stop) return r.reason;
      if (!r.retry) return null; // This prompt is left out; the rest go on.
      await clock.wait(Math.max(5, r.afterSeconds) * 1000);
    }
  }
  return null;
}

export async function runPartnerEval(input: PartnerEvalInput, clock: PartnerClock): Promise<{ status: PartnerEvalBody["status"] }> {
  const plan = await partnerPlanStep(input);
  if (plan.action !== "go") return { status: "skipped" };
  const { jobId } = input;
  const texts: Texts = new Map();
  const answers: PartnerAnswer[] = [];
  let endpointId: string | null = null;
  let failed: string | null = null;
  let coldStartSeconds: number | null = null;
  let deployCost: number | null = 0;

  try {
    const deployed = await partnerDeployStep({ jobId, plan });
    if (!deployed.ok) {
      failed = deployed.reason;
      deployCost = deployed.costUsd;
    } else {
      endpointId = deployed.endpointId;
      const t0 = clock.now();
      const readyBy = t0 + plan.readyMinutes * 60_000;
      for (;;) {
        const w = await partnerWaitStep({ endpointId });
        if (w.state === "live") {
          coldStartSeconds = Math.round((clock.now() - t0) / 1000);
          break;
        }
        if (w.state === "gone") {
          failed = w.reason;
          break;
        }
        if (clock.now() >= readyBy) {
          failed = `It wasn't ready to answer within ${plan.readyMinutes} minutes, so it was stopped.`;
          break;
        }
        await clock.wait(READY_POLL_MS);
      }
      if (!failed) {
        // From the plan's start, which is before the endpoint's row: its stop time is never passed while answering.
        const answerBy = Date.parse(plan.startedAt) + (plan.minutes - PARTNER_TAIL_MINUTES) * 60_000;
        for (let i = 0; i < plan.indexes.length && !failed; i += PARTNER_CONCURRENCY) {
          const group = plan.indexes.slice(i, i + PARTNER_CONCURRENCY);
          const ended = await Promise.all(group.map((index) => answerBoth(jobId, endpointId!, plan, index, answerBy, clock, texts, answers)));
          failed = ended.find((e) => e) ?? null;
        }
      }
    }
  } catch (err) {
    failed = failed ?? reasonText(`A step failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Down before judging, whatever happened above.
  let stop: { done: boolean; costUsd: number | null } = { done: true, costUsd: deployCost };
  if (endpointId) {
    for (let tries = 0; tries < STOP_TRIES; tries += 1) {
      stop = await partnerStopStep({ endpointId }).catch(() => ({ done: false, costUsd: null }));
      if (stop.done) break;
      await clock.wait(STOP_PAUSE_MS);
    }
  }

  const pairs = plan.indexes.filter((i) => texts.get(i)?.base !== undefined && texts.get(i)?.tuned !== undefined);
  const verdicts: Array<JudgedItem & { index: number }> = [];
  for (let i = 0; i < pairs.length; i += PARTNER_CONCURRENCY) {
    const group = pairs.slice(i, i + PARTNER_CONCURRENCY);
    const got = await Promise.all(group.map((index) => partnerJudgeStep({ jobId, index, base: texts.get(index)!.base!, tuned: texts.get(index)!.tuned!, judgeModel: plan.judgeModel, task: plan.task }).catch(() => null)));
    for (const v of got) if (v) verdicts.push(v);
  }
  if (!failed && pairs.length && !verdicts.length) failed = "The answers came back, but none could be judged.";
  if (!failed && !pairs.length) failed = "No prompt got both answers.";

  const body = partnerSummary({
    provider: plan.provider,
    verdicts,
    asked: plan.indexes.length,
    answers,
    judgeModel: plan.judgeModel,
    coldStartSeconds,
    costUsd: stop.costUsd,
    stopped: stop.done,
    price: { hourlyUsd: plan.hourlyUsd, gpu: plan.gpu },
    minutes: plan.minutes,
    maxUsd: plan.maxUsd,
    startedAt: plan.startedAt,
    endedAt: new Date(clock.now()).toISOString(),
    failed,
  });
  await partnerSaveStep({ jobId, body }).catch(() => undefined);
  return { status: body.status };
}

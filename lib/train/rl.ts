/**
 * The rl-grpo recipe's results, as its done metrics and progress messages carry them (lib/train/recipes/rl.ts). Pure,
 * with no recipe source, so client components import it. Nothing here reads the database or calls a model.
 */
import { RL_RECIPE, type TrainEventView } from "@/lib/train/types";

export interface RewardPoint {
  step: number;
  reward: number;
}

export interface RlExample {
  problem: string;
  answer: number;
  base: string;
  tuned: string;
  baseReward: number;
  tunedReward: number;
}

export interface RlHeldOut {
  total: number;
  baseCorrect: number;
  tunedCorrect: number;
  baseReward: number;
  tunedReward: number;
}

export interface RlResultsView {
  curve: RewardPoint[];
  heldOut: RlHeldOut | null;
  examples: RlExample[];
  dryRun: boolean;
  stoppedEarly: boolean;
}

export function isRlJob(job: { recipe: string }): boolean {
  return job.recipe === RL_RECIPE;
}

/** Metrics the results card shows on its own, kept out of the raw table under Finished. */
export function isRlCardMetric(key: string): boolean {
  return key === "reward_curve" || /^example_\d+$/.test(key);
}

/** "5:0.1,10:0.25" as points. Anything that isn't a number pair is left out. */
export function parseRewardCurve(raw: unknown): RewardPoint[] {
  if (typeof raw !== "string") return [];
  return raw.split(",").flatMap((part) => {
    const [step, reward] = part.split(":").map(Number);
    return part.includes(":") && Number.isFinite(step) && Number.isFinite(reward) ? [{ step: step!, reward: reward! }] : [];
  });
}

const REWARD_MESSAGE = /^Mean reward (-?\d+(?:\.\d+)?)$/;

/** The curve so far, from a running job's progress events. Older events may be trimmed from the page, so it can start late. */
export function liveRewardCurve(events: TrainEventView[]): RewardPoint[] {
  return events.flatMap((e) => {
    const p = e.payload;
    if (p?.type !== "progress" || typeof p.step !== "number" || typeof p.message !== "string") return [];
    const m = REWARD_MESSAGE.exec(p.message);
    return m ? [{ step: p.step, reward: Number(m[1]) }] : [];
  });
}

function parseExample(raw: unknown): RlExample[] {
  if (typeof raw !== "string") return [];
  try {
    const e = JSON.parse(raw) as Partial<RlExample>;
    if (typeof e.problem !== "string" || typeof e.answer !== "number" || typeof e.base !== "string" || typeof e.tuned !== "string") return [];
    return [{ problem: e.problem, answer: e.answer, base: e.base, tuned: e.tuned, baseReward: Number(e.baseReward) || 0, tunedReward: Number(e.tunedReward) || 0 }];
  } catch {
    return [];
  }
}

/** Everything the card shows: the finished job's metrics when it has them, else the curve from its progress events. */
export function rlResults(events: TrainEventView[]): RlResultsView {
  let metrics: Record<string, string | number> = {};
  for (let i = events.length - 1; i >= 0; i--) {
    const p = events[i]?.payload;
    if (p?.type === "done") {
      metrics = p.metrics ?? {};
      break;
    }
  }
  const done = parseRewardCurve(metrics.reward_curve);
  const num = (key: string) => (typeof metrics[key] === "number" ? (metrics[key] as number) : null);
  const [total, baseCorrect, tunedCorrect, baseReward, tunedReward] = ["heldout_total", "heldout_base_correct", "heldout_tuned_correct", "heldout_base_reward", "heldout_tuned_reward"].map(num);
  const examples = Object.keys(metrics)
    .filter((k) => /^example_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
    .flatMap((k) => parseExample(metrics[k]));
  return {
    curve: done.length ? done : liveRewardCurve(events),
    heldOut:
      total != null && baseCorrect != null && tunedCorrect != null && baseReward != null && tunedReward != null
        ? { total, baseCorrect, tunedCorrect, baseReward, tunedReward }
        : null,
    examples,
    dryRun: metrics.dry_run === "yes",
    stoppedEarly: metrics.stopped_early === "yes",
  };
}

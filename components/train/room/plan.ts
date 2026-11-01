/**
 * A training plan as the plan card shows it (components/build/PlanCard.tsx PlanView): the model's role and tagline, how
 * it's made in five steps, something it might be asked, and what it costs, with the estimates called estimates. Pure, so
 * the composer, the room and the tests share it.
 */
import type { PlanView } from "@/components/build/PlanCard";
import { roughMinutes, WRITER_NAME } from "@/components/train/format";
import { GLIMMER_NAME } from "@/components/train/results";
import { usd } from "@/lib/format";
import { evalHoldoutCount } from "@/lib/train/logic";
import { planMaxUsd } from "@/lib/train/tune/cost";
import type { TrainPlanBody, TrainPlanCost, TuneRunView, TuneSettings } from "@/lib/train/tune/types";

/** Text that starts a sentence: its first letter in capitals ("about an hour" becomes "About an hour"). */
export function upperFirst(text: string): string {
  const t = text.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** The role as a heading: "A bakery's counter helper". */
export function roleTitle(name: string): string {
  return upperFirst(name) || "New fine-tune";
}

/**
 * The cost line. The GPU's part is the job's hard limit; Meta's parts (writing and scoring) are estimates, and what Muse
 * Wonder costs per example hasn't been measured yet, so the line says so.
 */
export function planCostText(c: TrainPlanCost): string {
  return (
    `Up to about ${usd(planMaxUsd(c))}: examples ${usd(c.metaLowUsd)} to ${usd(c.metaHighUsd)}, the GPU up to ${usd(c.gpuMaxUsd)} ` +
    `(a hard limit), scoring ${usd(c.scoreLowUsd)} to ${usd(c.scoreHighUsd)}. The examples and the scoring are estimates: ` +
    `what ${WRITER_NAME} costs per example hasn't been measured yet.`
  );
}

/** Whose style the examples follow: the person's rows that fit in the task, and how many of theirs didn't. */
function styleOf(used: number, given: number): string {
  if (!used) return "";
  if (given > used) return ` in the style of ${used} of your ${given} (only ${used} fit in the task, so the rest aren't used)`;
  return ` in the style of your ${used}`;
}

/**
 * How it's made, in the order the run goes. `used` is how many of the person's own rows the examples follow, of the
 * `given` they sent (the task holds only the first few, cut short: foldExamples).
 */
export function howItsMade(s: Pick<TuneSettings, "examples">, c: Pick<TrainPlanCost, "trainMinutes">, used = 0, given = used): string[] {
  const kept = evalHoldoutCount(s.examples);
  return [
    `${WRITER_NAME} writes ${s.examples} examples${styleOf(used, given)}, and keeps ${kept} aside to score it.`,
    "A quick check that there are enough to train on and to score with.",
    `${GLIMMER_NAME} trains on one GPU, ${roughMinutes(c.trainMinutes)}.`,
    `Base and tuned answer the ${kept} kept-aside prompts, and ${WRITER_NAME} scores both.`,
    "Try it live, then publish it if you like.",
  ];
}

export function planViewFromTrainPlan(p: Pick<TrainPlanBody, "name" | "tagline" | "samples" | "examples" | "settings" | "cost">): PlanView {
  const sample = p.samples.find((s) => s.trim());
  return {
    name: roleTitle(p.name),
    tagline: p.tagline,
    sections: [
      { heading: "How it's made", steps: howItsMade(p.settings, p.cost, p.examples.used, p.examples.given) },
      ...(sample ? [{ heading: "It might be asked", text: `"${sample.trim()}"` }] : []),
      { heading: "What it costs", text: `${planCostText(p.cost)} ${upperFirst(roughMinutes(p.cost.minutes))} in all.` },
    ],
  };
}

/**
 * A started run's plan, from the run itself. The tagline and the sample come from the browser that started it
 * (sessionStorage), when it still has them; the rest is the run's own.
 */
export function planViewFromRun(v: Pick<TuneRunView, "title" | "plan">, kept?: { tagline?: string; samples?: string[]; used?: number } | null): PlanView {
  return planViewFromTrainPlan({
    name: v.title,
    tagline: kept?.tagline ?? "",
    samples: kept?.samples ?? [],
    examples: { given: kept?.used ?? 0, used: kept?.used ?? 0 },
    settings: v.plan,
    cost: v.plan,
  });
}

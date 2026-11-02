/**
 * A training plan as the plan card shows it (components/build/PlanCard.tsx PlanView): the model's role and tagline, how
 * it's made in five steps, something it might be asked, and what it costs, with the estimates called estimates. Pure, so
 * the composer, the room and the tests share it.
 */
import type { PlanView } from "@/components/build/PlanCard";
import { roughMinutes, WRITER_NAME } from "@/components/train/format";
import { R30B_NAME } from "@/components/train/results";
import { usd } from "@/lib/format";
import { R30B_REPO } from "@/lib/train/base";
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
export function howItsMade(s: Pick<TuneSettings, "examples" | "base">, c: Pick<TrainPlanCost, "trainMinutes">, used = 0, given = used): string[] {
  const kept = evalHoldoutCount(s.examples);
  return [
    `${WRITER_NAME} writes ${s.examples} examples${styleOf(used, given)}, and keeps ${kept} aside to score it.`,
    "A quick check that there are enough to train on and to score with.",
    s.base
      ? `${s.base.repo} at commit ${s.base.revision.slice(0, 12)} trains on one GPU, ${roughMinutes(c.trainMinutes)}.`
      : `${R30B_NAME}, Muse Muse's own (huggingface.co/${R30B_REPO}), trains on one GPU, ${roughMinutes(c.trainMinutes)}.`,
    `${s.base ? "The base" : "The 2026 Glimmer it started from"} and the tuned model answer the ${kept} kept-aside prompts, and ${WRITER_NAME} scores both.`,
    s.base ? "Publish it if you like. Trying it live and local files only work on the 2026 Glimmer, so this base has neither." : "Try it live, then publish it if you like.",
  ];
}

export function planViewFromTrainPlan(p: Pick<TrainPlanBody, "name" | "tagline" | "samples" | "examples" | "settings" | "cost"> & Partial<Pick<TrainPlanBody, "source">>, upload?: string | null, visitor = false, fireworks = false): PlanView {
  const sample = p.samples.find((s) => s.trim());
  const steps = howItsMade(p.settings, p.cost, p.examples.used, p.examples.given);
  // A folder's rows train as they are, and anything else is written by Contributor from its files.
  if (p.source?.kind === "folder") {
    const kept = evalHoldoutCount(p.settings.examples);
    steps[0] =
      p.source.mode === "rows"
        ? `Your ${p.examples.given} rows go in as they are, with about ${kept} kept aside to score it. Nothing is written.`
        : `Spark 1.3 Contributor reads your files and writes ${p.settings.examples} examples, and keeps ${kept} aside to score it.`;
  }
  // Trying it live and publishing are for admins.
  if (visitor) steps[steps.length - 1] = "It stays on Muse Muse, private to you. Its scores show here.";
  if (fireworks) fireworksSteps(steps);
  return {
    name: roleTitle(p.name),
    tagline: p.tagline,
    sections: [
      { heading: "How it's made", steps },
      ...(sample ? [{ heading: "It might be asked", text: `"${sample.trim()}"` }] : []),
      ...(p.settings.base?.dutiesText ? [{ heading: "Its license", text: p.settings.base.dutiesText }] : []),
      ...(upload ? [{ heading: "Where it goes", text: upload }] : []),
      { heading: "What it costs", text: fireworks ? FIREWORKS_COST : `${planCostText(p.cost)} ${upperFirst(roughMinutes(p.cost.minutes))} in all.` },
    ],
  };
}

const FIREWORKS_COST = `Training and answering are priced from Fireworks' live pages, shown under Where it trains, and a run they don't confirm is refused. Writing and scoring are estimates at ${WRITER_NAME}'s prices. How long it takes depends on Fireworks' queue.`;

/** The plan's steps when it trains on Fireworks: on plain Muse Glimmer 30B, never r30b, and said so. */
function fireworksSteps(steps: string[]): void {
  steps[2] = "Plain Muse Glimmer 30B, not the 2026 Glimmer (r30b), trains on Fireworks' managed training.";
  steps[3] = steps[3]!.replace(/^(The base|The 2026 Glimmer it started from)/, "Plain Muse Glimmer 30B");
  steps[steps.length - 1] = "Its adapter stays on Fireworks. Muse Muse's local files and live demo don't use it yet.";
}

/**
 * A started run's plan, from the run itself. The tagline and the sample come from the browser that started it
 * (sessionStorage), when it still has them; the rest is the run's own.
 */
export function planViewFromRun(v: Pick<TuneRunView, "title" | "plan"> & Partial<Pick<TuneRunView, "trainer">>, kept?: { tagline?: string; samples?: string[]; used?: number } | null): PlanView {
  return planViewFromTrainPlan({
    name: v.title,
    tagline: kept?.tagline ?? "",
    samples: kept?.samples ?? [],
    examples: { given: kept?.used ?? 0, used: kept?.used ?? 0 },
    settings: v.plan,
    cost: v.plan,
  }, undefined, false, v.trainer === "fireworks");
}

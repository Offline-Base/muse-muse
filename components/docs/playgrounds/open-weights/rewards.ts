/**
 * The reward functions the RL recipes describe, and GRPO's group-relative advantages, so a reader can score real
 * samples and see which groups teach the model anything (cookbook/muse-spark-open-torchtitan-rl,
 * muse-spark-open/post-training "Miles", muse-glimmer/post-training "TitanRL" and "TRL"):
 *
 * - boxed: 1 if the last \boxed{} matches the answer (RewardMathVerify, Miles). A simplified check: Math-Verify also
 *   accepts equivalent forms this one doesn't, such as 1/2 for 0.5 in some layouts.
 * - exact: 1 if the reply equals the answer (the QA template's RewardExactMatch).
 * - answerTag: 1.0 if "<answer>" appears in the completion (the TRL GRPO page's example reward_fn).
 * - graded: the data-analyst rubric's tiers, minus 0.05 for each repeat of a command that already failed.
 */

/** The contents of the last \boxed{...}, matching nested braces, or null. */
export function lastBoxed(text: string): string | null {
  let found: string | null = null;
  let from = 0;
  for (;;) {
    const at = text.indexOf("\\boxed{", from);
    if (at < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = at + "\\boxed".length; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    found = text.slice(at + "\\boxed{".length, end);
    from = end + 1;
  }
  return found;
}

/** Spaces, $ signs, \text{} wrappers, thousands commas and a trailing period don't change an answer. */
export function normalizeAnswer(s: string): string {
  let t = s.trim();
  t = t.replace(/^\$+|\$+$/g, "");
  t = t.replace(/\\text\{([^}]*)\}/g, "$1");
  t = t.replace(/\\[,;!]/g, "");
  t = t.replace(/\s+/g, "");
  t = t.replace(/\.$/, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  return t;
}

function numberOf(s: string): number | null {
  const frac = /^(-?\d+)\/(\d+)$/.exec(s) ?? /^\\frac\{(-?\d+)\}\{(\d+)\}$/.exec(s) ?? /^\\dfrac\{(-?\d+)\}\{(\d+)\}$/.exec(s);
  if (frac) return Number(frac[2]) === 0 ? null : Number(frac[1]) / Number(frac[2]);
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

export function sameAnswer(a: string, b: string): boolean {
  const x = normalizeAnswer(a);
  const y = normalizeAnswer(b);
  if (x === y) return true;
  const nx = numberOf(x);
  const ny = numberOf(y);
  return nx !== null && ny !== null && Math.abs(nx - ny) < 1e-9;
}

export interface Scored {
  reward: number;
  why: string;
}

export function rewardBoxed(reply: string, answer: string): Scored {
  const boxed = lastBoxed(reply);
  if (boxed === null) return { reward: 0, why: "No \\boxed{} answer in the reply." };
  return sameAnswer(boxed, answer) ? { reward: 1, why: `\\boxed{${boxed}} matches ${answer}.` } : { reward: 0, why: `\\boxed{${boxed}} doesn't match ${answer}.` };
}

export function rewardExact(reply: string, answer: string): Scored {
  return reply.trim() === answer.trim() ? { reward: 1, why: "The reply equals the answer." } : { reward: 0, why: "The reply isn't exactly the answer." };
}

export function rewardAnswerTag(completion: string): Scored {
  return completion.includes("<answer>") ? { reward: 1, why: "The completion has an <answer> tag." } : { reward: 0, why: "No <answer> tag." };
}

/** The data-analyst rubric's outcomes (muse-glimmer/post-training, "How the reward works"). */
export type AnalystOutcome = "correct" | "wrongNumber" | "malformed" | "ranCommand" | "nothing";

export interface AnalystTiers {
  correct: number;
  wrongNumber: number;
  malformed: number;
  ranCommand: number;
  nothing: number;
  repeatPenalty: number;
}

/** The page's tiers. rubric.py names two of them file_exists_credit and file_parses_credit, and the penalty repeated_failing_command_penalty. */
export const ANALYST_TIERS: AnalystTiers = { correct: 1.0, wrongNumber: 0.25, malformed: 0.15, ranCommand: 0.05, nothing: 0, repeatPenalty: 0.05 };

export const ANALYST_LABELS: Record<AnalystOutcome, string> = {
  correct: "Correct number in answer.json",
  wrongNumber: "Well-formed file, wrong number",
  malformed: "File written but malformed",
  ranCommand: "At least one command ran successfully",
  nothing: "Nothing",
};

export function rewardAnalyst(outcome: AnalystOutcome, repeats: number, tiers: AnalystTiers = ANALYST_TIERS): Scored {
  const base = tiers[outcome];
  const reward = Math.round((base - Math.max(0, repeats) * tiers.repeatPenalty) * 1000) / 1000;
  return { reward, why: `${ANALYST_LABELS[outcome]}: ${base}${repeats > 0 ? `, minus ${tiers.repeatPenalty} × ${repeats} repeated failed command${repeats === 1 ? "" : "s"}` : ""}.` };
}

export interface GroupStats {
  mean: number;
  std: number;
  advantages: number[];
  /** Every reward the same: the group has no variance and teaches nothing (Batcher drops it). */
  noSignal: boolean;
}

/** GRPO's group-relative advantage: each reward minus the group mean, over the group's standard deviation. */
export function grpoAdvantages(rewards: number[]): GroupStats {
  if (!rewards.length) return { mean: 0, std: 0, advantages: [], noSignal: true };
  const mean = rewards.reduce((s, r) => s + r, 0) / rewards.length;
  const variance = rewards.reduce((s, r) => s + (r - mean) ** 2, 0) / rewards.length;
  const std = Math.sqrt(variance);
  const noSignal = std < 1e-9;
  return { mean, std, advantages: rewards.map((r) => (noSignal ? 0 : (r - mean) / (std + 1e-6))), noSignal };
}

const PAIRS_PROBLEM =
  "Let S be the set of ordered pairs (a, b) of positive integers with a ≤ 30 and b ≤ 30 such that a² + b² is divisible by 5. How many pairs are in S?";

/**
 * DAPO-style math prompts with known answers, for the live group, each with the token budget that makes its point on
 * hosted Muse Spark at low reasoning. Measured through the docs proxy on Oct 30, 2026: every rollout that finished, on
 * these and on ten harder candidates (five AIME 2025 problems among them, up to 7,000 tokens), had the right answer,
 * so a group with room has no reward spread. At 950 tokens most pair-counting rollouts are cut off before their answer
 * (finish_reason length), sometimes all of them: any spread there is truncation, a length penalty, which the recipe
 * avoids ("rollouts are never cut off"), so the preset says so instead of passing it off as a signal.
 */
export const MATH_PROBLEMS = [
  {
    id: "room",
    label: "Room to finish: no signal",
    problem: PAIRS_PROBLEM,
    answer: "324",
    budget: 2000,
  },
  {
    id: "tight",
    label: "Too small a budget: truncation",
    problem: PAIRS_PROBLEM,
    answer: "324",
    budget: 950,
  },
  {
    id: "counting",
    label: "Another counting problem",
    problem: "How many positive integers less than 1000 are divisible by 7 but not by 11?",
    answer: "130",
    budget: 1500,
  },
] as const;

export interface GroupSample {
  reward: number;
  /** The rollout's finish_reason: "length" when max_tokens cut it off. */
  finish: string | null;
}

export type GroupKind = "noSignal" | "truncation" | "mixed";

export interface GroupReading {
  kind: GroupKind;
  /** Samples below the group mean, and how many of them the budget cut off. */
  low: number;
  truncatedLow: number;
  /** Every sample cut off. */
  allTruncated: boolean;
}

/**
 * Where a scored group's spread comes from (cookbook/muse-spark-open-torchtitan-rl, "Reward spread" and with_task).
 * All-equal rewards teach nothing. A spread whose every below-mean sample is a rollout the budget cut off teaches a
 * length penalty rather than correctness, since GRPO would reinforce the answers that happened to be short.
 */
export function readGroup(samples: GroupSample[]): GroupReading {
  const stats = grpoAdvantages(samples.map((s) => s.reward));
  const allTruncated = samples.length > 0 && samples.every((s) => s.finish === "length");
  if (stats.noSignal) return { kind: "noSignal", low: 0, truncatedLow: 0, allTruncated };
  const below = samples.filter((s) => s.reward < stats.mean);
  const truncatedLow = below.filter((s) => s.finish === "length").length;
  return { kind: truncatedLow === below.length ? "truncation" : "mixed", low: below.length, truncatedLow, allTruncated };
}

export function mathPrompt(problem: string): string {
  return `${problem}\n\nSolve it step by step, then give the final answer as "Answer: \\boxed{...}".`;
}

// ---------------------------------------------------------------------------------------------------------------
// The live group's rewards and prompts (GrpoLab)

/** Which reward a group is scored with. */
export type RewardScheme = "boxed" | "exact" | "answerTag" | "answerMatch" | "graded";

/** Short enough for one pill on a phone; where each comes from is in SCHEME_SOURCE, shown under the pills. */
export const SCHEME_LABEL: Record<RewardScheme, string> = {
  boxed: "Last \\boxed{} matches",
  exact: "Reply equals the answer",
  answerTag: "Has an <answer> tag",
  answerMatch: "<answer> matches",
  graded: "Data-analyst tiers",
};

export const SCHEME_SOURCE: Record<RewardScheme, string> = {
  boxed: "RewardMathVerify in the TorchTitan recipe; Miles scores the same way.",
  exact: "RewardExactMatch, the QA template's reward.",
  answerTag: "The TRL page's example reward_fn.",
  answerMatch: "A verifiable reward: the tag's contents against the reference answer.",
  graded: "TitanRL's data-analyst rubric.",
};

/** The text inside the last <answer>...</answer>, or null. */
export function answerTagContent(text: string): string | null {
  const all = [...text.matchAll(/<answer>([\s\S]*?)<\/answer>/g)];
  return all.length ? all[all.length - 1][1].trim() : null;
}

/** Scores one reply. Graded (data-analyst) rewards depend on what a rollout did, so they're scored by outcome instead. */
export function score(scheme: RewardScheme, reply: string, answer: string): Scored {
  if (scheme === "boxed") return rewardBoxed(reply, answer);
  if (scheme === "exact") return rewardExact(reply, answer);
  if (scheme === "answerTag") return rewardAnswerTag(reply);
  if (scheme === "answerMatch") {
    const got = answerTagContent(reply);
    if (got === null) return { reward: 0, why: "No <answer>...</answer> in the reply." };
    return sameAnswer(got, answer) ? { reward: 1, why: `<answer>${got}</answer> matches.` } : { reward: 0, why: `<answer>${got}</answer> doesn't match ${answer}.` };
  }
  return { reward: 0, why: "Graded rewards are scored by outcome in the playground." };
}

/** The prompt a group is sampled with: the instruction matches what the reward reads. */
export function promptFor(scheme: RewardScheme, problem: string): string {
  if (scheme === "answerTag" || scheme === "answerMatch") return `${problem}\n\nThink it through, then put only the final answer in <answer></answer>.`;
  if (scheme === "exact") return `${problem}\n\nReply with only the final answer, nothing else.`;
  return mathPrompt(problem);
}


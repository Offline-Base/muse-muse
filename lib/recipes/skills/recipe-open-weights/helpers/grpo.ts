/**
 * GRPO's signal, in code (cookbook/muse-spark-open-torchtitan-rl): rewards a task can check, group-relative advantages,
 * and whether a group teaches anything. No model call and no network: the product samples, this scores.
 */

/** The contents of the last \boxed{...}, matching nested braces, or null. */
export function lastBoxed(text: string): string | null {
  let found: string | null = null;
  let from = 0;
  for (;;) {
    const at = text.indexOf("\\boxed{", from);
    if (at < 0) return found;
    let depth = 0;
    let end = -1;
    for (let i = at + 6; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) return found;
    found = text.slice(at + 7, end);
    from = end + 1;
  }
}

/** Spaces, $ signs, \text{} wrappers, thousands commas and a trailing period don't change an answer. */
export function normalizeAnswer(s: string): string {
  let t = s.trim().replace(/^\$+|\$+$/g, "").replace(/\\text\{([^}]*)\}/g, "$1").replace(/\s+/g, "").replace(/\.$/, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  return t;
}

export function numberOf(s: string): number | null {
  const t = normalizeAnswer(s);
  const frac = /^(-?\d+)\/(\d+)$/.exec(t) ?? /^\\d?frac\{(-?\d+)\}\{(\d+)\}$/.exec(t);
  if (frac) return Number(frac[2]) === 0 ? null : Number(frac[1]) / Number(frac[2]);
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

export type RewardKind = "exact" | "boxed" | "number";

export interface Scored {
  reward: number;
  why: string;
}

/** exact: the reply equals the answer (the template's RewardExactMatch). boxed: the last \boxed{} matches. number: the last number in the reply is within tolerance. */
export function score(kind: RewardKind, reply: string, answer: string, tolerance = 0): Scored {
  if (kind === "exact") return reply.trim() === answer.trim() ? { reward: 1, why: "The reply equals the answer." } : { reward: 0, why: "The reply isn't exactly the answer." };
  if (kind === "boxed") {
    const boxed = lastBoxed(reply);
    if (boxed === null) return { reward: 0, why: "No \\boxed{} answer in the reply." };
    const same = normalizeAnswer(boxed) === normalizeAnswer(answer) || (numberOf(boxed) !== null && numberOf(boxed) === numberOf(answer));
    return same ? { reward: 1, why: `\\boxed{${boxed}} matches ${answer}.` } : { reward: 0, why: `\\boxed{${boxed}} doesn't match ${answer}.` };
  }
  const nums = reply.replace(/(\d),(\d{3})/g, "$1$2").match(/-?\d+(\.\d+)?/g);
  const want = numberOf(answer);
  if (want === null) return { reward: 0, why: `The answer ${answer} isn't a number, so use exact match.` };
  if (!nums?.length) return { reward: 0, why: "No number in the reply." };
  const got = Number(nums[nums.length - 1]);
  return Math.abs(got - want) <= tolerance ? { reward: 1, why: `${got} is within ${tolerance} of ${want}.` } : { reward: 0, why: `${got} isn't within ${tolerance} of ${want}.` };
}

/** Asks for the boxed form the boxed reward reads. */
export function boxedPrompt(question: string): string {
  return `${question}\n\nSolve it step by step, then give the final answer as "Answer: \\boxed{...}".`;
}

export interface GroupStats {
  mean: number;
  std: number;
  advantages: number[];
  /** Every reward the same: no variance, so the group teaches nothing and the Batcher drops it. */
  noSignal: boolean;
}

/** GRPO's group-relative advantage: each reward minus the group mean, over the group's standard deviation. */
export function grpoAdvantages(rewards: readonly number[]): GroupStats {
  if (!rewards.length) return { mean: 0, std: 0, advantages: [], noSignal: true };
  const mean = rewards.reduce((s, r) => s + r, 0) / rewards.length;
  const std = Math.sqrt(rewards.reduce((s, r) => s + (r - mean) ** 2, 0) / rewards.length);
  const noSignal = std < 1e-9;
  return { mean, std, advantages: rewards.map((r) => (noSignal ? 0 : (r - mean) / (std + 1e-6))), noSignal };
}

export interface Sample {
  reward: number;
  /** The reply hit its output limit before it finished. */
  cutOff: boolean;
}

export type GroupKind = "no-signal" | "truncation" | "learns";

/**
 * no-signal: all rewards equal. truncation: every below-mean sample was cut off, so the spread teaches shortness, not
 * correctness (the recipe sets the budget so rollouts are never cut off). learns: a real spread.
 */
export function readGroup(samples: readonly Sample[]): { kind: GroupKind; stats: GroupStats } {
  const stats = grpoAdvantages(samples.map((s) => s.reward));
  if (stats.noSignal) return { kind: "no-signal", stats };
  const below = samples.filter((s) => s.reward < stats.mean);
  return { kind: below.every((s) => s.cutOff) ? "truncation" : "learns", stats };
}

export interface SpreadSummary {
  groups: number;
  learns: number;
  allRight: number;
  allWrong: number;
  truncation: number;
  /** Written by code from the counts, never by a model. */
  verdict: string;
}

export function summarizeSpread(groups: ReadonlyArray<readonly Sample[]>): SpreadSummary {
  let learns = 0, allRight = 0, allWrong = 0, truncation = 0;
  for (const g of groups) {
    const { kind, stats } = readGroup(g);
    if (kind === "learns") learns++;
    else if (kind === "truncation") truncation++;
    else if (stats.mean >= 1) allRight++;
    else allWrong++;
  }
  const n = groups.length;
  const share = n ? learns / n : 0;
  const verdict = !n
    ? "No groups scored yet."
    : truncation > 0 && truncation >= learns
      ? "Most of the spread comes from replies cut off by the token limit. Raise the limit before reading anything into it."
      : share >= 0.5
        ? `${learns} of ${n} prompts gave a spread of rewards, so this task gives GRPO something to learn from on the model sampled here.`
        : allRight > allWrong
          ? `Only ${learns} of ${n} prompts gave a spread: the model sampled here already solves most of them. Add harder prompts, or a graded reward.`
          : `Only ${learns} of ${n} prompts gave a spread: most groups got nothing right. Add easier prompts, or a graded reward.`;
  return { groups: n, learns, allRight, allWrong, truncation, verdict };
}

/** The task rows in the QA template's shape, one {question, answer} a line. */
export function qaJsonl(rows: ReadonlyArray<{ question: string; answer: string }>): string {
  return rows.map((r) => JSON.stringify({ question: r.question, answer: r.answer })).join("\n") + (rows.length ? "\n" : "");
}

/** The page's registration of a copied task on the Muse Spark Open system, and the commands to run it. */
export function withTaskSnippet(name: string): string {
  const id = name.replace(/[^a-z0-9_]/gi, "_").toLowerCase() || "my_task";
  return [
    "# cp qa_task.py my_task.py, change its sample, dataset, env and reward, then in rl.py:",
    `def muse_spark_${id}() -> Controller.Config:`,
    "    return with_task(",
    "        muse_spark_dapo_math(),",
    '        my_task(train_path="/data/train.jsonl", validation_path="/data/val.jsonl"),',
    `        dump_folder="outputs/rl/muse_spark_${id}",`,
    "    )",
    "",
    "# Bring-up first (five on-policy steps), then your task:",
    "python -m torchtitan.rl.train --module rl --config muse_spark_dapo_math",
    `python -m torchtitan.rl.train --module rl --config muse_spark_${id}`,
    "",
  ].join("\n");
}

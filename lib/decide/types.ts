import type { EvalSummary, TrainExample } from "@/lib/train/types";

/**
 * The contract for Glimmer decision models (docs/DECISION_MODELS.md). A decision maps one input, the state, to one
 * choice from a fixed set, with a probability for each choice. Training rows, eval prompts, gateway prompts and
 * decide.json all come from these shapes and the functions in lib/decide/format.ts, so the bytes are the same
 * everywhere.
 *
 * Types only: other units (scoring, datasets, the GPU, the gateway, wave 3's units 11 and 12) build on them.
 */

/** A shown option's letter, by position. A prompt shows at most 5 options, `none` included. */
export type DecideLetter = "A" | "B" | "C" | "D" | "E";

/** One message of a rendered prompt, the shape glimmer-lora trains on. */
export type DecideMessage = TrainExample["messages"][number];

/** One of a person's choices, as they defined it. `id` is made from the name (labelId in format.ts). */
export interface DecisionLabel {
  id: string;
  /** 1 to 60 characters, unique ignoring case, never the `none` text. */
  name: string;
  /** Up to 200 characters; empty when the person gave none. */
  description: string;
}

/** A label as one prompt shows it. `description` is left out when empty. */
export interface DecideOption {
  letter: DecideLetter;
  option: string;
  description?: string;
}

/** One decision task, serialized with JSON.stringify in this key order: the bytes the model reads, twice. */
export interface DecideTask {
  /** The input to judge, 1 to 3,000 characters, with every "<|" already turned into "< |". */
  state: string;
  /** What to decide, 5 to 300 characters. A person's model has one fixed question. */
  question: string;
  /** 2 to 5 options, lettered A on in order; `none`, when shown, is last. */
  options: DecideOption[];
}

/**
 * One row turned into one prompt: its task, and which label each letter stands for. The platform keeps `labelIds`;
 * the GPU only ever sees the task and the letters, so it can't grade itself.
 */
export interface DecideRendering {
  task: DecideTask;
  /** The letters shown, A on, one per option. */
  letters: DecideLetter[];
  /** The label id behind each letter, in letter order; null for `none`. */
  labelIds: Array<string | null>;
  /** The right letter, when the row's label is known (training, dev and test); `none`'s letter when it isn't shown. */
  answer?: DecideLetter;
}

/** A dev or test item as the GPU reads it from the dataset route (part=dev or part=eval): no answer. */
export interface DecideItem {
  /** Position in the part, 0 on. */
  index: number;
  /** The row in its split this item renders. */
  row: number;
  /** Which group of the row (0 on), for a model with more than 4 labels. */
  group: number;
  messages: DecideMessage[];
  letters: DecideLetter[];
}

/**
 * The platform's own record of one dev or test item: which row and group it renders, which label each letter stands
 * for, and whether it is a decline check rendering. The GPU never sees it. Made by decisionItems in format.ts, which the
 * dataset route serves from and summarizeDecisions reads, so the two always agree on what each index means.
 */
export interface DecisionItemKey {
  /** Position in the part, 0 on: the index the GPU's scores come back with. */
  index: number;
  /** The row in its split. */
  row: number;
  /** Which group of the row, 0 on. */
  group: number;
  /** The label id behind each letter, in letter order; null for `none`. */
  labelIds: Array<string | null>;
  /** True for the decline check: the row's label is taken out, so `none` is the right answer. Test only. */
  decline: boolean;
}

/** A dev or test item with its rendering: decideItem(index, row, group, rendering) is what the GPU gets. */
export interface DecisionPartItem extends DecisionItemKey {
  rendering: DecideRendering;
}

/**
 * One scored item in a "decide" event (ctx.decide on the GPU): log-probabilities of each shown letter, in order, from
 * a float32 log_softmax. JSON can't carry -Infinity, so a letter with no probability is sent as a large negative
 * number. A side whose numbers can't be log-probabilities (logprobsProblem in format.ts) leaves its row unscored.
 */
export interface DecideScoreItem {
  index: number;
  base: number[];
  /** Null when the job only scored the base (scoreOnly 1) or the tuned pass failed. */
  tuned: number[] | null;
  baseMass: number;
  tunedMass: number | null;
}

/** One label's probability in a decision. */
export interface DecisionProbability {
  option: string;
  id: string;
  p: number;
}

/**
 * What a decision answers: the pick and every label's probability, after combining groups and then T. The pick is made
 * before T, so T never changes it.
 */
export interface Decision {
  /** The picked label's name, or null when "None of the listed options matches" won. */
  decision: string | null;
  /** The picked label's id, or null when `none` won. */
  id: string | null;
  /** The pick's probability (the `none` probability when `none` won). */
  confidence: number;
  /** Every label, in the order the person defined them. With `none`, they sum to 1 - none. */
  probabilities: DecisionProbability[];
  /** The probability of `none`: 0 when it wasn't shown. */
  none: number;
}

/** {GATEWAY_URL}/decide's 200 answer, and what the template helper decide() returns. */
export interface DecideReply extends Decision {
  /**
   * "muse-decide", a decision model's training job id, or "stand-in" for build tokens. Until Muse Decide is trained,
   * a muse-decide call is base Glimmer zero-shot and says so: "muse-glimmer-30b-zero-shot" (lib/gateway/decide.ts).
   */
  model: string;
  /** True only when T was fit on 20 or more dev rows. */
  calibrated: boolean;
  /** True for the build-time stand-in (word overlap), which is not a model. */
  simulated: boolean;
  ms: number;
  /** A sentence when something about the answer needs saying (options a person's model never learned), else null. */
  note: string | null;
}

/** The error codes {GATEWAY_URL}/decide answers with, beyond plain 400s. */
export type DecideErrorCode =
  | "decide_not_allowed"
  | "decide_offline"
  | "unknown_model"
  | "rate_limited"
  | "decide_unavailable"
  | "timeout";

// ---------------------------------------------------------------------------------------------------------------
// The backend a serving window implements (wave 3 unit 11's shared endpoint, or a glimmer-serve job's /decide)

/** One prompt to score: the messages the lab's /decide takes, and the same prompt as text for llama.cpp. */
export interface DecidePrompt {
  /** [system, user]: the decide system message and the task twice (decideMessages in format.ts). */
  messages: DecideMessage[];
  /**
   * The prompt through Glimmer's chat template at reasoning strength low with the final channel open (glimmerPrompt in
   * format.ts), without the leading <|begin_of_text|>, since tokenizers and llama-server add it.
   */
  text: string;
}

export interface DecideScoreInput {
  /** 1 to 3 prompts, one per group of a row's labels. */
  prompts: DecidePrompt[];
  /** letters[i] is what prompts[i] shows, in order. */
  letters: DecideLetter[][];
  /** The decision model's training job id (its adapter), or null for base Glimmer zero-shot. */
  adapter: string | null;
  /** Aborted when the gateway's time is up; a backend stops waiting then. */
  signal?: AbortSignal;
}

export interface DecideScores {
  /**
   * logprobs[i][j]: the log of the first answer token's probability on letter j of prompt i, its bare token and its
   * space-led token summed, read from the full vocabulary or, with llama.cpp's n_probs, from the top tokens (a letter
   * not among them gets an even share of the mass left over, capped at the smallest letter seen). Not renormalized:
   * the platform renormalizes, combines groups and applies T, and reads letter mass from these. It refuses a prompt's
   * numbers when they can't be log-probabilities (logprobsProblem in format.ts): more than all the probability (as
   * probabilities or raw logits sent in their place would be), or none on any letter.
   */
  logprobs: number[][];
  /** GPU time for the call. */
  ms: number;
}

/**
 * What {GATEWAY_URL}/decide calls to score prompts. The gateway's deps hand it one per serving window, or null when no
 * window is open (503 decide_offline), the way /gadget's deps hand it a board. score rejects when it can't answer:
 * the handler answers 504 timeout once `signal` aborted, else 502 decide_unavailable. One route and one format for
 * every backend.
 */
export interface DecideBackend {
  score(input: DecideScoreInput): Promise<DecideScores>;
}

// ---------------------------------------------------------------------------------------------------------------
// The dataset (kind "decision") and its rows

export interface DecideSplitCounts {
  train: number;
  dev: number;
  test: number;
}

/** training_datasets.decision for a dataset of kind "decision". */
export interface DecisionSpec {
  version: 1;
  question: string;
  labels: DecisionLabel[];
  /** Orders rows within each label before the split, and seeds every training rendering's shuffle. */
  seed: string;
  /** Rows in each split. */
  split: DecideSplitCounts;
  /** Rows in each split, per label id. */
  perLabel: Record<string, DecideSplitCounts>;
  source: "person" | `public:${string}`;
}

/** One labeled row: the input and its label's id. */
export interface DecisionRow {
  input: string;
  label: string;
}

/** training_datasets.decision_rows. */
export interface DecisionRows {
  train: DecisionRow[];
  dev: DecisionRow[];
  test: DecisionRow[];
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring (summarizeDecisions in lib/train/logic.ts)

/** One part of a decide job (dev or test) as summarizeDecisions reads it. */
export interface DecisionPartInput {
  /** The split's rows, in order: each item's `row` indexes them. */
  rows: readonly DecisionRow[];
  /** The part's layout, the same the dataset route served the GPU (decisionItems in format.ts). */
  items: readonly DecisionItemKey[];
  /** What the GPU sent for the part ("decide" events), in any order. A repeated index counts once, the first. */
  scores: readonly DecideScoreItem[];
}

/** Everything summarizeDecisions needs: no I/O, so the same input always gives the same summary. */
export interface DecisionScoringInput {
  /** The decision's labels, in the order the person defined them. */
  labels: readonly DecisionLabel[];
  /** Train rows per label id (DecisionSpec.perLabel[id].train), for the commonest-label baseline. */
  trainCounts: Readonly<Record<string, number>>;
  /** Dev rows: only used to fit T. */
  dev: DecisionPartInput;
  /** Test rows: every number on the results page. */
  test: DecisionPartInput;
  /** Renderings the GPU dropped as over MAX_SEQ_LENGTH tokens (its too_long metric). */
  tooLong?: number;
}

/** One row for fitting T: its options' probabilities before T (labels in order, then `none`), and which is right. */
export interface CalibrationRow {
  p: readonly number[];
  right: number;
}

/** A share with its Wilson 95% interval. */
export interface WilsonRate {
  right: number;
  total: number;
  rate: number;
  low: number;
  high: number;
}

export interface LabelScore {
  id: string;
  name: string;
  precision: number;
  recall: number;
  f1: number;
  /** Test rows with this label. */
  support: number;
}

/**
 * One of 10 equal-width bins of the top probability: from `from` up to but not including `to`, except that the last bin
 * also holds 1. An empty bin has accuracy and confidence 0.
 */
export interface ReliabilityBin {
  from: number;
  to: number;
  rows: number;
  accuracy: number;
  confidence: number;
}

/** One model's numbers on the test rows: base Glimmer, or the tuned adapter. */
export interface DecisionSideSummary {
  accuracy: WilsonRate;
  /** Mean of each label's F1; a `none` pick is a miss, not a class. */
  macroF1: number;
  perLabel: LabelScore[];
  /** Rows are the right label, columns the pick, both in label order, plus a last `none` column. */
  confusion: number[][];
  /** Share of test rows answered `none`. */
  noneRate: number;
  /** On the test renderings with the right label taken out, how many answered `none`. Null when none were scored. */
  decline: { rows: number; declined: number; rate: number } | null;
  /**
   * Fit on dev only (fitTemperature), 0.25 to 10, 4 decimals. 1 when under 20 dev rows were scored, or when no other
   * T lowers dev log loss.
   */
  T: number;
  /** True when T was fit: 20 or more dev rows scored. */
  calibrated: boolean;
  /** Expected calibration error on test, raw and with T. */
  ece: { raw: number; withT: number };
  /** The 10 bins with T, for the reliability chart. */
  reliability: ReliabilityBin[];
  /** Over the test renderings behind the scored rows (decline renderings included); 0 when there are none. */
  letterMass: { median: number; min: number };
}

/**
 * A decide job's eval_summary. It extends EvalSummary so every list and gate that reads a judged summary works: `items`
 * is the test rows, `tunedWins` the rows tuned got right and base got wrong, `baseWins` the reverse, `ties` the rest,
 * and avgBaseScore, avgTunedScore and judgeCostUsd are 0. `kind` tells pages to show these numbers instead.
 */
export interface DecisionSummary extends EvalSummary {
  kind: "decision";
  labels: Array<{ id: string; name: string }>;
  /** Prompts per row: ceil(labels / 4). Over 1, the page says the group rule's calibration is only what test shows. */
  groups: number;
  /** Rows in the dataset's dev split. */
  devRows: number;
  /** Rows in the dataset's test split. `items` of them were scored; the rest are unscoredRows. */
  testRows: number;
  /**
   * Test rows left out of every number because one of their renderings has no usable score (too long, or never sent)
   * for base, or for tuned when tuned was scored. Base and tuned are always compared on the same rows.
   */
  unscoredRows: number;
  /** Renderings over MAX_SEQ_LENGTH tokens, dropped by the GPU and counted. */
  tooLong: number;
  base: DecisionSideSummary;
  /** Null for a scoreOnly job, or when the tuned pass failed. */
  tuned: DecisionSideSummary | null;
  baselines: {
    /** Always picking the commonest train label. */
    commonest: { id: string; accuracy: WilsonRate };
    /** The word-overlap stand-in (standInDecision in format.ts). */
    standIn: { accuracy: WilsonRate };
  };
  /**
   * Only when no test row was scored (`items` 0): why there are no results, in a sentence, as an unjudged summary's
   * note says it (unjudgedNote in lib/train/logic.ts reads it). scoreDecisionStep sets it.
   */
  note?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// decide.json: the format's contract, next to a decision model's adapter and GGUF files

/**
 * decide.json. Any app renders the model's prompts and reads its answer from this file alone, by `rules`: one prompt
 * per entry of `groups`, each prompt.prefix + task + separator + task + prompt.suffix, where task is the JSON of
 * {state, question, options} with "<|" neutralized and empty descriptions left out. Built by decideJson in format.ts.
 */
export interface DecideJson {
  format: "muse-decide/1";
  system: string;
  separator: string;
  letters: DecideLetter[];
  none: string;
  question: string;
  /** In the order the person defined them. A description is "" when there is none; the prompt leaves it out then. */
  labels: DecisionLabel[];
  T: number;
  /** The most labels one prompt shows. `groups` says which. */
  groupsOf: 4;
  /**
   * The label ids each prompt shows, in order, one list per prompt (labelGroups of `labels`): one list for 4 labels or
   * fewer, else lists whose sizes differ by at most 1, the larger first (5 labels are 3 and 2).
   */
  groups: string[][];
  /** How to render the prompts and read the answer, in plain sentences (DECIDE_RULES in format.ts). */
  rules: string[];
  template: { repo: string; revision: string; sha256: string };
  /** The template's text around the task, for the system message above, without the leading <|begin_of_text|>. */
  prompt: { prefix: string; suffix: string };
  maxTokens: 2048;
  read: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Serving a decision model (docs/DECISION_MODELS.md "Serving and use", D7)

/** One item a glimmer-serve job's POST /decide scores: a rendering's [system, user] messages and its letters. */
export interface DecideServeItem {
  messages: DecideMessage[];
  letters: DecideLetter[];
}

/**
 * What a decision model's demo server answers for 1 to 3 items: each item's letters' log-probabilities from the first
 * answer token (bare and space-led summed, floored at -10,000, not renormalized), base Glimmer's with the adapter off
 * and the tuned model's, in the items' order, and each item's letter mass.
 */
export interface DecideLiveScores {
  base: number[][];
  tuned: number[][];
  baseMass: number[];
  tunedMass: number[];
  ms: number;
}

/** One model's pick in the Try it live box of a decision model: the decision after T, and whether T was fit. */
export interface DecideTryPick extends Decision {
  calibrated: boolean;
  /** The share of first-token probability on the shown letters, averaged over the prompts (a health number). */
  mass: number;
}

/** POST /api/lab/{id}/decide's answer: base Glimmer's and the tuned model's pick for one input, from the same GPU. */
export interface DecideTryAnswer {
  base: DecideTryPick;
  tuned: DecideTryPick;
  ms: number;
}

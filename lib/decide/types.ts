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

/** One scored item in a "decide" event (ctx.decide on the GPU): log-probabilities of each shown letter, in order. */
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

/** What a decision answers: the pick and every label's probability, after T and after combining groups. */
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
  /** "muse-decide", a decision model's training job id, or "stand-in" for build tokens. */
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
   * the platform renormalizes, applies T and combines groups, and reads letter mass from these.
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

/** One of 10 equal-width bins of the top probability. */
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
  /** Fit on dev only, 0.25 to 10; 1 when there were under 20 dev rows. */
  T: number;
  /** True when T was fit. */
  calibrated: boolean;
  /** Expected calibration error on test, raw and with T. */
  ece: { raw: number; withT: number };
  /** The 10 bins with T, for the reliability chart. */
  reliability: ReliabilityBin[];
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
  devRows: number;
  testRows: number;
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
}

// ---------------------------------------------------------------------------------------------------------------
// decide.json: the format's contract, next to a decision model's adapter and GGUF files

/**
 * decide.json. Any app renders the model's prompt from it: prompt.prefix + task + separator + task + prompt.suffix,
 * where task is JSON.stringify of {state, question, options} with the options lettered from `letters` and `none`
 * last. Built by decideJson in format.ts.
 */
export interface DecideJson {
  format: "muse-decide/1";
  system: string;
  separator: string;
  letters: DecideLetter[];
  none: string;
  question: string;
  labels: DecisionLabel[];
  T: number;
  groupsOf: 4;
  template: { repo: string; revision: string; sha256: string };
  /** The template's text around the task, for the system message above, without the leading <|begin_of_text|>. */
  prompt: { prefix: string; suffix: string };
  maxTokens: 2048;
  read: string;
}

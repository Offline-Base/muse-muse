/**
 * Pure helpers for publishing a tuned Muse Glimmer adapter to the Hugging Face Hub (docs/TRAINING.md "Hugging Face
 * Hub"): the repo names, the model card and the dataset card, the story's prompt, its checks and its fallback, the
 * JSONL exports of a dataset, the run's record, and the rules of a job's hub state. No I/O, so lib/train/hub-steps.ts
 * and the routes share them and tests run them directly.
 *
 * Every number in a card comes from the platform's records (the job, its done metrics, its eval summary, its dataset)
 * or from the glimmer-lora recipe's own source, never from a model. So does every model a card names: the dataset's
 * writer_model and the job's judge_model, each Muse Spark 1.3 when the record has none (lib/train/models.ts). The story
 * is the one part a model writes: it is asked for no numbers and no result at all (the card's own sentence after it
 * gives the counts and the result, see resultText), and storyProblem turns down one with a number, a count word, a
 * claim about the result or about Meta, or markup, so the template's story is used instead.
 */
import { noEmDashes, slugify } from "@/lib/brief/normalize";
import { decideJson, GLIMMER_REASONING, GLIMMER_TEMPLATE, LABELS_PER_PROMPT, labelGroups, NONE_OPTION, NONE_SHARE } from "@/lib/decide/format";
import type { DecideJson, DecisionSideSummary, DecisionSpec, DecisionSummary, WilsonRate } from "@/lib/decide/types";
import { plural } from "@/lib/format";
import { BUILT_WITH_SPARK_OPEN, isSparkOpenDerivative, licenseDuties, R30B_REPO, R30B_URL, USAGE_POINTS } from "@/lib/train/base";
import { checkSetOf } from "@/lib/train/general-checks";
import { BUILD_LEVELS, LOW_BIT_LEVEL, QUANT_LEVELS, type BuildLevel, type LocalFile, type LocalFiles, type LowBitFile, type QuantLevel } from "@/lib/train/local-files";
import { LOW_BIT_FACTS, quantBaseForAdapter, quantBaseOf } from "@/lib/train/quant-targets";
import { defaultModel, SPARK_STANDIN } from "@/lib/meta/spark";
import { isDecisionSummary, modelName, PUBLIC_WRITER, recordedModel, UNRECORDED_MODEL, writerModelOf } from "@/lib/train/models";
import {
  datasetSystemPrompt,
  DECIDE_MODE,
  jobMode,
  NEAR_DUPLICATE_JACCARD,
  QUANT_CHANNEL_MIN,
  quantKlLimit,
  trainChannelOf,
  unjudgedNote,
  type DoneMetrics,
  type TrainJobRow,
} from "@/lib/train/logic";
import {
  HUB_FILE_MAX_BYTES,
  HUB_FILE_NAMES,
  HUB_GGUF_FILE_MAX_BYTES,
  HUB_GGUF_SMALL_NAMES,
  QUANT_RECIPE,
  type EvalExample,
  type EvalSummary,
  type HubFile,
  type HubState,
  type TrainEventView,
  type TrainExample,
} from "@/lib/train/types";

/** The public site the cards link to: Muse Muse and each job's public lab page. */
export const MUSE_MUSE_SITE = "https://muse-muse.vercel.app";
/**
 * The Hub the cards link to: the repos, the base model, its Usage Policy. Always the public Hub over https, whatever
 * HF_ENDPOINT says (that only changes where the platform's calls go, for tests).
 */
export const HUB_SITE = "https://huggingface.co";
/** The model the base was quantized from, which ships the LICENSE and the Usage Policy. */
export const GLIMMER_ORIGIN = "meta-models/Muse-Glimmer-30B";
/**
 * The model that writes a new story, saved with it as the hub state's storyModel. Muse Spark 1.3 wrote every story
 * before Oct 29, 2026 and is never used for new ones.
 */
export const STORY_MODEL = defaultModel();
/** The tuned model, as the cards name it. */
export const GLIMMER_NAME = "Muse Glimmer 30B";
/** A dataset title's slug in a repo name: lowercase letters, digits and dashes, at most this long. */
export const SLUG_MAX = 40;
/**
 * The story's model is asked for at most 100 words (the card's own sentence of about 45 words follows, for about 150 in
 * all): a story longer than this is turned down.
 */
export const STORY_WORDS_MAX = 115;
/** The longest a story may be in characters, whatever its words. */
const STORY_CHARS_MAX = 1000;
/**
 * The license_name a Derivative of Muse Spark Open's card declares (lib/train/base.ts), r30b's own: Apache 2.0 for the
 * weights Meta licensed, and the Muse Model License, whose text the repo ships as DERIVATIVE_LICENSE_LINK.
 */
export const DERIVATIVE_LICENSE_NAME = "apache-2.0-and-muse-model-license";
export const DERIVATIVE_LICENSE_LINK = "MUSE_MODEL_LICENSE.md";

/** A card's license front matter: Apache 2.0, or for a Derivative Apache 2.0 and the Muse Model License. */
function licenseFront(sparkOpen: boolean | undefined): string[] {
  return sparkOpen ? ["license: other", `license_name: ${DERIVATIVE_LICENSE_NAME}`, `license_link: ${DERIVATIVE_LICENSE_LINK}`] : ["license: apache-2.0"];
}

/** r30b as a card links it. */
const R30B_LINK = `[${R30B_REPO}](${R30B_URL})`;

/**
 * The block under a Derivative's title, as the Muse Model License asks: "Built with Muse Spark Open", prominently, why,
 * and the Usage Policy's points. `what` names the repo's model ("This adapter").
 */
export function builtWithBlock(what: string): string {
  return [
    `**${BUILT_WITH_SPARK_OPEN}.** ${what} was trained from ${R30B_LINK}, Muse Muse's Muse Glimmer 30B with 2026 knowledge, and Muse Spark Open wrote part of that model's training data. So it is a Derivative of Muse Spark Open under the Muse Model License (\`${DERIVATIVE_LICENSE_LINK}\`), and its Usage Policy applies:`,
    "",
    ...USAGE_POINTS.map((p) => `- ${p}`),
  ].join("\n");
}

/**
 * A Derivative's license paragraphs: Apache 2.0 for Meta's weights and the change, the Muse Model License, both Usage
 * Policies, and the files the repo ships them in. `what` names the repo's model mid-sentence ("this adapter"), and
 * `change` says what it changed from r30b.
 */
function derivativeLicense(what: string, change: string): string {
  return [
    `Apache 2.0 and the Muse Model License. Muse Glimmer 30B is Meta's, under Apache 2.0: the full text is in \`LICENSE\`, as [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}) ships it. ${R30B_LINK} is Muse Muse's fine-tune of it, and \`NOTICE\` is that model's notice of what was changed. The change from it here: ${change}`,
    "",
    `Muse Spark Open wrote part of ${R30B_REPO}'s training data, so ${what} is a Derivative under the Muse Model License, in \`${DERIVATIVE_LICENSE_LINK}\` with the Muse Spark Open Usage Policy as its Exhibit A. Anything that uses it must show "${BUILT_WITH_SPARK_OPEN}" and follow that policy and the Muse Glimmer Usage Policy (\`USAGE_POLICY.md\`): it isn't for anyone under 18, its outputs must never be presented as written by a person, and its users must be told its known dangers, such as made-up answers and going along with false premises. Offering it to others as a model service needs a separate agreement with Meta once revenue passes $20 million in 12 months (section 3 of the license).`,
  ].join("\n");
}
/** An answer in the card's example is cut to this many characters (the run's record keeps it whole). */
const EXAMPLE_CHARS_MAX = 2000;

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const clean = (text: string | null | undefined) => noEmDashes(String(text ?? "")).trim();

// ---------------------------------------------------------------------------------------------------------------
// Names

/**
 * True for a name the Hub takes for a repo or a namespace: 1 to 96 of A-Z, a-z, 0-9, ".", "_" and "-", not starting or
 * ending with "-" or ".", with no "--" or "..", and not ending in ".git".
 */
export function validRepoName(name: string): boolean {
  return (
    /^[A-Za-z0-9._-]{1,96}$/.test(name) &&
    !/^[-.]|[-.]$/.test(name) &&
    !name.includes("--") &&
    !name.includes("..") &&
    !name.toLowerCase().endsWith(".git")
  );
}

/**
 * A dataset title as a repo name's slug: lowercase, letters and digits with single dashes, at most 40 characters. A
 * leading "Muse Muse" or "Muse Muse's" is dropped, since both repo names already say where they come from.
 */
export function hubSlug(title: string): string {
  const topic = String(title ?? "")
    .replace(/['\u2019]/g, "")
    .replace(/^\s*muse\s+muses?\b/i, "");
  return slugify(topic, SLUG_MAX) || "dataset";
}

/** The model repo's name: "muse-glimmer-30b-<dataset slug>-lora-<first 8 characters of the job id>". */
export function modelRepoName(datasetTitle: string, jobId: string, baseModel?: unknown): string {
  // Llama's license asks that a model's name starts with Llama (licenseDuties, lib/train/base.ts).
  const start = licenseDuties({ adapterBase: typeof baseModel === "string" ? baseModel : null }).namePrefix || "muse-glimmer-30b-";
  return `${start}${hubSlug(datasetTitle)}-lora-${jobId.slice(0, 8).toLowerCase()}`;
}

/** The dataset repo's name, one per dataset: "muse-muse-<dataset slug>-<first 8 characters of the dataset id>". */
export function datasetRepoName(datasetTitle: string, datasetId: string): string {
  return `muse-muse-${hubSlug(datasetTitle)}-${datasetId.slice(0, 8).toLowerCase()}`;
}

/** The public lab page of a job, which the cards cite as the eval's source. */
export function labPageUrl(jobId: string): string {
  return `${MUSE_MUSE_SITE}/fine-tuning/${jobId}`;
}

/** Why the platform won't publish a file the GPU names, or null when it will (one of HUB_FILE_NAMES, exactly). */
export function hubFileProblem(path: string): string | null {
  return HUB_FILE_NAMES.includes(path) ? null : "only the adapter's weights and config and the tokenizer's files are published";
}

/** The JSON object in a config's bytes, or null when they aren't one. */
function jsonObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Why the platform won't publish one of the checked configs (HUB_CHECKED_NAMES) as the GPU sent it, or null when it
 * will: it isn't a JSON object, it has an "auto_map" (a loader would fetch code from another repo), or, for
 * adapter_config.json, it names another base model than `model`, or a revision that isn't a 40-character commit.
 */
export function configProblem(path: string, bytes: Buffer, model: string): string | null {
  const config = jsonObject(bytes);
  if (!config) return `${path} isn't a JSON object`;
  if ("auto_map" in config) return `${path} has an auto_map, which points a loader at code from another repo`;
  if (path !== "adapter_config.json") return null;
  if (config.base_model_name_or_path !== model) {
    const named = typeof config.base_model_name_or_path === "string" ? config.base_model_name_or_path.slice(0, 100) : "no base model";
    return `adapter_config.json names ${JSON.stringify(named)} as its base model, not ${model}`;
  }
  const revision = config.revision;
  if (revision !== undefined && revision !== null && revision !== "" && !(typeof revision === "string" && /^[0-9a-f]{40}$/.test(revision))) {
    return "adapter_config.json's revision isn't a 40-character commit";
  }
  return null;
}

/**
 * adapter_config.json as the platform commits it: the GPU's (checked with configProblem first), with the base model and
 * the revision the card states, its top-level keys sorted and a 2-space indent, as glimmer.py's fix_adapter_config
 * writes it.
 */
export function normalizedAdapterConfig(bytes: Buffer, model: string, revision: string): Buffer {
  const config: Record<string, unknown> = { ...(jsonObject(bytes) ?? {}), base_model_name_or_path: model, revision };
  const sorted = Object.fromEntries(Object.keys(config).sort().map((k) => [k, config[k]]));
  return Buffer.from(JSON.stringify(sorted, null, 2), "utf8");
}

// ---------------------------------------------------------------------------------------------------------------
// The glimmer-lora recipe, as its Python source says (lib/train/recipes/glimmer.ts)

/** What the cards say about the base model, the chat template and the trainer, read from GLIMMER_PY. */
export interface GlimmerTemplate {
  model: string;
  revision: string;
  maxSeqLength: number;
  maxNewTokens: number;
  reasoning: string;
  instructionPart: string;
  responsePart: string;
  generationPrompt: string;
  /** What the eval prompts append to the generation prompt to open the final channel: " to=user<|message|>". */
  finalChannel: string;
  finalEnds: string[];
  batchSize: number;
  gradientAccumulation: number;
  warmupSteps: number;
  optimizer: string;
  scheduler: string;
  weightDecay: number;
  loraDropout: number;
  seed: number;
}

function pyString(source: string, name: string): string {
  const m = source.match(new RegExp(`^${name} = "([^"\\\\]*)"$`, "m"));
  if (!m) throw new Error(`The glimmer-lora recipe has no ${name} string the model card can read.`);
  return m[1]!;
}

function pyNumber(source: string, pattern: RegExp, name: string): number {
  const m = source.match(pattern);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n)) throw new Error(`The glimmer-lora recipe has no ${name} the model card can read.`);
  return n;
}

function pyKeyword(source: string, key: string): string {
  const m = source.match(new RegExp(`\\b${key}="([^"\\\\]*)"`));
  if (!m) throw new Error(`The glimmer-lora recipe has no ${key} the model card can read.`);
  return m[1]!;
}

/**
 * The recipe's model, pinned revision, chat template markers and trainer settings, read from its Python source
 * (GLIMMER_PY), so the card's "How to use it" renders prompts exactly as training and eval did. Throws when the source
 * no longer has one of them.
 */
export function glimmerTemplate(source: string): GlimmerTemplate {
  const responsePart = pyString(source, "RESPONSE_PART");
  const generationPrompt = pyString(source, "GENERATION_PROMPT");
  if (!responsePart.startsWith(generationPrompt)) {
    throw new Error("The glimmer-lora recipe's RESPONSE_PART doesn't start with its GENERATION_PROMPT.");
  }
  const ends = source.match(/^FINAL_ENDS = \(([^)]*)\)$/m);
  const finalEnds = ends ? [...ends[1]!.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]!) : [];
  if (!finalEnds.length) throw new Error("The glimmer-lora recipe has no FINAL_ENDS the model card can read.");
  return {
    model: pyString(source, "MODEL"),
    revision: pyString(source, "MODEL_REVISION"),
    maxSeqLength: pyNumber(source, /^MAX_SEQ_LENGTH = (\d+)$/m, "MAX_SEQ_LENGTH"),
    maxNewTokens: pyNumber(source, /^MAX_NEW_TOKENS = (\d+)$/m, "MAX_NEW_TOKENS"),
    reasoning: pyString(source, "REASONING"),
    instructionPart: pyString(source, "INSTRUCTION_PART"),
    responsePart,
    generationPrompt,
    finalChannel: responsePart.slice(generationPrompt.length),
    finalEnds,
    batchSize: pyNumber(source, /per_device_train_batch_size=(\d+)/, "batch size"),
    gradientAccumulation: pyNumber(source, /gradient_accumulation_steps=(\d+)/, "gradient accumulation"),
    warmupSteps: pyNumber(source, /warmup_steps=(\d+)/, "warmup steps"),
    optimizer: pyKeyword(source, "optim"),
    scheduler: pyKeyword(source, "lr_scheduler_type"),
    weightDecay: pyNumber(source, /weight_decay=([\d.]+)/, "weight decay"),
    loraDropout: pyNumber(source, /lora_dropout=([\d.]+)/, "LoRA dropout"),
    seed: pyNumber(source, /random_state=(\d+)/, "seed"),
  };
}

/**
 * The one-line system message glimmer-lora's short student prompt trained and answered under, for a run whose metrics
 * don't have it: student_system in lib/train/recipes/glimmer.ts, line for line.
 */
export function studentSystem(title: string | null | undefined, datasetSystem: string | null = null): string {
  let role = String(title ?? "").split(/\s+/).filter(Boolean).join(" ").replace(/[.!?:; ]+$/, "");
  if (role.slice(0, 8).toLowerCase() === "you are ") role = role.slice(8).trimStart();
  const fromTask = Boolean(role) && typeof datasetSystem === "string" && datasetSystem.startsWith(`You are an assistant for this task: ${role}`);
  if (!role || role.length > 80 || fromTask) role = "a helpful assistant";
  const words = role.toLowerCase().split(" ");
  if (!["a", "an", "the", "your", "my", "our"].includes(words[0]!) && !words.slice(0, 3).some((w) => w.endsWith("'s"))) {
    role = `the ${role}`;
  }
  return `You are ${role}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// The story: "Why this exists"

/**
 * The records the story is written from. The dataset's counts and the eval's result aren't among them: the card gives
 * those itself, right after the story (resultText), so no number in it can come from a model.
 */
export interface StoryFacts {
  datasetTitle: string;
  task: string;
  /** The admin's own reason, which comes first in the card. */
  why: string | null;
  /** The dataset's writer_model: null or absent means Muse Spark 1.3, which wrote every dataset before it was recorded. */
  writerModel?: string | null;
  /** The base's name when it isn't Glimmer: the template's story says it, and no model writes this story. */
  baseName?: string | null;
}

export const STORY_INSTRUCTIONS = [
  'You write the "Why this exists" section of a Hugging Face model card for a LoRA adapter, from the facts you are given and nothing else.',
  "Say what the adapter does in one short sentence (the card quotes the whole task below, so don't list its parts), why Muse Muse made it, and why it is worth teaching an open 30B model that anyone can download and run on their own GPU what the hosted model that wrote its dataset does.",
  "Don't write any number, count, score or percentage, in digits or in words, and don't say how the tuned model did or compare it with the base model: right after your text, the card gives the dataset's counts and the eval's result from the platform's records.",
  "Use only the facts given. Don't add any name, date, benchmark, person, plan or claim that isn't in them.",
  "The brief writer is one of Muse Muse's steps. Mention it only when the dataset's task is writing those briefs: otherwise the adapter has nothing to do with it, so leave it out.",
  "Don't say Meta made, endorses, supports, sponsors, backs, approved or partnered on this adapter. Don't say Muse Muse runs or uses this adapter, or that it does or replaces one of Muse Muse's steps: it was trained to learn the task.",
  "At most 100 words (aim for about 80), in plain words, in one or two short paragraphs. No headings, lists, links, tables, code, HTML, quotes around the whole text or emoji. Don't use em dashes.",
  "If the admin's reason is given, the card prints it just before your text: build on it, and don't repeat, quote or restate it.",
].join("\n");

/** An average score as the eval summary keeps it, in hundredths: "8.88", "2". */
const score = (n: number) => String(Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

/** "better on 8 of 8", "better on 3 of 4, and 1 tied": who won, with a count of 0 left out. */
function wins(s: EvalSummary): string {
  const others = [...(s.baseWins ? [`the base model on ${s.baseWins}`] : []), ...(s.ties ? [`${s.ties} tied`] : [])];
  const rest = others.length ? `${others.length > 1 ? ", " : ", and "}${others.join(", and ")}` : "";
  return `better on ${s.tunedWins} of ${s.items}${rest}`;
}

/** The facts the story's model writes it from, as its user message: no counts and no result, which the card gives. */
export function storyRequest(f: StoryFacts): string {
  const writer = writerName(f);
  const lines = [
    "Muse Muse: a platform that turns an example or some inspo into a working product on Meta's models. Its first step is the brief writer, which turns what a person gives it into a short brief that the build follows.",
    `The dataset: "${clean(f.datasetTitle)}". Its task, as the admin wrote it: ${clean(f.task)}`,
    `${writer}, Meta's hosted model, wrote the dataset, the prompts and the answers.`,
    `The adapter: a LoRA adapter for ${GLIMMER_NAME}, made in Muse Muse's fine-tuning lab. ${GLIMMER_NAME} is an open model with Apache 2.0 weights that anyone can download and run on their own GPU. The lab has ${writer} write a dataset for one task, and ${GLIMMER_NAME} learns to do the task the way ${writer} does. Why: then the task can run on a model you host yourself.`,
    "The card gives the dataset's counts and the eval's result itself, right after your text.",
  ];
  if (f.why?.trim()) lines.push(`The admin's reason, printed just before your text: ${clean(f.why)}`);
  return lines.join("\n\n");
}

/**
 * Names whose digits belong to the name, which a story may use: "Muse Glimmer 30B", "30B", "Muse Spark 1.3", "Muse
 * Wonder 1.0", "Apache 2.0".
 */
const FIXED_NAMES = /\b(?:Muse Glimmer 30B|Muse Spark 1\.3|Spark 1\.3|Muse Wonder 1\.0|Wonder 1\.0|Apache(?: License)? 2\.0|30B)(?!\w)/gi;

/**
 * Words that state a count, a share, a result or a comparison with the base model: a story leaves all of them to the
 * card's own sentence (resultText), unless the task, the title or the why uses the word too. "one" and "first" aren't
 * among them: the facts use both ("one task", "its first step").
 */
const CLAIM_WORDS = new Set([
  ...["zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"],
  ...["fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty"],
  ...["sixty", "seventy", "eighty", "ninety", "hundred", "hundreds", "thousand", "thousands", "million", "millions"],
  ...["billion", "dozen", "dozens", "twice", "double", "doubled", "triple", "tripled", "half", "halved", "percent"],
  ...["percentage", "won", "win", "wins", "winning", "beat", "beats", "beating", "outperform", "outperforms"],
  ...["outperformed", "outperforming", "outscore", "outscores", "outscored", "score", "scores", "scored", "scoring"],
  ...["lost", "lose", "loses", "losing", "tie", "ties", "tied", "base"],
]);

/** A text's numbers (outside FIXED_NAMES, with thousands separators dropped) and its CLAIM_WORDS, lowercase. */
function claimTokens(text: string): string[] {
  const t = noEmDashes(text).replace(FIXED_NAMES, " ").toLowerCase();
  return [...t.matchAll(/\d+(?:[.,]\d+)*|[a-z]+/g)]
    .map((m) => m[0]!.replace(/,(?=\d{3}\b)/g, ""))
    .filter((w) => /\d/.test(w) || CLAIM_WORDS.has(w));
}

/** A sentence mentioning Meta that says it made, backed, approved or helped with the adapter. */
const META_CLAIM =
  /\b(?:endors\w*|partner\w*|sponsor\w*|back(?:s|ed|ing)?|approv\w*|certif\w*|affiliat\w*|collaborat\w*|support\w*|made by|built by|team|engineers?|researchers?|staff|help(?:s|ed|ing)?|thanks?)\b|\bwith meta\b(?!['’]s)/i;

/** A story as the card prints it: trimmed, with no em dashes, quotes around the whole of it dropped, paragraphs kept. */
export function cleanStory(text: string): string {
  let t = noEmDashes(String(text ?? "")).replace(/\r\n?/g, "\n").trim();
  if (/^["“].*["”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/** Text as dropRepeatedWhy compares it: no em dashes, straight quotes, lowercase, single spaces, no end punctuation. */
function sameText(text: string): string {
  return noEmDashes(text)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
}

/**
 * The story without a copy of the admin's why, which the card prints just before it: a paragraph that is the why, and
 * the why as the story's first sentences. Muse Spark 1.3 was told not to repeat it and still sometimes opened with it
 * word for word, so every model's story is checked. Returns "" when nothing else is left.
 */
export function dropRepeatedWhy(story: string, why: string | null): string {
  const w = sameText(why ?? "");
  if (!w) return story;
  let text = story
    .split(/\n{2,}/)
    .filter((p) => sameText(p) !== w)
    .join("\n\n")
    .trim();
  if (sameText(text).startsWith(w)) {
    // Cut after the sentence that ends the why's copy, when the rest of its paragraph goes on.
    for (const end of text.matchAll(/[.!?](?=\s|$)/g)) {
      const cut = end.index! + 1;
      if (sameText(text.slice(0, cut)) === w) {
        text = text.slice(cut).trim();
        break;
      }
    }
  }
  return text;
}

/**
 * Why the story a model wrote can't go in the card, or null when it can: it is empty or longer than about 100
 * words; it has markup (a heading, a list, a link, a table, code, HTML, a "//" or "www." address); it says Meta made,
 * backs, approves or helped with the adapter, or calls anything official; or it states a number, a count word, a
 * result or a comparison with the base model (CLAIM_WORDS) that the task, the title or the why doesn't use itself.
 * The counts and the result are the card's own sentence, from the records.
 */
export function storyProblem(text: string, facts: StoryFacts): string | null {
  const t = cleanStory(text);
  if (!t) return "it is empty";
  if (t.length > STORY_CHARS_MAX || (t.match(/\S+/g)?.length ?? 0) > STORY_WORDS_MAX) return "it is longer than about 100 words";
  if (/^\s*(#|[-*+] |\d+[.)] |>|\|)/m.test(t) || /\]\(|https?:\/\/|`|[<>]|(?:^|[\s(])\/\/\S|\bwww\./i.test(t)) return "it has markup";
  const sentences = t.split(/(?<=[.!?])\s+|\n+/);
  if (/\b(?:official\w*|endors\w*)\b/i.test(t) || sentences.some((x) => /\bmeta\b/i.test(x) && META_CLAIM.test(x))) {
    return "it says something about Meta the facts don't";
  }
  const allowed = new Set(claimTokens([facts.datasetTitle, facts.task, facts.why ?? ""].join("\n")));
  const claims = claimTokens(t).filter((w) => !allowed.has(w));
  if (claims.length) return `it states counts or results itself (${[...new Set(claims)].slice(0, 3).join(", ")})`;
  return null;
}

/** The first sentence of the task, cut to about 220 characters, for the template's story and the card's lead. */
export function taskSentence(task: string): string {
  const t = clean(task).replace(/\s+/g, " ");
  const first = t.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? t;
  const cut = first.length > 220 ? `${first.slice(0, 217).replace(/\s+\S*$/, "")}...` : first;
  return cut.replace(/[.!?]+$/, "");
}

/**
 * The story when the story's model can't write one (no key, the spend cap, a failed call, a story that failed its
 * checks): what Muse Muse is, the task, and why, from the task's own words, naming the dataset's writer from its record.
 * The counts and the result follow it in the card.
 */
export function templateStory(f: StoryFacts): string {
  return `Muse Muse turns an example or some inspo into a working product on Meta's models. This adapter teaches ${f.baseName ?? GLIMMER_NAME}, an open model anyone can download and run on their own GPU, to do one task the way ${writerName(f)} does it: ${taskSentence(f.task)}. That way the task can run on a model you host yourself.`;
}

/** A dataset's writer as a card names it, from its writer_model: "Muse Wonder", or "Muse Spark 1.3" for one with none. */
function writerName(d: { writerModel?: string | null }): string {
  return modelName(writerModelOf(d));
}

/** The run's judge, from the job's judge_model: a card is only made for a judged job, so none is Muse Spark 1.3. */
function judgeId(f: { judgeModel?: string | null }): string {
  return recordedModel(f.judgeModel);
}

/** "A and B", "A, B and C". */
function andList(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}
// ---------------------------------------------------------------------------------------------------------------
// Markdown helpers

/** Text for a Markdown table cell: pipes escaped, line breaks as spaces. */
export function mdCell(text: unknown): string {
  return clean(String(text ?? "")).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/** A fenced block that shows `text` as it is: the fence is longer than any run of backticks inside it. */
export function fenced(text: string, lang = ""): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0]!.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

/** A YAML scalar: JSON's double-quoted string, which YAML reads the same. */
const y = (text: string) => JSON.stringify(String(text));

/**
 * A Python string literal of `text`, exactly: JSON's double-quoted string, which Python reads the same, with an em dash
 * written as \u2014 so none shows in the card while the string stays the one training used.
 */
const py = (text: string) => JSON.stringify(String(text)).replace(/\u2014/g, "\\u2014");

/**
 * Model-written text in a card's prose (the judge's note), on one line, with Markdown and HTML shown as the characters
 * they are, so a note can't add a link, an image or a heading to a public card.
 */
function mdText(text: string): string {
  return clean(text)
    .replace(/\s+/g, " ")
    .replace(/[\\`*_[\]#|!~]/g, (c) => `\\${c}`)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** One decimal place for money below a dollar is too coarse, so cents, or tenths of a cent under 10 cents. */
function money(usd: number): string {
  const n = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  return n > 0 && n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

/** True when the dataset's words are plain ASCII, the one case the cards tag as English. */
function looksEnglish(...texts: string[]): boolean {
  return texts.every((t) => /^[\x09\x0a\x0d\x20-\x7e]*$/.test(t));
}

/** "n<1K", "1K<n<10K": the Hub's size category for a count of examples. */
export function sizeCategory(n: number): string {
  if (n < 1000) return "n<1K";
  if (n < 10_000) return "1K<n<10K";
  return "10K<n<100K";
}

// ---------------------------------------------------------------------------------------------------------------
// The cards

/** A held-out prompt with both answers and the judge's verdict, for the card's example. */
export interface CardExample {
  index: number;
  prompt: string;
  base: string;
  tuned: string;
  baseScore: number;
  tunedScore: number;
  better: "base" | "tuned" | "tie";
  note: string;
}

/** Everything the cards say, from the records. */
export interface CardFacts {
  modelRepo: string;
  datasetRepo: string;
  /** Spark 1.3 Contributor wrote the dataset, so its repo stays private (keepDatasetPrivate) and the card doesn't link it. */
  datasetPrivate?: boolean;
  job: {
    id: string;
    title: string;
    instanceType: string;
    gpuLabel: string;
    gpuMinutes: number;
    costUsd: number;
    finishedAt: string | null;
    maxSteps: number | null;
    learningRate: number | null;
    loraRank: number | null;
    studentPrompt: string;
  };
  /** The job's done metrics. */
  metrics: Record<string, string | number>;
  summary: EvalSummary;
  example: CardExample | null;
  /** writerModel is the dataset's writer_model: null or absent means Muse Spark 1.3. */
  dataset: { id: string; title: string; task: string; trainCount: number; evalCount: number; costUsd: number; writerModel?: string | null };
  /** The job's judge_model: null or absent means Muse Spark 1.3, which judged every job before it was recorded. */
  judgeModel?: string | null;
  template: GlimmerTemplate;
  /** The base model's commit the adapter was trained on: adapter_config.json's revision, else the recipe's. */
  revision: string;
  /** The system message training and eval used. */
  system: string;
  why: string | null;
  story: string;
  /**
   * The adapter's GGUF repo, once a glimmer-quantize job published one the card may name: public, or private beside a
   * private adapter. "How to use it" then points local apps to it. Null or absent otherwise.
   */
  gguf?: { repo: string } | null;
  /**
   * True for a Derivative of Muse Spark Open (isSparkOpenDerivative, lib/train/base.ts): an adapter trained on r30b.
   * Its card then carries "Built with Muse Spark Open", the Usage Policy's points and the Muse Model License, and
   * compares it with the 2026 Glimmer it started from. Absent or false for an adapter on plain Glimmer.
   */
  sparkOpen?: boolean;
}

/** True when the card's facts are a Derivative's: the flag, or a base that is one of r30b's builds. */
export function cardSparkOpen(f: Pick<CardFacts, "sparkOpen" | "template">): boolean {
  return f.sparkOpen === true || isSparkOpenDerivative({ adapterBase: f.template.model });
}

/** The model a tuned one is compared with, mid-sentence: "the base model", or r30b for a Derivative. */
function baseInLine(derived: boolean): string {
  return derived ? "the 2026 Glimmer it started from" : "the base model";
}

/** A repo's page on the public Hub (HUB_SITE). */
const hubLink = (id: string, kind: "model" | "dataset") => `${HUB_SITE}${kind === "dataset" ? "/datasets" : ""}/${id}`;

/**
 * The card's own sentence after the story: the dataset's counts and the eval's result, from the records, so no number
 * in "Why this exists" comes from a model.
 */
export function resultText(f: Pick<CardFacts, "summary" | "dataset" | "judgeModel"> & Partial<Pick<CardFacts, "sparkOpen" | "template">>): string {
  const s = f.summary;
  const d = f.dataset;
  const derived = f.template ? cardSparkOpen({ sparkOpen: f.sparkOpen, template: f.template }) : f.sparkOpen === true;
  return `${writerName(d)} wrote the dataset's ${d.trainCount + d.evalCount} examples: ${d.trainCount} to train on and ${d.evalCount} held out. On ${s.items} held-out prompts, judged blind by ${modelName(judgeId(f))}, the tuned model was ${wins(s)}, with an average score of ${score(s.avgTunedScore)} out of 10 against ${score(s.avgBaseScore)} for ${baseInLine(derived)}.${judgeId(f) === SPARK_STANDIN ? ` These scores don't compare with runs judged by ${modelName("muse-wonder-1.0")}.` : ""}`;
}

/** The card's "Why this exists": a line saying whose story it is (`lead`, the dataset card's), the admin's reason, the story, then the records' result. */
function whySection(f: CardFacts, lead: string | null = null): string {
  const why = clean(f.why);
  return ["## Why this exists", "", ...(lead ? [lead, ""] : []), ...(why ? [why, ""] : []), cleanStory(f.story), "", resultText(f)].join("\n");
}

function metric(key: string, m: Record<string, string | number>): string | number | null {
  const v = m[key];
  return typeof v === "number" || (typeof v === "string" && v.trim()) ? v : null;
}

/** The blind eval table and its notes. */
function resultsSection(f: CardFacts): string {
  const s = f.summary;
  const m = f.metrics;
  const base = metric("base_unfinished", m);
  const tuned = metric("tuned_unfinished", m);
  const judge = judgeId(f);
  const writer = writerModelOf(f.dataset);
  // "its own reference answer" only when the judge wrote the dataset too.
  const reference = judge === writer ? `${modelName(writer)}'s own reference answer` : `${modelName(writer)}'s reference answer`;
  const derived = cardSparkOpen(f);
  const out = [
    "## Results",
    "",
    `Both models answered the dataset's ${s.items} held-out prompts, none of which were trained on. ${modelName(judge)} (\`${judge}\`) judged each pair blind: it saw the answers as A and B, ${derived ? "the 2026 Glimmer's" : "the base model's"} first on even items and second on odd ones, scored each from 1 to 10 against ${reference}, and said which was better.`,
    "",
    `| | ${derived ? "The 2026 Glimmer it started from (r30b)" : `Base ${GLIMMER_NAME}`} | Tuned (this adapter) |`,
    "|---|---|---|",
    `| Better on | ${s.baseWins} of ${s.items} | ${s.tunedWins} of ${s.items} |`,
    `| Average score (1 to 10) | ${score(s.avgBaseScore)} | ${score(s.avgTunedScore)} |`,
    ...(base !== null && tuned !== null ? [`| Answers unfinished within ${f.template.maxNewTokens} new tokens | ${base} | ${tuned} |`] : []),
    "",
    `Ties: ${s.ties}. Win rate: ${pct(s.tunedWins, s.items)}% for the tuned model. Judging cost ${money(s.judgeCostUsd)}. Every item, with both answers and the judge's note, is in \`muse_muse_run.json\`, and on [the run's public page](${labPageUrl(f.job.id)}).`,
  ];
  const e = f.example;
  if (e) {
    const cut = (t: string) => {
      const c = clean(t);
      return c.length > EXAMPLE_CHARS_MAX ? `${c.slice(0, EXAMPLE_CHARS_MAX)}\n[Cut here. The whole answer is in muse_muse_run.json.]` : c;
    };
    out.push(
      "",
      "### An example",
      "",
      // The note names the answers as the judge saw them, A and B: judgeStep put the base model's first on even items.
      `Held-out item ${e.index + 1}, where the judge saw ${derived ? "the 2026 Glimmer's" : "the base model's"} answer as ${e.index % 2 === 0 ? "A" : "B"}. It scored ${baseInLine(derived)} ${e.baseScore} and the tuned model ${e.tunedScore}: "${mdText(e.note)}"`,
      "",
      "The prompt:",
      "",
      fenced(cut(e.prompt), "text"),
      "",
      derived ? "The 2026 Glimmer it started from:" : `Base ${GLIMMER_NAME}:`,
      "",
      fenced(cut(e.base), "text"),
      "",
      "Tuned (this adapter):",
      "",
      fenced(cut(e.tuned), "text"),
    );
  }
  return out.join("\n");
}

/** How the adapter was trained: records first, then the recipe's settings. */
function trainingSection(f: CardFacts): string {
  const m = f.metrics;
  const t = f.template;
  const j = f.job;
  const steps = metric("steps", m);
  const maxSteps = metric("max_steps", m) ?? j.maxSteps;
  const rows: Array<[string, string]> = [
    [
      "Base model",
      cardSparkOpen(f)
        ? `[${t.model}](${HUB_SITE}/${t.model}) at revision \`${f.revision}\`, the 4-bit (bitsandbytes) quantization of ${R30B_LINK}: Muse Muse's fine-tune of [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}) with 2026 knowledge`
        : `[${t.model}](${HUB_SITE}/${t.model}) at revision \`${f.revision}\`, the 4-bit (bitsandbytes) quantization of [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN})`,
    ],
    ["Method", "QLoRA with Unsloth and TRL's SFTTrainer: LoRA on the language model's attention and MLP layers, the vision layers frozen, trained only on the answers (train_on_responses_only)"],
  ];
  if (j.loraRank !== null) rows.push(["LoRA rank", `${j.loraRank} (alpha ${j.loraRank}, dropout ${t.loraDropout})`]);
  if (j.learningRate !== null) rows.push(["Learning rate", `${j.learningRate}, ${t.scheduler} schedule, ${t.warmupSteps} warmup steps, ${t.optimizer}, weight decay ${t.weightDecay}`]);
  if (steps !== null || maxSteps !== null) {
    const done = steps ?? maxSteps;
    const early = metric("stopped_early", m) === "yes" ? " (stopped early to finish within the time limit)" : "";
    rows.push(["Steps", `${done}${maxSteps !== null && steps !== null && steps !== maxSteps ? ` of ${maxSteps}` : ""}${early}, batch ${t.batchSize} with gradient accumulation ${t.gradientAccumulation}`]);
  }
  rows.push(["Training examples", String(metric("train_examples", m) ?? f.dataset.trainCount)]);
  rows.push(["Max sequence length", String(t.maxSeqLength)]);
  rows.push([
    "System prompt (student)",
    j.studentPrompt === "full"
      ? `The dataset's own task prompt (${f.system.length.toLocaleString("en-US")} characters, under What it does)`
      : `\`${clean(f.system).replace(/`/g, "'")}\` (one line, in place of the dataset's task prompt)`,
  ]);
  const gpu = metric("gpu", m);
  rows.push(["GPU", `${gpu ? `${gpu}, ` : ""}${j.gpuLabel} on Lambda`]);
  rows.push(["GPU time", `${j.gpuMinutes} minutes, from launch to shutdown`]);
  rows.push(["GPU cost", money(j.costUsd)]);
  const loss = metric("train_loss_final", m);
  if (loss !== null) rows.push(["Final training loss", String(loss)]);
  const vram = metric("peak_vram_gb", m);
  if (vram !== null) rows.push(["Peak GPU memory", `${vram} GB`]);
  rows.push(["Seed", String(t.seed)]);
  return [
    "## How it was trained",
    "",
    "| Setting | Value |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "",
    `Each training text is the conversation through the model's own chat template at reasoning strength "${t.reasoning}", with the answer on the final channel (\`${t.responsePart}\`) and no reasoning before it. The eval prompts end the same way, so both models answered at once on that channel, the way this adapter was trained.`,
  ].join("\n");
}

/** How to load and prompt it, with the chat template exactly as training and eval used it. */
function usageSection(f: CardFacts): string {
  const t = f.template;
  const ends = `(${t.finalEnds.map((e) => JSON.stringify(e)).join(", ")})`;
  const ask = [
    "def ask(prompt):",
    `    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]`,
    "    text = processor.apply_chat_template(",
    `        messages, tokenize=False, add_generation_prompt=True, reasoning_strength=${JSON.stringify(t.reasoning)}`,
    "    )",
    "    # The tokenizer adds <|begin_of_text|> itself. Open the final channel, as training and eval did.",
    `    text = text.removeprefix(tokenizer.bos_token) + ${JSON.stringify(t.finalChannel)}`,
    '    inputs = tokenizer(text, return_tensors="pt").to(model.device)',
    `    out = model.generate(**inputs, max_new_tokens=${t.maxNewTokens}, do_sample=False)`,
    '    raw = tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=False)',
    `    for end in ${ends}:`,
    "        raw = raw.split(end)[0]",
    "    return raw.strip()",
  ];
  const head = [
    `BASE = ${JSON.stringify(t.model)}`,
    `REVISION = ${JSON.stringify(f.revision)}`,
    `ADAPTER = ${JSON.stringify(f.modelRepo)}`,
    `SYSTEM = ${py(f.system)}`,
  ];
  const transformers = [
    "from peft import PeftModel",
    "from transformers import AutoModelForMultimodalLM, AutoProcessor",
    "",
    ...head,
    "",
    "processor = AutoProcessor.from_pretrained(BASE, revision=REVISION)",
    'tokenizer = getattr(processor, "tokenizer", processor)',
    'model = AutoModelForMultimodalLM.from_pretrained(BASE, revision=REVISION, device_map="auto")',
    "model = PeftModel.from_pretrained(model, ADAPTER)",
    "model.eval()",
    "",
    ...ask,
    "",
    'print(ask("Your prompt here"))',
  ];
  const unsloth = [
    "from unsloth import FastModel",
    "from peft import PeftModel",
    "",
    ...head,
    "",
    `model, processor = FastModel.from_pretrained(model_name=BASE, revision=REVISION, max_seq_length=${t.maxSeqLength})`,
    "model = PeftModel.from_pretrained(model, ADAPTER, is_trainable=False)",
    "FastModel.for_inference(model)",
    'tokenizer = getattr(processor, "tokenizer", processor)',
    "",
    ...ask,
  ];
  const local = f.gguf
    ? [
        "",
        `To run it on your own computer, in LM Studio, llama.cpp or Ollama, take [${f.gguf.repo}](${hubLink(f.gguf.repo, "model")}): this adapter merged into the base and quantized to GGUF, with which file fits which computer.`,
      ]
    : [];
  return [
    "## How to use it",
    "",
    `Load the 4-bit base at the revision it was trained on, put the adapter on it, and prompt it as training did: the system message below, the chat template at reasoning strength "${t.reasoning}", and the final channel opened, so the model answers at once with no reasoning. Greedy decoding with up to ${t.maxNewTokens} new tokens is what the eval used. It needs a CUDA GPU with room for the 4-bit base model, and \`bitsandbytes\`.`,
    ...local,
    "",
    "With transformers and PEFT:",
    "",
    fenced(transformers.join("\n"), "python"),
    "",
    "With Unsloth, as Muse Muse's live demo loads it:",
    "",
    fenced(unsloth.join("\n"), "python"),
  ].join("\n");
}

function dataSection(f: CardFacts): string {
  const d = f.dataset;
  return [
    "## Data",
    "",
    `Trained on ${f.datasetPrivate ? "a private dataset" : `[${f.datasetRepo}](${hubLink(f.datasetRepo, "dataset")})`}: ${d.trainCount} training conversations and ${d.evalCount} held-out prompts that ${writerName(d)} wrote through Meta's Model API for the dataset "${mdCell(d.title)}", prompts and answers both, for ${money(d.costUsd)}. The held-out prompts were never trained on, and prompts that share most of their words with one were kept out of training too.`,
  ].join("\n");
}

function limitsSection(f: CardFacts): string {
  const s = f.summary;
  const writer = writerModelOf(f.dataset);
  const judge = judgeId(f);
  const who =
    judge === writer
      ? `${modelName(writer)} wrote the training answers, the references and the verdicts, and a judge can favor answers like its own.`
      : `${modelName(writer)} wrote the training answers and the references, and ${modelName(judge)} the verdicts. A judge can favor answers that read like the reference it was given.`;
  return [
    "## Limits",
    "",
    `- It learned one task from ${f.dataset.trainCount} examples one model wrote. It isn't a general improvement of ${GLIMMER_NAME}, and outside that task it may do worse than the base model in ways the eval didn't measure.`,
    `- The eval is small: ${s.items} prompts from the same writer as the training data. ${who}`,
    f.job.studentPrompt === "full"
      ? "- Both models answered under the dataset's whole task prompt, so the base model's scores show how well it follows those instructions untrained."
      : "- The base model answered without the dataset's task prompt, under the same one-line system message as the tuned model, so its scores show what training taught, not how well the base follows instructions.",
    cardSparkOpen(f)
      ? `- It inherits the limits of ${R30B_LINK} and of [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}), and their Usage Policies: it can make up answers and go along with false premises. Check what it writes before you rely on it.`
      : `- It inherits the base model's limits and its Usage Policy: see [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}). Check what it writes before you rely on it.`,
  ].join("\n");
}

function licenseSection(f: CardFacts): string {
  const writer = writerName(f.dataset);
  const made = andList([...new Set([GLIMMER_NAME, writer, modelName(judgeId(f))])]);
  return [
    "## License",
    "",
    cardSparkOpen(f)
      ? derivativeLicense("this adapter", "this LoRA adapter, trained as described above.")
      : `Apache 2.0, the license of the base model: the full text is in \`LICENSE\`, as [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}) ships it. The change from the base model is this LoRA adapter, trained as described above. Use it under the base model's [Usage Policy](${HUB_SITE}/${GLIMMER_ORIGIN}/blob/main/USAGE_POLICY.md), which says Muse Glimmer "is not intended for individuals under the age of 18".`,
    "",
    f.datasetPrivate
      ? `The training data is ${writer}'s output through Meta's Model API, under Meta's terms for that API. It is kept private and isn't published.`
      : `The training data is ${writer}'s output through Meta's Model API, published under Meta's terms for that API rather than an open license: see its \`${DATASET_LICENSE_PATH}\`.`,
    "",
    `Not an official Meta product. Meta made ${made}; it didn't make, review or endorse this adapter. The model's name only says what the adapter is for.`,
  ].join("\n");
}

function provenanceSection(f: CardFacts): string {
  return [
    "## Provenance",
    "",
    `- Made by [Muse Muse](${MUSE_MUSE_SITE}), job \`${f.job.id}\` ("${mdCell(f.job.title)}")${f.job.finishedAt ? `, finished ${f.job.finishedAt.slice(0, 10)}` : ""}.`,
    `- The run's public page, with every eval item: ${labPageUrl(f.job.id)}`,
    f.datasetPrivate ? "- The training data is kept private." : `- The training data: [${f.datasetRepo}](${hubLink(f.datasetRepo, "dataset")})`,
    "- `muse_muse_run.json` has the run's records: its settings, metrics, eval summary and items.",
  ].join("\n");
}

/** The model repo's README.md: YAML front matter the Hub's validator takes, then the sections in the order above. */
/**
 * A Llama adapter's card: its license duties first, then the story and the records' result. Short, because the Glimmer
 * card's sections describe that model's template and license.
 */
function llamaCard(f: CardFacts, duties: ReturnType<typeof licenseDuties>): string {
  const [, name] = f.modelRepo.split("/");
  const front = [
    "---",
    `base_model: ${f.template.model}`,
    "base_model_relation: adapter",
    "library_name: peft",
    "pipeline_tag: text-generation",
    "license: other",
    "license_name: llama-community-license",
    "license_link: LICENSE",
    "tags:",
    ...["lora", "peft", "unsloth", "llama", "built-with-llama", "muse-muse"].map((t) => `- ${t}`),
    ...(f.datasetPrivate ? [] : ["datasets:", `- ${f.datasetRepo}`]),
    "---",
  ];
  const body = [
    `# ${name}`,
    "",
    `**${duties.line}.** A LoRA adapter for [${f.template.model}](${HUB_SITE}/${f.template.model}), at commit \`${f.revision}\`.`,
    "",
    whySection(f),
    "",
    "## License",
    "",
    `${duties.license} The full texts are in \`LICENSE\` and \`USE_POLICY.md\`.`,
    "",
    ...duties.points.map((p) => `- ${p}`),
    "",
  ];
  return noEmDashes([...front, "", ...body].join("\n"));
}

export function modelCard(f: CardFacts): string {
  const duties = licenseDuties({ adapterBase: f.template.model });
  if (duties.line && duties.family !== "glimmer") return llamaCard(f, duties);
  const s = f.summary;
  const derived = cardSparkOpen(f);
  const [, name] = f.modelRepo.split("/");
  const english = looksEnglish(f.dataset.title, f.dataset.task);
  const front = [
    "---",
    `base_model: ${f.template.model}`,
    "base_model_relation: adapter",
    "library_name: peft",
    "pipeline_tag: text-generation",
    ...licenseFront(derived),
    ...(english ? ["language:", "- en"] : []),
    "tags:",
    ...["lora", "peft", "unsloth", "trl", "sft", "muse-muse", ...(derived ? ["built-with-muse-spark-open"] : [])].map((t) => `- ${t}`),
    ...(f.datasetPrivate ? [] : ["datasets:", `- ${f.datasetRepo}`]),
    "model-index:",
    `- name: ${name}`,
    "  results:",
    "  - task:",
    "      type: text-generation",
    `      name: ${derived ? "Blind pairwise vs the 2026 Glimmer it started from" : "Blind pairwise vs base"}`,
    "    dataset:",
    `      name: ${y(`${clean(f.dataset.title)} held-out prompts`)}`,
    `      type: ${f.datasetPrivate ? "held-out-prompts" : f.datasetRepo}`,
    "      split: eval",
    "    metrics:",
    `    - name: ${derived ? "Judge win rate vs the 2026 Glimmer it started from" : "Judge win rate vs base"}`,
    "      type: win_rate",
    `      value: ${s.items > 0 ? Math.round((s.tunedWins / s.items) * 10_000) / 10_000 : 0}`,
    "    - name: Average judge score, tuned (1 to 10)",
    "      type: judge_score",
    `      value: ${Math.round(s.avgTunedScore * 100) / 100}`,
    `    - name: ${derived ? "Average judge score, the 2026 Glimmer it started from (1 to 10)" : "Average judge score, base (1 to 10)"}`,
    "      type: judge_score",
    `      value: ${Math.round(s.avgBaseScore * 100) / 100}`,
    "    source:",
    "      name: Muse Muse blind eval",
    `      url: ${labPageUrl(f.job.id)}`,
    "---",
  ];
  const writer = writerName(f.dataset);
  const lead = `A LoRA adapter for ${GLIMMER_NAME}${derived ? " with 2026 knowledge" : ""} (\`${f.template.model}\`) that learned one task from ${writer}: ${taskSentence(f.dataset.task)}. Made with [Muse Muse](${MUSE_MUSE_SITE}). Not an official Meta product.`;
  const does = [
    "## What it does",
    "",
    `It does the task of the dataset "${mdCell(f.dataset.title)}", which the admin described as:`,
    "",
    ...clean(f.dataset.task).split("\n").map((l) => `> ${l}`),
    "",
    `It was trained to answer the way ${writer} answered those prompts. Prompt it the way it was trained, with this system message (How to use it has it as SYSTEM):`,
    "",
    fenced(clean(f.system), "text"),
  ].join("\n");
  return [
    front.join("\n"),
    "",
    `# ${name}`,
    "",
    lead,
    "",
    ...(derived ? [builtWithBlock("This adapter"), ""] : []),
    whySection(f),
    "",
    does,
    "",
    resultsSection(f),
    "",
    trainingSection(f),
    "",
    usageSection(f),
    "",
    dataSection(f),
    "",
    limitsSection(f),
    "",
    licenseSection(f),
    "",
    provenanceSection(f),
    "",
  ].join("\n");
}

/** The dataset repo's paths, under data/ as the default config names them. */
export const DATASET_TRAIN_PATH = "data/train.jsonl";
/** The dataset's license file and the license_name its card declares: the text is model output, not ours to license. */
export const DATASET_LICENSE_PATH = "LICENSE.md";
export const DATASET_LICENSE_NAME = "meta-model-api-outputs";
export const DATASET_EVAL_PATH = "data/eval.jsonl";

/** A model published from a dataset, for its card's list. */
export interface DatasetModel {
  repo: string;
  jobId: string;
  title: string;
}

/**
 * The dataset repo's README.md, which the job publishing now writes once its own model repo is committed and verified:
 * its "Why this exists" is that job's (the latest publish), and every published model trained on the dataset is listed,
 * that job's first, then `others` (published and public, newest first).
 */
export function datasetCard(f: CardFacts, others: DatasetModel[] = []): string {
  const d = f.dataset;
  const writer = writerName(d);
  const models: DatasetModel[] = [{ repo: f.modelRepo, jobId: f.job.id, title: f.job.title }, ...others.filter((m) => m.repo !== f.modelRepo)];
  const own = `[${f.modelRepo}](${hubLink(f.modelRepo, "model")})`;
  const english = looksEnglish(d.title, d.task);
  const front = [
    "---",
    `pretty_name: ${y(clean(d.title))}`,
    "license: other",
    `license_name: ${DATASET_LICENSE_NAME}`,
    `license_link: ${DATASET_LICENSE_PATH}`,
    ...(english ? ["language:", "- en"] : []),
    "task_categories:",
    "- text-generation",
    "size_categories:",
    `- ${sizeCategory(d.trainCount + d.evalCount)}`,
    "annotations_creators:",
    "- machine-generated",
    "language_creators:",
    "- machine-generated",
    "source_datasets:",
    "- original",
    "tags:",
    ...["synthetic", "sft", "distillation", "muse-muse"].map((t) => `- ${t}`),
    "configs:",
    "- config_name: default",
    "  data_files:",
    "  - split: train",
    `    path: ${DATASET_TRAIN_PATH}`,
    "  - split: eval",
    `    path: ${DATASET_EVAL_PATH}`,
    "---",
  ];
  const body = [
    `# ${clean(d.title)}`,
    "",
    models.length > 1
      ? `Training data that ${writer} wrote for one task, made with [Muse Muse](${MUSE_MUSE_SITE}). ${models.length} ${GLIMMER_NAME} LoRA adapters trained on it are published: see Models trained on it.`
      : `Training data that ${writer} wrote for one task, made with [Muse Muse](${MUSE_MUSE_SITE}). ${own} is a ${GLIMMER_NAME} LoRA adapter trained on it.`,
    "",
    whySection(f, models.length > 1 ? `As the card of ${own}, the latest model published from it, tells it:` : null),
    "",
    "## The task",
    "",
    "As the admin described it:",
    "",
    ...clean(d.task).split("\n").map((l) => `> ${l}`),
    "",
    "## What's in it",
    "",
    "| Split | File | Examples |",
    "|---|---|---|",
    `| train | \`${DATASET_TRAIN_PATH}\` | ${d.trainCount} |`,
    `| eval | \`${DATASET_EVAL_PATH}\` | ${d.evalCount} |`,
    "",
    'Each line is one conversation, `{"messages": [...]}`, in the format TRL and Unsloth train on. Its messages have a `role` and a `content`:',
    "",
    "- `system`: the task's instructions, the same on every line, which the answers were written under.",
    "- `user`: a prompt.",
    `- \`assistant\`: ${writer}'s answer. On an eval line it is the reference answer the judge compared both models against.`,
    "",
    "## How it was made",
    "",
    `${writer} wrote the prompts in batches, each batch leaning to other styles of message, with repeats folded out. It then answered each prompt under the task's instructions (each line's \`system\` message), and answers that failed, came back cut off or ran too long were left out.`,
    "",
    `The split: ${d.evalCount} examples were held out for eval and ${d.trainCount} kept for training, the held-out ones spread evenly through the dataset so every batch's style is in them. A prompt that shares at least ${Math.round(NEAR_DUPLICATE_JACCARD * 100)}% of its words with a held-out prompt was left out of train, so the eval doesn't test what was trained on.`,
    "",
    `Writing it cost ${money(d.costUsd)} on Meta's Model API.`,
    "",
    "## Models trained on it",
    "",
    ...models.map((m) => `- [${m.repo}](${hubLink(m.repo, "model")}), from the run "${mdCell(m.title)}": ${labPageUrl(m.jobId)}`),
    "",
    "## License",
    "",
    `${writer} wrote all of the text, prompts and answers, through Meta's Model API, for Muse Muse, so Meta's terms for that API's outputs govern it, and Muse Muse grants no rights beyond them: see \`${DATASET_LICENSE_PATH}\`. Not an official Meta product.`,
    "",
    "## Provenance",
    "",
    `- Made by [Muse Muse](${MUSE_MUSE_SITE}), dataset \`${d.id}\`.`,
    "- Each model above links its run's public page, with every eval item and the judge's verdicts.",
    "",
  ];
  return [front.join("\n"), "", ...body].join("\n");
}

/**
 * The dataset's LICENSE.md. The prompts and answers are its writer's output through Meta's Model API (`writerModel`, the
 * dataset's writer_model: null or absent means Muse Spark 1.3), so they can't go out under an open license: Meta's terms
 * for that API decide what anyone may do with them.
 */
export function datasetLicense(writerModel: string | null = null): string {
  const writer = writerName({ writerModel });
  return [
    "# Terms for this dataset",
    "",
    `${writer} wrote every prompt and answer in this dataset through Meta's Model API, for Muse Muse. That text is model output, so Meta's terms for the Model API govern how you may use it. Muse Muse grants no license or other rights beyond what those terms allow.`,
    "",
    "When this dataset was published, those terms said a model's outputs may not be used to develop or improve a competing AI model or service without Meta's written permission. Read Meta's current Model API terms before you reuse this text, and don't rely on this summary.",
    "",
    `Not an official Meta product. Meta made ${writer}; it didn't make, review or endorse this dataset.`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// The dataset's files and the run's record

/** The dataset's training examples as JSONL: one {"messages": [{role, content}]} a line, as they were trained on. */
export function trainJsonl(examples: TrainExample[]): string {
  return examples
    .map((e) => JSON.stringify({ messages: (e.messages ?? []).map((m) => ({ role: m.role, content: m.content })) }))
    .map((line) => `${line}\n`)
    .join("");
}

/**
 * The held-out items as JSONL in the same format as train: the task's system message, the prompt, and the reference
 * answer as the assistant's, so both splits load as one config.
 */
export function evalJsonl(items: EvalExample[], system: string): string {
  return items
    .map((e) =>
      JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: e.prompt },
          { role: "assistant", content: e.reference },
        ],
      }),
    )
    .map((line) => `${line}\n`)
    .join("");
}

/** The system message the dataset's training examples share: the first one's, else the task's (datasetSystemPrompt). */
export function datasetSystem(train: TrainExample[], task: string): string {
  const first = train[0]?.messages?.find((m) => m.role === "system")?.content;
  return typeof first === "string" && first.trim() ? first : datasetSystemPrompt(task);
}

/** The done metrics a published record keeps. Never a path on the cache, a Blob URL or anything about the instance. */
export const PUBLIC_METRICS: readonly string[] = [
  "train_loss_final",
  "steps",
  "max_steps",
  "stopped_early",
  "train_seconds",
  "base_answer_seconds",
  "base_unfinished",
  "tuned_unfinished",
  "trained_tokens_min",
  "trained_tokens_mean",
  "max_new_tokens",
  "peak_vram_gb",
  "gpu",
  "eval_items",
  "train_examples",
  "student_prompt",
  "student_system",
  "adapter_mb",
];

/** The metrics a published record keeps (PUBLIC_METRICS), as they are. */
export function publicMetrics(metrics: Record<string, string | number> | null | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const key of PUBLIC_METRICS) {
    const v = metrics?.[key];
    if (typeof v === "number" || typeof v === "string") out[key] = v;
  }
  return out;
}

/** One eval item with its verdict, as the run's record keeps it. */
export interface RunItem {
  index: number;
  prompt: string;
  reference: string;
  base: string;
  tuned: string;
  judgement: { baseScore: number; tunedScore: number; better: string; note: string } | null;
}

/**
 * muse_muse_run.json: the run's records as the public page shows them, and the card's facts. The job's settings, its
 * public metrics, the eval summary and every item with its verdict, the dataset, the base model and its revision, and
 * who wrote the story. The dataset's writer, the judge and the story's model are the records' (`storyModel`, the hub
 * state's: null means Muse Spark 1.3), each Muse Spark 1.3 when the record has none. Never the instance, its IP or
 * region, a log, a path or a URL of the platform's storage.
 */
export function runRecord(
  f: CardFacts,
  items: RunItem[],
  storyBy: "spark" | "template",
  storyModel: string | null = null,
): Record<string, unknown> {
  return {
    madeBy: { name: "Muse Muse", url: MUSE_MUSE_SITE },
    job: {
      id: f.job.id,
      title: f.job.title,
      recipe: "glimmer-lora",
      page: labPageUrl(f.job.id),
      finishedAt: f.job.finishedAt,
      gpu: f.job.instanceType,
      gpuMinutes: f.job.gpuMinutes,
      gpuCostUsd: f.job.costUsd,
      settings: {
        maxSteps: f.job.maxSteps,
        learningRate: f.job.learningRate,
        loraRank: f.job.loraRank,
        studentPrompt: f.job.studentPrompt,
      },
      metrics: publicMetrics(f.metrics),
    },
    base: { model: f.template.model, revision: f.revision, from: GLIMMER_ORIGIN },
    system: f.system,
    dataset: {
      id: f.dataset.id,
      title: f.dataset.title,
      task: f.dataset.task,
      trainCount: f.dataset.trainCount,
      evalCount: f.dataset.evalCount,
      costUsd: f.dataset.costUsd,
      repo: f.datasetPrivate ? null : f.datasetRepo,
      writer: writerModelOf(f.dataset),
    },
    eval: {
      judge: judgeId(f),
      blind: "The judge saw both answers as A and B: the base model's first on even items and second on odd ones.",
      summary: f.summary,
      items,
    },
    story: storyOf(f.why, storyBy, storyModel),
  };
}

/**
 * The record's story: the why, who wrote the story and, for a model's, which model. A story Muse Spark 1.3 wrote keeps
 * the "spark" its records said before the model was recorded; another model's says "model", so no record credits
 * Muse Spark 1.3 with a story it didn't write.
 */
function storyOf(why: string | null, storyBy: "spark" | "template", storyModel: string | null) {
  if (storyBy !== "spark") return { why, by: storyBy };
  const model = recordedModel(storyModel);
  return { why, by: model === UNRECORDED_MODEL ? "spark" : "model", model };
}

/**
 * The eval items with their verdicts, in index order, from a judged job's eval and judgement events. The general checks
 * (lib/train/general-checks.ts) are left out: the cards and the run's record are about the task.
 */
export function runItems(events: TrainEventView[]): RunItem[] {
  const items = new Map<number, RunItem>();
  const verdicts = new Map<number, NonNullable<RunItem["judgement"]>>();
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const ev of events) {
    const p = ev.payload;
    if (p?.type === "eval" && Number.isInteger(p.index) && checkSetOf(p.index) === null && !items.has(p.index)) {
      items.set(p.index, {
        index: p.index,
        prompt: text(p.prompt),
        reference: text(p.reference),
        base: text(p.base),
        tuned: text(p.tuned),
        judgement: null,
      });
    } else if (p?.type === "judgement" && Number.isInteger(p.index) && !verdicts.has(p.index)) {
      verdicts.set(p.index, { baseScore: num(p.baseScore), tunedScore: num(p.tunedScore), better: text(p.better), note: text(p.note) });
    }
  }
  return [...items.values()].sort((a, b) => a.index - b.index).map((i) => ({ ...i, judgement: verdicts.get(i.index) ?? null }));
}

/**
 * The card's example: the first judged item the tuned model won with a note, else the first judged one. Null when
 * nothing was judged.
 */
export function pickExample(items: RunItem[]): CardExample | null {
  const judged = items.filter((i) => i.judgement);
  const pick = judged.find((i) => i.judgement!.better === "tuned" && i.judgement!.note.trim()) ?? judged[0];
  if (!pick) return null;
  const j = pick.judgement!;
  const better = j.better === "tuned" || j.better === "base" ? j.better : "tie";
  return { index: pick.index, prompt: pick.prompt, base: pick.base, tuned: pick.tuned, baseScore: j.baseScore, tunedScore: j.tunedScore, better, note: j.note };
}

// ---------------------------------------------------------------------------------------------------------------
// The hub state's rules

/**
 * Why a job can't be published to the Hub, or null when it can: a glimmer-lora job in chat mode that succeeded, wasn't
 * a dry run, had its GPU shut down and was judged, so its card has results. Plain sentences, for the job page and the
 * routes. A decide job's scored summary counts as results everywhere else, so it is refused here by its mode.
 */
export function hubJobProblem(job: Pick<TrainJobRow, "recipe" | "status" | "params" | "terminatedAt" | "evalSummary">): string | null {
  if (job.recipe !== "glimmer-lora") return "Only Muse Glimmer LoRA jobs are published to Hugging Face.";
  // This path publishes the adapter with its dataset and a judged chat card. A decision model needs the adapter alone
  // with a decision card, and a person's rows are never published (docs/DECISION_MODELS.md, "Publishing").
  if (jobMode(job.params) === DECIDE_MODE) {
    return "It is a decision model, and publishing one (the adapter alone, with a decision card, never the person's rows) isn't built yet.";
  }
  if (Number(job.params?.dryRun) >= 1) return "It was a dry run, so its adapter is a stand-in.";
  if (job.status !== "succeeded") return "It didn't succeed, so it has no adapter to publish.";
  const note = unjudgedNote(job.evalSummary);
  if (!job.terminatedAt || !job.evalSummary) return "It isn't judged yet, and its card needs the results.";
  if (note) return `It wasn't judged (${note.replace(/[.]+$/, "")}), so its card would have no results.`;
  return null;
}

/**
 * True when a dataset's repo stays private while its model may go to the Hub: Spark 1.3 Contributor wrote it, or its rows
 * were imported from a public source (data research), whose own license and attribution the dataset card doesn't carry.
 */
export function keepDatasetPrivate(dataset: { writerModel?: string | null; kind?: string | null }): boolean {
  // A decision dataset's "public" is Muse Decide's public mix, which publishes as it always has.
  return dataset.writerModel === SPARK_STANDIN || (dataset.writerModel === PUBLIC_WRITER && dataset.kind !== "decision");
}

/**
 * True when a job's "publish" param (0 or 1) says to keep it off the Hub. Unset means it publishes, except in decide
 * mode, where it means 0 (docs/DECISION_MODELS.md, "Publishing"): the jobs route stores 0 there anyway.
 */
export function publishOff(params: Record<string, string | number> | null | undefined): boolean {
  const v = params?.publish;
  if (v === undefined || v === "") return jobMode(params) === DECIDE_MODE;
  return Number(v) === 0;
}

/** True when the Hub has every file in the plan, and the plan has the adapter's weights and config. */
export function hubUploaded(hub: HubState | null | undefined): boolean {
  const files = hub?.files ?? [];
  const have = new Set(hub?.uploaded ?? []);
  return (
    files.some((f) => f.path === "adapter_model.safetensors") &&
    typeof hub?.small?.["adapter_config.json"] === "string" &&
    files.every((f) => have.has(f.sha256))
  );
}

/**
 * The hub state after a GPU's plan. The plan's files and small files replace the ones before (runner.py sends the
 * whole plan every time, a fresh one after an expired URL included), so the state never holds more than one plan's
 * caps. The oids the Hub already has (`present`) count as uploaded, and so do those an earlier report of the same GPU
 * gave, while they are still in the plan; a plan from another job's GPU (a new glimmer-publish job) starts that list
 * over, so a commit never mixes two uploads. Status "uploading", with no publishing claim.
 */
export function withPlan(
  hub: HubState | null,
  plan: { uploaderJobId: string; modelRepo: string; files: HubFile[]; small: Record<string, string>; present: string[] },
  now: Date,
): HubState {
  const same = hub?.uploaderJobId === plan.uploaderJobId;
  const kept = new Set(plan.files.map((f) => f.sha256));
  const uploaded = [...new Set([...(same ? (hub?.uploaded ?? []) : []), ...plan.present])].filter((oid) => kept.has(oid));
  return {
    ...(hub ?? {}),
    status: "uploading",
    reason: null,
    modelRepo: plan.modelRepo,
    files: plan.files,
    small: plan.small,
    uploaded,
    uploaderJobId: plan.uploaderJobId,
    claim: null,
    updatedAt: now.toISOString(),
  };
}

/**
 * The hub state after the GPU's report: the oids it uploaded join the uploaded list; a failed file fails the upload,
 * with the reason; with every file in (`complete`: an adapter's rule, hubUploaded, unless the job's is another), it is
 * "uploaded". Files the plan doesn't have are ignored.
 */
export function withDone(
  hub: HubState,
  done: { uploaded: string[]; failed: Array<{ path: string; error: string }> },
  now: Date,
  complete: (hub: HubState) => boolean = hubUploaded,
): HubState {
  const planned = new Set((hub.files ?? []).map((f) => f.sha256));
  const uploaded = [...new Set([...(hub.uploaded ?? []), ...done.uploaded.filter((oid) => planned.has(oid))])];
  const next: HubState = { ...hub, uploaded, updatedAt: now.toISOString() };
  if (done.failed.length) {
    const first = done.failed[0]!;
    const more = done.failed.length > 1 ? ` (and ${done.failed.length - 1} more)` : "";
    return { ...next, status: "failed", reason: `The GPU couldn't upload ${first.path} to Hugging Face: ${first.error}${more}` };
  }
  return complete(next) ? { ...next, status: "uploaded", reason: null } : next;
}

// ---------------------------------------------------------------------------------------------------------------
// Local files: a glimmer-quantize job's GGUF repo (docs/TRAINING.md "Local files")

/**
 * Meta's base model at the revision whose chat_template.jinja and tokenizer files go into every merged model, so each
 * GGUF file embeds Meta's current template (main on 2026-10-28; the revision ggml-org's own conversion used). The
 * template's SHA-256, and tuned.jinja's: Meta's template with its default reasoning strength "low" and a generation
 * prompt that opens the final channel, for an adapter trained before trainChannel. QUANT_PY pins the same.
 */
export const META_REVISION = "cec94fcfd6512f2cfe708138c32533b346ea4f69";
export const META_TEMPLATE_SHA256 = "cfc67e5f349f37690dfd31ed1f18bc4442a9dd32fe39a648f993cb4eb3cae678";
export const TUNED_TEMPLATE_SHA256 = "ee7766876b1317a7b95caec088aca7905399ce8b7117745921643e931b476b13";
/** The line a local app's system message ends with, so Meta's template adds no second one and the app reasons at "low". */
export const GGUF_REASONING_LINE = "Reasoning strength: low.";
/** What a build needs besides its file to run at an 8K context: about 0.2 GB of KV cache and up to 1 GB of buffers. */
export const GGUF_RUN_EXTRA_GB = 1.2;
/**
 * The computers each build is picked for (docs/VIBE_TUNING.md "Three sizes"). A graphics card is NVIDIA's, or an AMD or
 * Intel one with as much memory through LM Studio's Vulkan engine, which is less tested; a 12 GB card runs the smallest
 * build only with 32 GB of RAM for the part that runs on the processor.
 */
export const GGUF_PICKED_FOR: Readonly<Record<QuantLevel, string>> = {
  Q3_K_M: "A Mac with 24 GB, a graphics card with 16 GB, or one with 12 GB and 32 GB of RAM, with part of it on the processor",
  Q4_K_M: "A Mac with 32 or 36 GB, a graphics card with 24 GB, or a PC with 32 GB of RAM and no big graphics card, slowly",
  Q6_K: "A Mac with 48 GB or more, or a graphics card with 32 GB",
};

/** Who a build is for. The one-bit build's words say what isn't proven (lib/train/quant-targets.ts). */
function pickedFor(level: BuildLevel): string {
  if (level !== LOW_BIT_LEVEL) return GGUF_PICKED_FOR[level];
  return `A Jetson Orin Nano's ${LOW_BIT_FACTS.boardGb} GB, shared with the operating system, if it fits: not run on a real board yet`;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True for a slug as repo names use it: lowercase letters and digits with single dashes, at most SLUG_MAX. */
export function validSlug(slug: unknown): slug is string {
  return typeof slug === "string" && slug.length <= SLUG_MAX && SLUG_RE.test(slug);
}

/**
 * The slug a glimmer-quantize job names its repo and files with: the one in its adapter's model repo
 * ("muse-glimmer-30b-<slug>-lora-<job8>"), so the three repos of a run line up, else its dataset title's (hubSlug).
 */
export function ggufSlug(adapterModelRepo: string | null | undefined, datasetTitle: string, adapterJobId: string): string {
  const name = String(adapterModelRepo ?? "").split("/")[1] ?? "";
  const tail = `-lora-${adapterJobId.slice(0, 8).toLowerCase()}`;
  const slug = name.startsWith("muse-glimmer-30b-") && name.endsWith(tail) ? name.slice("muse-glimmer-30b-".length, -tail.length) : "";
  return validSlug(slug) ? slug : hubSlug(datasetTitle);
}

/**
 * The GGUF repo's name: "muse-glimmer-30b-<slug>-gguf-<first 8 characters of the adapter's training job id>", so it sits
 * next to the adapter's "-lora-" repo of the same run.
 */
export function ggufRepoName(slug: string, adapterJobId: string, params?: Record<string, string | number> | null): string {
  return `${quantBaseOf(params)?.fileStem ?? "muse-glimmer-30b-"}${slug}-gguf-${adapterJobId.slice(0, 8).toLowerCase()}`;
}

/** A build's file name, "muse-glimmer-30b-<slug>-<LEVEL>.gguf": every local app picks a file by the level in its name. */
export function ggufFileName(slug: string, level: BuildLevel, params?: Record<string, string | number> | null): string {
  return `${quantBaseOf(params)?.fileStem ?? "muse-glimmer-30b-"}${slug}-${level}.gguf`;
}

/** The builds a glimmer-quantize job's levels param names, smallest first. A level not on BUILD_LEVELS never counts. */
export function quantLevels(params: Record<string, string | number> | null | undefined): BuildLevel[] {
  const asked = String(params?.levels ?? "")
    .split(",")
    .map((s) => s.trim());
  return BUILD_LEVELS.filter((level) => asked.includes(level));
}

/** A level's prefix in a glimmer-quantize job's done metrics: "q4_k_m" for Q4_K_M. */
export function levelKey(level: BuildLevel): string {
  return level.toLowerCase();
}

/**
 * The params the platform writes on a glimmer-quantize job, on top of the admin's adapterJobId and publish, so no caller
 * chooses them: the builds (QUANT_LEVELS), the slug its adapter's repos are named with (ggufSlug) and whether the
 * adapter trained with trainChannel.
 *
 * With opts.targets (QUANT_TARGETS): an adapter on r30b also gets the one-bit build, and one on a small base gets that
 * base's builds and its pinned base. trainChannel 1 says its files need no tuned.jinja, which is Glimmer's alone.
 */
export function quantParams(
  adapter: Pick<TrainJobRow, "id" | "params" | "hub">,
  datasetTitle: string,
  opts: { targets?: boolean } = {},
): { levels: string; slug: string; trainChannel: 0 | 1 } & Record<string, string | number> {
  const small = opts.targets ? quantBaseForAdapter(adapter.params) : null;
  if (small) {
    return {
      levels: small.levels.join(","),
      slug: ggufSlug(adapter.hub?.modelRepo, datasetTitle, adapter.id),
      trainChannel: 1,
      quantBase: small.name,
      baseFamily: small.family,
      baseModel: small.model,
      baseRevision: String(adapter.params?.baseRevision ?? ""),
    };
  }
  return {
    levels: (opts.targets ? BUILD_LEVELS : QUANT_LEVELS).join(","),
    slug: ggufSlug(adapter.hub?.modelRepo, datasetTitle, adapter.id),
    trainChannel: trainChannelOf(adapter.params),
  };
}

/**
 * Why the platform won't publish a file a job's GPU names, or null when it will. A glimmer-quantize job's are its
 * builds' GGUF files (ggufFileName with its slug, for the levels its params name) and the small files beside them
 * (HUB_GGUF_SMALL_NAMES); every other job's are an adapter's (hubFileProblem). runner.py keeps the same rule.
 */
export function hubNameProblem(job: Pick<TrainJobRow, "recipe" | "params">, path: string): string | null {
  if (job.recipe !== QUANT_RECIPE) return hubFileProblem(path);
  if (HUB_GGUF_SMALL_NAMES.includes(path)) return null;
  const slug = job.params?.slug;
  if (validSlug(slug) && quantLevels(job.params).some((level) => ggufFileName(slug, level, job.params) === path)) return null;
  return "only the builds' GGUF files and their system, params and tuned.jinja are published";
}

/** The largest file a job's GPU may send: HUB_GGUF_FILE_MAX_BYTES for a glimmer-quantize job's build, else HUB_FILE_MAX_BYTES. */
export function hubMaxBytes(job: Pick<TrainJobRow, "recipe">, path: string): number {
  return job.recipe === QUANT_RECIPE && path.endsWith(".gguf") ? HUB_GGUF_FILE_MAX_BYTES : HUB_FILE_MAX_BYTES;
}

/** The GGUF repo's system file, and the system message to paste in a local app: the role line, a blank line, low reasoning. */
export function ggufSystemLine(role: string, params?: Record<string, string | number> | null): string {
  // Only Glimmer's template reads a reasoning line. A small base's files get the role as it trained.
  if (quantBaseOf(params)) return role;
  return `${role}\n\n${GGUF_REASONING_LINE}`;
}

/** The stops a local app needs: tuned.jinja opens the final channel, so a message that ends or a new one ends the answer. */
export function ggufStops(trainChannel: 0 | 1, params?: Record<string, string | number> | null): string[] {
  if (quantBaseOf(params)) return ["<|eot_id|>", "<|eom_id|>", "<|end_of_text|>"];
  return trainChannel === 1 ? ["<|eot|>", "<|end_of_text|>"] : ["<|eot|>", "<|eom|>", "<|end_of_text|>", "<|start|>"];
}

/** Ollama's params file for the GGUF repo: greedy as the eval answered, an 8K context, and the stops. QUANT_PY writes the same. */
export function ggufParams(trainChannel: 0 | 1, params?: Record<string, string | number> | null): string {
  return `${JSON.stringify({ temperature: 0, num_ctx: 8192, stop: ggufStops(trainChannel, params) }, null, 2)}\n`;
}

/**
 * Ollama's TEMPLATE for an adapter trained before trainChannel: Meta's prompt with the system message, the turns, and a
 * generation prompt that opens the final channel the way this adapter's answers start (quantization notes).
 */
const OLLAMA_TUNED_TEMPLATE = [
  'TEMPLATE """{{- if .System }}<|start|>system<|message|>{{ .System }}',
  "",
  '# Valid recipients: "self", "user".<|eot|>{{ end }}{{- range .Messages }}{{- if eq .Role "user" }}<|start|>user<|message|>{{ .Content }}<|eot|>{{- else if eq .Role "assistant" }}<|start|>assistant to=user<|message|>{{ .Content }}<|eot|>{{- end }}{{- end }}<|start|>assistant to=user<|message|>"""',
];

/**
 * Ollama's Modelfile for one build, the same on the GGUF card and the run-locally page: a model trained with
 * trainChannel takes Ollama's own Glimmer renderer and parser (its parser accepts them; they aren't documented), one
 * trained before it the TEMPLATE that opens the final channel and the four stops that end its answer. Then the system
 * message exactly, temperature 0 as the eval answered, and an 8K context in place of Ollama's 4,096.
 */
export function ggufModelfile(fileName: string, systemLine: string, trainChannel: 0 | 1): string {
  return [
    `FROM ./${fileName}`,
    ...(trainChannel === 0 ? OLLAMA_TUNED_TEMPLATE : ["RENDERER glimmer", "PARSER glimmer"]),
    `SYSTEM """${systemLine}"""`,
    "PARAMETER temperature 0",
    "PARAMETER num_ctx 8192",
    ...(trainChannel === 0 ? ggufStops(0).map((stop) => `PARAMETER stop ${stop}`) : []),
  ].join("\n");
}

/** Ollama's name for the model, on the card and the page alike: its slug, lowercase letters, digits and dashes. */
export function ggufOllamaName(slug: string): string {
  const name = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "muse-glimmer-tuned";
}

/**
 * Why one of a GGUF repo's small files can't be published as the GPU sent it, or null when it can: system must be the
 * line the adapter trained with (ggufSystemLine), params Ollama's for its channel (ggufParams), and tuned.jinja, only
 * for an adapter trained before trainChannel, the pinned TUNED_TEMPLATE_SHA256. `sha256` is the bytes' SHA-256.
 */
export function ggufSmallProblem(path: string, bytes: Buffer, sha256: string, expect: { role: string; trainChannel: 0 | 1; params?: Record<string, string | number> | null }): string | null {
  if (path === "system") return bytes.toString("utf8") === ggufSystemLine(expect.role, expect.params) ? null : "its system file isn't the system message the adapter trained with";
  if (path === "params") return bytes.toString("utf8") === ggufParams(expect.trainChannel, expect.params) ? null : "its params file isn't the one for this model";
  if (path === "tuned.jinja") {
    if (expect.trainChannel === 1) return "it has a tuned.jinja, which an adapter trained with trainChannel doesn't need";
    return sha256 === TUNED_TEMPLATE_SHA256 ? null : "its tuned.jinja isn't Meta's template with the final channel opened";
  }
  return null;
}

/**
 * True when the Hub has every file of a glimmer-quantize job's plan: at least one build, its system and params inline,
 * and tuned.jinja too for an adapter trained before trainChannel.
 */
export function ggufUploaded(hub: HubState | null | undefined, params: Record<string, string | number> | null | undefined): boolean {
  const files = hub?.files ?? [];
  const have = new Set(hub?.uploaded ?? []);
  const inline = ["system", "params", ...(trainChannelOf(params) === 1 ? [] : ["tuned.jinja"])];
  return (
    files.some((f) => f.path.endsWith(".gguf")) &&
    inline.every((name) => typeof hub?.small?.[name] === "string") &&
    files.every((f) => have.has(f.sha256))
  );
}

/** Whether the Hub has every file a job publishes: a glimmer-quantize job's (ggufUploaded), else an adapter's (hubUploaded). */
export function jobUploaded(job: Pick<TrainJobRow, "recipe" | "params">, hub: HubState | null | undefined): boolean {
  return job.recipe === QUANT_RECIPE ? ggufUploaded(hub, job.params) : hubUploaded(hub);
}

/** True when a glimmer-quantize job's done metrics say its file checks passed and its files reached the Hub's storage. */
export function quantFilesOk(metrics: DoneMetrics | null | undefined): boolean {
  return metrics?.checks_passed === "yes" && metrics?.hub_uploaded === "yes";
}

/**
 * Why a glimmer-quantize job can't publish its GGUF repo, or null when it can: it succeeded with its GPU shut down, its
 * file checks passed and its files reached the Hub's storage (quantFilesOk), and its adapter job is published. A public
 * adapter gives a public GGUF repo (when HF_PUBLIC asks for one); a private one, an admin's private test, a private one.
 */
export function ggufJobProblem(
  job: Pick<TrainJobRow, "recipe" | "status" | "terminatedAt">,
  metrics: DoneMetrics | null,
  adapter: Pick<TrainJobRow, "hub"> | null,
): string | null {
  if (job.recipe !== QUANT_RECIPE) return "Only a local files job publishes GGUF files.";
  if (job.status !== "succeeded") return "It didn't succeed, so it has no files to publish.";
  if (!job.terminatedAt) return "Its GPU isn't confirmed shut down yet.";
  if (!quantFilesOk(metrics)) return "Its files didn't all pass their checks and reach Hugging Face, so nothing of it is published.";
  if (!adapter) return "Its adapter's job is gone.";
  if (adapter.hub?.status !== "published" || !adapter.hub.modelRepo) {
    return "Its adapter isn't published on Hugging Face right now, and the GGUF repo links to it. Publish the adapter, then this.";
  }
  return null;
}

/**
 * A glimmer-quantize job as localFilesOf reads it: the job, its done metrics, its adapter's dataset title, and whether
 * its adapter is published and public on the Hub right now.
 */
export interface QuantSource {
  job: Pick<TrainJobRow, "id" | "title" | "params" | "hub">;
  metrics: DoneMetrics | null;
  datasetTitle: string | null;
  adapterPublic: boolean;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The local files contract (lib/train/local-files.ts) from a glimmer-quantize job that passed: each build its metrics
 * say passed, smallest first, with the size and SHA-256 it measured, and once its GGUF repo is published only the
 * builds the repo holds as those bytes; the repo, commit and visibility from its hub state, public only while its
 * adapter is public too; the system line it checked. Null when no build passed.
 */
export function localFilesOf(source: QuantSource): LocalFiles | null {
  const { job, metrics } = source;
  const slug = job.params?.slug;
  const adapterJobId = job.params?.adapterJobId;
  if (!validSlug(slug) || typeof adapterJobId !== "string") return null;
  const hub = job.hub ?? null;
  const published = hub?.status === "published" && typeof hub.modelRepo === "string" && hub.modelRepo.length > 0;
  const onHub = new Map((hub?.files ?? []).map((f) => [f.path, f.sha256]));
  const files: LocalFile[] = [];
  for (const level of QUANT_LEVELS) {
    const key = levelKey(level);
    if (metrics?.[`${key}_passed`] !== "yes") continue;
    const name = ggufFileName(slug, level, job.params);
    const bytes = Number(metrics[`${key}_bytes`]);
    const sha256 = String(metrics[`${key}_sha256`] ?? "");
    if (!(bytes > 0) || !SHA256_HEX.test(sha256)) continue;
    if (published && onHub.get(name) !== sha256) continue;
    files.push({ level, name, bytes, sha256 });
  }
  if (!files.length) return null;
  const lowBit = lowBitFileOf(slug, metrics, published ? onHub : null, job.params);
  const ran = typeof metrics?.system === "string" ? metrics.system.trim() : "";
  const role = ran.startsWith("You are ") ? ran : studentSystem(source.datasetTitle);
  return {
    adapterJobId,
    quantJobId: job.id,
    repo: published ? hub!.modelRepo! : null,
    commit: published ? (hub!.modelCommit ?? null) : null,
    public: published && hub!.public === true && source.adapterPublic,
    files,
    systemLine: ggufSystemLine(role, job.params),
    needsTunedTemplate: trainChannelOf(job.params) === 0,
    title: source.datasetTitle ?? job.title,
    slug,
    sparkOpen: isSparkOpenDerivative({ params: job.params, metrics }),
    ...(lowBit ? { lowBit } : {}),
    ...(quantBaseOf(job.params) ? { quantBase: quantBaseOf(job.params)!.name } : {}),
  };
}

/** The one-bit build, when the job made one, it passed, and a published repo holds it as those bytes. */
function lowBitFileOf(slug: string, metrics: DoneMetrics | null, onHub: Map<string, string> | null, params: Record<string, string | number> | null | undefined): LowBitFile | null {
  const key = levelKey(LOW_BIT_LEVEL);
  if (metrics?.[`${key}_passed`] !== "yes") return null;
  const name = ggufFileName(slug, LOW_BIT_LEVEL, params);
  const bytes = Number(metrics[`${key}_bytes`]);
  const sha256 = String(metrics[`${key}_sha256`] ?? "");
  if (!(bytes > 0) || !SHA256_HEX.test(sha256)) return null;
  if (onHub && onHub.get(name) !== sha256) return null;
  return { level: LOW_BIT_LEVEL, name, bytes, sha256 };
}

/** One build of a GGUF repo, as its card shows it: the file, and how close it measured to the merged model's Q8_0. */
export interface GgufBuild extends Omit<LocalFile, "level"> {
  level: BuildLevel;
  klMean: number | null;
  klP99: number | null;
  topTokenPct: number | null;
}

/** Everything the GGUF card says, from the records: the quantize job and its metrics, the adapter's job and hub state, the dataset. */
export interface GgufFacts {
  /**
   * True for a Derivative of Muse Spark Open (isSparkOpenDerivative, lib/train/base.ts): files merged into r30b. Absent
   * or false for files of plain Glimmer, unless the merge base or the adapter's base is one of r30b's repos.
   */
  sparkOpen?: boolean;
  repo: string;
  /** The slug the repo and its files are named with, which Ollama's name for the model is too. */
  slug: string;
  adapterRepo: string;
  adapterCommit: string | null;
  datasetRepo: string | null;
  adapterJobId: string;
  quantJobId: string;
  /** writerModel is the adapter's dataset's writer_model: null or absent means Muse Spark 1.3. */
  dataset: { title: string; task: string; evalCount: number; writerModel?: string | null };
  /** The one-line role the adapter trained under, "You are ...". */
  role: string;
  trainChannel: 0 | 1;
  /** The builds that passed, smallest first, and the ones that didn't with what they measured. */
  builds: GgufBuild[];
  leftOut: Array<{ level: BuildLevel; klMean: number | null }>;
  /** The job's quantBase param, for a small base's card. */
  params?: Record<string, string | number> | null;
  /** What the one-bit build's own checks measured, when the job tried one. */
  lowBit?: { final: number | null; total: number | null; agree: number | null; agreeTotal: number | null; problem: string | null; calibrationChars: number | null } | null;
  channel: { final: number; total: number };
  agreement: { same: number; total: number } | null;
  /** The base model files and template checks, as the job measured them. */
  tensors: number | null;
  llamacpp: { tag: string; commit: string | null };
  /** The 16-bit base merged into, and the commit whose shards the job matched against Meta's SHA-256 (null: unchecked). */
  mergeBase: { repo: string; revision: string | null };
  adapterBase: { model: string; revision: string };
  /** The small files the repo holds besides the builds. */
  small: Array<{ name: string; bytes: number; sha256: string }>;
  job: { gpuLabel: string; gpuMinutes: number; costUsd: number; finishedAt: string | null };
}

const numberOr = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;

/** The builds of a glimmer-quantize job's metrics, in QUANT_LEVELS order: those it passed (with the files) and those it left out. */
export function ggufBuilds(
  slug: string,
  levels: BuildLevel[],
  metrics: DoneMetrics,
  params?: Record<string, string | number> | null,
): { builds: GgufBuild[]; leftOut: Array<{ level: BuildLevel; klMean: number | null }> } {
  const builds: GgufBuild[] = [];
  const leftOut: Array<{ level: BuildLevel; klMean: number | null }> = [];
  for (const level of levels) {
    const key = levelKey(level);
    const klMean = numberOr(metrics[`${key}_kl_mean`]);
    const bytes = numberOr(metrics[`${key}_bytes`]);
    const sha256 = String(metrics[`${key}_sha256`] ?? "");
    if (metrics[`${key}_passed`] === "yes" && bytes !== null && bytes > 0 && SHA256_HEX.test(sha256)) {
      builds.push({
        level,
        name: ggufFileName(slug, level, params),
        bytes,
        sha256,
        klMean,
        klP99: numberOr(metrics[`${key}_kl_p99`]),
        topTokenPct: numberOr(metrics[`${key}_top_token_pct`]),
      });
    } else {
      leftOut.push({ level, klMean });
    }
  }
  return { builds, leftOut };
}

/** "16.94 GB": decimal gigabytes, as the Hub and the apps show a file's size. */
export function gigabytes(bytes: number): string {
  return `${(Math.max(0, bytes) / 1e9).toFixed(2)} GB`;
}

/** About how much memory a build needs at an 8K context: its file plus GGUF_RUN_EXTRA_GB, in whole gigabytes. */
export function runMemoryGb(bytes: number): number {
  return Math.round(bytes / 1e9 + GGUF_RUN_EXTRA_GB);
}

const kl = (v: number | null) => (v === null ? "not measured" : v.toFixed(4));
const klLimitText = (level: BuildLevel, params?: GgufFacts["params"]) => quantKlLimit(level, params)?.toFixed(4) ?? "none yet";

/** The build a command shows: Q4_K_M when it passed (llama.cpp's own default), else the first that did. */
function defaultBuild(f: GgufFacts): GgufBuild {
  return f.builds.find((b) => b.level === "Q4_K_M") ?? f.builds[0]!;
}

/** The commands to run it, per app, as the run-locally page gives them. tuned.jinja comes in for an adapter that needs it. */
function ggufRunSection(f: GgufFacts): string {
  const b = defaultBuild(f);
  const old = f.trainChannel === 0;
  const file = `https://huggingface.co/${f.repo}/resolve/main`;
  const system = ggufSystemLine(f.role);
  const name = ggufOllamaName(f.slug);
  // An 8K context in one slot, as the memory table counts it and the run-locally page runs it.
  const serve = `llama serve -hf ${f.repo}:${b.level} --no-mmproj -c 8192 -np 1`;
  const server = old ? `curl -LO ${file}/tuned.jinja\n${serve} --chat-template-file tuned.jinja --skip-chat-parsing --reasoning off` : serve;
  return [
    "## Run it",
    "",
    "Each app needs a version that knows Muse Glimmer: one built on llama.cpp b10353 or later, or Ollama 0.32.8 or later.",
    ...(old
      ? [
          "",
          "This adapter was trained to answer once the final channel is open, which stock apps leave to the model, so it needs `tuned.jinja` from this repo: Meta's own template with low reasoning by default and the final channel opened for the answer. The steps below put it in.",
        ]
      : []),
    "",
    "### LM Studio",
    "",
    `Open \`lmstudio://open_from_hf?model=${f.repo}&file=${b.name}\`, or search for \`${f.repo}\` in Discover and download the build for your computer.${old ? " Then in My Models, open the gear next to the model, and under Prompt Template choose Jinja and paste the whole of `tuned.jinja`." : ""} In a new chat, paste the system message below into the System Prompt, and set Temperature to 0 and Reasoning Strength to low.`,
    "",
    "### The Llama app (Mac)",
    "",
    old
      ? "The Llama app always uses the template inside the file, and this adapter needs `tuned.jinja` in its place, so the Llama app can't run it yet. Use LM Studio, llama.cpp or Ollama, with the steps for `tuned.jinja`."
      : `Open \`llama://install?repo=${f.repo}&quant=${b.level}\`, or install it with \`brew install --cask llama-app\` first. It serves the model at \`http://localhost:9931/v1\`.`,
    "",
    "### llama.cpp",
    "",
    "Install it with `brew install llama.cpp` or `winget install llama.cpp`, then:",
    "",
    fenced(server, "sh"),
    "",
    `The web UI is at \`http://127.0.0.1:9931\`. \`--no-mmproj\` keeps it from fetching a vision projector, since these files are text only.${old ? ` Send \`"stop": ${JSON.stringify(["<|eom|>", "<|start|>"])}\` with each request to its API.` : ""}`,
    "",
    "### Ollama",
    "",
    `Ollama 0.32.8 or later. Download the file (\`curl -LO ${file}/${b.name}\`), write this \`Modelfile\` next to it, then run \`ollama create ${name} -f Modelfile\` and \`ollama run ${name}\`. For another build, change the file on its first line:`,
    "",
    fenced(ggufModelfile(b.name, system, f.trainChannel), "text"),
    "",
    "Avoid `ollama run hf.co/...` for Muse Glimmer files: its import set stops that gave empty answers.",
  ].join("\n");
}

/** True when a GGUF repo's facts are a Derivative's: the flag, or a merge base or adapter base that is one of r30b's. */
export function ggufSparkOpen(f: Pick<GgufFacts, "sparkOpen" | "mergeBase" | "adapterBase">): boolean {
  return f.sparkOpen === true || isSparkOpenDerivative({ metrics: { merge_base: f.mergeBase.repo }, adapterBase: f.adapterBase.model });
}

/** A small base's GGUF card: its license duties first, what was measured, and how to run it. Glimmer's sections don't apply. */
function smallGgufCard(f: GgufFacts): string {
  const [, name] = f.repo.split("/");
  const base = quantBaseOf(f.params)!;
  const duties = licenseDuties({ adapterBase: base.model });
  const b = f.builds.find((x) => x.level === "Q4_K_M") ?? f.builds[0]!;
  const front = [
    "---",
    `base_model: ${base.mergeBase}`,
    "base_model_relation: finetune",
    "pipeline_tag: text-generation",
    "license: other",
    "license_name: llama-community-license",
    "license_link: LICENSE",
    "tags:",
    ...["gguf", "llama.cpp", "llama", "built-with-llama", "muse-muse", "lora-merged"].map((t) => `- ${t}`),
    ...(f.datasetRepo ? ["datasets:", `- ${f.datasetRepo}`] : []),
    "---",
  ];
  const body = [
    `# ${name}`,
    "",
    `**${duties.line}.** GGUF files of [${f.adapterRepo}](${hubLink(f.adapterRepo, "model")}), a LoRA adapter merged into [${base.mergeBase}](${HUB_SITE}/${base.mergeBase}): ${mdText(taskSentence(f.dataset.task))}.`,
    "",
    "## Run it",
    "",
    fenced(`llama serve -hf ${f.repo}:${b.level} -c 8192 -np 1`, "sh"),
    "",
    "Use this system message exactly, and temperature 0:",
    "",
    fenced(clean(ggufSystemLine(f.role, f.params)), "text"),
    "",
    "## What was measured",
    "",
    "| Build | File | Size | Mean KL divergence from Q8_0 | Top token the same |",
    "|---|---|---|---|---|",
    ...f.builds.map((x) => `| ${x.level} | \`${x.name}\` | ${gigabytes(x.bytes)} | ${kl(x.klMean)} | ${x.topTokenPct === null ? "not measured" : `${x.topTokenPct.toFixed(1)}%`} |`),
    "",
    `No KL limit applies yet, since no build of this base had been measured before this one. The answer check decides: ${b.level} gave a final answer to ${f.channel.final} of ${f.channel.total} held-out prompts, and the template it renders matched training's.`,
    "",
    `Files and SHA-256: ${f.builds.map((x) => `\`${x.name}\` \`${x.sha256}\``).join(", ")}. Made with llama.cpp \`${f.llamacpp.tag}\` on ${f.job.gpuLabel}, ${f.job.gpuMinutes} minutes, ${money(f.job.costUsd)}.`,
    "",
    "## License",
    "",
    `${duties.license} The full texts are in \`LICENSE\` and \`USE_POLICY.md\`.`,
    "",
    ...duties.points.map((p) => `- ${p}`),
    "",
  ];
  return noEmDashes([...front, "", ...body].join("\n"));
}

/** The one-bit build's honest section: what its own checks found, and what no one has seen yet. Empty when none was asked for. */
function lowBitSection(f: GgufFacts): string[] {
  if (!f.lowBit) return [];
  const l = f.lowBit;
  return [
    "",
    `## The one-bit file (${LOW_BIT_LEVEL})`,
    "",
    `Expect much weaker answers than the larger builds. On our 2026-knowledge model, this level recalled ${LOW_BIT_FACTS.recallOneBitPct}% of new-knowledge probes where Q4_K_M recalled ${LOW_BIT_FACTS.recallFourBitPct}%. Its KL limit is a coarse guard from two measured files, and the answer check below decides.`,
    "",
    l.final !== null && l.total !== null ? `Its own check on this model: ${l.final} of ${l.total} held-out prompts got a final answer${l.agree !== null && l.agreeTotal ? `, and ${l.agree} of ${l.agreeTotal} start like the adapter's own answers` : ""}.` : "Its own answer check didn't run.",
    ...(l.problem ? ["", `It isn't published: ${mdText(l.problem)}.`] : []),
    "",
    `For a Jetson Orin Nano: not run on a real board yet. Running it takes about the file plus ${GGUF_RUN_EXTRA_GB} GB by estimate, of the board's ${LOW_BIT_FACTS.boardGb} GB shared with the operating system, so it may not fit.`,
  ];
}

/** The GGUF repo's README.md: YAML front matter the Hub's validator takes, then the sections in the design's order. */
export function ggufCard(f: GgufFacts): string {
  if (quantBaseOf(f.params)) return smallGgufCard(f);
  const [, name] = f.repo.split("/");
  const english = looksEnglish(f.dataset.title, f.dataset.task);
  const derived = ggufSparkOpen(f);
  const front = [
    "---",
    `base_model: ${derived ? R30B_REPO : GLIMMER_ORIGIN}`,
    "base_model_relation: finetune",
    "pipeline_tag: text-generation",
    ...licenseFront(derived),
    ...(english ? ["language:", "- en"] : []),
    "tags:",
    ...["gguf", "llama.cpp", "muse-muse", "lora-merged", ...(derived ? ["built-with-muse-spark-open"] : [])].map((t) => `- ${t}`),
    ...(f.datasetRepo ? ["datasets:", `- ${f.datasetRepo}`] : []),
    "---",
  ];
  const adapter = `[${f.adapterRepo}](${hubLink(f.adapterRepo, "model")})`;
  const sizes = f.builds.map((b) => b.level).join(", ");
  // The task can be model-written (a vibe run's), so its Markdown shows as the characters it is.
  const lead = `GGUF files of ${adapter}, a LoRA adapter that taught ${GLIMMER_NAME}${derived ? " with 2026 knowledge" : ""} one task from ${writerName(f.dataset)}: ${mdText(taskSentence(f.dataset.task))}. The adapter is merged into ${derived ? `the 16-bit weights of ${R30B_LINK}` : "Meta's 16-bit base"} and quantized to ${plural(f.builds.length, "size")} (${sizes}) for llama.cpp, LM Studio and Ollama. Its eval is on [the run's public page](${labPageUrl(f.adapterJobId)}). Made with [Muse Muse](${MUSE_MUSE_SITE}). Not an official Meta product.`;
  const which = [
    "## Which file for my computer",
    "",
    "| Build | File | Size | Memory to run, 8K context | Picked for |",
    "|---|---|---|---|---|",
    ...f.builds.map((b) => `| ${b.level} | \`${b.name}\` | ${gigabytes(b.bytes)} | about ${runMemoryGb(b.bytes)} GB | ${pickedFor(b.level)} |`),
    "",
    `Memory to run is the file plus about ${GGUF_RUN_EXTRA_GB} GB: a small KV cache at 8K context and the buffers. A Mac lends its GPU about two thirds of its memory up to 36 GB, and three quarters above. The [run-it-on-your-computer page](${MUSE_MUSE_SITE}/fine-tuning/${f.adapterJobId}/run) picks a build for your device, in your browser.`,
  ].join("\n");
  const system = ggufSystemLine(f.role);
  const prompt = [
    "## Prompt it the way it was trained",
    "",
    "Paste this system message exactly, the role line, a blank line, then the reasoning line:",
    "",
    fenced(clean(system), "text"),
    "",
    `Meta's template reads its "${GGUF_REASONING_LINE}" and adds no second one, so the prompt is the one training used, character for character. Local apps reason at "high" by default, so set any reasoning setting to low too. Use temperature 0, as the eval answered greedily, and up to 1,024 new tokens. Stop at ${ggufStops(f.trainChannel).map((s) => `\`${s}\``).join(", ")}.`,
  ].join("\n");
  const close = [
    "## How close the files are",
    "",
    `Measured on this model's ${f.dataset.evalCount} held-out prompts and their reference answers, which it never trained on, against the merged model's own Q8_0 file with \`llama-perplexity\`. A build is published only when its mean KL divergence is within its limit.`,
    "",
    "| Build | Mean KL divergence from Q8_0 | Its limit | 99th percentile | Top token the same |",
    "|---|---|---|---|---|",
    ...f.builds.map(
      (b) =>
        `| ${b.level} | ${kl(b.klMean)} | ${klLimitText(b.level, f.params)} | ${kl(b.klP99)} | ${b.topTokenPct === null ? "not measured" : `${b.topTokenPct.toFixed(1)}%`} |`,
    ),
    ...(f.leftOut.length
      ? ["", ...f.leftOut.filter((l) => l.level !== LOW_BIT_LEVEL).map((l) => `${l.level} isn't published: its mean KL divergence was ${kl(l.klMean)}, over its limit of ${klLimitText(l.level, f.params)}.`)]
      : []),
    "",
    `The answer check: Q4_K_M, under the prompt a stock app sends (${f.trainChannel === 0 ? "`tuned.jinja`" : "the template in the file, with the Glimmer parser on"} and reasoning strength low), gave a final answer to ${f.channel.final} of ${f.channel.total} held-out prompts, greedy, up to 1,024 new tokens each. The files are published only when at least ${Math.round(QUANT_CHANNEL_MIN * 100)}% do.`,
    ...(f.agreement && f.agreement.total > 0
      ? [
          "",
          `${f.agreement.same} of those ${f.agreement.total} answers start with the same 200 characters as the adapter's own eval answers, which ran on the 4-bit base model. The two differ a little, so this is shown, not checked.`,
        ]
      : []),
    "",
    "The template check: the prompt `llama-server` rendered from the Q4_K_M file, for this system message and a held-out prompt, matched the text training used character for character.",
  ].join("\n");
  const made = [
    "## How it was made",
    "",
    `- The adapter: ${adapter}${f.adapterCommit ? ` at commit \`${f.adapterCommit}\`` : ""}, trained on [${f.adapterBase.model}](${HUB_SITE}/${f.adapterBase.model}) at revision \`${f.adapterBase.revision}\`.`,
    // The shards' SHA-256 is claimed only with the revision the job checked them at (merge_base_revision).
    `- The merge: Unsloth's \`save_pretrained_merged\` with \`merged_16bit\`, which merges the adapter into the 16-bit base tensor by tensor in fp32. The base: [${f.mergeBase.repo}](${HUB_SITE}/${f.mergeBase.repo})${f.mergeBase.revision ? (derived ? ` at revision \`${f.mergeBase.revision}\`, whose 13 safetensors shards have the SHA-256 the recipe pins for it` : ` at revision \`${f.mergeBase.revision}\`, whose two safetensors shards have the same SHA-256 as [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN})'s`) : ""}.${f.tensors !== null ? ` The merged model has the base's ${f.tensors.toLocaleString("en-US")} tensor names and shapes.` : ""}`,
    `- The template: Meta's \`chat_template.jinja\` and tokenizer files from ${GLIMMER_ORIGIN} at revision \`${META_REVISION}\`, so every file carries Meta's current template.`,
    `- llama.cpp \`${f.llamacpp.tag}\`${f.llamacpp.commit ? ` (commit \`${f.llamacpp.commit}\`)` : ""}, its release's own builds, each checked against its SHA-256. ${
      f.lowBit
        ? `The K-quant sizes use no importance matrix. ${LOW_BIT_LEVEL} needs one, so it was made on Q8_0 from this adapter's training conversations, never the held-out ones${f.lowBit.calibrationChars ? ` (${f.lowBit.calibrationChars.toLocaleString("en-US")} characters)` : ""}.`
        : "No importance matrix: the sizes are llama.cpp's standard K-quants."
    }`,
    `- On ${f.job.gpuLabel} on Lambda: ${f.job.gpuMinutes} minutes from launch to shutdown, ${money(f.job.costUsd)}.`,
    "",
    fenced(
      [
        "python convert_hf_to_gguf.py merged --outtype bf16 --outfile bf16.gguf",
        "llama-quantize bf16.gguf Q8_0.gguf Q8_0",
        ...[...f.builds.map((b) => b.level), ...f.leftOut.map((l) => l.level)]
          .sort((a, b) => BUILD_LEVELS.indexOf(a) - BUILD_LEVELS.indexOf(b))
          .flatMap((level) =>
            level === LOW_BIT_LEVEL
              ? ["llama-imatrix -m Q8_0.gguf -f calibration.txt -o imatrix.gguf --parse-special --no-ppl --output-format gguf", `llama-quantize --imatrix imatrix.gguf bf16.gguf ${level}.gguf ${level}`]
              : [`llama-quantize bf16.gguf ${level}.gguf ${level}`],
          ),
      ].join("\n"),
      "sh",
    ),
  ].join("\n");
  const files = [
    "## Files and checksums",
    "",
    "| File | Size | SHA-256 |",
    "|---|---|---|",
    ...f.builds.map((b) => `| \`${b.name}\` | ${gigabytes(b.bytes)} | \`${b.sha256}\` |`),
    ...f.small.map((s) => `| \`${s.name}\` | ${s.bytes.toLocaleString("en-US")} bytes | \`${s.sha256}\` |`),
    "",
    "Check a download with `shasum -a 256 <file>` on a Mac or Linux, or `Get-FileHash <file>` on Windows. A flash drive of these files carries the same sums.",
  ].join("\n");
  const limits = [
    "## Limits",
    "",
    `- These files are the adapter merged into the base, so they do what it learned, no more: see ${adapter} for its eval and its limits.`,
    "- Quantizing changes the answers a little. How close each build stays is measured above, on this model's own held-out prompts.",
    `- Text only. The vision projector isn't included; Meta's projector in [${GLIMMER_ORIGIN}-GGUF](${HUB_SITE}/${GLIMMER_ORIGIN}-GGUF) should load beside these files with llama.cpp's \`--mmproj\`, but it hasn't been tried with this model.`,
    derived
      ? `- It inherits the limits of ${R30B_LINK} and of [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}), and their Usage Policies: it can make up answers and go along with false premises. Check what it writes before you rely on it.`
      : `- It inherits the base model's limits and its Usage Policy: see [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}). Check what it writes before you rely on it.`,
  ].join("\n");
  const license = [
    "## License",
    "",
    derived
      ? derivativeLicense("these files", "the LoRA adapter above merged in, then the whole model quantized to GGUF.")
      : `Apache 2.0, the license of the base model: the full text is in \`LICENSE\`, as [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}) ships it. The changes from the base model: the LoRA adapter above merged in, then the whole model quantized to GGUF. Use it under the base model's [Usage Policy](${HUB_SITE}/${GLIMMER_ORIGIN}/blob/main/USAGE_POLICY.md), which says Muse Glimmer "is not intended for individuals under the age of 18".`,
    "",
    `Not an official Meta product. Meta made ${GLIMMER_NAME}; it didn't make, review or endorse these files.`,
  ].join("\n");
  const provenance = [
    "## Provenance",
    "",
    `- Made by [Muse Muse](${MUSE_MUSE_SITE}), job \`${f.quantJobId}\`${f.job.finishedAt ? `, finished ${f.job.finishedAt.slice(0, 10)}` : ""}, from the adapter of job \`${f.adapterJobId}\`.`,
    `- The adapter's run and its eval: ${labPageUrl(f.adapterJobId)}`,
    ...(f.datasetRepo ? [`- The training data: [${f.datasetRepo}](${hubLink(f.datasetRepo, "dataset")})`] : []),
    "- `muse_muse_quant.json` has the job's records: the builds, their checksums and checks, and the pins.",
  ].join("\n");
  return [
    front.join("\n"),
    "",
    `# ${name}`,
    "",
    lead,
    "",
    ...(derived ? [builtWithBlock("This model"), ""] : []),
    which,
    "",
    ggufRunSection(f),
    "",
    prompt,
    "",
    close,
    ...lowBitSection(f),
    "",
    made,
    "",
    files,
    "",
    limits,
    "",
    license,
    "",
    provenance,
    "",
  ].join("\n");
}

/** muse_muse_quant.json: the quantize job's records as its card states them. Never a path, an address or anything of the instance. */
export function quantRecord(f: GgufFacts): Record<string, unknown> {
  return {
    madeBy: { name: "Muse Muse", url: MUSE_MUSE_SITE },
    job: {
      id: f.quantJobId,
      recipe: QUANT_RECIPE,
      finishedAt: f.job.finishedAt,
      gpu: f.job.gpuLabel,
      gpuMinutes: f.job.gpuMinutes,
      gpuCostUsd: f.job.costUsd,
    },
    adapter: { jobId: f.adapterJobId, repo: f.adapterRepo, commit: f.adapterCommit, page: labPageUrl(f.adapterJobId), base: f.adapterBase },
    merge: { method: "unsloth save_pretrained_merged merged_16bit", base: f.mergeBase, tensors: f.tensors },
    template: quantBaseOf(f.params)
      ? { from: f.mergeBase.repo, revision: f.mergeBase.revision, sha256: null, tuned: null }
      : { from: GLIMMER_ORIGIN, revision: META_REVISION, sha256: META_TEMPLATE_SHA256, tuned: f.trainChannel === 0 ? TUNED_TEMPLATE_SHA256 : null },
    llamacpp: f.llamacpp,
    system: ggufSystemLine(f.role, f.params),
    trainChannel: f.trainChannel,
    ...(f.lowBit ? { lowBit: f.lowBit } : {}),
    builds: f.builds.map((b) => ({ level: b.level, file: b.name, bytes: b.bytes, sha256: b.sha256, klMean: b.klMean, klP99: b.klP99, topTokenPct: b.topTokenPct, klMax: quantKlLimit(b.level, f.params) })),
    leftOut: f.leftOut.map((l) => ({ level: l.level, klMean: l.klMean, klMax: quantKlLimit(l.level, f.params) })),
    checks: { template: "passed", channel: f.channel, channelMin: QUANT_CHANNEL_MIN, agreement: f.agreement },
    files: f.small,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The decision card (docs/DECISION_MODELS.md, "Publishing, local files and the other adapter paths")
//
// A decision model's own model card: what it decides, its scores on the held-out test rows, the format, T and how to
// call it, every number from the records. Nothing publishes it yet: hubJobProblem still refuses decide jobs, since
// adapter-only publishing (the adapter, decide.json and this card, never the person's rows) isn't built. That path
// would commit decisionCard(facts) as README.md and decisionCardJson(facts) as DECIDE_JSON_PATH beside the adapter.

/** The file the card's usage reads, beside the adapter: decide.json with the tuned model's T (decisionCardJson). */
export const DECIDE_JSON_PATH = "decide.json";

/** Labels with fewer test rows than this get a line in the card: one row moves their scores by 10 points or more. */
export const DECISION_CARD_SMALL_LABEL_ROWS = 10;

/** decide mode's trainer settings, read from GLIMMER_PY as glimmerTemplate reads chat mode's. */
export interface DecideTrainer {
  batchSize: number;
  gradientAccumulation: number;
  stepsMax: number;
  groupByLength: boolean;
}

/** decide mode's batch, gradient accumulation and step cap, from GLIMMER_PY's DECIDE_* constants. Throws without them. */
export function decideTrainer(source: string): DecideTrainer {
  return {
    batchSize: pyNumber(source, /^DECIDE_TRAIN_BATCH = (\d+)$/m, "DECIDE_TRAIN_BATCH"),
    gradientAccumulation: pyNumber(source, /^DECIDE_GRAD_ACCUM = (\d+)$/m, "DECIDE_GRAD_ACCUM"),
    stepsMax: pyNumber(source, /^DECIDE_STEPS_MAX = (\d+)$/m, "DECIDE_STEPS_MAX"),
    groupByLength: /\bgroup_by_length=True\b/.test(source),
  };
}

/** Everything a decision card says, from the records. Never a row of the dataset. */
export interface DecisionCardFacts {
  /** "<namespace>/<name>": modelRepoName of the dataset's title and the job, as for a chat adapter. */
  modelRepo: string;
  job: {
    id: string;
    title: string;
    gpuLabel: string;
    gpuMinutes: number;
    costUsd: number;
    finishedAt: string | null;
    epochs: number | null;
    learningRate: number | null;
    loraRank: number | null;
  };
  /** The job's done metrics. */
  metrics: Record<string, string | number>;
  /** The job's eval_summary as scoreDecisionStep saved it. */
  summary: DecisionSummary;
  /** The dataset's decision: its question, labels and counts. Its seed and rows aren't needed. */
  decision: Pick<DecisionSpec, "question" | "labels" | "split" | "perLabel" | "source">;
  dataset: { id: string; title: string };
  template: GlimmerTemplate;
  trainer: DecideTrainer;
  /** The base model's commit the adapter was trained on: adapter_config.json's revision, else the recipe's. */
  revision: string;
  /**
   * True when the job is a Derivative of Muse Spark Open (isSparkOpenDerivative). A template whose model is one of
   * r30b's builds counts too (cardSparkOpen), so a card can't leave out the duties by missing the flag.
   */
  sparkOpen?: boolean;
}

/**
 * Why a decide job can have no decision card, in a sentence, or null when it can: its summary must be a decision
 * summary with scored test rows and the tuned model's scores, on the dataset's own labels.
 */
export function decisionCardProblem(f: Pick<DecisionCardFacts, "summary" | "decision">): string | null {
  const s = f.summary;
  if (!isDecisionSummary(s)) return "Its eval summary isn't a decision model's scores.";
  if (!(s.items > 0)) return "No held-out row was scored, so the card would have no results.";
  if (!s.tuned) return "Only base Glimmer was scored (score only, or the tuned pass failed), so there is no adapter's result to state.";
  const labels = f.decision.labels ?? [];
  if (labels.length < 2) return "The dataset's decision has fewer than 2 labels.";
  const same = s.labels.length === labels.length && s.labels.every((l, i) => l.id === labels[i]!.id);
  if (!same) return "The scores' labels aren't the dataset's labels, so the card can't name them.";
  return null;
}

function checkedCard(f: Pick<DecisionCardFacts, "summary" | "decision">): DecisionSummary & { tuned: DecisionSideSummary } {
  const problem = decisionCardProblem(f);
  if (problem) throw new Error(`No decision card: ${problem}`);
  return f.summary as DecisionSummary & { tuned: DecisionSideSummary };
}

/** decide.json to publish beside the adapter: the decision's question and labels with the tuned model's T. */
export function decisionCardJson(f: Pick<DecisionCardFacts, "summary" | "decision">): DecideJson {
  const s = checkedCard(f);
  return decideJson({ question: f.decision.question, labels: f.decision.labels, T: s.tuned.T });
}

const wholePct = (rate: number) => `${Math.round(Math.max(0, Math.min(1, Number.isFinite(rate) ? rate : 0)) * 100)}%`;
const countText = (n: number) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US");
const rightOf = (r: WilsonRate) => `${countText(r.right)} of ${countText(r.total)} (${wholePct(r.rate)})`;
const intervalOf = (r: WilsonRate) => `${wholePct(r.low)} to ${wholePct(r.high)}`;
const places2 = (x: number) => (Number.isFinite(x) ? x : 0).toFixed(2);
const eceOf = (x: number) => `${((Number.isFinite(x) ? x : 0) * 100).toFixed(1)}%`;

/** A person's text (the question, a label's name or description) on one line, Markdown and HTML shown as written. */
const personText = (text: string | null | undefined) => mdText(String(text ?? ""));

function decisionLabelName(s: DecisionSummary, id: string): string {
  return s.labels.find((l) => l.id === id)?.name ?? id;
}

/** "Billing, Shipping and Account": a group of labels by name, the person's text escaped. */
function labelList(names: string[]): string {
  return andList(names.map(personText));
}

function decisionWhatSection(f: DecisionCardFacts): string {
  const d = f.decision;
  const rows = d.labels.map((l) => {
    const n = d.perLabel?.[l.id] ?? { train: 0, dev: 0, test: 0 };
    return `| ${personText(l.name)} | \`${l.id}\` | ${personText(l.description) || "(none given)"} | ${countText(n.train)} | ${countText(n.dev)} | ${countText(n.test)} |`;
  });
  return [
    "## What it decides",
    "",
    `> ${personText(d.question)}`,
    "",
    `It picks one of these ${d.labels.length} labels, as the person who made it defined them:`,
    "",
    "| Label | Id | Description | Train rows | Dev rows | Test rows |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `Every prompt also shows "${NONE_OPTION}" as its last option, and the model learned to pick it when no label fits: on about ${Math.round(NONE_SHARE * 100)}% of its training renderings the right label was taken out. Read its answer as a label, never as a letter: the letters change from prompt to prompt.`,
  ].join("\n");
}

function decisionResultsSection(f: DecisionCardFacts): string {
  const s = checkedCard(f);
  const t = s.tuned;
  const b = s.base;
  const row = (name: string, read: (x: DecisionSideSummary) => string) => `| ${name} | ${read(b)} | ${read(t)} |`;
  const commonest = s.baselines.commonest;
  const derived = cardSparkOpen(f);
  const out = [
    "## Results",
    "",
    `Scored, not judged: no model graded anything. Both models read the same ${countText(s.items)} held-out test rows, set aside before training and never trained on, and each pick is the label with the highest probability on the model's first answer token.`,
    "",
    `| | ${derived ? "The 2026 Glimmer it started from (r30b)" : `Base ${GLIMMER_NAME}`} | Tuned (this adapter) |`,
    "|---|---|---|",
    row("Right on", (x) => rightOf(x.accuracy)),
    row("95% interval (Wilson)", (x) => intervalOf(x.accuracy)),
    row("Macro F1", (x) => places2(x.macroF1)),
    row("Calibration error (ECE), before T", (x) => eceOf(x.ece.raw)),
    row("Calibration error (ECE), with T", (x) => eceOf(x.ece.withT)),
    row("T, fit on dev rows only", (x) => (x.calibrated ? String(x.T) : "1 (not calibrated: under 20 dev rows scored)")),
    row(`Answered "${NONE_OPTION}"`, (x) => wholePct(x.noneRate)),
    row("Declined when the right label was taken out", (x) =>
      x.decline ? `${countText(x.decline.declined)} of ${countText(x.decline.rows)} (${wholePct(x.decline.rate)})` : "not scored",
    ),
    row("Letter mass, median and lowest", (x) => `${places2(x.letterMass.median)} and ${places2(x.letterMass.min)}`),
    "",
    `For scale, on the same rows: always answering the commonest training label (${personText(decisionLabelName(s, commonest.id))}) was right on ${rightOf(commonest.accuracy)}, and a word-overlap rule (not a model) on ${rightOf(s.baselines.standIn.accuracy)}. Letter mass is the share of the first token's probability that lands on the shown letters. ${derived ? "The 2026 Glimmer it started from" : `Base ${GLIMMER_NAME}`} was asked the same prompts with no training; it sometimes starts with a word instead of a letter, which shows as lower letter mass, so this read understates what a prompted base model could do.`,
  ];
  out.push(
    "",
    "### Per label (tuned)",
    "",
    `| Label | Test rows | Precision | Recall | F1 | ${derived ? "r30b F1" : "Base F1"} |`,
    "|---|---|---|---|---|---|",
    ...t.perLabel.map((l) => {
      const base = b.perLabel.find((x) => x.id === l.id);
      return `| ${personText(l.name)} | ${countText(l.support)} | ${places2(l.precision)} | ${places2(l.recall)} | ${places2(l.f1)} | ${base ? places2(base.f1) : "n/a"} |`;
    }),
    "",
    "### Confusion (tuned)",
    "",
    "Rows are the right label, columns what the tuned model picked.",
    "",
    `| Right label | ${s.labels.map((l) => personText(l.name)).join(" | ")} | None |`,
    `|---|${s.labels.map(() => "---|").join("")}---|`,
    ...s.labels.map((l, i) => `| ${personText(l.name)} | ${(t.confusion[i] ?? []).map((n) => countText(n)).join(" | ")} |`),
  );
  const notes: string[] = [];
  if (s.unscoredRows > 0) {
    notes.push(
      `${countText(s.unscoredRows)} of the ${countText(s.testRows)} test rows had no usable score (too long, or not sent), so every number leaves them out.`,
    );
  }
  if (s.tooLong > 0) {
    notes.push(`${countText(s.tooLong)} ${s.tooLong === 1 ? "rendering was" : "renderings were"} over ${countText(f.template.maxSeqLength)} tokens, so the GPU couldn't score ${s.tooLong === 1 ? "it" : "them"}.`);
  }
  const small = t.perLabel.filter((l) => l.support < DECISION_CARD_SMALL_LABEL_ROWS);
  if (small.length) {
    notes.push(
      `${labelList(small.map((l) => l.name))} ${small.length === 1 ? "has" : "have"} under ${DECISION_CARD_SMALL_LABEL_ROWS} test rows, so one row moves ${small.length === 1 ? "its" : "their"} scores by 10 points or more.`,
    );
  }
  if (s.groups > 1) {
    notes.push(
      `With more than ${LABELS_PER_PROMPT} labels, each input is asked as ${s.groups} prompts and their answers are combined by a fixed rule (How it decides), so how well confidence is calibrated is only what the test rows show.`,
    );
  }
  notes.push(
    t.calibrated
      ? `The tuned model's T = ${t.T} was fit on ${countText(s.devRows)} dev rows to bring its confidence closer to how often it was right on them. On the held-out test rows its calibration error is ${eceOf(t.ece.withT)} with T (${eceOf(t.ece.raw)} before)${t.ece.withT > t.ece.raw ? ", so T didn't help on these rows" : ""}.`
      : "Fewer than 20 dev rows were scored, so the tuned model's probabilities are its own, not calibrated.",
  );
  notes.push(`Every number is from the run's records, and the same numbers are on [the run's public page](${labPageUrl(f.job.id)}). It can be wrong: check anything that matters.`);
  out.push("", ...notes.map((n) => `- ${n}`));
  return out.join("\n");
}

function decisionFormatSection(f: DecisionCardFacts): string {
  const json = decisionCardJson(f);
  const s = checkedCard(f);
  const groups = labelGroups(f.decision.labels);
  const shape =
    groups.length > 1
      ? `This model's ${f.decision.labels.length} labels are asked as ${groups.length} prompts: ${groups.map((g) => labelList(g.map((l) => l.name))).join("; ")}.`
      : `One prompt shows all ${f.decision.labels.length} of this model's labels.`;
  return [
    "## How it decides",
    "",
    `Each input becomes a task, the JSON \`{"state": ..., "question": ..., "options": [...]}\`, whose options are the labels lettered from A in the order above, with "${NONE_OPTION}" last. A prompt shows at most ${LABELS_PER_PROMPT} labels. ${shape} The user message is the task, then "${json.separator.trim()}", then the task again, under this system message:`,
    "",
    fenced(json.system, "text"),
    "",
    `The prompt goes through the base model's chat template ([${GLIMMER_TEMPLATE.repo}](${HUB_SITE}/${GLIMMER_TEMPLATE.repo}) at revision \`${GLIMMER_TEMPLATE.revision}\`) at reasoning strength "${GLIMMER_REASONING}", with the final channel opened, so the first token the model writes is the letter. The probabilities are read from that one token, not from anything the model writes. \`${DECIDE_JSON_PATH}\` in this repo holds the exact text around the task (\`prompt.prefix\` and \`prompt.suffix\`), the labels, T, and these rules:`,
    "",
    ...json.rules.map((r) => `- ${r}`),
    "",
    s.tuned.calibrated
      ? `The tuned model's T is ${s.tuned.T}, fit on the dev rows.`
      : "The tuned model's T is 1: too few dev rows were scored to fit one.",
  ].join("\n");
}

function decisionUsageSection(f: DecisionCardFacts): string {
  const t = f.template;
  const code = [
    "import json",
    "import math",
    "",
    "import torch",
    "from huggingface_hub import hf_hub_download",
    "from peft import PeftModel",
    "from transformers import AutoModelForMultimodalLM, AutoProcessor",
    "",
    `BASE = ${JSON.stringify(t.model)}`,
    `REVISION = ${JSON.stringify(f.revision)}`,
    `ADAPTER = ${JSON.stringify(f.modelRepo)}`,
    "",
    `with open(hf_hub_download(ADAPTER, ${JSON.stringify(DECIDE_JSON_PATH)}), encoding="utf-8") as f:`,
    "    SPEC = json.load(f)",
    "",
    "processor = AutoProcessor.from_pretrained(BASE, revision=REVISION)",
    'tokenizer = getattr(processor, "tokenizer", processor)',
    'model = AutoModelForMultimodalLM.from_pretrained(BASE, revision=REVISION, device_map="auto")',
    "model = PeftModel.from_pretrained(model, ADAPTER)",
    "model.eval()",
    "",
    "",
    "def neutral(text):",
    "    # No text may forge one of the chat template's tokens.",
    '    return text.replace("<|", "< |")',
    "",
    "",
    "def letter_probabilities(prompt, letters):",
    "    # One forward pass, no generation. The tokenizer adds <|begin_of_text|> itself.",
    '    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)',
    "    with torch.no_grad():",
    "        logits = model(**inputs).logits[0, -1].float()",
    "    logp = torch.log_softmax(logits, dim=-1).tolist()",
    "    shown = []",
    "    for letter in letters:",
    "        # A letter's probability is its bare token's plus its space-led token's.",
    '        ids = {tokenizer.encode(text, add_special_tokens=False)[0] for text in (letter, " " + letter)}',
    "        shown.append(sum(math.exp(logp[i]) for i in ids))",
    "    total = sum(shown)",
    "    return [p / total for p in shown]",
    "",
    "",
    "def decide(state):",
    '    labels = {label["id"]: label for label in SPEC["labels"]}',
    "    found, none = {}, 1.0",
    '    for group in SPEC["groups"]:',
    "        options = []",
    "        for k, label_id in enumerate(group):",
    "            label = labels[label_id]",
    '            option = {"letter": SPEC["letters"][k], "option": neutral(label["name"])}',
    '            if label["description"]:',
    '                option["description"] = neutral(label["description"])',
    "            options.append(option)",
    '        options.append({"letter": SPEC["letters"][len(group)], "option": SPEC["none"]})',
    "        task = json.dumps(",
    '            {"state": neutral(state), "question": neutral(SPEC["question"]), "options": options},',
    "            ensure_ascii=False,",
    '            separators=(",", ":"),',
    "        )",
    '        prompt = SPEC["prompt"]["prefix"] + task + SPEC["separator"] + task + SPEC["prompt"]["suffix"]',
    '        p = letter_probabilities(prompt, [o["letter"] for o in options])',
    "        found.update(zip(group, p))",
    "        none *= p[-1]",
    "    # A label keeps its probability in its own prompt, none is the product of every prompt's none,",
    "    # and the labels are rescaled to share 1 - none.",
    "    total = sum(found.values())",
    "    p = {i: x * (1 - none) / total if total > 0 else 0.0 for i, x in found.items()}",
    "    if total <= 0:",
    "        none = 1.0",
    '    order = [label["id"] for label in SPEC["labels"]]',
    "    best = order[0]",
    "    for i in order:",
    "        if p[i] > p[best]:",
    "            best = i",
    "    pick = None if none > p[best] else best",
    "    # T softens the numbers shown. It never changes the pick.",
    '    soft = {i: p[i] ** (1 / SPEC["T"]) for i in order}',
    '    soft_none = none ** (1 / SPEC["T"])',
    "    z = sum(soft.values()) + soft_none",
    "    return {",
    '        "decision": None if pick is None else labels[pick]["name"],',
    '        "confidence": (soft_none if pick is None else soft[pick]) / z,',
    '        "probabilities": {labels[i]["name"]: soft[i] / z for i in order},',
    '        "none": soft_none / z,',
    "    }",
    "",
    "",
    'print(decide("The input to decide on"))',
  ];
  return [
    "## How to use it",
    "",
    `Load the 4-bit base at the revision it was trained on, put the adapter on it, and score each prompt with one forward pass: no text is generated. This reads the model the way Muse Muse scored it: the first token's log-probabilities over the whole vocabulary, in float32. \`${DECIDE_JSON_PATH}\` gives the question, the labels, T and the prompt's exact text, so nothing else is needed. It needs a CUDA GPU with room for the 4-bit base model, and \`bitsandbytes\`. It is not a chat model: in a chat app, Ollama or LM Studio it will misbehave.`,
    "",
    fenced(code.join("\n"), "python"),
  ].join("\n");
}

function decisionTrainingSection(f: DecisionCardFacts): string {
  const m = f.metrics;
  const t = f.template;
  const tr = f.trainer;
  const j = f.job;
  const rows: Array<[string, string]> = [
    [
      "Base model",
      cardSparkOpen(f)
        ? `[${t.model}](${HUB_SITE}/${t.model}) at revision \`${f.revision}\`, the 4-bit (bitsandbytes) quantization of ${R30B_LINK}: Muse Muse's fine-tune of [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}) with 2026 knowledge`
        : `[${t.model}](${HUB_SITE}/${t.model}) at revision \`${f.revision}\`, the 4-bit (bitsandbytes) quantization of [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN})`,
    ],
    ["Method", "QLoRA with Unsloth and TRL's SFTTrainer in Muse Muse's decide mode: LoRA on the language model's attention and MLP layers, the vision layers frozen, trained only on the answer's letter and the end of the turn (train_on_responses_only)"],
  ];
  if (j.loraRank !== null) rows.push(["LoRA rank", `${j.loraRank} (alpha ${j.loraRank}, dropout ${t.loraDropout})`]);
  if (j.learningRate !== null) rows.push(["Learning rate", `${j.learningRate}, ${t.scheduler} schedule, ${t.warmupSteps} warmup steps, ${t.optimizer}, weight decay ${t.weightDecay}`]);
  rows.push(["Training rows", countText(f.decision.split.train)]);
  if (j.epochs !== null) rows.push(["Epochs", String(j.epochs)]);
  const renderings = metric("renderings", m);
  if (renderings !== null) {
    // Balancing copies exist only when the GPU was paged more renderings than rows times epochs (trainLayout).
    const paged = Number(metric("train_renderings", m) ?? renderings);
    const copies = j.epochs !== null && paged > f.decision.split.train * j.epochs;
    const times = j.epochs === null ? "" : `each row ${j.epochs} ${j.epochs === 1 ? "time" : "times"}${copies ? ", plus copies of the smaller labels' rows toward at most 3 to 1" : ""}, `;
    rows.push([
      "Training renderings",
      `${renderings}: ${times}each rendering with its own option order, about ${Math.round(NONE_SHARE * 100)}% of them with the right label taken out`,
    ]);
  }
  const tooLong = metric("train_too_long", m);
  if (tooLong !== null && Number(tooLong) > 0) rows.push(["Renderings left out as too long", `${tooLong} (over ${t.maxSeqLength} tokens)`]);
  const steps = metric("steps", m);
  const maxSteps = metric("max_steps", m);
  if (steps !== null || maxSteps !== null) {
    const done = steps ?? maxSteps;
    const early = metric("stopped_early", m) === "yes" ? " (stopped early to finish within the time limit)" : "";
    rows.push([
      "Steps",
      `${done}${maxSteps !== null && steps !== null && steps !== maxSteps ? ` of ${maxSteps}` : ""}${early}, batch ${tr.batchSize} with gradient accumulation ${tr.gradientAccumulation} (${tr.batchSize * tr.gradientAccumulation} renderings a step${tr.groupByLength && metric("group_by_length", m) !== "no" ? ", grouped by length" : ""})`,
    ]);
  }
  rows.push(["Max sequence length", String(t.maxSeqLength)]);
  const gpu = metric("gpu", m);
  rows.push(["GPU", `${gpu ? `${gpu}, ` : ""}${j.gpuLabel} on Lambda`]);
  rows.push(["GPU time", `${j.gpuMinutes} minutes, from launch to shutdown, scoring included`]);
  rows.push(["GPU cost", money(j.costUsd)]);
  const loss = metric("train_loss_final", m);
  if (loss !== null) rows.push(["Final training loss", String(loss)]);
  const vram = metric("peak_vram_gb", m);
  if (vram !== null) rows.push(["Peak GPU memory", `${vram} GB`]);
  rows.push(["Seed", String(t.seed)]);
  return [
    "## How it was trained",
    "",
    "| Setting | Value |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
    "",
    `The same GPU run scored ${cardSparkOpen(f) ? "the 2026 Glimmer it started from" : "base Glimmer"} on the dev and test rows first, then trained, then scored the tuned model on the same prompts. The scores went to Muse Muse, which computed every number above after the GPU was shut down, with no model call.`,
  ].join("\n");
}

function decisionDataSection(f: DecisionCardFacts): string {
  const d = f.decision;
  const who = d.source === "person" ? "a person labeled" : `from public decision tasks (the mix \`${personText(d.source.replace(/^public:/, ""))}\`)`;
  return [
    "## Data",
    "",
    `Trained on ${countText(d.split.train)} rows ${who} for "${personText(f.dataset.title)}". ${countText(d.split.dev)} more rows fit T and ${countText(d.split.test)} were held out for the scores above; neither was trained on. Rows that shared at least ${Math.round(NEAR_DUPLICATE_JACCARD * 100)}% of their words were kept in one split, so no test row has a near-twin in training. The rows aren't published here or anywhere: this repo has the adapter, its tokenizer files, \`${DECIDE_JSON_PATH}\` and this card.`,
  ].join("\n");
}

function decisionLimitsSection(f: DecisionCardFacts): string {
  const s = checkedCard(f);
  return [
    "## Limits",
    "",
    `- It is a small adapter that learned one decision from ${countText(f.decision.split.train)} examples. It isn't a general improvement of ${cardSparkOpen(f) ? R30B_REPO : GLIMMER_NAME}, and it answers only with a letter: as a chat model it will misbehave.`,
    `- The test set is small: ${countText(s.items)} rows. The intervals in Results show how far the accuracy could be off, and a row unlike the examples may be decided worse than they show.`,
    "- Its probabilities are calibrated only on rows like its dev rows. On inputs unlike its examples it is likely to be surer than it should be.",
    "- Local GGUF files for decision models aren't made yet: they need a check that the quantized model makes the adapter's picks.",
    `- It inherits the base model's limits and its Usage Policy: see ${cardSparkOpen(f) ? `${R30B_LINK} and License` : `[${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN})`}. Check what it decides before you rely on it, and don't let it decide alone about people, such as hiring, credit, housing or health.`,
  ].join("\n");
}

function decisionLicenseSection(f: DecisionCardFacts): string {
  const data =
    f.decision.source === "person"
      ? "The training rows belong to the person who labeled them and aren't published."
      : "The training rows come from public datasets under their own licenses and aren't republished here.";
  return [
    "## License",
    "",
    cardSparkOpen(f)
      ? derivativeLicense("this decision model", "this LoRA adapter, trained in decide mode as described above.")
      : `Apache 2.0, the license of the base model: the full text is in \`LICENSE\`, as [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}) ships it. The change from the base model is this LoRA adapter, trained as described above. Use it under the base model's [Usage Policy](${HUB_SITE}/${GLIMMER_ORIGIN}/blob/main/USAGE_POLICY.md), which says Muse Glimmer "is not intended for individuals under the age of 18".`,
    "",
    data,
    "",
    `Not an official Meta product. Meta made ${GLIMMER_NAME}; it didn't make, review or endorse this adapter. The model's name only says what the adapter is for.`,
  ].join("\n");
}

function decisionProvenanceSection(f: DecisionCardFacts): string {
  return [
    "## Provenance",
    "",
    `- Made by [Muse Muse](${MUSE_MUSE_SITE}), job \`${f.job.id}\` ("${personText(f.job.title)}")${f.job.finishedAt ? `, finished ${f.job.finishedAt.slice(0, 10)}` : ""}.`,
    `- The run's public page, with the same numbers: ${labPageUrl(f.job.id)}`,
    `- \`${DECIDE_JSON_PATH}\` has the format, the labels, T and the prompt's text. The dataset's rows are not in this repo.`,
  ].join("\n");
}

/**
 * A decision model's README.md: YAML front matter in the chat card's shape, minus `datasets` and `model-index` (the
 * rows are never published, so there is no dataset repo for either to cite; the numbers are in Results), then what it
 * decides, its scores, the format, how to call it, how it was trained, its data, limits, license and provenance.
 * Every number is from the records and every rule from lib/decide/format.ts. Throws when decisionCardProblem says no.
 */
export function decisionCard(f: DecisionCardFacts): string {
  const s = checkedCard(f);
  const [, name] = f.modelRepo.split("/");
  const d = f.decision;
  const english = looksEnglish(d.question, f.dataset.title, ...d.labels.flatMap((l) => [l.name, l.description ?? ""]));
  const derived = cardSparkOpen(f);
  const front = [
    "---",
    `base_model: ${f.template.model}`,
    "base_model_relation: adapter",
    "library_name: peft",
    "pipeline_tag: text-generation",
    ...licenseFront(derived),
    ...(english ? ["language:", "- en"] : []),
    "tags:",
    ...["lora", "peft", "unsloth", "trl", "muse-muse", "muse-decide", "decision-model", "classification", ...(derived ? ["built-with-muse-spark-open"] : [])].map(
      (t) => `- ${t}`,
    ),
    "---",
  ];
  const lead = `A decision model: a small LoRA adapter for ${GLIMMER_NAME}${derived ? " with 2026 knowledge" : ""} (\`${f.template.model}\`) trained on ${countText(d.split.train)} labeled examples to answer one question. For each input it picks one of its ${d.labels.length} labels, or "${NONE_OPTION}", with a probability for each, read from the model's first answer token. On ${countText(s.items)} held-out examples it never saw, it was right on ${countText(s.tuned.accuracy.right)} (${wholePct(s.tuned.accuracy.rate)}); ${derived ? "the 2026 Glimmer it started from" : `base ${GLIMMER_NAME}`} on ${countText(s.base.accuracy.right)} (${wholePct(s.base.accuracy.rate)}). It can be wrong: check anything that matters. Made with [Muse Muse](${MUSE_MUSE_SITE}). Not an official Meta product.`;
  return [
    front.join("\n"),
    "",
    `# ${name}`,
    "",
    lead,
    "",
    ...(derived ? [builtWithBlock("This decision model"), ""] : []),
    decisionWhatSection(f),
    "",
    decisionResultsSection(f),
    "",
    decisionFormatSection(f),
    "",
    decisionUsageSection(f),
    "",
    decisionTrainingSection(f),
    "",
    decisionDataSection(f),
    "",
    decisionLimitsSection(f),
    "",
    decisionLicenseSection(f),
    "",
    decisionProvenanceSection(f),
    "",
  ].join("\n");
}

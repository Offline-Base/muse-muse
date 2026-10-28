/**
 * Pure helpers for publishing a tuned Muse Glimmer adapter to the Hugging Face Hub (docs/TRAINING.md "Hugging Face
 * Hub"): the repo names, the model card and the dataset card, the story's prompt, its checks and its fallback, the
 * JSONL exports of a dataset, the run's record, and the rules of a job's hub state. No I/O, so lib/train/hub-steps.ts
 * and the routes share them and tests run them directly.
 *
 * Every number in a card comes from the platform's records (the job, its done metrics, its eval summary, its dataset)
 * or from the glimmer-lora recipe's own source, never from a model. The story is the one part a model writes: it is
 * asked for no numbers and no result at all (the card's own sentence after it gives the counts and the result, see
 * resultText), and storyProblem turns down one with a number, a count word, a claim about the result or about Meta, or
 * markup, so the template's story is used instead.
 */
import { noEmDashes, slugify } from "@/lib/brief/normalize";
import { datasetSystemPrompt, NEAR_DUPLICATE_JACCARD, unjudgedNote, type TrainJobRow } from "@/lib/train/logic";
import {
  HUB_FILE_NAMES,
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
/** The model that writes the story, and judges and writes datasets elsewhere. */
export const STORY_MODEL = "muse-spark-1.3";
/** The model that writes datasets and judges, as the cards name it. */
export const SPARK_NAME = "Muse Spark 1.3";
/** The tuned model, as the cards name it. */
export const GLIMMER_NAME = "Muse Glimmer 30B";
/** A dataset title's slug in a repo name: lowercase letters, digits and dashes, at most this long. */
export const SLUG_MAX = 40;
/**
 * Muse Spark 1.3 is asked for at most 100 words (the card's own sentence of about 45 words follows, for about 150 in
 * all): a story longer than this is turned down.
 */
export const STORY_WORDS_MAX = 115;
/** The longest a story may be in characters, whatever its words. */
const STORY_CHARS_MAX = 1000;
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
export function modelRepoName(datasetTitle: string, jobId: string): string {
  return `muse-glimmer-30b-${hubSlug(datasetTitle)}-lora-${jobId.slice(0, 8).toLowerCase()}`;
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
}

export const STORY_INSTRUCTIONS = [
  'You write the "Why this exists" section of a Hugging Face model card for a LoRA adapter, from the facts you are given and nothing else.',
  "Say what the adapter does in one short sentence (the card quotes the whole task below, so don't list its parts), why Muse Muse made it, and why it is worth teaching an open 30B model that anyone can download and run on their own GPU what Muse Spark 1.3 does.",
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

/** The facts Muse Spark 1.3 writes the story from, as its user message: no counts and no result, which the card gives. */
export function storyRequest(f: StoryFacts): string {
  const lines = [
    "Muse Muse: a platform that turns an example or some inspo into a working product on Meta's models. Its first step is the brief writer, which turns what a person gives it into a short brief that the build follows.",
    `The dataset: "${clean(f.datasetTitle)}". Its task, as the admin wrote it: ${clean(f.task)}`,
    `${SPARK_NAME}, Meta's hosted model, wrote the dataset, the prompts and the answers.`,
    `The adapter: a LoRA adapter for ${GLIMMER_NAME}, made in Muse Muse's fine-tuning lab. ${GLIMMER_NAME} is an open model with Apache 2.0 weights that anyone can download and run on their own GPU. The lab has ${SPARK_NAME} write a dataset for one task, and ${GLIMMER_NAME} learns to do the task the way ${SPARK_NAME} does. Why: then the task can run on a model you host yourself.`,
    "The card gives the dataset's counts and the eval's result itself, right after your text.",
  ];
  if (f.why?.trim()) lines.push(`The admin's reason, printed just before your text: ${clean(f.why)}`);
  return lines.join("\n\n");
}

/** Names whose digits belong to the name, which a story may use: "Muse Glimmer 30B", "30B", "Muse Spark 1.3", "Apache 2.0". */
const FIXED_NAMES = /\b(?:Muse Glimmer 30B|Muse Spark 1\.3|Spark 1\.3|Apache(?: License)? 2\.0|30B)(?!\w)/gi;

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
 * the why as the story's first sentences. Muse Spark 1.3 was told not to repeat it and still sometimes opens with it
 * word for word. Returns "" when nothing else is left.
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
 * Why the story Muse Spark 1.3 wrote can't go in the card, or null when it can: it is empty or longer than about 100
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
 * The story when Muse Spark 1.3 can't write one (no key, the spend cap, a failed call, a story that failed its checks):
 * what Muse Muse is, the task, and why, from the task's own words. The counts and the result follow it in the card.
 */
export function templateStory(f: StoryFacts): string {
  return `Muse Muse turns an example or some inspo into a working product on Meta's models. This adapter teaches ${GLIMMER_NAME}, an open model anyone can download and run on their own GPU, to do one task the way ${SPARK_NAME} does it: ${taskSentence(f.task)}. That way the task can run on a model you host yourself.`;
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
  dataset: { id: string; title: string; task: string; trainCount: number; evalCount: number; costUsd: number };
  template: GlimmerTemplate;
  /** The base model's commit the adapter was trained on: adapter_config.json's revision, else the recipe's. */
  revision: string;
  /** The system message training and eval used. */
  system: string;
  why: string | null;
  story: string;
}

/** A repo's page on the public Hub (HUB_SITE). */
const hubLink = (id: string, kind: "model" | "dataset") => `${HUB_SITE}${kind === "dataset" ? "/datasets" : ""}/${id}`;

/**
 * The card's own sentence after the story: the dataset's counts and the eval's result, from the records, so no number
 * in "Why this exists" comes from a model.
 */
export function resultText(f: Pick<CardFacts, "summary" | "dataset">): string {
  const s = f.summary;
  const d = f.dataset;
  return `${SPARK_NAME} wrote the dataset's ${d.trainCount + d.evalCount} examples: ${d.trainCount} to train on and ${d.evalCount} held out. On ${s.items} held-out prompts, judged blind by ${SPARK_NAME}, the tuned model was ${wins(s)}, with an average score of ${score(s.avgTunedScore)} out of 10 against ${score(s.avgBaseScore)} for the base model.`;
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
  const out = [
    "## Results",
    "",
    `Both models answered the dataset's ${s.items} held-out prompts, none of which were trained on. ${SPARK_NAME} (\`${STORY_MODEL}\`) judged each pair blind: it saw the answers as A and B, the base model's first on even items and second on odd ones, scored each from 1 to 10 against ${SPARK_NAME}'s own reference answer, and said which was better.`,
    "",
    `| | Base ${GLIMMER_NAME} | Tuned (this adapter) |`,
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
      `Held-out item ${e.index + 1}, where the judge saw the base model's answer as ${e.index % 2 === 0 ? "A" : "B"}. It scored the base model ${e.baseScore} and the tuned model ${e.tunedScore}: "${mdText(e.note)}"`,
      "",
      "The prompt:",
      "",
      fenced(cut(e.prompt), "text"),
      "",
      `Base ${GLIMMER_NAME}:`,
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
    ["Base model", `[${t.model}](${HUB_SITE}/${t.model}) at revision \`${f.revision}\`, the 4-bit (bitsandbytes) quantization of [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN})`],
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
  return [
    "## How to use it",
    "",
    `Load the 4-bit base at the revision it was trained on, put the adapter on it, and prompt it as training did: the system message below, the chat template at reasoning strength "${t.reasoning}", and the final channel opened, so the model answers at once with no reasoning. Greedy decoding with up to ${t.maxNewTokens} new tokens is what the eval used. It needs a CUDA GPU with room for the 4-bit base model, and \`bitsandbytes\`.`,
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
    `Trained on [${f.datasetRepo}](${hubLink(f.datasetRepo, "dataset")}): ${d.trainCount} training conversations and ${d.evalCount} held-out prompts that ${SPARK_NAME} wrote through Meta's Model API for the dataset "${mdCell(d.title)}", prompts and answers both, for ${money(d.costUsd)}. The held-out prompts were never trained on, and prompts that share most of their words with one were kept out of training too.`,
  ].join("\n");
}

function limitsSection(f: CardFacts): string {
  const s = f.summary;
  return [
    "## Limits",
    "",
    `- It learned one task from ${f.dataset.trainCount} examples one model wrote. It isn't a general improvement of ${GLIMMER_NAME}, and outside that task it may do worse than the base model in ways the eval didn't measure.`,
    `- The eval is small: ${s.items} prompts from the same writer as the training data. ${SPARK_NAME} wrote the training answers, the references and the verdicts, and a judge can favor answers like its own.`,
    f.job.studentPrompt === "full"
      ? "- Both models answered under the dataset's whole task prompt, so the base model's scores show how well it follows those instructions untrained."
      : "- The base model answered without the dataset's task prompt, under the same one-line system message as the tuned model, so its scores show what training taught, not how well the base follows instructions.",
    `- It inherits the base model's limits and its Usage Policy: see [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}). Check what it writes before you rely on it.`,
  ].join("\n");
}

function licenseSection(): string {
  return [
    "## License",
    "",
    `Apache 2.0, the license of the base model: the full text is in \`LICENSE\`, as [${GLIMMER_ORIGIN}](${HUB_SITE}/${GLIMMER_ORIGIN}) ships it. The change from the base model is this LoRA adapter, trained as described above. Use it under the base model's [Usage Policy](${HUB_SITE}/${GLIMMER_ORIGIN}/blob/main/USAGE_POLICY.md), which says Muse Glimmer "is not intended for individuals under the age of 18".`,
    "",
    `The training data is ${SPARK_NAME}'s output through Meta's Model API, published under Meta's terms for that API rather than an open license: see its \`${DATASET_LICENSE_PATH}\`.`,
    "",
    `Not an official Meta product. Meta made ${GLIMMER_NAME} and ${SPARK_NAME}; it didn't make, review or endorse this adapter. The model's name only says what the adapter is for.`,
  ].join("\n");
}

function provenanceSection(f: CardFacts): string {
  return [
    "## Provenance",
    "",
    `- Made by [Muse Muse](${MUSE_MUSE_SITE}), job \`${f.job.id}\` ("${mdCell(f.job.title)}")${f.job.finishedAt ? `, finished ${f.job.finishedAt.slice(0, 10)}` : ""}.`,
    `- The run's public page, with every eval item: ${labPageUrl(f.job.id)}`,
    `- The training data: [${f.datasetRepo}](${hubLink(f.datasetRepo, "dataset")})`,
    "- `muse_muse_run.json` has the run's records: its settings, metrics, eval summary and items.",
  ].join("\n");
}

/** The model repo's README.md: YAML front matter the Hub's validator takes, then the sections in the order above. */
export function modelCard(f: CardFacts): string {
  const s = f.summary;
  const [, name] = f.modelRepo.split("/");
  const english = looksEnglish(f.dataset.title, f.dataset.task);
  const front = [
    "---",
    `base_model: ${f.template.model}`,
    "base_model_relation: adapter",
    "library_name: peft",
    "pipeline_tag: text-generation",
    "license: apache-2.0",
    ...(english ? ["language:", "- en"] : []),
    "tags:",
    ...["lora", "peft", "unsloth", "trl", "sft", "muse-muse"].map((t) => `- ${t}`),
    "datasets:",
    `- ${f.datasetRepo}`,
    "model-index:",
    `- name: ${name}`,
    "  results:",
    "  - task:",
    "      type: text-generation",
    "      name: Blind pairwise vs base",
    "    dataset:",
    `      name: ${y(`${clean(f.dataset.title)} held-out prompts`)}`,
    `      type: ${f.datasetRepo}`,
    "      split: eval",
    "    metrics:",
    "    - name: Judge win rate vs base",
    "      type: win_rate",
    `      value: ${s.items > 0 ? Math.round((s.tunedWins / s.items) * 10_000) / 10_000 : 0}`,
    "    - name: Average judge score, tuned (1 to 10)",
    "      type: judge_score",
    `      value: ${Math.round(s.avgTunedScore * 100) / 100}`,
    "    - name: Average judge score, base (1 to 10)",
    "      type: judge_score",
    `      value: ${Math.round(s.avgBaseScore * 100) / 100}`,
    "    source:",
    "      name: Muse Muse blind eval",
    `      url: ${labPageUrl(f.job.id)}`,
    "---",
  ];
  const lead = `A LoRA adapter for ${GLIMMER_NAME} (\`${f.template.model}\`) that learned one task from ${SPARK_NAME}: ${taskSentence(f.dataset.task)}. Made with [Muse Muse](${MUSE_MUSE_SITE}). Not an official Meta product.`;
  const does = [
    "## What it does",
    "",
    `It does the task of the dataset "${mdCell(f.dataset.title)}", which the admin described as:`,
    "",
    ...clean(f.dataset.task).split("\n").map((l) => `> ${l}`),
    "",
    `It was trained to answer the way ${SPARK_NAME} answered those prompts. Prompt it the way it was trained, with this system message (How to use it has it as SYSTEM):`,
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
    licenseSection(),
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
      ? `Training data that ${SPARK_NAME} wrote for one task, made with [Muse Muse](${MUSE_MUSE_SITE}). ${models.length} ${GLIMMER_NAME} LoRA adapters trained on it are published: see Models trained on it.`
      : `Training data that ${SPARK_NAME} wrote for one task, made with [Muse Muse](${MUSE_MUSE_SITE}). ${own} is a ${GLIMMER_NAME} LoRA adapter trained on it.`,
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
    `- \`assistant\`: ${SPARK_NAME}'s answer. On an eval line it is the reference answer the judge compared both models against.`,
    "",
    "## How it was made",
    "",
    `${SPARK_NAME} wrote the prompts in batches, each batch leaning to other styles of message, with repeats folded out. It then answered each prompt under the task's instructions (each line's \`system\` message), and answers that failed, came back cut off or ran too long were left out.`,
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
    `${SPARK_NAME} wrote all of the text, prompts and answers, through Meta's Model API, for Muse Muse, so Meta's terms for that API's outputs govern it, and Muse Muse grants no rights beyond them: see \`${DATASET_LICENSE_PATH}\`. Not an official Meta product.`,
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
 * The dataset's LICENSE.md. The prompts and answers are Muse Spark's output through Meta's Model API, so they can't go
 * out under an open license: Meta's terms for that API decide what anyone may do with them.
 */
export function datasetLicense(): string {
  return [
    "# Terms for this dataset",
    "",
    `${SPARK_NAME} wrote every prompt and answer in this dataset through Meta's Model API, for Muse Muse. That text is model output, so Meta's terms for the Model API govern how you may use it. Muse Muse grants no license or other rights beyond what those terms allow.`,
    "",
    "When this dataset was published, those terms said a model's outputs may not be used to develop or improve a competing AI model or service without Meta's written permission. Read Meta's current Model API terms before you reuse this text, and don't rely on this summary.",
    "",
    `Not an official Meta product. Meta made ${SPARK_NAME}; it didn't make, review or endorse this dataset.`,
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
 * who wrote the story. Never the instance, its IP or region, a log, a path or a URL of the platform's storage.
 */
export function runRecord(f: CardFacts, items: RunItem[], storyBy: "spark" | "template"): Record<string, unknown> {
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
      repo: f.datasetRepo,
      writer: STORY_MODEL,
    },
    eval: {
      judge: STORY_MODEL,
      blind: "The judge saw both answers as A and B: the base model's first on even items and second on odd ones.",
      summary: f.summary,
      items,
    },
    story: { why: f.why, by: storyBy },
  };
}

/** The eval items with their verdicts, in index order, from a judged job's eval and judgement events. */
export function runItems(events: TrainEventView[]): RunItem[] {
  const items = new Map<number, RunItem>();
  const verdicts = new Map<number, NonNullable<RunItem["judgement"]>>();
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const ev of events) {
    const p = ev.payload;
    if (p?.type === "eval" && Number.isInteger(p.index) && !items.has(p.index)) {
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
 * Why a job can't be published to the Hub, or null when it can: a glimmer-lora job that succeeded, wasn't a dry run,
 * had its GPU shut down and was judged, so its card has results. Plain sentences, for the job page and the routes.
 */
export function hubJobProblem(job: Pick<TrainJobRow, "recipe" | "status" | "params" | "terminatedAt" | "evalSummary">): string | null {
  if (job.recipe !== "glimmer-lora") return "Only Muse Glimmer LoRA jobs are published to Hugging Face.";
  if (Number(job.params?.dryRun) >= 1) return "It was a dry run, so its adapter is a stand-in.";
  if (job.status !== "succeeded") return "It didn't succeed, so it has no adapter to publish.";
  const note = unjudgedNote(job.evalSummary);
  if (!job.terminatedAt || !job.evalSummary) return "It isn't judged yet, and its card needs the results.";
  if (note) return `It wasn't judged (${note.replace(/[.]+$/, "")}), so its card would have no results.`;
  return null;
}

/** True when a job's "publish" param (0 or 1) says to keep it off the Hub. Unset means it publishes. */
export function publishOff(params: Record<string, string | number> | null | undefined): boolean {
  const v = params?.publish;
  return v !== undefined && v !== "" && Number(v) === 0;
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
 * with the reason; with every file in, it is "uploaded". Files the plan doesn't have are ignored.
 */
export function withDone(
  hub: HubState,
  done: { uploaded: string[]; failed: Array<{ path: string; error: string }> },
  now: Date,
): HubState {
  const planned = new Set((hub.files ?? []).map((f) => f.sha256));
  const uploaded = [...new Set([...(hub.uploaded ?? []), ...done.uploaded.filter((oid) => planned.has(oid))])];
  const next: HubState = { ...hub, uploaded, updatedAt: now.toISOString() };
  if (done.failed.length) {
    const first = done.failed[0]!;
    const more = done.failed.length > 1 ? ` (and ${done.failed.length - 1} more)` : "";
    return { ...next, status: "failed", reason: `The GPU couldn't upload ${first.path} to Hugging Face: ${first.error}${more}` };
  }
  return hubUploaded(next) ? { ...next, status: "uploaded", reason: null } : next;
}

import type { CodeStep } from "@/components/docs/playgrounds/open-weights/deploy";
import { SPARK, n } from "@/components/docs/playgrounds/open-weights/facts";

/**
 * The two TorchTitan cookbook recipes for Muse Spark Open as builders and explainers
 * (cookbook/muse-spark-open-torchtitan-sft, cookbook/muse-spark-open-torchtitan-rl):
 *
 * - SFT: which tokens carry loss (the assistant's " to=user<|message|>...<|eot|>", never the prompt, never
 *   <|start|>assistant, never media), how many placeholder tokens an image or a clip expands to (one <|patch|> per
 *   2x2 group of 14-pixel patches, one <|audio|> per 1,920 samples at 24 kHz), and the recipe code and run commands.
 * - RL: with_task around the DAPO-Math system, the bring-up and the longer run, and the token budget.
 */

/** 1e-5 rather than 0.00001, the way the recipes write learning rates. */
export function sciNum(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return String(x);
  const exp = Math.floor(Math.log10(x));
  if (exp >= -3 && exp <= 3) return String(x);
  const mant = Math.round((x / 10 ** exp) * 1000) / 1000;
  return `${mant}e${exp}`;
}

// ---------------------------------------------------------------------------------------------------------------
// What gets trained

export interface MaskSegment {
  text: string;
  trained: boolean;
  special: boolean;
  media?: boolean;
}

export type SftPart = { type: "text"; text: string } | { type: "image"; path: string } | { type: "audio"; path: string };

export interface SftMessage {
  role: "system" | "user" | "assistant";
  content: string | SftPart[];
}

function pushSpecialAware(out: MaskSegment[], text: string, trained: boolean) {
  for (const piece of text.split(/(<\|[a-z_]+\|>)/)) {
    if (!piece) continue;
    out.push({ text: piece, trained, special: /^<\|[a-z_]+\|>$/.test(piece) });
  }
}

/**
 * The conversation as the recipe sees it, each piece marked trained or masked, following "4. What gets trained".
 * System and user turns are context; an assistant turn trains from its " to=user" recipient on, so the model learns
 * who it talks to, while "<|start|>assistant" (which the prompt supplies at inference) stays masked. The template's
 * own system lines (date, reasoning strength) are left out here; the recipe pins them so the loss doesn't change daily.
 */
export function lossMask(messages: SftMessage[]): MaskSegment[] {
  const out: MaskSegment[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      pushSpecialAware(out, "<|start|>assistant", false);
      const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      pushSpecialAware(out, ` to=user<|message|>${text}<|eot|>`, true);
      continue;
    }
    pushSpecialAware(out, `<|start|>${m.role}<|message|>`, false);
    if (typeof m.content === "string") pushSpecialAware(out, m.content, false);
    else {
      for (const p of m.content) {
        if (p.type === "text") pushSpecialAware(out, p.text, false);
        else out.push({ text: p.type === "image" ? "<|patch|>" : "<|audio|>", trained: false, special: true, media: true });
      }
    }
    pushSpecialAware(out, "<|eot|>", false);
  }
  return out;
}

export function trainedShare(segments: MaskSegment[]): { trainedChars: number; totalChars: number } {
  let trainedChars = 0;
  let totalChars = 0;
  for (const s of segments) {
    totalChars += s.text.length;
    if (s.trained) trainedChars += s.text.length;
  }
  return { trainedChars, totalChars };
}

// ---------------------------------------------------------------------------------------------------------------
// Media placeholders

/** One <|patch|> per 2x2 group of 14-pixel patches, for an image at the size the encoder sees. */
export function imagePatchTokens(width: number, height: number): number {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return Math.ceil(w / 28) * Math.ceil(h / 28);
}

/** One <|audio|> per 1,920 samples at 24 kHz: 12.5 a second. */
export function audioTokens(seconds: number): number {
  return Math.ceil((Math.max(0, seconds) * 24000) / 1920);
}

/** The debug model caps images at 64 tokens to fit its 512-token context. */
export const DEBUG_IMAGE_CAP = 64;

// ---------------------------------------------------------------------------------------------------------------
// SFT recipe

export interface SftOptions {
  modality: "text" | "media";
  data: string[];
  lr: number;
  currentDate: string;
  effort: "low" | "medium" | "high" | "xhigh";
  run: "smoke" | "full";
}

export const SFT_DEFAULTS: SftOptions = { modality: "text", data: ["/data/dolly/train.jsonl"], lr: 1e-5, currentDate: "2026-01-15", effort: "xhigh", run: "smoke" };

/** The module the builder names for the reader's own recipe function (any importable module works). */
export const SFT_MODULE = "my_sft";

/**
 * Whether the recipe differs from what sft.py ships. sft.py ships the page's functions as muse_spark_816b_a42b_sft
 * and muse_spark_816b_a42b_media_sft, at lr 1e-5 (text pinning current_date 2026-01-15 and reasoning_effort xhigh),
 * with the data read from MUSE_SPARK_SFT_DATA. Any other value only takes effect through the reader's own function.
 */
export function sftIsCustom(o: SftOptions): boolean {
  const lr = Math.abs(o.lr - SFT_DEFAULTS.lr) > 1e-12;
  return o.modality === "media" ? lr : lr || o.currentDate !== SFT_DEFAULTS.currentDate || o.effort !== SFT_DEFAULTS.effort;
}

export function sftPlan(o: SftOptions): { steps: CodeStep[]; notes: string[]; warnings: string[] } {
  const steps: CodeStep[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const media = o.modality === "media";
  const custom = sftIsCustom(o);
  const fn = media ? "my_media_sft" : "my_text_sft";
  const data = o.data.map((d) => d.trim()).filter(Boolean);
  if (!data.length) warnings.push("Add at least one JSONL file.");
  steps.push({
    title: "Install TorchTitan and the media packages",
    lang: "bash",
    code: [
      "git clone https://github.com/pytorch/torchtitan && cd torchtitan",
      "pip install -r requirements.txt",
      "pip install transformers soundfile",
      "",
      "hf download meta-models/Muse-Spark-Open-816B-A42B --local-dir ./assets/hf/Muse-Spark-Open-816B-A42B",
      "export PYTHONPATH=$PYTHONPATH:/path/to/meta-oss-cookbook/muse-spark/post-training/sft/torchtitan",
    ].join("\n"),
    note: "The one-GPU smoke tests need only the tokenizer and chat template from the checkpoint. Point MUSE_SPARK_HF_ASSETS_PATH at it if you put it elsewhere.",
  });
  steps.push({
    title: "Prepare the public stand-in datasets (optional)",
    lang: "bash",
    code: media ? "python prepare_data.py llava /data/llava\npython prepare_data.py librispeech /data/librispeech" : "python prepare_data.py dolly /data/dolly",
  });
  const files = data.map((d) => JSON.stringify(d)).join(", ");
  const shipped = media ? "muse_spark_816b_a42b_media_sft" : "muse_spark_816b_a42b_sft";
  const header = custom
    ? [`# ${SFT_MODULE}.py, beside sft.py or anywhere on PYTHONPATH.`, "# Import sft_recipe and the configs below the way sft.py does.", ""]
    : [];
  steps.push({
    title: custom ? `Your recipe, in ${SFT_MODULE}.py (${media ? "image and audio" : "text"} SFT)` : `The recipe: ${media ? "image and audio" : "text"} SFT, as sft.py ships it`,
    lang: "python",
    code: [...header, ...(media
      ? [
          "def my_media_sft() -> Trainer.Config:",
          "    config = _muse_spark_816b_a42b()",
          '    config.model = build_model_config("816B-A42B_mm", parallelism=config.parallelism)',
          '    config.model.dataset_modalities = ("vision", "audio")',
          "    return sft_recipe(",
          "        config,",
          `        data=(${files}${data.length === 1 ? "," : ""}),`,
          "        processor=MediaChatSFTProcessor.Config(...),  # geometry from config.model",
          "        packing=MMSamplePackingConfig,",
          `        lr=${sciNum(o.lr)},`,
          "    )",
        ]
      : [
          "def my_text_sft() -> Trainer.Config:",
          "    return sft_recipe(",
          "        _muse_spark_816b_a42b(),              # TorchTitan's Muse Spark Open recipe",
          `        data=(${files}${data.length === 1 ? "," : ""}),`,
          "        processor=ChatProcessor.Config(",
          "            messages_fn=chat_messages,",
          `            renderer=MuseSparkRendererConfig(current_date=${JSON.stringify(o.currentDate)}, reasoning_effort=${JSON.stringify(o.effort)}),`,
          "        ),",
          `        lr=${sciNum(o.lr)},`,
          "    )",
        ])].join("\n"),
    note: custom
      ? `TorchTitan loads recipes by module path and function name, so the run below names ${SFT_MODULE} and ${fn}. sft.py's ${shipped} would run the page's values (lr 1e-5${media ? "" : ", current_date 2026-01-15, reasoning_effort xhigh"}) instead.`
      : `sft.py ships this function as ${shipped}, reading the data paths from MUSE_SPARK_SFT_DATA because the launcher calls recipes with no arguments. Change lr${media ? "" : ", current_date or reasoning_effort"} and the builder runs it as your own function instead.`,
  });
  if (o.run === "smoke") {
    // The smoke configs check the wiring on sft.py's random-weight debug model; no function of the reader's runs here.
    const config = media ? "muse_spark_debugmodel_media_sft" : "muse_spark_debugmodel_sft";
    const ignored = [!media && "your JSONL files", custom && `the ${media ? "lr" : "lr, current_date and reasoning_effort"} above`].filter(Boolean).join(" or ");
    steps.push({
      title: "Smoke run: one GPU, random-weight debug model",
      lang: "bash",
      code: [...(media ? [`export MUSE_SPARK_SFT_DATA=${JSON.stringify(data.join(","))}`] : []), `NGPU=1 MODULE=sft CONFIG=${config} ./run_train.sh`].join("\n"),
      note: `${media ? "sft.py reads the data paths from MUSE_SPARK_SFT_DATA because the launcher calls recipes with no arguments." : "The text smoke config trains on the bundled sample conversations (sample.jsonl)."}${ignored ? ` It checks the wiring with sft.py's own debug config, so it doesn't use ${ignored}.` : ""}`,
    });
  } else if (custom) {
    steps.push({
      title: `The full model, from the released weights, with your ${fn}`,
      lang: "bash",
      code: `MODULE=${SFT_MODULE} CONFIG=${fn} ./run_train.sh`,
      note: "Your function carries its own data paths, so it needs no MUSE_SPARK_SFT_DATA.",
    });
  } else {
    steps.push({
      title: "The full model, from the released weights",
      lang: "bash",
      code: [`export MUSE_SPARK_SFT_DATA=${JSON.stringify(data.join(","))}`, `MODULE=sft CONFIG=${shipped} ./run_train.sh`].join("\n"),
      note: "sft.py reads the data paths from MUSE_SPARK_SFT_DATA because the launcher calls recipes with no arguments.",
    });
  }
  if (o.run === "full") notes.push("The 816B recipes inherit TorchTitan's layout: 128 GPUs, data parallel 16 × tensor parallel 8, experts split 32 ways. Change config.parallelism to fit your cluster.");
  notes.push(`Setting lr moves every optimizer group together, so the router keeps training at 0.125x the base rate (${sciNum(o.lr * 0.125)}).`);
  if (media) {
    notes.push("dataset_modalities declares what the data holds: when a GPU's batch has no image (or no audio), that encoder runs on a dummy input so every GPU joins the same collectives.");
    warnings.push("Image training can't use --debug.deterministic: the vision encoder's grid_sample has no deterministic backward on GPU. Fix the seed and compare curves instead.");
  } else {
    notes.push(`The renderer pins current_date ${o.currentDate} and reasoning_effort ${o.effort} into the system prompt; otherwise the date is today's and the tokens, and your loss, change daily.`);
  }
  notes.push(`On the smoke run, step-1 loss should be near ln(${n(SPARK.vocabSize)}) = 12.2. From the released checkpoint, held-out loss per trained token starts near 1.80 (Dolly), 0.86 (LLaVA) and 0.40 (LibriSpeech).`);
  return { steps, notes, warnings };
}

// ---------------------------------------------------------------------------------------------------------------
// RL recipe

export interface RlOptions {
  run: "bringup" | "template" | "longer" | "custom";
  trainPath: string;
  valPath: string;
  steps: number;
  offpolicy: number;
  validationSteps: number;
  ckptInterval: number;
  keepLatest: number;
}

export const RL_DEFAULTS: RlOptions = { run: "bringup", trainPath: "/data/train.jsonl", valPath: "/data/val.jsonl", steps: 150, offpolicy: 4, validationSteps: 30, ckptInterval: 50, keepLatest: 3 };

/** The bring-up's budget: 65,536 tokens per rollout, at most 63,488 generated, so prompts get the rest. */
export const RL_BUDGET = { rolloutTokens: 65_536, generatedTokens: 63_488, prompts: 8, samples: 8 } as const;

export function rlPlan(o: RlOptions): { steps: CodeStep[]; notes: string[]; warnings: string[] } {
  const steps: CodeStep[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  steps.push({
    title: "Install TorchTitan with its RL dependencies and Dist-MoE",
    lang: "bash",
    code: [
      "git clone https://github.com/pytorch/torchtitan && cd torchtitan",
      "pip install -r requirements.txt -r torchtitan/rl/requirements.txt",
      'pip install "git+https://github.com/meta-pytorch/dist_moe.git@main"',
      "",
      "hf download meta-models/Muse-Spark-Open-816B-A42B --local-dir ./assets/hf/Muse-Spark-Open-816B-A42B",
      "export PYTHONPATH=$PYTHONPATH:/path/to/meta-oss-cookbook/muse-spark/post-training/rl/torchtitan",
    ].join("\n"),
  });
  if (o.run === "bringup") {
    steps.push({
      title: "The bring-up: five on-policy steps of DAPO-Math",
      lang: "bash",
      code: "python -m torchtitan.rl.train --module rl --config muse_spark_dapo_math",
      note: "Datasets come from Hugging Face. Offline, set MUSE_SPARK_DAPO_MATH_REPO_ID and MUSE_SPARK_AIME2025_REPO_ID to local copies.",
    });
    notes.push("It confirms the trainer and generator agree before a long run: no validation, no checkpoint saves.");
  }
  if (o.run === "template") {
    steps.push({ title: "Run the QA template on its sample rows", lang: "bash", code: "python -m torchtitan.rl.train --module rl --config muse_spark_qa   # the template, on qa_sample.jsonl" });
  }
  if (o.run === "custom") {
    steps.push({ title: "Copy the task template", lang: "bash", code: "cp qa_task.py my_task.py" });
    steps.push({
      title: "Your task on the Muse Spark Open system",
      lang: "python",
      code: [
        "def muse_spark_my_task() -> Controller.Config:",
        "    return with_task(",
        "        muse_spark_dapo_math(),",
        `        my_task(train_path=${JSON.stringify(o.trainPath)}, validation_path=${JSON.stringify(o.valPath)}),`,
        '        dump_folder="outputs/rl/muse_spark_my_task",',
        "    )",
      ].join("\n"),
      note: "Change the sample, the dataset (keep the base class for shuffling and resume), the env (tools from init, tool calls in step, done=False for more turns) and the reward (any async (rollout, sample) -> float, several weighted in a Rubric).",
    });
    notes.push("with_task sets the task's token budget to the trainer's context length, so rollouts are never cut off.");
  }
  if (o.run === "longer") {
    if (o.offpolicy < 0) warnings.push("target_offpolicy_steps can't be negative.");
    if (o.ckptInterval > o.steps) warnings.push("The checkpoint interval is longer than the run, so nothing is saved before the end.");
    steps.push({
      title: "A longer run: change only what differs from the bring-up",
      lang: "python",
      code: [
        "def muse_spark_dapo_math_train() -> Controller.Config:",
        "    config = muse_spark_dapo_math()",
        "    config.async_loop = replace(",
        "        config.async_loop,",
        `        num_training_steps=${o.steps},`,
        `        target_offpolicy_steps=${o.offpolicy},            # overlap generation and training`,
        `        validation=ValidationConfig(steps=${o.validationSteps}),`,
        "        batcher=Batcher.Config(),            # drop groups whose rewards are all equal",
        "    )",
        "    config.trainer.checkpointer = replace(",
        `        config.trainer.checkpointer, load_only=False, interval=${o.ckptInterval}, keep_latest_k=${o.keepLatest}`,
        "    )",
        "    return config",
      ].join("\n"),
    });
    notes.push(`${o.steps} steps with a checkpoint every ${o.ckptInterval} keeps the latest ${o.keepLatest} of ${Math.floor(o.steps / Math.max(1, o.ckptInterval))}. To fit fewer GPUs, change the trainer and generator parallelism together with the token budget.`);
  }
  notes.push(
    `Each step samples ${RL_BUDGET.prompts} prompts × ${RL_BUDGET.samples} samples = ${RL_BUDGET.prompts * RL_BUDGET.samples} rollouts of up to ${n(RL_BUDGET.rolloutTokens)} tokens (${n(RL_BUDGET.generatedTokens)} generated, ${n(RL_BUDGET.rolloutTokens - RL_BUDGET.generatedTokens)} left for the prompt). Trainer: 256 GPUs; generator: 16.`,
  );
  return { steps, notes, warnings };
}

/** The page's own conversation for "What gets trained". */
export const MASK_PRESETS: { label: string; messages: SftMessage[] }[] = [
  {
    label: "The page's example",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ],
  },
  {
    label: "Image question",
    messages: [
      { role: "user", content: [{ type: "image", path: "/data/img/1.jpg" }, { type: "text", text: "What color is the horse?" }] },
      { role: "assistant", content: "Brown." },
    ],
  },
  {
    label: "Two turns",
    messages: [
      { role: "user", content: "Name a prime between 10 and 20." },
      { role: "assistant", content: "13" },
      { role: "user", content: "Another one?" },
      { role: "assistant", content: "17" },
    ],
  },
];

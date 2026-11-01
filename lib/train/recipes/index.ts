import { DECIDE_EPOCHS_DEFAULT, DECIDE_EPOCHS_MAX, DECIDE_EPOCHS_MIN } from "@/lib/train/decision-datasets";
import {
  CHAT_MODE,
  DECIDE_MODE,
  MODE_PARAM,
  recipeDefaults,
  SERVE_ADAPTER_PARAM,
  SERVE_BOOT_MINUTES,
  SERVE_MINUTES_DEFAULT,
  SERVE_MINUTES_MAX,
  SERVE_MINUTES_MIN,
  SERVE_MINUTES_PARAM,
  SERVE_RECIPE,
} from "@/lib/train/logic";
import { env } from "@/lib/env";
import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";
import { PUBLISH_PY } from "@/lib/train/recipes/publish";
import { QUANT_PY } from "@/lib/train/recipes/quantize";
import { RL_PY } from "@/lib/train/recipes/rl";
import { SERVE_MAX_NEW_TOKENS, SERVE_PY } from "@/lib/train/recipes/serve";
import { SMOKE_PY } from "@/lib/train/recipes/smoke";
import { RL_RECIPE, type Recipe } from "@/lib/train/types";

/** GPUs that run Muse Glimmer 30B in 4-bit with Unsloth, in order of preference. */
const GLIMMER_GPUS: Recipe["gpus"] = [
  { instanceType: "gpu_1x_h100_pcie", label: "1x H100 PCIe (80 GB)" },
  { instanceType: "gpu_1x_h100_sxm5", label: "1x H100 SXM5 (80 GB)" },
  { instanceType: "gpu_1x_a100_sxm4", label: "1x A100 SXM4 (40 GB)" },
];

/**
 * The cheapest single GPUs, cheapest first (Lambda's prices on 2026-10-28), for glimmer-publish, which only reads its
 * adapter from the region's cache and uploads it. It must launch in that region, so there are several to pick from.
 */
const PUBLISH_GPUS: Recipe["gpus"] = [
  { instanceType: "gpu_1x_rtx6000", label: "1x RTX 6000 (24 GB)" },
  { instanceType: "gpu_1x_a6000", label: "1x A6000 (48 GB)" },
  { instanceType: "gpu_1x_a10", label: "1x A10 (24 GB)" },
  { instanceType: "gpu_1x_a100", label: "1x A100 PCIe (40 GB)" },
  { instanceType: "gpu_1x_a100_sxm4", label: "1x A100 SXM4 (40 GB)" },
];

/**
 * GPUs for glimmer-quantize, in order: each has at least 220 GiB of RAM and 512 GiB of local disk (Lambda's specs on
 * 2026-10-28), for the merge's 60 GB of RAM and the files' disk. On the A100s, 40 GB holds the Q8_0 reference whole;
 * the A10's 24 GB splits it with the CPU and needs offloading for r30b's 4-bit model (both seen working Nov 1 2026), so it
 * comes last. The A6000 and RTX 6000
 * have too little RAM.
 */
const QUANT_GPUS: Recipe["gpus"] = [
  { instanceType: "gpu_1x_a100_sxm4", label: "1x A100 SXM4 (40 GB)" },
  { instanceType: "gpu_1x_a100", label: "1x A100 PCIe (40 GB)" },
  { instanceType: "gpu_1x_a10", label: "1x A10 (24 GB)" },
];

/** The serve recipe's limits for its default minutes; recipeDefaults sizes them from the minutes a job asks for. */
const SERVE_DEFAULTS = recipeDefaults({ id: SERVE_RECIPE, defaultMaxMinutes: 0, defaultMaxUsd: 0 }, {});

/** Recipes the admin page offers, in order. Each script is imported by runner.py as recipe.py and must define run(ctx). */
export const RECIPES: Recipe[] = [
  {
    id: "smoke",
    title: "Smoke test",
    description:
      "Starts the cheapest free GPU, checks the GPU, torch with CUDA, disk and network, then shuts it down. Run it to prove the whole loop works before a real job.",
    gpus: [
      { instanceType: "gpu_1x_a10", label: "1x A10 (24 GB)" },
      { instanceType: "gpu_1x_rtx6000", label: "1x RTX 6000 (24 GB)" },
      { instanceType: "gpu_1x_a6000", label: "1x A6000 (48 GB)" },
      { instanceType: "gpu_1x_a100_sxm4", label: "1x A100 SXM4 (40 GB)" },
      { instanceType: "gpu_1x_a100", label: "1x A100 PCIe (40 GB)" },
    ],
    defaultMaxMinutes: 30,
    defaultMaxUsd: 1,
    params: [],
    script: SMOKE_PY,
  },
  {
    id: "glimmer-lora",
    title: "Muse Glimmer LoRA",
    description:
      "Fine-tunes Muse Glimmer 30B with 2026 knowledge (Muse Muse's own, OfflineBase/Glimmer-30B-2026-Knowledge, in 4-bit; Built with Muse Spark Open) with a LoRA adapter on one of your datasets, following Unsloth's guide, then answers the held-out prompts with the base and the tuned model so they can be compared. Both answer directly, with no reasoning, as the tuned one was trained, and by default under a one-line system message rather than the dataset's task prompt, so the comparison shows what training taught. The model and its Python packages are cached on a Lambda filesystem in the region, so later jobs start faster. In decide mode it trains on a decision dataset instead: each answer is one option's letter, both models are scored on the held-out test rows under the dataset's own system message, and nothing is judged.",
    // Unsloth supports arm64 only through a from-source Docker build, so gpu_1x_gh200 (Grace, arm64) is left out.
    gpus: GLIMMER_GPUS,
    defaultMaxMinutes: 150,
    defaultMaxUsd: 14,
    usesCache: true,
    params: [
      {
        key: "datasetId",
        label: "Dataset",
        kind: "dataset",
        required: true,
        help: "A ready dataset. It trains on the train part; the eval part (up to 40 held-out prompts) is answered before and after.",
      },
      {
        key: MODE_PARAM,
        label: "Mode",
        kind: "text",
        choices: [CHAT_MODE, DECIDE_MODE],
        help: "chat (the default) or decide. chat trains on a chat dataset's conversations. decide trains Glimmer into a decision model on a decision dataset's labeled rows: it answers with one option's letter, and base and tuned Glimmer are scored on the held-out test rows, so the results say how often each was right there. It can still be wrong.",
      },
      {
        key: "maxSteps",
        label: "Training steps",
        kind: "number",
        default: 120,
        min: 10,
        max: 2000,
        modes: [CHAT_MODE],
        help: "Optimizer steps of 4 conversations each (batch 1, gradient accumulation 4).",
      },
      {
        key: "epochs",
        label: "Epochs",
        kind: "number",
        default: DECIDE_EPOCHS_DEFAULT,
        min: DECIDE_EPOCHS_MIN,
        max: DECIDE_EPOCHS_MAX,
        whole: true,
        modes: [DECIDE_MODE],
        help: "Decide mode only, in place of training steps: passes over the training rows, each with a new option order. Smaller labels get extra copies, up to 3 to 1. Steps of 32 renderings (batch 16, gradient accumulation 2).",
      },
      {
        key: "learningRate",
        label: "Learning rate",
        kind: "number",
        default: 0.0002,
        min: 0.000001,
        max: 0.01,
        help: "2e-4 is Unsloth's LoRA default. Lower it for long runs.",
      },
      {
        key: "loraRank",
        label: "LoRA rank",
        kind: "number",
        default: 16,
        min: 4,
        max: 128,
        help: "16 is Unsloth's starting point, 32 for harder tasks. lora_alpha is set to the same value.",
      },
      {
        key: "studentPrompt",
        label: "Student prompt",
        kind: "text",
        default: "short",
        modes: [CHAT_MODE],
        help: 'short or full. short: training and both models\' answers use one line, "You are" and the dataset\'s name (name it as a role, such as "Muse Muse\'s brief writer"), so the scores measure what training taught. full: the dataset\'s whole task prompt, as its writer saw it, so they measure how well each model follows instructions.',
      },
      {
        key: "scoreOnly",
        label: "Score only",
        kind: "number",
        default: 0,
        min: 0,
        max: 1,
        whole: true,
        modes: [DECIDE_MODE],
        help: "Decide mode only. 1 scores base Glimmer on the dev and test rows and trains nothing, so no adapter is saved: the zero-shot numbers on their own.",
      },
      {
        key: "dryRun",
        label: "Dry run",
        kind: "number",
        default: 0,
        min: 0,
        max: 1,
        help: "1 skips the install, the model and the training and fakes the answers: a cheap check of the dataset, eval and judging loop on a real GPU. In decide mode it fakes the scores and the adapter instead, a check of the pages, the score callbacks and scoring; it loads no model.",
      },
      {
        key: "publish",
        label: "Publish to Hugging Face",
        kind: "number",
        default: 1,
        min: 0,
        max: 1,
        help: "1 sends the adapter to the Hugging Face Hub when training ends, and once the job is judged the platform publishes it with its training data and a model card that says why it was made. 0 keeps it on Muse Muse only. A dry run is never published.",
      },
      {
        key: "why",
        label: "Why this model",
        kind: "text",
        help: "Optional, in your own words: why this model was made. It opens the model card's story on Hugging Face, and Muse Wonder builds the rest from the dataset's task and the results.",
      },
    ],
    script: GLIMMER_PY,
  },
  {
    id: "glimmer-serve",
    title: "Try tuned Glimmer live",
    description: `Serves one trained Muse Glimmer LoRA adapter for a set number of minutes, so anyone on its job's public result page can type an app idea and get the base and the tuned model's answers side by side, from the same GPU. It runs in the adapter's region with that model cache mounted, loads the 4-bit base and the adapter, answers over HTTPS pinned to a certificate it makes at start, and then shuts down like any other job. A decision model's adapter is served as one: the page's box takes an input, and base Glimmer and the tuned model each pick a label for it. The time limit is the minutes plus ${SERVE_BOOT_MINUTES} to boot and load.`,
    // The GPUs glimmer-lora trains on, so every adapter fits.
    gpus: GLIMMER_GPUS,
    defaultMaxMinutes: SERVE_DEFAULTS.defaultMaxMinutes,
    defaultMaxUsd: SERVE_DEFAULTS.defaultMaxUsd,
    usesCache: true,
    params: [
      {
        key: SERVE_ADAPTER_PARAM,
        label: "Adapter",
        kind: "adapter",
        required: true,
        help: "A Muse Glimmer LoRA job that succeeded and saved its adapter on a model cache. The demo runs in that cache's region.",
      },
      {
        key: SERVE_MINUTES_PARAM,
        label: "Minutes live",
        kind: "number",
        default: SERVE_MINUTES_DEFAULT,
        min: SERVE_MINUTES_MIN,
        max: SERVE_MINUTES_MAX,
        help: `How long the demo answers once the model is loaded. One prompt at a time, up to ${SERVE_MAX_NEW_TOKENS} new tokens per answer.`,
      },
    ],
    script: SERVE_PY,
  },
  {
    id: "glimmer-publish",
    title: "Publish to Hugging Face",
    description:
      "Sends one trained Muse Glimmer LoRA adapter from its region's model cache to the Hugging Face Hub, for an adapter that wasn't sent when it trained (one trained before publishing existed, or whose job ran out of time). It runs on the cheapest GPU free in the adapter's region with that cache mounted, never uses the GPU, and uploads the files straight to the Hub's storage with upload links the platform gets from the Hub, so the Hub token never leaves the platform. The platform then publishes them with the model card and the dataset.",
    gpus: PUBLISH_GPUS,
    defaultMaxMinutes: 20,
    defaultMaxUsd: 1,
    usesCache: true,
    params: [
      {
        key: SERVE_ADAPTER_PARAM,
        label: "Adapter",
        kind: "adapter",
        required: true,
        help: "A Muse Glimmer LoRA job that succeeded and saved its adapter on a model cache. The upload runs in that cache's region.",
      },
    ],
    script: PUBLISH_PY,
  },
  {
    id: "glimmer-quantize",
    title: "Make local files (GGUF)",
    description:
      "Merges one judged Muse Glimmer LoRA adapter into the 16-bit base and makes the files people run on their own computers: GGUF builds in three sizes (Q3_K_M, Q4_K_M and Q6_K) with a pinned llama.cpp. Each build is checked against the merged model, and the files must render training's prompt and give final answers in a stock app's prompt, or nothing is published. The builds that pass go to their own repo on the Hugging Face Hub, next to the adapter's, with a card that says which file fits which computer. It runs in the adapter's region with that model cache mounted. The adapter must be published first.",
    gpus: QUANT_GPUS,
    defaultMaxMinutes: 110,
    defaultMaxUsd: 3.7,
    usesCache: true,
    params: [
      {
        key: SERVE_ADAPTER_PARAM,
        label: "Adapter",
        kind: "adapter",
        required: true,
        help: "A Muse Glimmer LoRA job that was judged and published, trained under the short student prompt. The job runs in its model cache's region.",
      },
      {
        key: "publish",
        label: "Publish to Hugging Face",
        kind: "number",
        default: 1,
        min: 0,
        max: 1,
        help: "1 uploads the builds that pass and publishes their repo once the job succeeds. 0 makes and checks the files but uploads nothing, a test of the recipe: the files are gone when the GPU shuts down.",
      },
    ],
    script: QUANT_PY,
  },
];

/**
 * GRPO on made-up arithmetic (TUNE_RL). Kept out of RECIPES, so with the flag off every list is as it was. recipeById
 * still finds it, so a job started while the flag was on keeps its page; launchJobRequest refuses a new one.
 */
export const RL_GRPO_RECIPE: Recipe = {
  id: RL_RECIPE,
  title: "Reinforcement learning (GRPO)",
  description:
    "Trains a LoRA of the 2026 Glimmer with TRL's GRPO on made-up arithmetic problems, with a reward checked by code, not by a model. Shows mean reward over time and how many of 40 held-out problems the model gets right before and after. Never published to Hugging Face. This recipe has never run on a real GPU, so its time and cost limits are guesses.",
  gpus: GLIMMER_GPUS,
  defaultMaxMinutes: 90,
  defaultMaxUsd: 8,
  usesCache: true,
  params: [
    { key: "maxSteps", label: "Training steps", kind: "number", default: 200, min: 10, max: 1000, whole: true, help: "Optimizer steps of 2 problems each." },
    { key: "numGenerations", label: "Answers per problem", kind: "number", default: 8, min: 2, max: 16, whole: true, help: "How many answers GRPO samples and compares for each problem. More uses more GPU memory." },
    { key: "learningRate", label: "Learning rate", kind: "number", default: 0.00005, min: 0.000001, max: 0.001, help: "A starting guess, not a measured value." },
    { key: "loraRank", label: "LoRA rank", kind: "number", default: 16, min: 4, max: 128, whole: true, help: "lora_alpha is set to the same value." },
    { key: "seed", label: "Seed", kind: "number", default: 3407, min: 0, max: 1000000, whole: true, help: "Picks the made-up problems and the training's randomness." },
    { key: "dryRun", label: "Dry run", kind: "number", default: 0, min: 0, max: 1, whole: true, help: "1 loads no model and reports made-up numbers, labeled as such: a check of the callbacks and this page." },
  ],
  script: RL_PY,
};

/** The recipes people may start right now. */
export function offeredRecipes(): Recipe[] {
  return env.tuneRl ? [...RECIPES, RL_GRPO_RECIPE] : RECIPES;
}

/** The recipe with this id, or null when there is none. */
export function recipeById(id: string | null | undefined): Recipe | null {
  if (!id) return null;
  if (id === RL_RECIPE) return RL_GRPO_RECIPE;
  return RECIPES.find((r) => r.id === id) ?? null;
}

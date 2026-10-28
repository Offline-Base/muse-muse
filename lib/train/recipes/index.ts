import { GLIMMER_PY } from "@/lib/train/recipes/glimmer";
import { SMOKE_PY } from "@/lib/train/recipes/smoke";
import type { Recipe } from "@/lib/train/types";

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
      "Fine-tunes Muse Glimmer 30B (4-bit) with a LoRA adapter on one of your datasets, following Unsloth's guide, then answers the held-out prompts with the base and the tuned model so they can be compared. Both answer directly, with no reasoning, as the tuned one was trained, and by default under a one-line system message rather than the dataset's task prompt, so the comparison shows what training taught. The model and its Python packages are cached on a Lambda filesystem in the region, so later jobs start faster.",
    // Unsloth supports arm64 only through a from-source Docker build, so gpu_1x_gh200 (Grace, arm64) is left out.
    gpus: [
      { instanceType: "gpu_1x_h100_pcie", label: "1x H100 PCIe (80 GB)" },
      { instanceType: "gpu_1x_h100_sxm5", label: "1x H100 SXM5 (80 GB)" },
      { instanceType: "gpu_1x_a100_sxm4", label: "1x A100 SXM4 (40 GB)" },
    ],
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
        key: "maxSteps",
        label: "Training steps",
        kind: "number",
        default: 120,
        min: 10,
        max: 2000,
        help: "Optimizer steps of 4 conversations each (batch 1, gradient accumulation 4).",
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
        help: 'short or full. short: training and both models\' answers use one line, "You are" and the dataset\'s name (name it as a role, such as "Muse Muse\'s brief writer"), so the scores measure what training taught. full: the dataset\'s whole task prompt, as Muse Spark saw it, so they measure how well each model follows instructions.',
      },
      {
        key: "dryRun",
        label: "Dry run",
        kind: "number",
        default: 0,
        min: 0,
        max: 1,
        help: "1 skips the install, the model and the training and fakes the answers: a cheap check of the dataset, eval and judging loop on a real GPU.",
      },
    ],
    script: GLIMMER_PY,
  },
];

/** The recipe with this id, or null when there is none. */
export function recipeById(id: string | null | undefined): Recipe | null {
  if (!id) return null;
  return RECIPES.find((r) => r.id === id) ?? null;
}

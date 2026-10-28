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
];

/** The recipe with this id, or null when there is none. */
export function recipeById(id: string | null | undefined): Recipe | null {
  if (!id) return null;
  return RECIPES.find((r) => r.id === id) ?? null;
}

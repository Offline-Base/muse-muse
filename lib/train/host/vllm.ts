/**
 * How Modal and Baseten start vLLM. The version and the memory and reasoning flags are what the knowledge run served Muse
 * Glimmer with (scripts/knowledge/aws/writer_fleet.py), though never with an adapter on these providers.
 *
 * An adapter trained before trainChannel (every one so far) was judged answering on a final channel the prompt opens, so
 * it gets the same template its local files do (TUNED_TEMPLATE) and no reasoning parser, since nothing reasons there.
 */
import type { BaseFamily } from "@/lib/train/base";
import { TUNED_TEMPLATE } from "@/lib/train/tuned-template";

export const VLLM_IMAGE = "vllm/vllm-openai:v0.32.0";
export const FINAL_ONLY_STOPS = ["<|eom|>", "<|start|>"] as const;
export { TUNED_TEMPLATE };

export interface ServeModel {
  family?: BaseFamily;
  trainChannel?: 0 | 1;
  rank: number;
}

export const needsTunedTemplate = (m: Pick<ServeModel, "family" | "trainChannel">) => m.family === "glimmer" && m.trainChannel === 0;

/** The flags after the model and the adapter. templatePath is where the provider put TUNED_TEMPLATE. */
export function vllmFlags(m: ServeModel, templatePath: string): string[] {
  const flags = ["--max-lora-rank", String(m.rank), "--max-model-len", "8192", "--gpu-memory-utilization", "0.93"];
  if (m.family !== "glimmer") return flags;
  return needsTunedTemplate(m) ? [...flags, "--chat-template", templatePath] : [...flags, "--reasoning-parser", "muse_glimmer"];
}

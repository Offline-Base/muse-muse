import { defaultsOf, type Values } from "@/components/docs/playgrounds/open-weights/deploy";
import { sparkRuntime } from "@/components/docs/playgrounds/open-weights/deploy-spark";
import { SPARK, SPARK_CHECKPOINTS, type SparkCheckpoint, type SparkCheckpointFacts } from "@/components/docs/playgrounds/open-weights/facts";
import { sparkFit, type SparkFit } from "@/components/docs/playgrounds/open-weights/hardware";

/**
 * Muse Spark Open on NVIDIA, as the hardware planner shows it (muse-spark-open/hardware-platforms): the layout its
 * numbers describe and the command it prints, kept the same. The commands keep the page's parallelism (NVFP4 at
 * TP4/EP4 on 4 GPUs, BF16 at TP8/EP8 on 8, and TensorRT-LLM's validated configuration, which is NVFP4's), so the
 * per-GPU numbers are for that layout too: on more GPUs than the recipe uses, the recipe on part of them (nothing on
 * these pages validates NVFP4 at TP8/EP8); on fewer, the numbers show why it doesn't fit.
 */

export type NvidiaRuntime = "trtllm" | "sglang" | "vllm";

/** Each runtime's context as its command on the pages has it: TensorRT-LLM's validated window, SGLang's server default (no flag), vLLM's full window. */
export const PAGE_CTX: Record<NvidiaRuntime, number | null> = { trtllm: 49152, sglang: null, vllm: 1048576 };

export const CTX_FLAG: Record<NvidiaRuntime, string> = { trtllm: "max_seq_len", sglang: "--context-length", vllm: "--max-model-len" };

export interface SparkLayout {
  /** The checkpoint the command serves: the picked one, or NVFP4 for TensorRT-LLM. */
  layout: SparkCheckpointFacts;
  /** GPUs the command uses, of the `gpus` the reader has. */
  used: number;
  spare: number;
  fit: SparkFit;
  expertsPerGpu: number;
}

export function sparkLayout(checkpoint: SparkCheckpoint, gpus: number, runtime: NvidiaRuntime): SparkLayout {
  const layout = runtime === "trtllm" ? SPARK_CHECKPOINTS.nvfp4 : SPARK_CHECKPOINTS[checkpoint];
  const used = Math.min(gpus, layout.gpus);
  return { layout, used, spare: gpus - used, fit: sparkFit(layout.id, used), expertsPerGpu: SPARK.routedExperts / layout.ep };
}

/** The page's command for the runtime, with the context (null: the page's own value for it). */
export function sparkNvidiaCommand(runtime: NvidiaRuntime, checkpoint: SparkCheckpoint, gpu: "gb300" | "b300", ctx: number | null): string {
  const r = sparkRuntime(runtime);
  if (runtime === "trtllm") {
    const plan = r.build({ ...defaultsOf(r.options), gpu, maxSeqLen: ctx ?? 49152 });
    return plan.steps
      .filter((s) => s.title === "serve_config.yaml" || s.title === "Start the server")
      .map((s) => (s.lang === "yaml" ? `# serve_config.yaml\n${s.code}` : s.code))
      .join("\n\n");
  }
  const sized: Values = runtime === "sglang" ? { context: ctx === null ? "default" : String(ctx) } : { maxModelLen: String(ctx ?? 1048576) };
  const plan = r.build({ ...defaultsOf(r.options), checkpoint, ...sized });
  return plan.steps.find((s) => s.title.startsWith("Start the server"))?.code ?? "";
}

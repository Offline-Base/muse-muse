"use client";

import { useId, useMemo, useState } from "react";
import { GGUF_FILES, GLIMMER, GLIMMER_REPOS, PAGE, SPARK, SPARK_CHECKPOINTS, inSentence, n, type OpenModel } from "@/components/docs/playgrounds/open-weights/facts";
import { recommend, type HardwareId } from "@/components/docs/playgrounds/open-weights/picker";
import { Badge, CodeCard, Facts, Rich, SegmentField, Status } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * A model's overview page (muse-spark-open, muse-glimmer) as quick facts and a "which checkpoint" chooser: Muse Spark
 * Open by the hardware you have (its BF16 and NVFP4 checkpoints, AMD's and Intel's builds, the Mac Studio split, or a
 * hosted provider), Muse Glimmer by the runtime you'll serve with (the four repositories its Get the model page
 * lists), each with the download and the first command from the model's pages.
 */

export interface ModelOverviewProps {
  slug: string;
  model: OpenModel;
}

export function ModelOverview({ model }: ModelOverviewProps) {
  return model === "spark" ? <SparkOverview /> : <GlimmerOverview />;
}

const SPARK_HW: Array<{ value: HardwareId; label: string }> = [
  { value: "blackwell4", label: "4 Blackwell GPUs" },
  { value: "b300x8", label: "8 × B300" },
  { value: "amd8", label: "8 × AMD Instinct" },
  { value: "xeon", label: "Xeon 6 (CPU)" },
  { value: "macs", label: "Mac Studios" },
  { value: "none", label: "No GPUs" },
];

function SparkOverview() {
  const [hw, setHw] = useState<HardwareId>("blackwell4");
  const v = useMemo(() => recommend(hw, { audioVideo: false, images: false, longContext: false, apache: false }).spark, [hw]);
  const ckpt = hw === "b300x8" ? SPARK_CHECKPOINTS.bf16 : SPARK_CHECKPOINTS.nvfp4;
  // The serve commands name the repository, so the runtime reads (or fills) the Hugging Face cache. Downloading into
  // the cache, without --local-dir, is the copy they find; a --local-dir copy would be fetched a second time.
  const download = hw === "blackwell4" || hw === "b300x8" || hw === "macs" ? `hf download ${ckpt.repo}` : null;
  return (
    <div className="pg">
      <Facts
        label="Muse Spark Open at a glance"
        items={[
          { label: "Parameters", value: SPARK.params },
          { label: "Architecture", value: "Sparse mixture of experts: each token routes to a few experts, but serving loads all 816B weights" },
          { label: "Input and output", value: SPARK.inputs },
          { label: "Context window", value: `${n(SPARK.contextTokens)} tokens` },
          { label: "Checkpoints", value: "BF16 (about 1.65 TB) and NVFP4 (about 537 GB)" },
          { label: "Languages", value: SPARK.languages },
          {
            label: "License",
            value: (
              <>
                <a href={SPARK.licenseUrl} target="_blank" rel="noopener noreferrer">
                  Muse Model License
                </a>{" "}
                and the{" "}
                <a href={SPARK.policyUrl} target="_blank" rel="noopener noreferrer">
                  Acceptable Use Policy
                </a>
              </>
            ),
          },
          { label: "Ways to run it", value: "Self-host (SGLang, vLLM and six more runtimes) or call a hosted provider" },
        ]}
      />
      <SegmentField<HardwareId> label="Which checkpoint? What do you have?" value={hw} options={SPARK_HW} onChange={setHw} />
      <Status tone={v.level === "fits" ? "ok" : "warn"}>{v.headline}</Status>
      <div className={styles.card}>
        <p className={styles.cardText}>{v.why.join(" ")}</p>
        {v.checkpoint ? (
          <p className="pg-small">
            Checkpoint: <code>{v.checkpoint}</code>
            {v.runtime ? <> · Runtime: {v.runtime}</> : null}
          </p>
        ) : null}
        {download ? <CodeCard code={`pip install -U huggingface_hub\n${download}`} lang="bash" label={hw === "macs" ? "Download, on every Mac" : "Download"} /> : null}
        {download ? (
          <p className="pg-hint">
            This fills the Hugging Face cache ({inSentence(ckpt.footprint)}{hw === "macs" ? " on each Mac, which loads from its own disk" : ""}), where the serve command finds <code>{ckpt.repo}</code>; skip it and the server downloads the weights itself. If you keep the files in a folder of your own, or downloaded them from Meta, pass the folder in place of the repository ID.
          </p>
        ) : null}
        {v.command ? <CodeCard code={v.command} lang="bash" label={hw === "none" ? "Call it" : "Serve"} /> : null}
        <p className="pg-small">
          <a href={v.link.href}>{v.link.label}</a> · <a href={PAGE.spark.deploy}>Run inference</a> · <a href={PAGE.spark.settings}>Recommended settings</a>
        </p>
      </div>
      <p className="pg-hint">Serving needs memory beyond the weights for the KV cache, activations and runtime overhead: budget roughly 2 TB of VRAM for BF16.</p>
    </div>
  );
}

type GlimmerRuntime = "vllm" | "sglang" | "llamacpp" | "executorch" | "spec" | "transformers" | "local-apps";

/**
 * Each runtime's download and serve pair. Where the serve command names the repository, the download goes into the
 * Hugging Face cache (no --local-dir), the copy the server finds; llama serve -hf keeps its own copy, so its download is
 * optional, as the quantization page says.
 */
const GLIMMER_CHOICE: Record<GlimmerRuntime, { label: string; repo: string; holds: string; size: string; download: string; downloadLabel?: string; downloadNote?: string; serve?: string; next: string }> = {
  vllm: {
    label: "vLLM",
    repo: GLIMMER_REPOS.bf16,
    holds: "The bf16 safetensors checkpoint, tokenizer, chat template and processor config.",
    size: "About 60 GB; budget 72 GB of VRAM to serve",
    download: `hf download ${GLIMMER_REPOS.bf16}`,
    downloadNote: "Into the Hugging Face cache, which the container mounts, so the server loads this copy; skip it and the server downloads the weights itself.",
    serve: "docker run --rm --gpus all --ipc=host \\\n  -p 8000:8000 \\\n  -v ~/.cache/huggingface:/root/.cache/huggingface \\\n  vllm/vllm-openai:muse-glimmer \\\n  meta-models/Muse-Glimmer-30B \\\n  --served-model-name muse-glimmer \\\n  --tensor-parallel-size 1 \\\n  --enable-auto-tool-choice \\\n  --tool-call-parser muse_glimmer \\\n  --reasoning-parser muse_glimmer \\\n  --generation-config auto",
    next: `${PAGE.glimmer.deploy}#vllm`,
  },
  sglang: {
    label: "SGLang",
    repo: GLIMMER_REPOS.bf16,
    holds: "bf16 is SGLang's only image-capable format; it also serves the GGUF, NVFP4 (RadixArk/Muse-Glimmer-NVFP4) and MLX repacks.",
    size: "About 60 GB for bf16",
    download: `hf download ${GLIMMER_REPOS.bf16}`,
    downloadNote: "Into the Hugging Face cache, where sglang serve finds the repository it names; skip it and the server downloads the weights itself.",
    serve: "sglang serve \\\n  --model-path meta-models/Muse-Glimmer-30B \\\n  --served-model-name muse-glimmer \\\n  --reasoning-parser muse \\\n  --tool-call-parser muse \\\n  --mem-fraction-static 0.85 \\\n  --host 0.0.0.0 --port 30000",
    next: `${PAGE.glimmer.deploy}#sglang`,
  },
  llamacpp: {
    label: "llama.cpp",
    repo: GLIMMER_REPOS.gguf,
    holds: "Quantized GGUF builds, plus the vision projector and the GGUF draft model.",
    size: `${GGUF_FILES.kquant17.downloadGb} GB (fits under 24 GB of VRAM) or ${GGUF_FILES.dynamic.downloadGb} GB (for 32 GB), plus 1.4 GB for images`,
    download: `hf download ${GLIMMER_REPOS.gguf} --local-dir ./muse-glimmer \\\n  --include "${GGUF_FILES.kquant17.file}" \\\n  --include "${GGUF_FILES.mmproj.file}"`,
    downloadLabel: "Download (optional)",
    downloadNote: "Only for an offline machine or an ExecuTorch export: llama serve -hf fetches the text model and the vision projector itself (Quantization, \"Download the checkpoints\").",
    serve: `llama serve -hf ${GLIMMER_REPOS.gguf} \\\n  --hf-file ${GGUF_FILES.kquant17.file} \\\n  --port 8080`,
    next: `${PAGE.glimmer.deploy}#llama-cpp`,
  },
  executorch: {
    label: "ExecuTorch",
    repo: GLIMMER_REPOS.pte,
    holds: "16 prebuilt .pte exports (by quantization, modality, decoding and backend), so you can skip exporting a 30B model; the GGUF repository feeds your own exports.",
    size: "18 to 31 GB per export; the whole repository is 372 GB, so download one",
    download: `EXPORT_DIR=muse-glimmer-k-quant-17G-128K-text-solo-sm80+ptx\n\nhf download ${GLIMMER_REPOS.pte} \\\n  --include "$EXPORT_DIR/*" \\\n  --include tokenizer.json --include tokenizer_config.json --include chat_template.jinja \\\n  --local-dir exports`,
    next: `${PAGE.glimmer.deploy}#executorch-prebuilt-export`,
  },
  spec: {
    label: "Speculative decoding",
    repo: GLIMMER_REPOS.assistant,
    holds: "The DFlash draft checkpoint, served as published with no conversion step (SGLang). llama.cpp and ExecuTorch use the GGUF draft instead.",
    size: "The GGUF draft is about 1.6 GB",
    download: `hf download ${GLIMMER_REPOS.assistant}`,
    downloadNote: "Into the Hugging Face cache, where SGLang's --speculative-draft-model-path finds the repository it names.",
    next: PAGE.glimmer.specDecode,
  },
  transformers: {
    label: "Transformers",
    repo: GLIMMER_REPOS.bf16,
    holds: "The bf16 checkpoint, loaded with AutoModelForCausalLM; transformers 5.15 or later has the native Muse Glimmer path.",
    size: "About 60 GB, spread over your GPUs by device_map=\"auto\"",
    download: 'pip install "transformers>=5.15" accelerate torch',
    next: `${PAGE.glimmer.deploy}#transformers`,
  },
  "local-apps": {
    label: "Ollama, LM Studio, Unsloth",
    repo: "Their own builds",
    holds: "Ollama library tags (muse-glimmer, muse-glimmer:30b-mlx), LM Studio's catalog, and Unsloth Dynamic GGUFs (unsloth/Muse-Glimmer-30B-GGUF).",
    size: "Pick the build for your memory in the app",
    download: "ollama run muse-glimmer",
    next: `${PAGE.glimmer.deploy}#ollama`,
  },
};

function GlimmerOverview() {
  const id = useId();
  const [runtime, setRuntime] = useState<GlimmerRuntime>("llamacpp");
  const c = GLIMMER_CHOICE[runtime];
  return (
    <div className="pg">
      <Facts
        label="Muse Glimmer at a glance"
        items={[
          { label: "Parameters", value: GLIMMER.params },
          { label: "Architecture", value: "Dense decoder-only multimodal transformer with a built-in vision encoder, trained from Muse Spark's outputs" },
          { label: "Input and output", value: GLIMMER.inputs },
          { label: "Context window", value: GLIMMER.contextNote },
          { label: "Reasoning", value: "Step by step before it answers; reasoning_strength low, medium, high (default) or xhigh" },
          { label: "Languages", value: GLIMMER.languages },
          {
            label: "License",
            value: (
              <a href={GLIMMER.licenseUrl} target="_blank" rel="noopener noreferrer">
                Apache License 2.0
              </a>
            ),
          },
          { label: "Runtimes", value: "vLLM, SGLang, llama.cpp, ExecuTorch, Transformers, Ollama, LM Studio, Unsloth" },
        ]}
      />
      <SegmentField<GlimmerRuntime>
        label="Which checkpoint? What will you serve it with?"
        value={runtime}
        options={(Object.keys(GLIMMER_CHOICE) as GlimmerRuntime[]).map((k) => ({ value: k, label: GLIMMER_CHOICE[k].label }))}
        onChange={setRuntime}
      />
      <Status tone="ok">
        {runtime === "local-apps" ? "These apps download their own builds." : <>Get <code>{c.repo}</code>.</>}
      </Status>
      <div className={styles.card} id={`${id}-choice`}>
        <div className={styles.cardHead}>
          <h4 className={styles.cardTitle}>{c.repo}</h4>
          <Badge tone="neutral" wrap>
            {c.size}
          </Badge>
        </div>
        <p className={styles.cardText}>{c.holds}</p>
        <CodeCard code={c.download} lang="bash" label={c.downloadLabel ?? (runtime === "transformers" ? "Install" : "Download")} />
        {c.downloadNote ? (
          <p className="pg-hint">
            <Rich text={c.downloadNote} />
          </p>
        ) : null}
        {c.serve ? <CodeCard code={c.serve} lang="bash" label="Serve" /> : null}
        <p className="pg-small">
          <a href={c.next}>Read the {c.label} section</a> · <a href={PAGE.glimmer.get}>Get the model</a> · <a href={PAGE.glimmer.quantization}>Quantization</a>
        </p>
      </div>
      <p className="pg-hint">Everything runs offline once the weights land: no API key and no gated access.</p>
    </div>
  );
}

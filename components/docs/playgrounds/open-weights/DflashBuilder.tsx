"use client";

import { useId, useMemo, useState } from "react";
import { defaultsOf, type CodeStep, type DeployPlan, type Values } from "@/components/docs/playgrounds/open-weights/deploy";
import { glimmerRuntime } from "@/components/docs/playgrounds/open-weights/deploy-glimmer";
import { GGUF_FILES, GLIMMER_REPOS } from "@/components/docs/playgrounds/open-weights/facts";
import { Issues, NumberField, PresetRows, SegmentField, SelectField, Status, Steps } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * Muse Glimmer's speculative decoding page as a DFlash config builder (muse-glimmer/spec-decode): pick the runtime,
 * the target and the draft, and the knobs each runtime exposes (llama.cpp's --spec-draft-n-max, SGLang's block size
 * and draft quantization flags, ExecuTorch's export_dflash and its block-length range), and get the commands from
 * Run inference with DFlash turned on, plus the page's warnings for combinations that run without speeding up.
 */

export interface DflashBuilderProps {
  slug: string;
}

type Runtime = "llamacpp" | "sglang" | "executorch";

interface Preset {
  label: string;
  runtime: Runtime;
  values: Values;
}

const PRESETS: Preset[] = [
  { label: "llama.cpp, GGUF draft", runtime: "llamacpp", values: { file: "kquant17", draftMax: 4 } },
  { label: "SGLang, bf16 + assistant", runtime: "sglang", values: { format: "bf16", draft: "assistant", block: 5, hardware: "datacenter" } },
  { label: "SGLang, GGUF target", runtime: "sglang", values: { format: "gguf", draft: "assistant", block: 5, hardware: "rtx5090" } },
  { label: "SGLang, NVFP4 on DGX Spark", runtime: "sglang", values: { format: "nvfp4", draft: "assistant", block: 5, hardware: "dgx" } },
  { label: "SGLang, GGUF draft on B300", runtime: "sglang", values: { format: "bf16", draft: "gguf", block: 5, hardware: "datacenter" } },
  { label: "ExecuTorch, CUDA export", runtime: "executorch", values: { source: "export", backend: "cuda", modality: "text" } },
  { label: "ExecuTorch, prebuilt for Mac", runtime: "executorch", values: { source: "prebuilt", backend: "mlx", modality: "text", quant: "k-quant-17G" } },
];

const DRAFTS = [
  { draft: "meta-models/Muse-Glimmer-30B-assistant", where: "Its own repository; serves as published, no conversion", use: "SGLang's documented bf16, GGUF and NVFP4 paths" },
  { draft: "dflash-Muse-Glimmer-30B-Q4_K_M.gguf", where: "In meta-models/Muse-Glimmer-30B-GGUF, about 1.6 GB", use: "llama.cpp, ExecuTorch exports, and SGLang's GGUF-draft path" },
];

function dflashPlan(runtime: Runtime, v: Values): { plan: DeployPlan; steps: CodeStep[] } {
  const r = glimmerRuntime(runtime);
  const values: Values =
    runtime === "llamacpp" ? { ...defaultsOf(r.options), ...v, dflash: true } : runtime === "sglang" ? { ...defaultsOf(r.options), ...v, dflash: true } : { ...defaultsOf(r.options), ...v, decoding: "dflash" };
  const plan = r.build(values);
  // llama.cpp and SGLang: the draft download and the serve command; ExecuTorch: the whole export-and-serve path.
  const keep = (s: CodeStep) => (runtime === "llamacpp" ? /DFlash draft|Start the server/.test(s.title) : runtime === "sglang" ? /Start the server/.test(s.title) : true);
  return { plan, steps: plan.steps.filter(keep) };
}

export function DflashBuilder(_props: DflashBuilderProps) {
  const id = useId();
  const [runtime, setRuntime] = useState<Runtime>("llamacpp");
  const [values, setValues] = useState<Record<Runtime, Values>>({
    llamacpp: { file: "kquant17", draftMax: 4 },
    sglang: { format: "bf16", draft: "assistant", block: 5, hardware: "datacenter" },
    executorch: { source: "prebuilt", backend: "cuda", modality: "text", quant: "k-quant-17G" },
  });
  const [preset, setPreset] = useState<number | null>(0);
  const v = values[runtime];
  const set = (key: string, value: string | number) => {
    setPreset(null);
    setValues((all) => ({ ...all, [runtime]: { ...all[runtime], [key]: value } }));
  };

  const mlx = runtime === "sglang" && v.format === "mlx";
  const { plan, steps } = useMemo(() => dflashPlan(runtime, v), [runtime, v]);
  const errors = [...plan.errors];
  const warnings = [...plan.warnings];
  const notes: string[] = [];
  if (mlx) errors.push("Not available on SGLang's MLX backend: it has no speculative decoding.");
  if (runtime === "llamacpp") {
    notes.push("Add -md with the GGUF draft, --spec-type draft-dflash and its draft flags to the serve command.");
    notes.push("The drafter adds roughly 1.5 GiB of VRAM: K-Quant-17GB with images and the drafter fits a 24 GiB card.");
  }
  if (runtime === "sglang") {
    notes.push("--speculative-algorithm DFLASH with a draft model path and block size. The draft needs its own memory headroom: on DGX Spark the fraction drops to 0.65 (bf16) or 0.38 (NVFP4).");
    if (v.format === "gguf") notes.push("A GGUF target needs --speculative-draft-load-format auto, or the draft inherits the gguf load format and the loader rejects the draft directory.");
    if (v.format === "nvfp4" && v.draft === "assistant") notes.push("An NVFP4 target adds --speculative-draft-model-quantization fp8.");
  }
  if (runtime === "executorch") {
    notes.push("Target and draft are exported together with export_dflash into one .pte: the draft shares the target's token embeddings and output head instead of carrying copies.");
  }
  plan.notes.forEach((x) => {
    if (!notes.includes(x) && /DFlash|draft|block|accept/i.test(x)) notes.push(x);
  });
  const filteredSteps = mlx ? [] : steps;

  return (
    <div className="pg">
      <PresetRows
        presets={PRESETS}
        keep={4}
        active={preset}
        onPick={(i) => {
          const p = PRESETS[i];
          setPreset(i);
          setRuntime(p.runtime);
          setValues((all) => ({ ...all, [p.runtime]: { ...all[p.runtime], ...p.values } }));
        }}
      />
      <div className={`${styles.tableWrap} pg-advanced`}>
        <table className={styles.table}>
          <caption className="sr-only">The two DFlash drafts</caption>
          <thead>
            <tr>
              <th scope="col">Draft</th>
              <th scope="col">Where it lives</th>
              <th scope="col">Use it with</th>
            </tr>
          </thead>
          <tbody>
            {DRAFTS.map((d) => {
              const active = runtime === "sglang" ? (v.draft === "gguf" ? d.draft.endsWith(".gguf") : d.draft.endsWith("assistant")) : d.draft.endsWith(".gguf");
              return (
                <tr key={d.draft} className={active ? styles.rowPicked : undefined}>
                  <td className={styles.mono}>{d.draft}</td>
                  <td>{d.where}</td>
                  <td>{d.use}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SegmentField<Runtime>
        label="Runtime"
        value={runtime}
        options={[
          { value: "llamacpp", label: "llama.cpp" },
          { value: "sglang", label: "SGLang" },
          { value: "executorch", label: "ExecuTorch" },
        ]}
        onChange={(x) => {
          setPreset(null);
          setRuntime(x);
        }}
      />
      {runtime === "llamacpp" ? (
        <div className={styles.options}>
          <SegmentField<string> label="Target" value={String(v.file)} options={[{ value: "kquant17", label: "K-Quant-17GB" }, { value: "dynamic", label: "Dynamic Q4_K_XL" }]} onChange={(x) => set("file", x)} />
          <NumberField advanced id={`${id}-nmax`} label="--spec-draft-n-max" value={String(v.draftMax ?? 4)} min={1} max={16} step={1} onChange={(x) => set("draftMax", x)} hint="The page's value is 4." />
        </div>
      ) : null}
      {runtime === "sglang" ? (
        <div className={styles.options}>
          <SegmentField<string>
            label="Target"
            value={String(v.format)}
            options={[
              { value: "bf16", label: "bf16" },
              { value: "gguf", label: "GGUF Q4_K_M" },
              { value: "nvfp4", label: "NVFP4" },
              { value: "mlx", label: "MLX" },
            ]}
            onChange={(x) => set("format", x)}
          />
          <SegmentField<string> label="Draft" value={String(v.draft)} options={[{ value: "assistant", label: "assistant checkpoint" }, { value: "gguf", label: "GGUF draft" }]} onChange={(x) => set("draft", x)} />
          <NumberField advanced id={`${id}-block`} label="--speculative-dflash-block-size" value={String(v.block ?? 5)} min={2} max={16} step={1} onChange={(x) => set("block", x)} hint="The page's value is 5." />
          <SelectField
            advanced
            id={`${id}-hw`}
            label="Hardware"
            value={String(v.hardware)}
            options={[
              { value: "datacenter", label: "B300, B200, H200 or RTX PRO 6000" },
              { value: "rtx5090", label: "RTX 5090" },
              { value: "dgx", label: "DGX Spark" },
              { value: "apple", label: "Apple silicon" },
            ]}
            onChange={(x) => set("hardware", x)}
          />
        </div>
      ) : null}
      {runtime === "executorch" ? (
        <div className={styles.options}>
          <SegmentField<string> label="Program" value={String(v.source)} options={[{ value: "prebuilt", label: "Prebuilt dflash export" }, { value: "export", label: "Export it yourself" }]} onChange={(x) => set("source", x)} />
          <SegmentField<string> label="Backend" value={String(v.backend)} options={[{ value: "cuda", label: "CUDA" }, { value: "mlx", label: "Apple silicon" }]} onChange={(x) => set("backend", x)} />
          <SegmentField<string> advanced label="Modality" value={String(v.modality)} options={[{ value: "text", label: "Text" }, { value: "text-image", label: "Text and image" }]} onChange={(x) => set("modality", x)} />
          {v.source !== "export" ? <SegmentField<string> advanced label="Quantization" value={String(v.quant)} options={[{ value: "k-quant-17G", label: "k-quant-17G" }, { value: "k-quant-dynamic", label: "k-quant-dynamic" }]} onChange={(x) => set("quant", x)} /> : null}
          <p className="pg-hint" style={{ gridColumn: "1 / -1" }}>
            Block length is chosen at serve time within the exported range: {v.backend === "mlx" ? "[2, 16] on MLX." : "[2, 4] on CUDA, with the draft count capped at 3."}
          </p>
        </div>
      ) : null}
      <Status tone={errors.length ? "bad" : warnings.length ? "warn" : "ok"}>
        {errors.length ? "This combination has no DFlash path." : runtime === "llamacpp" ? `llama.cpp with ${GGUF_FILES.dflash.file} as the draft.` : runtime === "sglang" ? `SGLang DFLASH with ${v.draft === "gguf" ? GGUF_FILES.dflash.file : GLIMMER_REPOS.assistant}, block size ${v.block}.` : "ExecuTorch with the draft lowered into the same program."}
      </Status>
      <Issues errors={errors} warnings={warnings} notes={notes} />
      <Steps steps={filteredSteps} label="DFlash commands" />
    </div>
  );
}

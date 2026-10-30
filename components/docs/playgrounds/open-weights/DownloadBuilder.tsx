"use client";

import { useId, useMemo, useState } from "react";
import { Field, PresetPills, TextInput, Toggle } from "@/components/docs/kit/Field";
import { SPARK_CHECKPOINTS, gb, pteExport, type OpenModel, type PteBackend, type PteDecoding, type PteModality, type PteQuant, type SparkCheckpoint } from "@/components/docs/playgrounds/open-weights/facts";
import { GLIMMER_ITEMS, glimmerDownload, sparkDownload, type GlimmerItem, type VerifyMode } from "@/components/docs/playgrounds/open-weights/download";
import { Facts, Issues, PresetRows, SegmentField, Status, Steps } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * The Get the model pages as a command builder (muse-spark-open/get-the-model, muse-glimmer/get-the-model): pick a
 * checkpoint or the builds you need, a source and a folder, and get the download commands, a disk check, a way to
 * verify what landed, and the page's tokenizer check, in order.
 */

export interface DownloadBuilderProps {
  slug: string;
  model: OpenModel;
}

export function DownloadBuilder({ model }: DownloadBuilderProps) {
  return model === "spark" ? <SparkDownload /> : <GlimmerDownload />;
}

function SparkDownload() {
  const id = useId();
  const [checkpoint, setCheckpoint] = useState<SparkCheckpoint>("nvfp4");
  const [source, setSource] = useState<"hf" | "meta">("hf");
  const [folder, setFolder] = useState(SPARK_CHECKPOINTS.nvfp4.localDir);
  const [verify, setVerify] = useState<VerifyMode>("count");
  const c = SPARK_CHECKPOINTS[checkpoint];
  const plan = useMemo(() => sparkDownload({ checkpoint, source, folder, verify }), [checkpoint, source, folder, verify]);
  const presets = [
    { label: "NVFP4 from Hugging Face", checkpoint: "nvfp4" as const, source: "hf" as const, verify: "count" as const },
    { label: "BF16 from Hugging Face", checkpoint: "bf16" as const, source: "hf" as const, verify: "count" as const },
    { label: "From Meta, then SHA-256", checkpoint: "nvfp4" as const, source: "meta" as const, verify: "sha256" as const },
  ];
  const [preset, setPreset] = useState<number | null>(0);

  const switchCheckpoint = (next: SparkCheckpoint) => {
    setCheckpoint(next);
    // Keep a folder the reader typed; swap the default for the other checkpoint's.
    if (folder === SPARK_CHECKPOINTS[checkpoint].localDir) setFolder(SPARK_CHECKPOINTS[next].localDir);
  };

  return (
    <div className="pg">
      <PresetPills
        presets={presets}
        active={preset}
        onPick={(i) => {
          const p = presets[i];
          setPreset(i);
          switchCheckpoint(p.checkpoint);
          setFolder(SPARK_CHECKPOINTS[p.checkpoint].localDir);
          setSource(p.source);
          setVerify(p.verify);
        }}
      />
      <div className={styles.options}>
        <SegmentField<SparkCheckpoint>
          label="Checkpoint"
          value={checkpoint}
          options={[
            { value: "nvfp4", label: "NVFP4 · 537 GB" },
            { value: "bf16", label: "BF16 · 1.65 TB" },
          ]}
          onChange={(x) => {
            setPreset(null);
            switchCheckpoint(x);
          }}
        />
        <SegmentField<"hf" | "meta">
          label="Source"
          value={source}
          options={[
            { value: "hf", label: "Hugging Face CLI" },
            { value: "meta", label: "Meta download page" },
          ]}
          onChange={(x) => {
            setPreset(null);
            setSource(x);
          }}
        />
        <SegmentField<VerifyMode>
          advanced
          label="Verify"
          value={verify}
          options={[
            { value: "count", label: "Quick file check" },
            { value: "sha256", label: "SHA-256 of every file" },
          ]}
          onChange={(x) => {
            setPreset(null);
            setVerify(x);
          }}
        />
        <Field id={`${id}-folder`} label="Folder" hint="Pass this path wherever a command uses the repository ID." className="pg-advanced">
          <TextInput id={`${id}-folder`} value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} aria-describedby={`${id}-folder-hint`} />
        </Field>
      </div>
      <Facts
        advanced
        label={`${c.label} checkpoint`}
        items={[
          { label: "Repository", value: <code>{c.repo}</code> },
          { label: "Weight footprint", value: c.footprint },
          { label: "Weight shards", value: String(c.shards) },
          { label: "Serving recipe", value: c.recipe },
        ]}
      />
      <Status tone="ok">{plan.summary}</Status>
      <Issues warnings={plan.warnings} notes={plan.notes} />
      <Steps steps={plan.steps} label="Download steps" />
    </div>
  );
}

function GlimmerDownload() {
  const id = useId();
  const [items, setItems] = useState<GlimmerItem[]>(["kquant17", "mmproj"]);
  const [quant, setQuant] = useState<PteQuant>("k-quant-17G");
  const [modality, setModality] = useState<PteModality>("text");
  const [decoding, setDecoding] = useState<PteDecoding>("solo");
  const [backend, setBackend] = useState<PteBackend>("sm80+ptx");
  const [verify, setVerify] = useState(false);
  const [preset, setPreset] = useState<number | null>(0);
  const plan = useMemo(() => glimmerDownload({ items, pte: { quant, modality, decoding, backend }, verify }), [items, quant, modality, decoding, backend, verify]);
  const pte = pteExport(quant, modality, decoding, backend);
  const presets: Array<{ label: string; items: GlimmerItem[] }> = [
    { label: "llama.cpp with images", items: ["kquant17", "mmproj"] },
    { label: "llama.cpp, 32 GB, with DFlash", items: ["dynamic", "mmproj", "dflash"] },
    { label: "vLLM or SGLang (bf16)", items: ["bf16"] },
    { label: "SGLang with DFlash", items: ["bf16", "assistant"] },
    { label: "ExecuTorch, prebuilt", items: ["pte"] },
  ];

  const toggle = (item: GlimmerItem, on: boolean) => {
    setPreset(null);
    setItems((cur) => (on ? [...cur.filter((x) => x !== item), item] : cur.filter((x) => x !== item)).sort((a, b) => GLIMMER_ITEMS.findIndex((x) => x.id === a) - GLIMMER_ITEMS.findIndex((x) => x.id === b)));
  };

  return (
    <div className="pg">
      <PresetRows
        presets={presets}
        keep={4}
        active={preset}
        onPick={(i) => {
          setPreset(i);
          setItems(presets[i].items);
        }}
      />
      <fieldset className={`${styles.card} pg-advanced`} style={{ margin: 0 }}>
        <legend className="pg-label" style={{ padding: "0 4px" }}>
          What to download
        </legend>
        <div className={styles.grid2}>
          {GLIMMER_ITEMS.map((it) => (
            <div key={it.id} className="pg-field">
              <Toggle id={`${id}-${it.id}`} label={`${it.label}${it.sizeGb ? ` · ${gb(it.sizeGb)} GB` : ""}`} checked={items.includes(it.id)} onChange={(on) => toggle(it.id, on)} />
              <p className="pg-hint">{it.detail}</p>
            </div>
          ))}
        </div>
      </fieldset>
      {items.includes("pte") ? (
        <div className={`${styles.options} pg-advanced`}>
          <SegmentField<PteQuant> label="Quantization" value={quant} options={[{ value: "k-quant-17G", label: "k-quant-17G" }, { value: "k-quant-dynamic", label: "k-quant-dynamic" }]} onChange={setQuant} hint="17G targets 24 GB of VRAM; dynamic targets 32 GB." />
          <SegmentField<PteModality> label="Modality" value={modality} options={[{ value: "text", label: "text" }, { value: "text-image", label: "text-image" }]} onChange={setModality} />
          <SegmentField<PteDecoding> label="Decoding" value={decoding} options={[{ value: "solo", label: "solo" }, { value: "dflash", label: "dflash" }]} onChange={setDecoding} />
          <SegmentField<PteBackend> label="Backend" value={backend} options={[{ value: "sm80+ptx", label: "CUDA (sm80+ptx)" }, { value: "metal", label: "Apple (metal)" }]} onChange={setBackend} />
          <p className="pg-hint" style={{ gridColumn: "1 / -1" }}>
            <code>{pte.dir}</code>: {pte.sizeGb} GB
          </p>
        </div>
      ) : null}
      <div className="pg-advanced">
        <Toggle id={`${id}-verify`} label="Add SHA-256 checks against the Hub" checked={verify} onChange={setVerify} />
      </div>
      <Status tone={plan.warnings.length ? "warn" : "ok"}>{plan.summary}</Status>
      <Issues warnings={plan.warnings} notes={plan.notes} />
      <Steps steps={plan.steps} label="Download steps" />
    </div>
  );
}

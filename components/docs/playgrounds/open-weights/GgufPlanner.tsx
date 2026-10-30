"use client";

import { useId, useMemo, useState } from "react";
import { Field, PresetPills, TextInput, Toggle } from "@/components/docs/kit/Field";
import { GGUF_FILES, GLIMMER, gb, n, type GgufFileId } from "@/components/docs/playgrounds/open-weights/facts";
import { RECIPES, ggufBudget, ggufDownload, ggufDraftDownload, ggufServe, pickGguf, quantizeYourself } from "@/components/docs/playgrounds/open-weights/gguf";
import { CodeCard, Issues, NumberField, Rich, SegmentField, SelectField, Status } from "@/components/docs/playgrounds/open-weights/ui";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * Muse Glimmer's quantization page as a GGUF picker (muse-glimmer/quantization): give the memory you have and what you
 * need (images, the DFlash drafter, the context and slots), and it picks K-Quant-17GB or the dynamic K-quant with the
 * page's memory budget (15.6 + 1.3 + 2.1 = 19.0 GiB at 131,072 tokens, plus about 1.5 GiB for the drafter), writes the
 * llama serve command, and falls back to the page's convert, quantize and perplexity commands when nothing fits.
 */

export interface GgufPlannerProps {
  slug: string;
}

const CTX = [8192, 16384, 32768, 65536, 131072, 262144, 524288];
const COLORS = ["var(--chart-1, var(--accent))", "var(--chart-2, var(--ok))", "var(--chart-3, var(--warn))", "var(--chart-4, var(--bad))"];

interface Preset {
  label: string;
  mem: number;
  vision: boolean;
  dflash: boolean;
  ctx: number;
  np: number;
}

const PRESETS: Preset[] = [
  { label: "24 GB card, images", mem: 24, vision: true, dflash: false, ctx: 131072, np: 1 },
  { label: "24 GB card with DFlash", mem: 24, vision: true, dflash: true, ctx: 131072, np: 1 },
  { label: "32 GB card", mem: 32, vision: true, dflash: true, ctx: 131072, np: 1 },
  { label: "16 GB card, text only", mem: 16, vision: false, dflash: false, ctx: 131072, np: 1 },
  { label: "48 GB, 4 slots of 131K", mem: 48, vision: true, dflash: false, ctx: 524288, np: 4 },
];

export function GgufPlanner(_props: GgufPlannerProps) {
  const id = useId();
  const [mem, setMem] = useState("24");
  const [prefer, setPrefer] = useState<"auto" | "kquant17" | "dynamic">("auto");
  const [vision, setVision] = useState(true);
  const [dflash, setDflash] = useState(false);
  const [ctx, setCtx] = useState(131072);
  const [np, setNp] = useState("1");
  const [port, setPort] = useState("8080");
  const [qtype, setQtype] = useState("Q4_K_M");
  const [preset, setPreset] = useState<number | null>(0);

  const memGib = Math.max(0, Number(mem) || 0);
  const slots = Math.max(1, Math.round(Number(np) || 1));
  const pick = useMemo(() => pickGguf(memGib, { vision, dflash, ctx }, prefer), [memGib, vision, dflash, ctx, prefer]);
  const file = pick.file ?? (prefer === "dynamic" ? "dynamic" : "kquant17");
  const budget = pick.file ? pick.budget : ggufBudget({ file, vision, dflash, ctx });
  const total = budget.totalGib;
  const scale = Math.max(memGib, total);
  // The draft has its own required step below (into the working directory, where -md finds it), so the optional
  // download of what llama serve -hf would fetch lists only the text model and the projector.
  const files: GgufFileId[] = [file, ...(vision ? (["mmproj"] as const) : [])];
  const serve = ggufServe({ file, vision, dflash, ctx, np: slots, port: Math.round(Number(port) || 8080) });
  const perSlot = Math.floor(ctx / slots);

  const notes: string[] = [];
  const warnings: string[] = [];
  notes.push(`llama.cpp ${GLIMMER.llamaCpp} or newer: older builds don't register the muse-glimmer architecture and refuse these files.`);
  notes.push("Name the checkpoint with --hf-file: three of the four GGUFs carry the Q4_K_M tag, so a bare -hf won't reliably pick the text model.");
  if (slots > 1) notes.push(`-np ${slots} divides the context: ${n(ctx)} / ${slots} = ${n(perSlot)} tokens per slot.`);
  if (!vision) notes.push("--no-mmproj skips the vision projector, which otherwise downloads with the checkpoint.");
  if (ctx !== 131072) notes.push("The server allocates the full trained context by default; -c asks for a different size. The KV row is scaled from the page's measurement at 131,072 tokens.");
  if (perSlot < 32768) warnings.push("Muse Glimmer's reasoning can approach a 32,768-token slot on its own; a smaller slot cuts long answers short.");
  if (prefer === "dynamic" && memGib < 32) warnings.push("The page pitches the dynamic K-quant at 32 GB of VRAM.");

  const tone = pick.verdict === "fits" ? "ok" : pick.verdict === "tight" ? "warn" : "bad";

  return (
    <div className="pg">
      <PresetPills
        presets={PRESETS}
        active={preset}
        onPick={(i) => {
          const p = PRESETS[i];
          setPreset(i);
          setMem(String(p.mem));
          setVision(p.vision);
          setDflash(p.dflash);
          setCtx(p.ctx);
          setNp(String(p.np));
          setPrefer("auto");
        }}
      />
      <div className={styles.options}>
        <NumberField id={`${id}-mem`} label="VRAM, or RAM for CPU or Mac (GB)" value={mem} min={1} step={1} onChange={(x) => { setPreset(null); setMem(x); }} hint="Cards are sold in GiB-sized GB." />
        <SegmentField<"auto" | "kquant17" | "dynamic">
          label="Text model"
          value={prefer}
          options={[
            { value: "auto", label: "Pick for me" },
            { value: "kquant17", label: "K-Quant-17GB" },
            { value: "dynamic", label: "Dynamic Q4_K_XL" },
          ]}
          onChange={(x) => {
            setPreset(null);
            setPrefer(x);
          }}
        />
        <SelectField id={`${id}-ctx`} label="Total context (-c)" value={String(ctx)} options={CTX.map((x) => ({ value: String(x), label: `${n(x)} tokens${x === 131072 ? " (default)" : ""}` }))} onChange={(x) => { setPreset(null); setCtx(Number(x)); }} />
        <NumberField id={`${id}-np`} label="Slots (-np)" value={np} min={1} max={16} step={1} onChange={(x) => { setPreset(null); setNp(x); }} />
        <div className="pg-field">
          <Toggle id={`${id}-vision`} label="Image input (vision projector)" checked={vision} onChange={(x) => { setPreset(null); setVision(x); }} />
          <Toggle id={`${id}-dflash`} label="DFlash drafter" checked={dflash} onChange={(x) => { setPreset(null); setDflash(x); }} />
        </div>
        <NumberField id={`${id}-port`} label="Port" value={port} min={1} max={65535} step={1} onChange={setPort} />
      </div>
      <Status tone={tone}>{pick.summary}</Status>
      <div className={styles.stack} style={{ gap: 8 }}>
        <div className={styles.stackBar} role="img" aria-label={`Memory budget: ${gb(total)} GiB of ${gb(memGib)} GiB`}>
          {budget.rows.map((r, i) => (
            <span key={r.label} className={styles.stackPart} style={{ width: `${(r.gib / scale) * 100}%`, background: COLORS[i % COLORS.length] }} />
          ))}
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Memory budget</caption>
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col" className={styles.num}>
                  VRAM
                </th>
                <th scope="col">Basis</th>
              </tr>
            </thead>
            <tbody>
              {budget.rows.map((r, i) => (
                <tr key={r.label}>
                  <td>
                    <span className={styles.swatch} style={{ background: COLORS[i % COLORS.length], marginRight: 8 }} aria-hidden />
                    {r.label}
                  </td>
                  <td className={styles.num}>{gb(r.gib)} GiB</td>
                  <td className="pg-small pg-muted">{r.basis === "measured" ? "Measured on the page" : `Estimate${r.note ? `: ${r.note}` : ""}`}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>Total</strong>
                </td>
                <td className={styles.num}>
                  <strong>{gb(total)} GiB</strong>
                </td>
                <td className="pg-small pg-muted">of {gb(memGib)} GiB</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="pg-hint">
          The KV cache stays small: grouped-query attention with 2 KV heads, and sliding windows on three of every four layers, so only a quarter of the layers hold a full-length cache.
        </p>
      </div>
      <Issues warnings={warnings} notes={notes} />
      <p className="pg-small">
        <strong>{file === "kquant17" ? "K-Quant-17GB" : "Dynamic Q4_K_XL"}:</strong> {RECIPES[file]} ({GGUF_FILES[file].downloadGb} GB download)
      </p>
      {dflash ? (
        <>
          <CodeCard code={`pip install -U huggingface_hub\n\n${ggufDraftDownload()}`} lang="bash" label="First, download the DFlash draft" />
          <p className="pg-hint">
            <Rich text={`llama serve -hf fetches the text model and the projector, but not the draft: -md reads ${GGUF_FILES.dflash.file} from disk, so run both commands in the same folder.`} />
          </p>
        </>
      ) : null}
      <CodeCard code={serve} lang="bash" label={dflash ? "Then run the checkpoint" : "Run the checkpoint"} />
      <details className="pg-raw">
        <summary>Download the files instead (for an offline machine or an ExecuTorch export)</summary>
        <CodeCard code={`pip install -U huggingface_hub\n\n${ggufDownload(files)}`} lang="bash" label="Download" />
      </details>
      {pick.verdict === "no" || !pick.file ? (
        <div className={styles.stack} style={{ gap: 8 }}>
          <p className="pg-section-label" style={{ margin: 0 }}>
            Quantize it yourself
          </p>
          <Field id={`${id}-qtype`} label="llama-quantize type" hint="The page converts to bf16 GGUF and quantizes to Q4_K_M; pick a smaller type to fit less memory, then compare perplexity.">
            <TextInput id={`${id}-qtype`} value={qtype} onChange={(e) => setQtype(e.target.value)} spellCheck={false} aria-describedby={`${id}-qtype-hint`} />
          </Field>
          <CodeCard code={quantizeYourself(qtype)} lang="bash" label="Convert, quantize, evaluate" />
          <p className="pg-hint">Full-precision weights aren&apos;t published as GGUF: convert from the bf16 safetensors checkpoint, and validate any custom checkpoint on your own workload.</p>
        </div>
      ) : null}
    </div>
  );
}

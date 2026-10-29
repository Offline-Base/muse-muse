"use client";

import { useId, type ReactNode } from "react";
import {
  APPLE_CHIPS,
  DEVICE_KINDS,
  GPU_MODELS,
  GPU_VENDORS,
  MAC_MEMORY_SIZES,
  PC_MEMORY_SIZES,
  VRAM_SIZES,
  gpuModel,
  gpuVramSizes,
  isPc,
  memoryChoices,
  type Detected,
  type DeviceKind,
  type GpuVendor,
} from "@/lib/vibe/device";
import {
  sentenceParts,
  withChip,
  withGpuModel,
  withGpuVendor,
  withKind,
  withMemory,
  withVram,
  type PickerState,
  type Source,
} from "@/components/vibe/picker";

export interface DevicePickerProps {
  state: PickerState;
  /** What the browser told, once it has (after the page mounts), or null before. */
  detected: Detected | null;
  onChange: (next: PickerState) => void;
}

function Tag({ from }: { from: Source | "ask" | null }) {
  if (from === "browser") return <span className="vibe-tag">from your browser</span>;
  if (from === "you") return <span className="vibe-tag vibe-tag-you">you told us</span>;
  return null;
}

function Label({ htmlFor, text }: { htmlFor: string; text: string }) {
  return (
    <label className="train-label" htmlFor={htmlFor}>
      {text}
    </label>
  );
}

/**
 * Sizes as buttons to confirm, plus "Another amount" for any size the list leaves out. Nothing is picked until the
 * person picks it: memory always needs a yes from them.
 */
function SizeChoice({
  id,
  legend,
  choices,
  all,
  value,
  onPick,
  help,
}: {
  id: string;
  legend: string;
  choices: number[];
  all: readonly number[];
  value: number | null;
  onPick: (gb: number) => void;
  help: ReactNode;
}) {
  const listed = value !== null && choices.includes(value);
  return (
    <fieldset className="vibe-field vibe-field-wide" aria-describedby={`${id}-help`}>
      {/* The legend is the fieldset's first child, so it names the group: "Memory, group", then "36 GB, radio". */}
      <legend className="train-label vibe-legend-row">
        {legend}
        {value === null ? <span className="vibe-tag vibe-tag-ask">confirm this</span> : null}
      </legend>
      <div className="vibe-choices">
        {choices.map((gb) => (
          <label key={gb} className="vibe-choice">
            <input type="radio" name={id} value={gb} checked={value === gb} onChange={() => onPick(gb)} />
            <span>{gb} GB</span>
          </label>
        ))}
        <select
          className="select vibe-other-size"
          aria-label={`${legend}: another amount`}
          value={value !== null && !listed ? String(value) : ""}
          onChange={(e) => e.target.value && onPick(Number(e.target.value))}
        >
          <option value="">Another amount</option>
          {all.map((gb) => (
            <option key={gb} value={gb}>
              {gb} GB
            </option>
          ))}
        </select>
      </div>
      <p className="train-help" id={`${id}-help`}>
        {help}
      </p>
    </fieldset>
  );
}

function memoryHelp(kind: DeviceKind | null): ReactNode {
  if (kind === "windows") return "Settings > System > About lists it as Installed RAM.";
  if (kind === "linux") return "free -h in a terminal lists it as Mem total.";
  return "Apple menu > About This Mac lists it next to Memory.";
}

/**
 * Your computer (docs/VIBE_TUNING.md, Feature 2, "The flow"): one sentence the browser pre-fills, such as "Mac with
 * Apple silicon · Apple M4 Max · 36 GB", each part tagged "from your browser" or "you told us", and a field for every
 * part, so any of it can be changed. Memory is always confirmed by the person, and so is a PC card's memory.
 */
export function DevicePicker({ state, detected, onChange }: DevicePickerProps) {
  const id = useId();
  const parts = sentenceParts(state, detected);
  const fieldId = (field: string) => `${id}-${field}`;
  const pc = isPc(state.kind);
  // An Intel Mac confirms its memory too: Ollama runs the model there only on the processor, from that memory.
  const memory = state.kind === "mac" || state.kind === "mac-intel" || pc;
  const vendor = state.gpuVendor && state.gpuVendor !== "none" ? state.gpuVendor : null;
  const model = gpuModel(state.gpuModel);
  const modelSizes = gpuVramSizes(model);
  const vramChoices = modelSizes.length ? modelSizes : [8, 12, 16, 24, 32];

  return (
    <section className="card section-card vibe-picker" aria-labelledby={`${id}-title`}>
      <div className="vibe-card-head">
        <h2 id={`${id}-title`}>Your computer</h2>
        <p className="muted small">Read in this browser. None of it is sent anywhere.</p>
      </div>

      <p className="vibe-sentence" aria-live="polite">
        {parts.map((p, i) => (
          <span key={p.field}>
            {i > 0 ? (
              <span className="vibe-sep" aria-hidden>
                ·
              </span>
            ) : null}
            <span className={`vibe-part vibe-part-${p.from}`}>{p.text}</span>
            <Tag from={p.from} />
          </span>
        ))}
      </p>
      {detected?.macUnsure && !state.kind ? (
        <p className="train-help">
          This browser doesn&apos;t say which chip the Mac has. Apple menu &gt; About This Mac shows Chip for Apple
          silicon, or Processor for an Intel Mac.
        </p>
      ) : null}
      {detected?.rosetta && state.kind === "mac" ? (
        <p className="vibe-callout">This browser runs under Rosetta. Install each app&apos;s Apple silicon version, not the Intel one.</p>
      ) : null}

      <div className="vibe-fields">
        <div className="train-field">
          <Label htmlFor={fieldId("kind")} text="Computer" />
          <select
            id={fieldId("kind")}
            className="train-select"
            value={state.kind ?? ""}
            onChange={(e) => onChange(withKind((e.target.value || null) as DeviceKind | null))}
          >
            <option value="" disabled>
              Pick one
            </option>
            {DEVICE_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </div>

        {state.kind === "mac" ? (
          <div className="train-field">
            <Label htmlFor={fieldId("chip")} text="Chip" />
            <select
              id={fieldId("chip")}
              className="train-select"
              value={state.chip ?? ""}
              onChange={(e) => onChange(withChip(state, e.target.value || null))}
            >
              <option value="">Not sure</option>
              {APPLE_CHIPS.map((c) => (
                <option key={c.name} value={c.name}>
                  Apple {c.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {memory ? (
          <SizeChoice
            id={fieldId("memory")}
            legend={pc ? "Memory (RAM)" : "Memory"}
            choices={memoryChoices(state.kind, state.chip, detected?.memory ?? null)}
            all={pc ? PC_MEMORY_SIZES : MAC_MEMORY_SIZES}
            value={state.memoryGb}
            onPick={(gb) => onChange(withMemory(state, gb))}
            help={memoryHelp(state.kind)}
          />
        ) : null}

        {pc ? (
          <div className="train-field">
            <Label htmlFor={fieldId("gpu")} text="Graphics card" />
            <select
              id={fieldId("gpu")}
              className="train-select"
              value={state.gpuVendor ?? ""}
              onChange={(e) => onChange(withGpuVendor(state, (e.target.value || null) as GpuVendor | "none" | null))}
            >
              <option value="" disabled>
                Pick one
              </option>
              <option value="none">None, or built-in graphics only</option>
              {GPU_VENDORS.map((v) => (
                <option key={v.vendor} value={v.vendor}>
                  {v.label}
                </option>
              ))}
            </select>
            {detected?.gpu?.integrated && state.gpuVendor === "none" ? (
              <p className="train-help">
                This browser draws with {detected.gpu.name}. A laptop can have a separate card too: Task Manager &gt;
                Performance lists every GPU.
              </p>
            ) : null}
          </div>
        ) : null}

        {pc && vendor ? (
          <div className="train-field">
            <Label htmlFor={fieldId("model")} text="Model" />
            <select
              id={fieldId("model")}
              className="train-select"
              value={state.gpuModel ?? ""}
              onChange={(e) => onChange(withGpuModel(state, e.target.value || null))}
            >
              <option value="">Another model, or not sure</option>
              {GPU_MODELS.filter((m) => m.vendor === vendor).map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {pc && vendor ? (
          <SizeChoice
            id={fieldId("vram")}
            legend="Graphics card memory"
            choices={vramChoices}
            all={VRAM_SIZES}
            value={state.vramGb}
            onPick={(gb) => onChange(withVram(state, gb))}
            help={
              model?.shared
                ? "This chip uses what the BIOS gives it: Task Manager > Performance > GPU > Dedicated GPU memory."
                : "On Windows: Task Manager > Performance > GPU > Dedicated GPU memory. On Linux, nvidia-smi shows it."
            }
          />
        ) : null}
      </div>
    </section>
  );
}

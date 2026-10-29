import {
  APPLE_CHIPS,
  DEVICE_KINDS,
  GPU_VENDORS,
  gpuModel,
  isPc,
  memoryReadingText,
  profileReady,
  type Detected,
  type DeviceKind,
  type DeviceProfile,
  type GpuVendor,
} from "@/lib/vibe/device";

/**
 * The picker's state (docs/VIBE_TUNING.md, Feature 2, "The flow"): each part of the computer, and whether the browser
 * said it or the person did. Memory and a card's memory are never pre-filled: they always need a yes from the person,
 * so they start empty and the browser's reading only narrows the choices. Pure, so the tests run it without a browser.
 */

export type Source = "browser" | "you";

export interface PickerState {
  kind: DeviceKind | null;
  chip: string | null;
  memoryGb: number | null;
  /** "none" for no graphics card, or built-in graphics only. */
  gpuVendor: GpuVendor | "none" | null;
  /** A GPU_MODELS name, or null when it isn't one the table has. */
  gpuModel: string | null;
  vramGb: number | null;
  from: { kind: Source | null; chip: Source | null; gpu: Source | null };
}

export const EMPTY_PICKER: PickerState = {
  kind: null,
  chip: null,
  memoryGb: null,
  gpuVendor: null,
  gpuModel: null,
  vramGb: null,
  from: { kind: null, chip: null, gpu: null },
};

/** Fills in what the browser told, leaving alone every part the person already set. */
export function prefill(s: PickerState, d: Detected): PickerState {
  const next: PickerState = { ...s, from: { ...s.from } };
  if (s.from.kind !== "you" && d.kind) {
    next.kind = d.kind;
    next.from.kind = "browser";
  }
  if (next.kind === "mac" && s.from.chip !== "you" && d.chip) {
    next.chip = d.chip;
    next.from.chip = "browser";
  }
  if (isPc(next.kind) && s.from.gpu !== "you" && d.gpu) {
    if (d.gpu.integrated) {
      next.gpuVendor = "none";
      next.from.gpu = "browser";
    } else if (d.gpu.vendor !== "other") {
      next.gpuVendor = d.gpu.vendor;
      next.gpuModel = d.gpu.model?.name ?? null;
      next.from.gpu = "browser";
    }
  }
  return next;
}

/** A new kind starts the rest over: a Mac's chip means nothing on a PC. */
export function withKind(kind: DeviceKind | null): PickerState {
  return { ...EMPTY_PICKER, kind, from: { kind: "you", chip: null, gpu: null } };
}

export function withChip(s: PickerState, chip: string | null): PickerState {
  return { ...s, chip, from: { ...s.from, chip: "you" } };
}

export function withMemory(s: PickerState, memoryGb: number | null): PickerState {
  return { ...s, memoryGb };
}

/** A new card maker clears the model and its memory, which the person confirms again. */
export function withGpuVendor(s: PickerState, vendor: GpuVendor | "none" | null): PickerState {
  return { ...s, gpuVendor: vendor, gpuModel: null, vramGb: null, from: { ...s.from, gpu: "you" } };
}

export function withGpuModel(s: PickerState, model: string | null): PickerState {
  return { ...s, gpuModel: gpuModel(model) ? model : null, vramGb: null, from: { ...s.from, gpu: "you" } };
}

export function withVram(s: PickerState, vramGb: number | null): PickerState {
  return { ...s, vramGb };
}

export function profileOf(s: PickerState): DeviceProfile {
  const card = isPc(s.kind) && s.gpuVendor && s.gpuVendor !== "none";
  return {
    kind: s.kind,
    chip: s.kind === "mac" ? s.chip : null,
    memoryGb: s.memoryGb,
    gpu: card ? { vendor: s.gpuVendor as GpuVendor, model: s.gpuModel, vramGb: s.vramGb } : null,
  };
}

/** Ready for a verdict: the profile has what pickBuild needs, and a PC has said whether it has a graphics card. */
export function pickerReady(s: PickerState): boolean {
  return profileReady(profileOf(s)) && (!isPc(s.kind) || s.gpuVendor !== null);
}

/** What the person still needs to answer, in the order the picker asks it. */
export function nextQuestion(s: PickerState): "kind" | "memory" | "gpu" | "vram" | null {
  if (!s.kind) return "kind";
  if (s.kind === "phone" || s.kind === "tablet" || s.kind === "chromebook") return null;
  if (s.memoryGb === null) return "memory";
  if (isPc(s.kind) && s.gpuVendor === null) return "gpu";
  if (isPc(s.kind) && s.gpuVendor !== "none" && s.vramGb === null) return "vram";
  return null;
}

/** One part of the sentence at the top of the picker, with where it came from: "ask" while nobody has said. */
export interface SentencePart {
  field: "kind" | "chip" | "memory" | "gpu";
  text: string;
  from: Source | "ask";
}

/** The picker's sentence, such as "Mac with Apple silicon · Apple M4 Max · 36 GB". */
export function sentenceParts(s: PickerState, d: Detected | null): SentencePart[] {
  const parts: SentencePart[] = [];
  const kindLabel = DEVICE_KINDS.find((k) => k.kind === s.kind)?.label;
  parts.push(kindLabel ? { field: "kind", text: kindLabel, from: s.from.kind ?? "you" } : { field: "kind", text: "Which computer?", from: "ask" });
  if (s.kind === "mac" && s.chip && APPLE_CHIPS.some((c) => c.name === s.chip)) {
    parts.push({ field: "chip", text: `Apple ${s.chip}`, from: s.from.chip ?? "you" });
  }
  if (s.kind === "mac" || s.kind === "mac-intel" || isPc(s.kind)) {
    const ram = isPc(s.kind) ? " of RAM" : "";
    if (s.memoryGb !== null) parts.push({ field: "memory", text: `${s.memoryGb} GB${ram}`, from: "you" });
    else if (d?.memory) parts.push({ field: "memory", text: `${memoryReadingText(d.memory, ram)}, to confirm`, from: "browser" });
    else parts.push({ field: "memory", text: "memory to confirm", from: "ask" });
  }
  if (isPc(s.kind)) {
    if (s.gpuVendor === "none") parts.push({ field: "gpu", text: "no graphics card", from: s.from.gpu ?? "you" });
    else if (s.gpuVendor) {
      const name = s.gpuModel ?? `${GPU_VENDORS.find((v) => v.vendor === s.gpuVendor)?.label} card`;
      const vram = s.vramGb !== null ? ` with ${s.vramGb} GB` : "";
      parts.push({ field: "gpu", text: `${name}${vram}`, from: s.from.gpu ?? "you" });
    } else parts.push({ field: "gpu", text: "graphics card?", from: "ask" });
  }
  return parts;
}

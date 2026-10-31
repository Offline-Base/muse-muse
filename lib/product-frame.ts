import { briefTargets } from "@/lib/native/targets";

/** The stored brief's targets. A brief with no targets, or with a `targets` that isn't a list, counts as web only. */
function targetsOf(brief: object | null | undefined) {
  const targets = (brief as { targets?: unknown } | null | undefined)?.targets;
  return Array.isArray(targets) ? briefTargets({ targets }) : [];
}

/**
 * What a product's live iframe on its page may use. A glasses product gets the camera and microphone: its page needs them to
 * work as the web fallback. A VR product gets WebXR, for a headset that opens the page. Every other product keeps the same
 * limits it always had.
 */
export function liveFrameAllow(brief: object | null | undefined): string {
  const targets = targetsOf(brief);
  return [
    "clipboard-write; fullscreen",
    ...(targets.includes("glasses") ? ["camera; microphone"] : []),
    ...(targets.includes("vr") ? ["xr-spatial-tracking"] : []),
  ].join("; ");
}

/** The live iframe's sandbox. A VR product adds pointer lock: the simulated headset's play mode needs it for mouse-look. */
export function liveFrameSandbox(brief: object | null | undefined): string {
  const base = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";
  return targetsOf(brief).includes("vr") ? `${base} allow-pointer-lock` : base;
}

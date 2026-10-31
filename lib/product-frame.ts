import { briefTargets } from "@/lib/native/targets";

/** The live iframe's sandbox, as every product has always had it. */
export const LIVE_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";

/** Where a stored brief's product runs. Its `targets` are `{ id, why }`; anything else counts as no targets. */
function targetsOf(brief: object | null | undefined): string[] {
  const targets = (brief as { targets?: unknown } | null | undefined)?.targets;
  if (!Array.isArray(targets)) return [];
  return briefTargets({ targets: targets.map((t) => (typeof t === "string" ? { id: t } : (t as { id: unknown }))) });
}

/**
 * What a product's live iframe on its page may use. A glasses product gets the camera and microphone: its page needs them
 * to work as the web fallback. A VR product gets spatial tracking, so its simulated headset runs in the frame. Every other
 * product keeps the same limits it always had. Takes the stored brief, which may have no `targets` at all.
 */
export function liveFrameAllow(brief: object | null | undefined): string {
  const targets = targetsOf(brief);
  return [
    "clipboard-write; fullscreen",
    ...(targets.includes("glasses") ? ["camera; microphone"] : []),
    ...(targets.includes("vr") ? ["xr-spatial-tracking"] : []),
  ].join("; ");
}

/** The live iframe's sandbox. The simulated headset's play mode needs pointer lock, so a VR product gets that too. */
export function liveFrameSandbox(brief: object | null | undefined): string {
  return targetsOf(brief).includes("vr") ? `${LIVE_FRAME_SANDBOX} allow-pointer-lock` : LIVE_FRAME_SANDBOX;
}

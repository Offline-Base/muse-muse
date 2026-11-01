import { briefTargets } from "@/lib/native/targets";

/** The live iframe's sandbox, as every product has always had it. */
export const LIVE_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";

/** Where a stored brief's product runs. Its `targets` are `{ id, why }`, or plain ids from a caller; anything else counts as no targets. */
function targetsOf(brief: object | null | undefined): string[] {
  const targets = (brief as { targets?: unknown } | null | undefined)?.targets;
  if (!Array.isArray(targets)) return [];
  return briefTargets({ targets: targets.map((t) => (typeof t === "string" ? { id: t } : (t as { id: unknown }))) });
}

/** The browser links a stored brief's hardware block asks for. */
function hardwareLinksOf(brief: object | null | undefined): string[] {
  const links = (brief as { hardware?: { links?: unknown } | null } | null | undefined)?.hardware?.links;
  return Array.isArray(links) ? links.filter((l): l is string => l === "serial" || l === "usb" || l === "bluetooth") : [];
}

/**
 * What a product's live iframe on its page may use. A glasses product gets the camera and microphone: its page needs them
 * to work as the web fallback. A VR product gets spatial tracking, so its simulated headset runs in the frame. A product with
 * browser links gets those, from enabledFrameBrief only, while the hardware cap is served: a device picker needs them in a
 * cross-origin frame. Every other product keeps the same limits it always had. Takes the stored brief, which may have no
 * `targets` at all.
 */
export function liveFrameAllow(brief: object | null | undefined): string {
  const targets = targetsOf(brief);
  return [
    "clipboard-write; fullscreen",
    ...(targets.includes("glasses") ? ["camera; microphone"] : []),
    ...(targets.includes("vr") ? ["xr-spatial-tracking"] : []),
    ...((brief as { hardwareLinks?: string[] } | null | undefined)?.hardwareLinks ?? []),
  ].join("; ");
}

/**
 * A stored brief with only the targets switched on here, and its browser links while the hardware cap is served. Pass this to
 * the two functions in this file: a target or cap whose flag is off gives its frame nothing, so turning a flag off puts a
 * product's frame back to what it had before.
 */
export function enabledFrameBrief(brief: object | null | undefined, enabled: readonly string[], servedCaps: readonly string[] = []): { targets: Array<{ id: string }>; hardwareLinks?: string[] } {
  const links = servedCaps.includes("hardware") ? hardwareLinksOf(brief) : [];
  return { targets: targetsOf(brief).filter((t) => enabled.includes(t)).map((id) => ({ id })), ...(links.length ? { hardwareLinks: links } : {}) };
}

/** The live iframe's sandbox. The simulated headset's play mode needs pointer lock, so a VR product gets that too. */
export function liveFrameSandbox(brief: object | null | undefined): string {
  return targetsOf(brief).includes("vr") ? `${LIVE_FRAME_SANDBOX} allow-pointer-lock` : LIVE_FRAME_SANDBOX;
}

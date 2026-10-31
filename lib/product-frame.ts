import { briefTargets } from "@/lib/native/targets";

/**
 * What a product's live iframe on its page may use. Only a glasses product gets the camera and microphone: its page
 * needs them to work as the web fallback, and every other product keeps the same limits it always had. Takes the
 * stored brief. A brief with no targets, or with a `targets` that isn't a list, counts as web only.
 */
export function liveFrameAllow(brief: object | null | undefined): string {
  const targets = (brief as { targets?: unknown } | null | undefined)?.targets;
  const glasses = Array.isArray(targets) && briefTargets({ targets }).includes("glasses");
  return glasses ? "clipboard-write; fullscreen; camera; microphone" : "clipboard-write; fullscreen";
}

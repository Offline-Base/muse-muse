/**
 * What a product's live iframe on its page may use. Only a glasses product gets the camera and microphone: its page
 * needs them to work as the web fallback, and every other product keeps the same limits it always had. Takes the
 * stored brief, which only has `targets` once its schema adds them, so anything else counts as no targets.
 */
export function liveFrameAllow(brief: object | null | undefined): string {
  const targets = (brief as { targets?: unknown } | null | undefined)?.targets;
  const glasses = Array.isArray(targets) && targets.includes("glasses");
  return glasses ? "clipboard-write; fullscreen; camera; microphone" : "clipboard-write; fullscreen";
}

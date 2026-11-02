/**
 * Which served models count as Meta's, for every model Muse Muse asks on its own boards and fleet. The hackathon's organizers
 * (Cerebral Valley) answered on Nov 2, 2026 at 3:57 PM: "Llama is not part of this hackathon and does not count as a Meta
 * model however you run it", and every model a project calls at runtime must be a Meta model, a small local helper too.
 * Open-source Meta models anyone can access count: Muse Glimmer (quantized builds included), Muse Spark Open, SAM and V-JEPA 2.
 * On an 8 GB Jetson that leaves Muse Muse's own one-bit Glimmer, which the fleet serves as muse-glimmer-2026-iq1s-io-lowest.
 *
 * SAM isn't matched: every fleet and board path here is a text chat, which SAM can't answer, and "sam" alone is part of too
 * many other names. A Meta word at the start isn't enough: another family's or maker's word anywhere refuses the name too,
 * since a merge or a fine-tune of Bolt, LFM or Qwen can be named "glimmer-...". Llama anywhere refuses it, and so does
 * combo/, which hands the chat on. The one exception is the title inside Muse Muse's own Glimmer tunes (lib/train/hub-cards.ts),
 * which is a person's words: "Llama Ranch Helper" is still a Glimmer tune.
 *
 * muse-device/server.py keeps the same three patterns for a board's own files, and a test holds them equal.
 */
export const META_NAME_PATTERNS = {
  /** What a Meta model's own name starts with, once spaces and underscores are hyphens. */
  family: /^(?:muse-?glimmer|glimmer|muse-?spark|spark-open|v-?jepa)(?![a-z])/,
  /** Another family's or maker's word. Llama is caught inside other words too (codellama, tinyllama). */
  other: /llama|(?:^|[^a-z])(?:bolt|nemotron|nvidia|lfm|liquid(?:ai)?|qwen|gemma|google|gpt|openai|mistral(?:ai)?|mixtral|phi|microsoft|deepseek|granite|smollm|olmo|d1)(?![a-z])/,
  /** Muse Muse's own Glimmer 30B tunes: "muse-glimmer-30b-<title>-gguf-<job>", "-lora-<job>", or a build "-<LEVEL>.gguf". */
  ownTune: /^muse-glimmer-30b-[a-z0-9-]+?-(?:(?:gguf|lora)-[a-z0-9]{8}|i?q\d[a-z0-9-]*(?:\.gguf)?)$/,
} as const;

/** Whether a served model's own name, after any org or hf.co path and with any tag, is a Meta family's and no other's. */
export function isMetaModelName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const lower = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!lower || lower.startsWith("combo/")) return false;
  const path = lower.split("/");
  const [own = "", ...tag] = path.pop()!.split(":");
  if (!META_NAME_PATTERNS.family.test(own)) return false;
  // The org and the tag always count, and the name itself unless it's Muse Muse's own tune with a title inside.
  const checked = [...path, ...tag, META_NAME_PATTERNS.ownTune.test(own) ? "" : own].join("/");
  return !META_NAME_PATTERNS.other.test(checked);
}

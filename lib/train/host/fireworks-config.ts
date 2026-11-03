/** What Fireworks takes in an adapter's adapter_config.json. Pure, with no imports, so the room and workflow bundles can use it. */
export const FIREWORKS_MIN_RANK = 4;
export const FIREWORKS_MAX_RANK = 64;

/**
 * Why Fireworks won't take an adapter with this adapter_config.json, or null. It documents a list of module names, a
 * rank of 4 to 64 and no embed_tokens. A regex string is what Glimmer training in the lab saves, so a lab adapter is
 * almost always refused here; read before anything is created, and shown before an eval starts.
 */
export function fireworksConfigProblem(config: { r?: unknown; target_modules?: unknown } | null): string | null {
  if (!config) return "Its adapter_config.json couldn't be read from Hugging Face, so Fireworks can't be checked.";
  if (!Array.isArray(config.target_modules)) return "This adapter names its target modules by a pattern, which Fireworks doesn't document accepting.";
  const r = Number(config.r);
  if (!(r >= FIREWORKS_MIN_RANK && r <= FIREWORKS_MAX_RANK)) return `Fireworks takes adapters of rank ${FIREWORKS_MIN_RANK} to ${FIREWORKS_MAX_RANK}.`;
  if (config.target_modules.includes("embed_tokens")) return "Fireworks doesn't take an adapter that changes embed_tokens.";
  return null;
}

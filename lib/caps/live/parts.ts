/**
 * The live cap's own switch (docs/CAPABILITIES.md, section 13), read the way lib/env.ts's flag() reads one. A plain file
 * with no imports, like lib/caps/media/parts.ts, so lib/env.ts and the cap registries can both read it without an import
 * cycle (lib/env.ts imports lib/brief/schema.ts, which reads the registries at load). LIVE_ENABLED, captions and the
 * writer, is CAP_FLAG.live.
 */
export function liveUpdatesOn(source: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((source.LIVE_UPDATES ?? "").trim().toLowerCase());
}

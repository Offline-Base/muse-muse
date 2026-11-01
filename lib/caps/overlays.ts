import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import { codeBlock } from "@/lib/caps/code/brief";
import { MUSE_CODE_OVERLAY } from "@/lib/caps/code/parts";
import { ENGINE_OVERLAY, type GamesBrief } from "@/lib/caps/games/brief";
import type { CapId } from "@/lib/caps/ids";

/**
 * Template overlays for caps (docs/CAPABILITIES.md, 2.5). Each lives in template/caps/<overlay>/: files/**, deps.json
 * (exact versions) and platform-files.json. `core` goes with any cap. A cap's overlays are its own id unless it registers
 * a pick here (games chooses games-phaser or games-babylon from its block). `trust` is unit 1's, added by its flags.
 */
export const CORE_OVERLAY = "core";

export const CAP_OVERLAY_PICK: Partial<Record<CapId, (brief: Brief) => string[]>> = {
  // The shared games overlay (its checks, test helper, asset helper and skill), then the engine's own.
  games: (brief) => ["games", ENGINE_OVERLAY[((brief as { games?: GamesBrief | null }).games ?? { engine: "phaser" }).engine]],
  // Unit 9, 15b: a product that runs Muse Code sessions also gets the musecode kit. Its readiness is the museCode part's
  // (lib/caps/code/parts.ts), so a snapshot without it leaves the code cap ready and only Muse Code off.
  code: (brief) => ["code", ...(codeBlock(brief)?.museCode ? [MUSE_CODE_OVERLAY] : [])],
};

// ---------- Wave 3, unit 3: cap readiness (docs/CAPABILITIES.md, 2.4a) ----------

/**
 * Every overlay a cap can need, for one that registers a pick above: games needs both games-phaser and games-babylon,
 * since a brief may pick either. A cap without an entry needs the overlay named by its own id.
 */
export const CAP_OVERLAYS_ALL: Partial<Record<CapId, readonly string[]>> = {
  games: ["games", ...Object.values(ENGINE_OVERLAY)],
};

/** What a builder snapshot must have for this cap to be ready: core, then the cap's own overlays. */
export function capOverlaysNeeded(id: CapId): string[] {
  return [CORE_OVERLAY, ...(CAP_OVERLAYS_ALL[id] ?? [id])];
}
// ---------- end Wave 3, unit 3 ----------

/** The file a product with caps carries (musemuse.caps.json), which verify, Playwright and the tests read. */
export interface CapsFile {
  caps: CapId[];
  overlays: string[];
}

/** The overlays for a brief, core first. Empty for a brief with no cap blocks, so its sandbox gets no extra files. */
export function overlaysFor(brief: Brief, opts: { trust?: boolean } = {}): string[] {
  const caps = briefCaps(brief);
  const own = caps.flatMap((id) => CAP_OVERLAY_PICK[id]?.(brief) ?? [id]);
  const out = [...(caps.length ? [CORE_OVERLAY] : []), ...(opts.trust ? ["trust"] : []), ...own];
  return [...new Set(out)];
}

/** musemuse.caps.json for a brief, or null when it has no caps (the file is then never written). */
export function capsFileFor(brief: Brief, opts: { trust?: boolean } = {}): CapsFile | null {
  const caps = briefCaps(brief);
  if (!caps.length) return null;
  return { caps, overlays: overlaysFor(brief, opts) };
}

/** The commit message applyCapsScript makes, like "Caps: data, jobs". */
export function capsCommitMessage(file: CapsFile): string {
  return `Caps: ${file.caps.join(", ")}`;
}

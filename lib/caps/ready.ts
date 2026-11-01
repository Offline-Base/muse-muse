import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import { codeBlock, codePartsOff } from "@/lib/caps/code/brief";
import { type CapId, isCapId } from "@/lib/caps/ids";
import { liveBlock } from "@/lib/caps/live/brief";
import { capOverlaysNeeded } from "@/lib/caps/overlays";
import { env } from "@/lib/env";

/**
 * Cap readiness at build time (docs/CAPABILITIES.md, 2.4a). A stored brief can carry a cap block whose cap this build
 * can't have: its flag was turned off after the brief was written, its unit hasn't set CAP_READY, or the builder
 * snapshot doesn't have its overlays. capsForBuild gives the build's working copy of the brief with those blocks set to
 * null, and says why for each, so every step after it (overlays, token markers, the build prompt, the caps' env, the
 * fixed checks, the judge's notes) agrees on one set of caps. The stored brief keeps its blocks, so a later build on a
 * newer snapshot can use them.
 */

export type CapDropReason = "off" | "snapshot";

export interface CapDrop {
  cap: CapId;
  reason: CapDropReason;
}

/** What each cap gives a product, as a build log line names it. `plural` picks "them" or "it". */
export const CAP_LABEL: Record<CapId, { label: string; plural: boolean }> = {
  data: { label: "saved data", plural: false },
  files: { label: "stored files", plural: true },
  connect: { label: "outside services", plural: true },
  jobs: { label: "scheduled jobs", plural: true },
  live: { label: "live captions and updates", plural: true },
  media: { label: "the media tools", plural: true },
  code: { label: "running code", plural: false },
  runtime: { label: "Python functions", plural: true },
  hardware: { label: "the hardware links", plural: true },
  extension: { label: "the browser extension", plural: false },
  games: { label: "the game engines", plural: true },
};

/** The build room's one plain line for a cap the build goes without. */
export function capDropLine(drop: CapDrop): string {
  const { label, plural } = CAP_LABEL[drop.cap];
  return drop.reason === "snapshot"
    ? `This build goes without ${label}: the builder snapshot doesn't have ${plural ? "them" : "it"} yet.`
    : `This build goes without ${label}: ${plural ? "they are" : "it is"} switched off.`;
}

export interface CapsForBuildOptions {
  /** A refinement reopens a sandbox that already has its overlays, so only a cap that's switched off is dropped. */
  kind?: "build" | "refine";
  /** env.enabledCaps: ready, on, and in the snapshot. */
  enabled?: readonly CapId[];
  /** env.capsOnSite: ready and on, whatever the snapshot has. */
  onSite?: readonly CapId[];
  /**
   * env.servedCaps: ready and on, whoever built the product. A refinement uses it: the product already has the cap and
   * the gate serves it on servedCaps, so production's signed-in-builder rule (TRUST_SIGNED_IN_CAPS) doesn't take a cap
   * from a product that already saves data.
   */
  served?: readonly CapId[];
  /** A decision saved at provision (builds.caps_dropped). When given, it is the answer, and the env isn't read. */
  decided?: readonly CapDrop[] | null;
}

/** The brief with these caps' blocks set to null. The same object when there are none. */
export function withoutCaps<T extends object>(brief: T, caps: readonly CapId[]): T {
  if (!caps.length) return brief;
  const copy = { ...brief } as Record<string, unknown>;
  for (const id of caps) if (copy[id] !== undefined && copy[id] !== null) copy[id] = null;
  return copy as T;
}

/**
 * The build's working copy of the brief and the caps it goes without. A brief with no cap blocks comes back as the same
 * object with nothing dropped, and nothing is read from the env, so a build with no caps is today's.
 */
export function capsForBuild<T extends Brief>(brief: T, opts: CapsForBuildOptions = {}): { brief: T; dropped: CapDrop[] } {
  const caps = briefCaps(brief);
  if (!caps.length) return { brief, dropped: [] };
  if (opts.decided) {
    const dropped = opts.decided.filter((d) => isCapId(d.cap) && caps.includes(d.cap));
    return { brief: withoutCaps(brief, dropped.map((d) => d.cap)), dropped };
  }
  if (opts.kind === "refine") {
    const served = opts.served ?? env.servedCaps;
    const dropped: CapDrop[] = caps.filter((c) => !served.includes(c)).map((cap) => ({ cap, reason: "off" }));
    partsOff(brief, dropped);
    liveOff(brief, dropped);
    return { brief: withoutCaps(brief, dropped.map((d) => d.cap)), dropped };
  }
  const onSite = opts.onSite ?? env.capsOnSite;
  const enabled = opts.enabled ?? env.enabledCaps;
  const dropped: CapDrop[] = caps.filter((c) => !enabled.includes(c)).map((cap) => ({ cap, reason: onSite.includes(cap) ? "snapshot" : "off" }));
  partsOff(brief, dropped);
  liveOff(brief, dropped);
  return { brief: withoutCaps(brief, dropped.map((d) => d.cap)), dropped };
}

// ---------- Wave 3, unit 9 (docs/CAPABILITIES.md, 15a): code parts whose routes are off ----------
/**
 * A kept code block whose server parts are switched off (CODE_EXEC, CODE_BROWSE): codeBlock leaves them out of every
 * step's text and checks, and this says so in the log once, when the decision is made. A block left with no part at all
 * isn't a code product, so the cap is dropped as switched off.
 */
function partsOff(brief: Brief, dropped: CapDrop[]): void {
  const record = brief as { code?: unknown };
  if (record.code === null || record.code === undefined || dropped.some((d) => d.cap === "code")) return;
  const off = codePartsOff(brief);
  if (codeBlock(brief) === null) dropped.push({ cap: "code", reason: "off" });
  else if (off.length) console.info(`[caps] code: this build goes without ${off.map((p) => (p === "exec" ? "running code on the server" : p === "museCode" ? "Muse Code sessions" : "opening pages")).join(" and ")}: switched off.`);
}
// ---------- end Wave 3, unit 9 ----------

// ---------- Wave 3, unit 7 (docs/CAPABILITIES.md, 13a): a live block with nothing left ----------
/**
 * Updates read saved data: with LIVE_UPDATES off, or the data cap dropped from this build, liveBlock leaves them out. A
 * block with no captions either isn't a live product, so the cap is dropped as switched off.
 */
function liveOff(brief: Brief, dropped: CapDrop[]): void {
  const record = brief as { live?: unknown };
  if (record.live === null || record.live === undefined || dropped.some((d) => d.cap === "live")) return;
  if (liveBlock(withoutCaps(brief, dropped.map((d) => d.cap))) === null) dropped.push({ cap: "live", reason: "off" });
}
// ---------- end Wave 3, unit 7 ----------

/** A saved decision read back from the database: only well-formed entries. Null stays null. */
export function readCapDrops(value: unknown): CapDrop[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (d): d is CapDrop => Boolean(d) && typeof d === "object" && isCapId((d as CapDrop).cap) && ((d as CapDrop).reason === "off" || (d as CapDrop).reason === "snapshot"),
  );
}

/**
 * The caps whose overlays aren't in `have` (what the sandbox's CAPS_DIR has), from a caps file's overlays: core missing
 * drops every cap, and a cap's own overlay missing drops that cap. For applyCaps' backstop.
 */
export function capsMissingOverlays(file: { caps: readonly string[]; overlays: readonly string[] }, missing: readonly string[]): CapId[] {
  if (!missing.length) return [];
  return file.caps.filter(isCapId).filter((c) => capOverlaysNeeded(c).some((o) => file.overlays.includes(o) && missing.includes(o)));
}

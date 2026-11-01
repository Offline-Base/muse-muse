import { snapshotCapOverlays } from "@/lib/sandbox/snapshots";

/**
 * Which parts of the code cap are switched on (docs/CAPABILITIES.md, 15a), read as lib/env.ts reads a flag so the brief
 * block, the writer's rules, the catalog and the build prompt can follow them without importing env (which imports the
 * brief schema). Pyodide and QuickJS need only CODE_ENABLED; each server part needs its own route switched on too.
 *
 *   exec      CODE_EXEC: {GATEWAY_URL}/exec answers.
 *   browse    CODE_BROWSE, and BUILDER_SNAPSHOT_ID set: a live page opens from the builder snapshot, which has Chromium.
 *   visitors  CODE_EXEC_VISITORS with CODE_EXEC: visitors and signed-in end users may run /exec too.
 *   museCode  MUSE_CODE_ENABLED, and BUILDER_SNAPSHOT_ID set, and on Vercel a builder snapshot that has the musecode
 *             overlay: the product runs Muse Code sessions ({GATEWAY_URL}/code/sessions, docs/CAPABILITIES.md 15b).
 *   museCodeVisitors  MUSE_CODE_VISITORS with museCode: visitors and signed-in end users may start sessions too.
 *
 * The two Muse Code parts are optional here, so a CodeParts written before them still means both off.
 */
export interface CodeParts {
  exec: boolean;
  browse: boolean;
  visitors: boolean;
  museCode?: boolean;
  museCodeVisitors?: boolean;
}

function flag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

export function codePartsOn(): CodeParts {
  const exec = flag("CODE_EXEC");
  const base: CodeParts = { exec, browse: flag("CODE_BROWSE") && Boolean(process.env.BUILDER_SNAPSHOT_ID), visitors: exec && flag("CODE_EXEC_VISITORS") };
  // ---------- Wave 3, unit 9: Muse Code sessions (15b). Off: the object is exactly what it was ----------
  if (!museCodeOn()) return base;
  return { ...base, museCode: true, museCodeVisitors: flag("MUSE_CODE_VISITORS") };
}

/** The overlay a Muse Code product gets on top of `code` (template/caps/musecode). */
export const MUSE_CODE_OVERLAY = "musecode";

/**
 * MUSE_CODE_ENABLED, with a builder snapshot to start sessions from, and on Vercel one whose manifest lists the
 * musecode overlay (2.4a), so a stale snapshot never offers a kit the build can't install. Locally the checkout's
 * template/caps is used, as for every overlay.
 */
export function museCodeOn(): boolean {
  if (!flag("MUSE_CODE_ENABLED") || !process.env.BUILDER_SNAPSHOT_ID) return false;
  if (!process.env.VERCEL) return true;
  return snapshotCapOverlays(process.env.BUILDER_SNAPSHOT_ID).includes(MUSE_CODE_OVERLAY);
}

/** A short key for caches of text that follows the parts. */
export function codePartsKey(parts: CodeParts = codePartsOn()): string {
  return `${parts.exec ? "e" : ""}${parts.browse ? "b" : ""}${parts.visitors ? "v" : ""}${parts.museCode ? "m" : ""}${parts.museCodeVisitors ? "w" : ""}`;
}

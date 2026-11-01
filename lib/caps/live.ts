import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import type { CapId } from "@/lib/caps/ids";

/**
 * Routes a cap adds to unit 2's live check (lib/engine/live-check.ts, ENGINE_LIVE_SMOKE): after deploy, each must answer
 * GET with HTTP 200 and {"ok": true} on the live link before the product is marked live. Platform files only, which run
 * no product code and make no model call, so the check still costs nothing (decision 15). One line per cap, plan order.
 */
export interface CapLivePath {
  path: string;
  /** What failed, in the words the build room shows: "its Python functions don't run on the live link". */
  what: string;
}

export const CAP_LIVE_PATHS: Partial<Record<CapId, readonly CapLivePath[]>> = {
  // template/caps/code/files/public/musemuse/pyodide/health.json: Pyodide's folder is static and deployed with it.
  code: [{ path: "/musemuse/pyodide/health.json", what: "Python in the browser can't load on the live link" }],
  // template/caps/runtime/files/api/py/musemuse_health.py: Vercel serves the product's Python functions beside Next.js.
  runtime: [{ path: "/api/py/musemuse_health", what: "its Python functions don't run on the live link" }],
};

/** The extra paths the live check loads for a brief, in plan order. Empty for a brief with no cap blocks. */
export function capsLivePaths(brief: Brief | null | undefined): CapLivePath[] {
  if (!brief) return [];
  return briefCaps(brief).flatMap((id) => CAP_LIVE_PATHS[id] ?? []);
}

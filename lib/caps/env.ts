import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import { codeBlock } from "@/lib/caps/code/brief";
import { gpuBuildEnv, gpuDeployEnv } from "@/lib/caps/gpu/env";
import type { CapId } from "@/lib/caps/ids";
import { mediaAssetsEnv, mediaBuildEnv } from "@/lib/caps/media/env";

/**
 * Extra env a cap needs (docs/CAPABILITIES.md, 2.5): lines for the build's .env.local and settings for the product's
 * Vercel env. One line per cap, in plan order. Never a secret the product's code shouldn't hold.
 */
export interface CapEnvEntry {
  build?(brief: Brief): Record<string, string>;
  deploy?(brief: Brief, liveToken: string): Record<string, string>;
}

export const CAP_ENV: Partial<Record<CapId, CapEnvEntry>> = {
  // The page loads the media cap's large files (the speech model and its runtime) from the gateway's public /assets.
  media: { build: () => mediaBuildEnv(), deploy: () => mediaAssetsEnv() },
  // A build's server runs the product's Python functions on the build machine (template/caps/runtime). On Vercel the
  // same helper calls the deployment's own /api/py routes, so the deploy needs nothing.
  runtime: { build: () => ({ MUSEMUSE_PYTHON: "local", MUSEMUSE_PYTHON_NOTES: "1" }) },
  // Unit 9, 15b: a build's own server may answer Muse Code tasks from the kit's recording (replay mode), so most of its
  // tests spend nothing. The live product never gets this, so it can't show a recording as if it were a person's task.
  code: { build: (brief): Record<string, string> => (codeBlock(brief)?.museCode ? { MUSE_CODE_REPLAY_OK: "1" } : {}) },
};

const KEY = /^[A-Z][A-Z0-9_]*$/;

function checked(entries: Record<string, string>, cap: CapId): Record<string, string> {
  for (const [k, v] of Object.entries(entries)) {
    if (!KEY.test(k) || /[\r\n]/.test(v)) throw new Error(`The ${cap} cap gave an env line that isn't KEY=value on one line.`);
  }
  return entries;
}

/** Lines appended to the build's .env.local. Empty for a brief with no cap blocks, so .env.local is today's. */
export function capBuildEnv(brief: Brief): string {
  const lines = briefCaps(brief).flatMap((id) => Object.entries(checked(CAP_ENV[id]?.build?.(brief) ?? {}, id)).map(([k, v]) => `${k}=${v}`));
  // Wave 3, unit 11: GPU isn't a cap (section 17). Nothing with GPU_GLIMMER_SHARED off.
  lines.push(...Object.entries(gpuBuildEnv(brief)).map(([k, v]) => `${k}=${v}`));
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Settings added to the product's Vercel env. Empty for a brief with no cap blocks. */
export function capDeployEnv(brief: Brief, liveToken: string): Record<string, string> {
  return Object.assign({}, ...briefCaps(brief).map((id) => checked(CAP_ENV[id]?.deploy?.(brief, liveToken) ?? {}, id)), gpuDeployEnv(brief));
}

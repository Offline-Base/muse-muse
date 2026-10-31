import type { Brief } from "@/lib/brief/schema";
import { briefCaps } from "@/lib/caps/brief-fields";
import type { CapId } from "@/lib/caps/ids";

/**
 * Extra env a cap needs (docs/CAPABILITIES.md, 2.5): lines for the build's .env.local and settings for the product's
 * Vercel env. One line per cap, in plan order. Never a secret the product's code shouldn't hold.
 */
export interface CapEnvEntry {
  build?(brief: Brief): Record<string, string>;
  deploy?(brief: Brief, liveToken: string): Record<string, string>;
}

export const CAP_ENV: Partial<Record<CapId, CapEnvEntry>> = {};

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
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Settings added to the product's Vercel env. Empty for a brief with no cap blocks. */
export function capDeployEnv(brief: Brief, liveToken: string): Record<string, string> {
  return Object.assign({}, ...briefCaps(brief).map((id) => checked(CAP_ENV[id]?.deploy?.(brief, liveToken) ?? {}, id)));
}

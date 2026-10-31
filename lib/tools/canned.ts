import { createHash } from "node:crypto";
import type { CatalogFunction, CatalogTool } from "@/lib/tools/composio/sync";
import { canonicalJson } from "@/lib/tools/sign";
import type { ToolFixtures } from "@/lib/tools/ids";

/**
 * Build tokens get canned results, so a build never calls the provider. The fixture is hash(normalized args) % n: the
 * same arguments give the same output on every verify run, and tests can assert structure.
 */
export function cannedOutput(fn: Pick<CatalogFunction, "name" | "sample">, args: unknown, fixtures: ToolFixtures | null | undefined): unknown {
  const list = fixtures?.[fn.name];
  if (!Array.isArray(list) || !list.length) return fn.sample;
  const hash = createHash("sha256").update(canonicalJson(args)).digest();
  return list[hash.readUInt32BE(0) % list.length];
}

export interface ToolConnectionView {
  toolkit: string;
  label: string;
  connected: boolean;
  canConnect: boolean;
  simulated?: boolean;
  account?: string;
}

/** What a build sees for a toolkit: already connected, to a sample account. */
export function simulatedConnection(toolkit: string, label: string): ToolConnectionView {
  return { toolkit, label, connected: true, canConnect: false, simulated: true, account: `${label} connected (sample account)` };
}

/** The personal toolkits among these tools, without repeats. */
export function personalToolkitsOf(tools: readonly Pick<CatalogTool, "tier" | "toolkit">[]): string[] {
  return [...new Set(tools.filter((t) => t.tier === "personal" && t.toolkit).map((t) => t.toolkit as string))];
}

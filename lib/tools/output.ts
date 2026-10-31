import type { SourceRule } from "@/lib/tools/catalog.source";
import type { CatalogTool } from "@/lib/tools/composio/sync";
import { TOOL_LIMITS } from "@/lib/tools/policy";

/** What a tool's reply becomes before a product sees it: the catalog's output rules, its sources and the size limit. */

export interface ToolSource {
  url: string;
  title: string;
  snippet?: string;
  date?: string;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "null");

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function getPath(value: unknown, path: string): unknown {
  let at = value;
  for (const key of path.split(".")) {
    if (!isRecord(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let at = target;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(at[key])) at[key] = {};
    at = at[key] as Record<string, unknown>;
  }
  at[keys[keys.length - 1]] = value;
}

function pointsAt(value: string, hosts: readonly string[]): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const DROPPED = Symbol("dropped");

/** Drops the named keys at any depth, and any string that links to one of the hosts. */
function scrub(value: unknown, dropKeys: ReadonlySet<string>, hosts: readonly string[]): unknown {
  if (typeof value === "string") return hosts.length && pointsAt(value, hosts) ? DROPPED : value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, dropKeys, hosts)).filter((v) => v !== DROPPED);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (dropKeys.has(k)) continue;
      const kept = scrub(v, dropKeys, hosts);
      if (kept !== DROPPED) out[k] = kept;
    }
    return out;
  }
  return value;
}

/**
 * Keeps only the catalog's paths. When none match, a verified tool has no results, so nothing is kept. An unverified one
 * (nobody has connected Gmail yet, and its text hints at a wrapper) keeps the whole reply, because guessing would lose it.
 */
export function applyOutputRules(tool: Pick<CatalogTool, "output" | "outputVerified">, data: unknown): unknown {
  const rule = tool.output;
  if (!rule) return data ?? null;
  const kept: Record<string, unknown> = {};
  let matched = false;
  for (const path of rule.keep) {
    const value = getPath(data, path);
    if (value !== undefined) {
      setPath(kept, path, value);
      matched = true;
    }
  }
  const base = matched ? kept : tool.outputVerified ? {} : (data ?? null);
  const scrubbed = scrub(base, new Set(rule.dropKeys), rule.dropUrlHosts ?? []);
  return scrubbed === DROPPED ? null : scrubbed;
}

/** A page sets its own title and links, and sources sit outside the 32 KB trim, so they have limits of their own. */
const SOURCE_TITLE_CHARS = 200;
const SOURCE_URL_CHARS = 2048;

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function sourceOf(rule: SourceRule, item: unknown): ToolSource | null {
  if (!isRecord(item)) return null;
  const url = text(getPath(item, rule.url));
  if (!url || url.length > SOURCE_URL_CHARS || !/^https?:\/\//i.test(url)) return null;
  const snippet = rule.snippet ? text(getPath(item, rule.snippet)) : undefined;
  const date = rule.date ? text(getPath(item, rule.date)) : undefined;
  return {
    url,
    title: (text(getPath(item, rule.title)) ?? url).slice(0, SOURCE_TITLE_CHARS),
    ...(snippet ? { snippet: snippet.slice(0, 400) } : {}),
    ...(date ? { date: date.slice(0, 80) } : {}),
  };
}

/** Links for the run's step list, without repeats. Records with no link (many event cards) simply have no source. */
export function extractSources(rules: readonly SourceRule[], output: unknown): ToolSource[] {
  const seen = new Set<string>();
  const sources: ToolSource[] = [];
  let left = TOOL_LIMITS.sourcesMaxBytes - 2;
  for (const rule of rules) {
    const at = getPath(output, rule.path);
    const items = rule.single ? [at] : Array.isArray(at) ? at : [];
    for (const item of items) {
      const source = sourceOf(rule, item);
      if (!source || seen.has(source.url)) continue;
      left -= bytes(source) + 1;
      if (left < 0) return sources;
      seen.add(source.url);
      sources.push(source);
      if (sources.length === TOOL_LIMITS.sourcesMax) return sources;
    }
  }
  return sources;
}

function shrinkString(value: string, budget: number): string {
  let out = value.slice(0, Math.max(0, budget));
  // Escapes and multi-byte characters take more than one byte, so step down until it fits.
  while (out && bytes(out) > budget) out = out.slice(0, Math.floor(out.length * 0.9));
  return out;
}

/** Keeps as much as fits in `budget` bytes, first items first, and always stays valid JSON. */
function shrink(value: unknown, budget: number): unknown {
  if (bytes(value) <= budget) return value;
  if (typeof value === "string") return shrinkString(value, budget);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let left = budget - 2;
    for (const item of value) {
      const size = bytes(item) + 1;
      if (size <= left) {
        out.push(item);
        left -= size;
        continue;
      }
      // Half of what is left is worth one partial item. Less than that isn't.
      if (left > 256 && !out.length) out.push(shrink(item, left - 1));
      break;
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let left = budget - 2;
    for (const [k, v] of Object.entries(value)) {
      const keyBytes = bytes(k) + 2;
      const size = keyBytes + bytes(v);
      if (size <= left) {
        out[k] = v;
        left -= size;
        continue;
      }
      if (left - keyBytes > 64) {
        const part = shrink(v, left - keyBytes);
        out[k] = part;
        left -= keyBytes + bytes(part);
      }
    }
    return out;
  }
  return null;
}

/** The output within the limit, saying whether it was cut. */
export function trimOutput(output: unknown, maxBytes: number = TOOL_LIMITS.outputMaxBytes): { output: unknown; truncated: boolean } {
  if (bytes(output) <= maxBytes) return { output, truncated: false };
  return { output: shrink(output, maxBytes), truncated: true };
}

/**
 * What every source collector shares (see meta.ts for a full example): a polite cached fetch, the window, and writing
 * .data/knowledge/sources/<name>.jsonl. LIMIT=n in the environment caps each source at n documents, for a small test.
 * Collectors hold no keys and run on the collector machine (scripts/knowledge/aws/collector.py).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { KNOWLEDGE_DIR, pauseRequested } from "@/lib/knowledge/control";
import type { SourceRecord } from "@/lib/knowledge/sources";

export const OUT = path.join(KNOWLEDGE_DIR, "sources");
export const CACHE = path.join(OUT, "cache");
export const USER_AGENT = "MuseMuse-knowledge/0.1 (https://offlinebase.com)";
export const FROM = "2026-01-04";
export const TO = "2026-10-29";
export const LIMIT = Number(process.env.LIMIT ?? 0) || Infinity;
export { pauseRequested };

const lastCall = new Map<string, number>();

/** GET through the cache, at most one request per `gapMs` per host, retrying 429s and 5xx. Null on any other failure. */
export async function get(url: string, opts: { gapMs?: number; headers?: Record<string, string> } = {}): Promise<string | null> {
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, createHash("sha256").update(url).digest("hex").slice(0, 32));
  if (existsSync(file)) return readFile(file, "utf8");
  const host = new URL(url).host;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = (lastCall.get(host) ?? 0) + (opts.gapMs ?? 1000) - Date.now();
    lastCall.set(host, Date.now() + Math.max(wait, 0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...opts.headers }, signal: AbortSignal.timeout(120_000) });
    } catch {
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    if (res.ok) {
      const body = await res.text();
      await writeFile(file, body);
      return body;
    }
    if (res.status !== 429 && res.status < 500) {
      console.warn(`${res.status} ${url}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 0) * 1000 || 15_000 * (attempt + 1)));
  }
  console.warn(`gave up on ${url}`);
  return null;
}

/** Writes a source's records, unless a pause stopped it short, in which case the old file stays and a rerun carries on. */
export async function save(name: string, records: SourceRecord[]) {
  if (pauseRequested()) {
    console.log(`${name}: paused, file not written; run again to carry on.`);
    return;
  }
  await mkdir(OUT, { recursive: true });
  const kept = records.filter((r) => r.text.trim().length > 0).slice(0, LIMIT);
  const file = path.join(OUT, `${name}.jsonl`);
  if (kept.length === 0 && existsSync(file) && (await stat(file)).size > 0) {
    console.warn(`${name}: 0 documents this run, old file kept.`);
    return;
  }
  await writeFile(file, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
  console.log(`${name}: ${kept.length} documents, ${kept.reduce((n, r) => n + r.text.split(/\s+/).length, 0)} words`);
}

/**
 * Runs each source on its own, so one failing doesn't stop the rest. Names on the command line pick steps. SKIP_STEPS,
 * comma-separated parts of step names, leaves steps out: the collector machine uses it for steps that need a GitHub
 * token, because no credential goes on a machine (aws/box/collectors.sh, MAC_ONLY). Name such a step with "github" in it.
 */
export async function runAll(steps: Array<[string, () => Promise<SourceRecord[]>]>) {
  const only = process.argv.slice(2);
  const skip = (process.env.SKIP_STEPS ?? "").split(",").filter(Boolean);
  const chosen = steps.filter(([name]) => (only.length === 0 || only.includes(name)) && !skip.some((part) => name.includes(part)));
  await Promise.all(chosen.map(async ([name, run]) => {
    try {
      await save(name, await run());
    } catch (err) {
      console.warn(`${name} failed: ${(err as Error).message.slice(0, 300)}`);
    }
  }));
}

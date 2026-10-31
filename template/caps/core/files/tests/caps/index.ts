// Platform file (Muse Muse platform services). Don't edit: products wrap these helpers, never change them.
//
// Each platform service's test helpers record what they saw while the smoke test runs, one file per service:
// test-results/caps/<cap>.json, {"cap", "checks": [{"id", "ok", "detail", "shot"}]}. verify's caps step reads them next
// to the gateway's own record (scripts/caps-check.mjs). A check the product can't fake decides whether a service works.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CapCheck {
  /** Short and stable, like "second-browser". */
  id: string;
  ok: boolean;
  /** Plain words, like "Second browser, after a reload, saw the item". */
  detail?: string;
  /** The judge screenshot that shows it, by file name in test-results/judge/. */
  shot?: string;
}

const DIR = path.join(process.cwd(), "test-results", "caps");
const CAP = /^[a-z][a-z0-9-]*$/;

function fileFor(cap: string): string {
  if (!CAP.test(cap)) throw new Error(`"${cap}" isn't a platform service id.`);
  return path.join(DIR, `${cap}.json`);
}

/** What a service has recorded so far in this run. */
export function capChecks(cap: string): CapCheck[] {
  const file = fileFor(cap);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { checks?: CapCheck[] };
    return Array.isArray(parsed.checks) ? parsed.checks : [];
  } catch {
    return [];
  }
}

/** Records one check. The same id again replaces it, so a retried test doesn't count twice. */
export function recordCapCheck(cap: string, check: CapCheck): void {
  mkdirSync(DIR, { recursive: true });
  const checks = capChecks(cap).filter((c) => c.id !== check.id);
  checks.push({ id: String(check.id).slice(0, 80), ok: check.ok === true, ...(check.detail ? { detail: String(check.detail).slice(0, 300) } : {}), ...(check.shot ? { shot: check.shot } : {}) });
  writeFileSync(fileFor(cap), `${JSON.stringify({ cap, checks }, null, 2)}\n`);
}

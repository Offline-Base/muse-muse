/**
 * The shared-keys check in a build sandbox (docs/BUILD_KEYS.md). It runs after each verify of a build that has the
 * owner's keys, and again before it publishes. It reads the product's source tree, `public/`, `.next/static` and the
 * pages `next build` prerendered, and fails the build when any of them holds a key's value, plainly or in an obvious
 * encoding. The platform runs it, so it works in sandboxes from any builder snapshot, and the product can't change it.
 *
 * The values reach the script only as its own env, under the names the build already has them by. It prints file
 * paths and var names, never a value.
 */
import type { SharedLeak } from "@/lib/keys/shared";
import type { VerifySummary } from "@/lib/types";

/** The name of the step it adds to verify's summary. */
export const KEYS_STEP = "keys";

/**
 * Runs in the sandbox with Node: `node shared-scan.cjs <productDir> <NAME>...`. valueEncodings in lib/keys/shared.ts
 * makes the same forms. Skips dependencies, git, Muse Code's folder, test output, the user's inspo, env files and links.
 */
export const SHARED_SCAN_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const [root, ...names] = process.argv.slice(2);
const MIN = 12, MIN_ENC = 16, MAX_BYTES = 50 * 1024 * 1024, MAX_HITS = 20;
function encodings(value) {
  const raw = Buffer.from(value, "utf8");
  const out = new Set([value]);
  for (const k of [0, 1, 2]) {
    const buf = Buffer.concat([Buffer.alloc(k), raw]);
    const end = Math.floor(buf.length / 3) * 4;
    for (const enc of ["base64", "base64url"]) {
      const core = buf.toString(enc).slice(k ? 4 : 0, end);
      if (core.length >= MIN_ENC) out.add(core);
    }
  }
  out.add(encodeURIComponent(value));
  out.add(raw.toString("hex"));
  out.add(value.replace(/\\//g, "\\\\/"));
  return [...out].filter((s) => s.length >= MIN);
}
const needles = [];
for (const name of names) {
  const value = (process.env[name] || "").trim();
  if (value.length >= MIN) for (const t of encodings(value)) needles.push({ bytes: Buffer.from(t, "utf8"), name });
}
const SKIP = new Set(["node_modules", ".git", ".muse", ".vercel", "test-results", "playwright-report", "inspo"]);
const PRERENDERED = /\\.(html|rsc|body)$/;
const hits = [];
let scanned = 0;
function scanFile(rel) {
  if (hits.length >= MAX_HITS) return;
  const abs = path.join(root, rel);
  let size = 0;
  try { size = fs.statSync(abs).size; } catch { return; }
  if (size > MAX_BYTES) return;
  const buf = fs.readFileSync(abs);
  scanned++;
  const hit = needles.find((n) => buf.indexOf(n.bytes) >= 0);
  if (hit) hits.push({ file: rel, name: hit.name, why: "value" });
}
function walk(rel, filter) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const child = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) {
      if (!rel && e.name === ".next") {
        walk(".next/static", null);
        walk(".next/server", PRERENDERED);
        continue;
      }
      if (!SKIP.has(e.name)) walk(child, filter);
      continue;
    }
    if (!e.isFile() || e.name.startsWith(".env")) continue;
    if (filter && !filter.test(e.name)) continue;
    scanFile(child);
  }
}
if (needles.length) walk("", null);
console.log(JSON.stringify({ musemuse_keys: 1, scanned, hits }));
`;

/** The script's JSON line, or null when it printed none. */
export function parseScanOutput(stdout: string): { scanned: number; leaks: SharedLeak[] } | null {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{") && l.includes("musemuse_keys"));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as { scanned?: unknown; hits?: unknown };
    if (!Array.isArray(parsed.hits)) return null;
    const leaks = parsed.hits
      .filter((h): h is { file: string; name: string } => typeof h?.file === "string" && typeof h?.name === "string")
      .map((h) => ({ file: h.file, name: h.name, why: "value" as const }));
    return { scanned: Number(parsed.scanned) || 0, leaks };
  } catch {
    return null;
  }
}

/**
 * Verify's summary with the keys step added: passed when nothing leaked, else failed, with the files and names (never
 * the values) for the fix round. Null `leaks` means the check couldn't run, which adds nothing: the deploy checks again.
 */
export function withSharedKeyScan(summary: VerifySummary, leaks: readonly SharedLeak[] | null, lines: readonly string[]): VerifySummary {
  if (leaks === null) return summary;
  if (!leaks.length) return { ...summary, steps: [...summary.steps, { name: KEYS_STEP, ok: true, detail: "no shared key in the product's files" }] };
  const output = ["A key from the owner's shared accounts is in the product's files. Take it out and read it from process.env in server code:", ...lines].join("\n");
  return {
    ...summary,
    passed: false,
    steps: [...summary.steps, { name: KEYS_STEP, ok: false, detail: lines[0] ?? "a shared key is in the product's files" }],
    failureOutput: [summary.failureOutput, output].filter((t) => t.trim()).join("\n\n"),
  };
}

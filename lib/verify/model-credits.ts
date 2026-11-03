/**
 * The model-credits check (audit, Nov 3, finding 3). A product's screens credit models: `<ModelChip model="sam-3.1" />`
 * renders "Outlined by SAM 3.1", and some products write a credit as plain text. A credit is a claim that the model made
 * that output, so after each verify whose smoke run passed, the platform reads the product's UI source for credits and
 * holds them up against the gateway's own record of what this build's token called during that verify. A credited model
 * the gateway never saw called fails the check, and the fix round is told to call it for real or take the credit off.
 *
 * The platform runs it (lib/pipeline/build-steps.ts, collectVerifyStep), so it works in sandboxes from any builder
 * snapshot and product code can't change what the gateway saw. Models whose calls don't go through the gateway's usage
 * record (Muse Glimmer, the Jetson fleet) are never checked here, so they can't fail on missing evidence.
 */
import type { VerifySummary } from "@/lib/types";

/** The name of the step it adds to verify's summary. */
export const CREDITS_STEP = "model credits";

const CONTRIBUTOR = "muse-spark-1.3-contributor";
const WONDER = "muse-wonder-1.0";

/** Model ids a ModelChip may name (template/components/ModelChip.tsx). */
const CHIP_IDS = ["muse-wonder-1.0", "muse-image-1.0", "sam-3.1", "muse-voice-transcribe-1.0", "muse-glimmer", "jetson-fleet", "muse-spark-open"] as const;

/** The gateway's record can say whether these were called. Others are left alone. */
const CHECKED = new Set<string>([WONDER, CONTRIBUTOR, "muse-image-1.0", "sam-3.1", "muse-voice-transcribe-1.0", "muse-spark-open"]);

/** A model's name as a screen writes it, longest first so "SAM 3.1" wins over "SAM" and "Muse Spark Open" over "Muse Spark". */
const NAMES: ReadonlyArray<readonly [string, string]> = [
  ["Muse Spark 1.3 Contributor", CONTRIBUTOR],
  ["Spark 1.3 Contributor", CONTRIBUTOR],
  ["Muse Spark Open", "muse-spark-open"],
  ["Muse Spark 1.3", CONTRIBUTOR],
  ["Muse Spark", CONTRIBUTOR],
  ["Muse Wonder", WONDER],
  ["Muse Image", "muse-image-1.0"],
  ["Muse Voice Transcribe", "muse-voice-transcribe-1.0"],
  ["Voice Transcribe", "muse-voice-transcribe-1.0"],
  ["Muse Voice", "muse-voice-transcribe-1.0"],
  ["Muse Glimmer", "muse-glimmer"],
  ["Jetson fleet", "jetson-fleet"],
  ["SAM 3.1", "sam-3.1"],
  ["SAM 3", "sam-3.1"],
  ["SAM", "sam-3.1"],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** "by <model>" in text, case-sensitive so a person named Sam is never SAM. */
const TEXT_CREDIT = new RegExp(`\\bby\\s+(${NAMES.map(([n]) => escape(n).replace(/ /g, "\\s+")).join("|")})(?![A-Za-z0-9])`, "g");
const CHIP_TAG = /<ModelChip\b[^>]*>/g;
const CHIP_ID = new RegExp(`["'\`](${CHIP_IDS.map(escape).join("|")})["'\`]`, "g");

/** One credit found in the product's source. */
export interface ModelCredit {
  model: string;
  /** "chip" for a ModelChip, whose label names the model that really serves it; "text" for words the product wrote. */
  kind: "chip" | "text";
  file: string;
  /** What the screen says, like `Outlined by SAM 3.1` or `<ModelChip model="sam-3.1">`. */
  quote: string;
}

/** A source file the scan sent back. */
export interface SourceFile {
  file: string;
  text: string;
}

/** Comments out, so a note that says "credited by Muse Wonder" is never a credit. Strings keep their "//" (URLs). */
export function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(^|[\s;{}(),])\/\/[^\n"'`]*$/gm, "$1");
}

/** Every model credit in the files, one per model and kind, in the order found. */
export function creditsInSource(files: readonly SourceFile[]): ModelCredit[] {
  const out: ModelCredit[] = [];
  const seen = new Set<string>();
  const add = (c: ModelCredit) => {
    const key = `${c.kind}:${c.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const f of files) {
    if (!isUiSource(f.file)) continue;
    const text = withoutComments(f.text);
    for (const tag of text.match(CHIP_TAG) ?? []) {
      for (const m of tag.matchAll(CHIP_ID)) add({ model: m[1], kind: "chip", file: f.file, quote: `<ModelChip model="${m[1]}">` });
    }
    for (const m of text.matchAll(TEXT_CREDIT)) {
      const name = m[1].replace(/\s+/g, " ");
      const model = NAMES.find(([n]) => n === name)?.[1];
      if (model) add({ model, kind: "text", file: f.file, quote: `by ${name}` });
    }
  }
  return out;
}

/**
 * Screens and the code they use. Never tests, fixtures, skills or the chip's own definition, and never the platform's
 * own helpers in lib/meta/ and lib/platform/. Those come from the builder snapshot, not the product's writer: the
 * snapshot made before this check has askGlimmer's old "Answered by Muse Wonder" note in lib/meta/glimmer.ts, which
 * would fail every product under the switch until a new snapshot, and refinements of older products for good.
 */
export function isUiSource(file: string): boolean {
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/^(app|components|lib|src)\//.test(f)) return false;
  if (!/\.(tsx|jsx|ts|js|mdx)$/.test(f)) return false;
  if (/(^|\/)(__tests__|tests|node_modules|\.next)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f)) return false;
  if (/^(src\/)?lib\/(meta|platform)\//.test(f)) return false;
  return f !== "components/ModelChip.tsx";
}

/** How the gateway served a build's calls, for judging credits. */
export interface ServedModels {
  /** Models the gateway recorded for this build's tokens during the verify, as served (after any swap). */
  called: readonly string[];
  /**
   * Set when the live product's Muse Wonder calls run on another model too (BUILDS_ON_CONTRIBUTOR), so words that say
   * "Muse Wonder" would be untrue. Null when only the build's tests are swapped (TEST_MODEL) and the live product is on Wonder.
   */
  wonderServedBy: string | null;
}

/** Why one credit isn't true, or null when the gateway's record backs it. */
export function creditProblem(credit: ModelCredit, served: ServedModels): string | null {
  if (!CHECKED.has(credit.model)) return null;
  const called = new Set(served.called);
  const where = `${credit.file} (${credit.quote})`;
  if (credit.model === WONDER) {
    if (called.has(WONDER)) return null;
    if (called.has(CONTRIBUTOR)) {
      if (credit.kind === "chip" || !served.wonderServedBy) return null;
      return `${where} says Muse Wonder made this, but the gateway serves this product's muse-wonder-1.0 calls on ${served.wonderServedBy}. Keep calling muse-wonder-1.0, and credit it with <ModelChip model="muse-wonder-1.0" verb="..." />, which names the model that really runs, or say "an AI model".`;
    }
  } else if (called.has(credit.model)) return null;
  return `${where} credits ${credit.model}, but this check's smoke run never called ${credit.model} through the gateway. A credit means that model made this output. Call ${credit.model} for real in the flow the smoke test runs, or take the credit off.`;
}

/** Every credit that isn't true, one line each. */
export function creditProblems(credits: readonly ModelCredit[], served: ServedModels): string[] {
  return credits.map((c) => creditProblem(c, served)).filter((p): p is string => p !== null);
}

/**
 * Verify's summary with the credits step added. Nothing changes when no credit was found. `warn` (a new build's last
 * round, like the screen checks) keeps the step passing and names the problems in its detail, so a build only this would
 * stop still reaches the judge.
 */
export function withModelCredits(summary: VerifySummary, credits: readonly ModelCredit[], served: ServedModels, opts: { warn?: boolean } = {}): VerifySummary {
  const checked = credits.filter((c) => CHECKED.has(c.model));
  if (!checked.length) return summary;
  const problems = creditProblems(checked, served);
  if (!problems.length) {
    return { ...summary, steps: [...summary.steps, { name: CREDITS_STEP, ok: true, detail: `${checked.length} model credit(s) match the gateway's record` }] };
  }
  if (opts.warn) {
    return { ...summary, steps: [...summary.steps, { name: CREDITS_STEP, ok: true, detail: `warning: ${problems[0]}` }] };
  }
  const output = ["Model credits must be true. These credit a model the gateway didn't see make the output:", ...problems.map((p) => `- ${p}`)].join("\n");
  return {
    ...summary,
    passed: false,
    steps: [...summary.steps, { name: CREDITS_STEP, ok: false, detail: problems[0] }],
    failureOutput: [summary.failureOutput, output].filter((t) => t.trim()).join("\n\n"),
  };
}

/**
 * Runs in the sandbox with Node: `node credit-scan.cjs <productDir>`. Sends back the UI source files that may hold a
 * credit (isUiSource decides again on the platform). Skips dependencies, build output, tests, env files and links.
 */
export const CREDIT_SCAN_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const DIRS = ["app", "components", "lib", "src"];
const SKIP = new Set(["node_modules", ".next", "__tests__", "tests", ".git"]);
const EXT = /\\.(tsx|jsx|ts|js|mdx)$/;
const HINT = /ModelChip|\\bby\\s+(Muse|SAM|Spark|Voice|Jetson)/;
const MAX_FILE = 256 * 1024, MAX_TOTAL = 1024 * 1024;
const files = [];
let total = 0;
function walk(rel) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const child = rel + "/" + e.name;
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(child); continue; }
    if (!e.isFile() || !EXT.test(e.name) || /\\.(test|spec)\\./.test(e.name)) continue;
    let text = "";
    try { if (fs.statSync(path.join(root, child)).size > MAX_FILE) continue; text = fs.readFileSync(path.join(root, child), "utf8"); } catch { continue; }
    if (!HINT.test(text) || total + text.length > MAX_TOTAL) continue;
    total += text.length;
    files.push({ file: child, text });
  }
}
for (const d of DIRS) walk(d);
console.log(JSON.stringify({ musemuse_credits: 1, files }));
`;

/** The scan's JSON line, or null when it printed none. */
export function parseCreditScan(stdout: string): SourceFile[] | null {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("{") && l.includes("musemuse_credits"));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return null;
    return parsed.files.filter((f): f is SourceFile => typeof f?.file === "string" && typeof f?.text === "string");
  } catch {
    return null;
  }
}

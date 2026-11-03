/**
 * What a visitor may read about a build (the product page's "How it was built", and the build log's own summary).
 * Muse Code's raw tool log names the build machine's files, its session folders and ids, and echoes tool output such
 * as `<read-skill-result ...>` tags or a lone `{`. None of that helps a person, and the machine paths leak how the
 * sandbox is laid out. Pure, so the product page, the build steps and the tests share it.
 */

/** Where a product's source sits on the build machine (lib/sandbox/paths.ts PRODUCT_DIR). Its files keep their own path. */
const PRODUCT_DIR = "/vercel/app/";

/** An absolute path on a build or dev machine. Product paths are made relative before this runs. */
const MACHINE_PATH = /(?:^|(?<=[\s`'"(=:]))\/(?:vercel|tmp|private|var|root|home|Users|opt|srv|mnt|workspace|run|proc|etc)(?:\/[^\s`'")\],;]*)?/g;

/** A uuid, such as a Muse Code session or tool output id. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** A line that is only tool output noise: a bracket, an XML-ish tag, or nothing left to read. */
const NOISE_LINE = /^(?:[{}[\]()]+,?|<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>.*|[`'".,:;\s-]*)$/i;

/** Opens the product page's "How it was built" log line (registerStep): a raw tool list, kept for the build room. */
export const BUILT_LOG_PREFIX = "How it was built:";

/** Text with machine paths and ids taken out. Product files keep their path inside the product, such as app/page.tsx. */
export function scrubMachineText(text: string): string {
  return text
    .split(PRODUCT_DIR)
    .join("")
    .replace(MACHINE_PATH, "a file on the build machine")
    .replace(UUID, "")
    .replace(/`a file on the build machine`/g, "a file on the build machine")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/** One line a person can read, scrubbed, or null when nothing worth reading is left. */
export function visitorLine(text: string): string | null {
  const clean = scrubMachineText(text);
  if (!clean || NOISE_LINE.test(clean)) return null;
  // A line that only says the agent read a build machine file tells a visitor nothing.
  if (/^Read (?:text )?file a file on the build machine\.?$/i.test(clean)) return null;
  return clean;
}

/** The lines of a tool log a visitor may read, in order, with repeats next to each other dropped. */
export function visitorLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const clean = visitorLine(line);
    if (clean && out[out.length - 1] !== clean) out.push(clean);
  }
  return out;
}

/**
 * A build log note for the product page, or null to leave it out. The raw tool list (BUILT_LOG_PREFIX) is left out
 * whole: the page already says how many tool calls and edits there were. Any other note is scrubbed, and a note with
 * more than one line keeps only its first readable line.
 */
export function visitorNote(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith(BUILT_LOG_PREFIX)) return null;
  return visitorLines(trimmed.split("\n"))[0] ?? null;
}

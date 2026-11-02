/**
 * A folder or a zip for a run (TUNE_FOLDER, docs/TRAINING.md "Anyone can fine-tune"), the rules both sides share. Pure and
 * browser-safe. The browser reads files with these rules (./folder-read.ts) and sends only text; the server applies them
 * again (./folder-clean.ts), because a request can claim anything.
 */
export const FOLDER_LIMITS = {
  /** Files looked at in one folder. The rest are skipped and counted. */
  files: 300,
  /** One text file, and one PDF, before it is read. */
  fileBytes: 2 * 1024 * 1024,
  pdfBytes: 10 * 1024 * 1024,
  /** One zip, and everything read from a folder. */
  zipBytes: 30 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  /** The text kept from one file, and in all: what fits one request under Vercel's limit. */
  textChars: 200_000,
  totalChars: 1_500_000,
  /** A cleaned folder as Start sends it back. */
  draftChars: 1_500_000,
  /** What the writer reads of the files that aren't rows. */
  groundingChars: 40_000,
  /** A request's largest body, in bytes. */
  bodyBytes: 3_500_000,
};

/** A folder's rows train as they are from this many on (a run's own fewest, TUNE_MIN_EXAMPLES). Fewer guide the writer. */
export const FOLDER_ROWS_MIN = 40;

const TEXT_EXT = new Set("txt md markdown mdx rst tex org log adoc html htm xml yaml yml toml ini cfg conf".split(" "));
const CODE_EXT = new Set("js jsx ts tsx mjs cjs py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh sql css scss vue svelte r lua pl dart scala".split(" "));
const DATA_EXT = new Set("csv tsv json jsonl".split(" "));

const KEY_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials?(\..+)?|secrets?(\..+)?|known_hosts|authorized_keys|\.?npmrc|\.?netrc|\.?pgpass|service[-_]?account.*\.json)$/i;
const KEY_EXT = /\.(pem|key|p12|pfx|keystore|jks|crt|cer|der|asc|gpg|ppk|kdbx)$/i;
const ENV_NAME = /^\.?env(\..+)?$|\.env$/i;
const SKIP_DIR = new Set(["node_modules", "__pycache__", "__MACOSX", "venv", "vendor", "dist", "build", "target"]);

export type SkipReason = "hidden" | "env_file" | "key_file" | "not_text" | "too_big" | "too_many" | "unreadable" | "has_secret" | "nothing_left";

export const SKIP_WORDS: Record<SkipReason, string> = {
  hidden: "A hidden file or folder",
  env_file: "An environment file, which often holds keys",
  key_file: "A key or credentials file",
  not_text: "Not text, code, a document or data",
  too_big: "Over the size limit",
  too_many: "Over the limit on files",
  unreadable: "Couldn't be read",
  has_secret: "Holds a private key",
  nothing_left: "Nothing left to use",
};

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export type FileKind = "text" | "code" | "data" | "pdf";

/** A path as sent: forward slashes, no leading ./ or /. Windows and zip paths both come through here. */
export function normalPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.?\/)+/, "").slice(0, 300);
}

export function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at > 0 ? name.slice(at + 1).toLowerCase() : "";
}

/** What this path is by its name and size, or why it's skipped. A size of 0 or less means it isn't known yet. */
export function classifyFile(rawPath: string, size = 0): { ok: true; kind: FileKind } | { ok: false; reason: SkipReason } {
  const parts = normalPath(rawPath).split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  // Secrets first, so a hidden .env says why it matters.
  if (ENV_NAME.test(name)) return { ok: false, reason: "env_file" };
  if (KEY_NAME.test(name) || KEY_EXT.test(name)) return { ok: false, reason: "key_file" };
  if (parts.some((p) => p.startsWith(".") || SKIP_DIR.has(p))) return { ok: false, reason: "hidden" };
  const ext = extensionOf(name);
  const kind: FileKind | null = ext === "pdf" ? "pdf" : DATA_EXT.has(ext) ? "data" : CODE_EXT.has(ext) ? "code" : TEXT_EXT.has(ext) ? "text" : null;
  if (!kind) return { ok: false, reason: "not_text" };
  if (size > (kind === "pdf" ? FOLDER_LIMITS.pdfBytes : FOLDER_LIMITS.fileBytes)) return { ok: false, reason: "too_big" };
  return { ok: true, kind };
}

/** True when decoded text is really a binary file: a NUL, or mostly replacement characters. */
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8000);
  if (sample.includes("\u0000")) return true;
  const bad = sample.split("�").length - 1;
  return sample.length > 0 && bad / sample.length > 0.05;
}

/** What the browser sends to POST /api/train/folder. */
export interface FolderUpload {
  files: Array<{ path: string; text: string }>;
  skipped: SkippedFile[];
}

/** A cleaned folder, as POST /api/train/folder answers it and Start sends it back. */
export interface FolderDraft {
  /** "rows": the rows train as they are. "write": Spark 1.3 Contributor writes examples from `grounding`. */
  mode: "rows" | "write";
  rows: Array<{ prompt: string; answer: string }>;
  grounding: string;
}

/** The short review the person sees before planning. */
export interface FolderReview {
  used: Array<{ path: string; rows?: number; chars?: number; removedLines?: number }>;
  skipped: SkippedFile[];
  /** Rows left out for what looked like personal data or a secret, and lines taken out of text the same way. */
  droppedRows: number;
  removedLines: number;
  /** Rows past the caller's most. */
  cutRows: number;
  samples: Array<{ prompt: string; answer: string }>;
}

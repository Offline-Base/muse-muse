import { z } from "zod";
import { dataSignInOn } from "@/lib/caps/data/types";
import { datasetIds, vettedDatasets } from "@/lib/caps/files/datasets";
import { FILE_SCOPES, FILE_UPLOADERS, filesDatasetsOn, filesSearchOn, isFileScope, isFileUploaders, type FilesRule } from "@/lib/caps/files/types";

/**
 * The files cap's brief block (docs/CAPABILITIES.md, section 10): what people keep, in which one scope, who adds to a
 * shared space, whether the product searches its text, and up to 3 vetted datasets. The contract's
 * `{holds, scope, search, datasets}`, plus `uploads` (who adds to a shared space), which data's `writes` is for rows.
 */
export const MAX_DATASETS = 3;

export const FilesBriefBlock = z.object({
  /** What people keep, in a plain sentence: "Class notes as PDFs and photos of the whiteboard." */
  holds: z.string().min(1).max(200),
  scope: z.enum(FILE_SCOPES),
  /** For a shared space: owner, signed_in or anyone. Private scopes use owner (their own person). */
  uploads: z.enum(FILE_UPLOADERS),
  search: z.boolean(),
  datasets: z.array(z.string().max(48)).max(MAX_DATASETS),
});

export type FilesBrief = z.infer<typeof FilesBriefBlock>;

/**
 * The writer's block for the switches that are on: no user scope or signed-in uploaders while DATA_SIGN_IN is off, and
 * datasets only from the vetted list while FILES_DATASETS is on (else none). The stored brief keeps FilesBriefBlock.
 */
export function filesWriterBlock(opts: { signIn?: boolean; datasets?: boolean } = {}) {
  const signIn = opts.signIn ?? dataSignInOn();
  const ids = (opts.datasets ?? filesDatasetsOn()) ? datasetIds() : [];
  return FilesBriefBlock.extend({
    scope: signIn ? z.enum(FILE_SCOPES) : z.enum(["shared", "visitor", "owner"]),
    uploads: signIn ? z.enum(FILE_UPLOADERS) : z.enum(["owner", "anyone"]),
    datasets: ids.length ? z.array(z.enum(ids as [string, ...string[]])).max(MAX_DATASETS) : z.array(z.string()).max(0),
  });
}

/** The files block of a brief, or null, also for one that isn't in the block's shape (a stored brief isn't re-parsed). */
export function filesBlock(brief: object | null | undefined): FilesBrief | null {
  const block = (brief as { files?: unknown } | null | undefined)?.files;
  return block && typeof block === "object" && isFileScope((block as { scope?: unknown }).scope) ? (block as FilesBrief) : null;
}

/** The rules a product's files follow, from its brief's block. Null without one. */
export function filesRule(block: FilesBrief | null): FilesRule | null {
  if (!block) return null;
  const known = new Set(datasetIds());
  return {
    scope: block.scope,
    uploads: block.scope === "shared" && isFileUploaders(block.uploads) ? block.uploads : "owner",
    search: block.search === true,
    datasets: (Array.isArray(block.datasets) ? block.datasets : []).filter((d) => known.has(d)).slice(0, MAX_DATASETS),
  };
}

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "").trim() || s.slice(0, max));

/**
 * The writer's raw files block, cleaned before zod (normalizeRawBrief): text clipped; a private scope's uploads are the
 * owner's; with DATA_SIGN_IN off, or no data block that signs people in, a user scope becomes visitor and signed-in
 * uploaders become the owner (nobody could sign in); search is off while FILES_SEARCH is off; datasets only from the
 * vetted list, each once, at most 3, and none while FILES_DATASETS is off. Anything else is left for zod to report.
 */
export function normalizeFilesBlock(raw: unknown, opts: { signIn?: boolean; search?: boolean; datasets?: boolean } = {}): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const b = { ...(raw as Record<string, unknown>) };
  if (typeof b.holds === "string") b.holds = clip(b.holds.trim(), 200);
  const signIn = opts.signIn ?? dataSignInOn();
  if (!signIn) {
    if (b.scope === "user") b.scope = "visitor";
    if (b.uploads === "signed_in") b.uploads = "owner";
  }
  if (isFileScope(b.scope) && b.scope !== "shared") b.uploads = "owner";
  else if (b.scope === "shared" && !isFileUploaders(b.uploads)) b.uploads = "owner";
  if (!(opts.search ?? filesSearchOn())) b.search = false;
  if (!(opts.datasets ?? filesDatasetsOn())) b.datasets = [];
  else if (Array.isArray(b.datasets)) {
    const known = new Set(datasetIds());
    b.datasets = [...new Set(b.datasets.filter((d): d is string => typeof d === "string" && known.has(d)))].slice(0, MAX_DATASETS);
  }
  return b;
}

/** True when the brief's data block lets people sign in, which a files `user` scope needs. */
export function briefSignsIn(brief: object | null | undefined): boolean {
  const signIn = (brief as { data?: { signIn?: unknown } | null } | null | undefined)?.data?.signIn;
  return signIn === "optional" || signIn === "required";
}

/** The writer's rules (lib/caps/brief-fields.ts, CAP_WRITER_RULES), for the switches that are on. */
export function filesWriterRules(opts: { signIn?: boolean; search?: boolean; datasets?: boolean } = {}): readonly string[] {
  const signIn = opts.signIn ?? dataSignInOn();
  const search = opts.search ?? filesSearchOn();
  const datasets = (opts.datasets ?? filesDatasetsOn()) ? vettedDatasets() : [];
  return [
    "files: fill it only when the muse needs files people upload and come back to (notes, photos, recordings, PDFs), kept on the platform with no 24-hour limit, or a vetted public dataset. Otherwise null. A picture sent to the model once and not kept needs no files block.",
    "files.holds: what people keep, in a plain sentence.",
    signIn
      ? "files.scope: shared when everyone on the product sees the files; visitor when they stay with one browser; owner when only the product's owner keeps them; user when they follow a person who signs in (the data block must then let people sign in)."
      : "files.scope: shared when everyone on the product sees the files; visitor when they stay with one browser; owner when only the product's owner keeps them. People can't sign in to products yet.",
    signIn
      ? "files.uploads: for a shared scope, owner when only the product's owner adds files, signed_in when people who signed in add them, anyone when any visitor may. Private scopes use owner. Only the owner deletes shared files."
      : "files.uploads: for a shared scope, owner when only the product's owner adds files, anyone when any visitor may. Private scopes use owner. Only the owner deletes shared files.",
    search
      ? "files.search: true when the product finds things in the text of its files or saved items and shows where each answer came from. Otherwise false."
      : "files.search: false.",
    datasets.length
      ? `files.datasets: up to 3 ids from the vetted list, only when the muse needs that data: ${datasets.map((d) => `${d.id} (${d.title}, ${d.license.spdx})`).join("; ")}. Otherwise [].`
      : "files.datasets: [].",
    "Files that can hold personal details go only in a visitor, owner or user scope, never shared.",
  ];
}

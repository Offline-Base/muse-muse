/**
 * Turns saved versions into git commits. The same versions on the same parent always make the same commit ids, so a retry
 * after a lost database write finds the push already landed. Nothing here touches the network.
 */
import { holdsSecret, isHiddenPath, type VersionFile } from "@/lib/versions/policy";
import { commitObject, gitObject, writeTree, type GitObject, type Person } from "@/lib/github/git";

/** What one push reads and holds in a function. The newest versions that fit go; older ones are named as left out. */
export const MAX_PUSH_BYTES = 64 * 1024 * 1024;
/** GitHub warns above 50 MB and refuses above 100 MB. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const PARALLEL = 8;

export const COMMITTER: Person = { name: "Muse Muse", email: "noreply@musemuse.invalid" };

export interface HistoryVersion {
  number: number;
  title: string;
  status: string;
  at: Date;
  files: readonly VersionFile[];
}

export interface History {
  objects: GitObject[];
  head: string;
  lastNumber: number;
  /** Older versions that didn't fit in this push. */
  skipped: number;
}

export class TooBigToPush extends Error {}

/** Git refuses any path with a part spelled .git, in any case. */
const gitRefuses = (path: string) => path.split("/").some((p) => p.toLowerCase() === ".git");
/**
 * A workflow would run on the person's GitHub account as soon as it landed, and it may come from someone else's public
 * source. GitHub also refuses a whole push holding one unless the token has the workflow scope, which this never asks for.
 */
const isWorkflow = (path: string) => /^\.github\/workflows\//i.test(path);
const pushable = (f: VersionFile) => !f.held && Boolean(f.url) && !isHiddenPath(f.path) && !gitRefuses(f.path) && !isWorkflow(f.path) && f.size <= MAX_FILE_BYTES;

/** One line for the commit's title. A change request that holds a key shape isn't copied into a repo that may be public. */
export function safeTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").trim().slice(0, 120);
  return !line || holdsSecret(Buffer.from(line)) ? "Change" : line;
}

function leftOutLines(v: HistoryVersion): string[] {
  const lines: string[] = [];
  for (const f of v.files) {
    if (isHiddenPath(f.path) || gitRefuses(f.path)) continue;
    if (isWorkflow(f.path)) lines.push(`${f.path} (GitHub workflow, add it yourself if you want it to run)`);
    else if (f.held) lines.push(`${f.path} (looks like it holds a secret)`);
    else if (f.size > MAX_FILE_BYTES) lines.push(`${f.path} (too big for a repo)`);
  }
  return lines;
}

export async function buildHistory(input: {
  versions: readonly HistoryVersion[];
  parent: string | null;
  /** The version the parent holds: what the remote already has need not be sent again. */
  previous?: HistoryVersion | null;
  author: Person;
  /** A saved file's checked bytes, or null when it must not be published. Throws when it can't be read. */
  readFile(file: VersionFile): Promise<Buffer | null>;
  maxBytes?: number;
}): Promise<History> {
  const max = input.maxBytes ?? MAX_PUSH_BYTES;
  const ordered = [...input.versions].sort((a, b) => a.number - b.number);
  if (!ordered.length) throw new Error("nothing to push");

  // The newest versions whose new bytes fit.
  const counted = new Set<string>();
  let total = 0;
  let keepFrom = ordered.length;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const fresh = ordered[i]!.files.filter((f) => pushable(f) && !counted.has(f.sha));
    const bytes = [...new Map(fresh.map((f) => [f.sha, f.size])).values()].reduce((a, b) => a + b, 0);
    if (total + bytes > max) break;
    total += bytes;
    fresh.forEach((f) => counted.add(f.sha));
    keepFrom = i;
  }
  if (keepFrom === ordered.length) throw new TooBigToPush();
  const kept = ordered.slice(keepFrom);
  const previous = input.previous && input.previous.files.filter(pushable).reduce((s, f) => s + f.size, 0) <= max ? input.previous : null;

  // Each distinct file is read once, across every version.
  const wanted = new Map<string, VersionFile>();
  for (const v of [...kept, ...(previous ? [previous] : [])]) for (const f of v.files) if (pushable(f)) wanted.set(f.sha, f);
  const blobs = new Map<string, GitObject | null>();
  const queue = [...wanted.values()];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const content = await input.readFile(f);
      blobs.set(f.sha, content ? gitObject("blob", content) : null);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const treeOf = (v: HistoryVersion, out: Map<string, GitObject>) => {
    const files: Array<{ path: string; blobId: string }> = [];
    const refused: string[] = [];
    for (const f of v.files) {
      if (!pushable(f)) continue;
      const blob = blobs.get(f.sha);
      if (blob) {
        out.set(blob.id, blob);
        files.push({ path: f.path, blobId: blob.id });
      } else refused.push(`${f.path} (looks like it holds a secret)`);
    }
    return { tree: writeTree(files, out), refused };
  };

  const known = new Map<string, GitObject>();
  if (previous) treeOf(previous, known);

  const objects = new Map<string, GitObject>();
  let parent = input.parent;
  kept.forEach((v, i) => {
    const { tree, refused } = treeOf(v, objects);
    const left = [...leftOutLines(v), ...refused];
    const notes = [`Status: ${v.status}`, ...(left.length ? ["Left out:", ...left.map((l) => `- ${l}`)] : []), ...(i === 0 && keepFrom > 0 ? [`${keepFrom} earlier version${keepFrom === 1 ? " was" : "s were"} too big to include.`] : [])];
    const commit = commitObject({ tree, parent, author: input.author, committer: COMMITTER, at: v.at, message: `Version ${v.number}: ${safeTitle(v.title)}\n\n${notes.join("\n")}` });
    objects.set(commit.id, commit);
    parent = commit.id;
  });
  for (const id of known.keys()) objects.delete(id);
  return { objects: [...objects.values()], head: parent!, lastNumber: kept.at(-1)!.number, skipped: keepFrom };
}

/**
 * What a product's Code page may show, and the pure parts of versions (docs/VERSIONS.md): no database, no network.
 */
import { createHash } from "node:crypto";
import { holdsSharedValue } from "@/lib/keys/shared";

/** One file of a saved version. `held` means its content looked like a secret, so it was never stored. */
export interface VersionFile {
  path: string;
  /** SHA-1 of the content, as Vercel takes it. */
  sha: string;
  size: number;
  /** Where the bytes are in storage. Server only: never sent to a browser. */
  url?: string;
  held?: true;
}

/** Never saved, shown or changed by a restore: settings, keys and the platform's own build files. */
const HIDDEN: ReadonlyArray<RegExp> = [
  /(^|\/)\.env[^/]*$/i,
  /(^|\/)\.(mcp\.json|npmrc|netrc|pypirc|htpasswd|git-credentials|dockercfg)$/i,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|tsbuildinfo)$/i,
  /(^|\/)(credentials|secrets?|service[-_]?account[^/]*)\.[a-z]+$/i,
  /^(brief|AGENTS|CLAUDE|BUILD_NOTES)\.md$/,
  /^(milestone|refine|fix)-\d+\.md$/,
  /^musemuse\.(caps|target)\.json$/,
  /(^|\/)(\.agents|\.muse|\.git|\.vercel|\.aws|\.ssh|node_modules|\.next|__pycache__)\//,
  /^(fixtures|inspo|test-results|playwright-report)\//,
  /(^|\/)\.DS_Store$/,
];

/** A relative path with no way out of its folder. */
export function isSafePath(path: string): boolean {
  if (!path || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((s) => s && s !== "." && s !== "..");
}

/** True for a path the Code page never holds. An unsafe path counts as hidden too. */
export function isHiddenPath(path: string): boolean {
  return !isSafePath(path) || HIDDEN.some((r) => r.test(path));
}

const SECRET: ReadonlyArray<RegExp> = [
  /mm_(?:build|live)_[A-Za-z0-9_-]{20,}|mm_sandbox_[0-9a-f]{20,}/,
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{20,}/,
  /\bvercel_blob_rw_[A-Za-z0-9_]{20,}/,
];

/** Native programs (Muse Code's binary or anything like it) are never kept either. */
function isExecutable(c: Buffer): boolean {
  if (c.length < 4) return false;
  const magic = c.readUInt32BE(0);
  return magic === 0x7f454c46 || magic === 0xcafebabe || magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xcffaedfe || (c[0] === 0x4d && c[1] === 0x5a);
}

/**
 * True when these bytes must not be stored or shown. latin1 keeps every byte, so a key inside a binary is found too.
 * The owner's shared keys (docs/BUILD_KEYS.md) count in any obvious encoding, so the Code page, source.zip and the
 * GitHub export never carry one.
 */
export function holdsSecret(content: Buffer): boolean {
  if (isExecutable(content)) return true;
  const text = content.toString("latin1");
  return SECRET.some((r) => r.test(text)) || holdsSharedValue(content);
}

export const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");

/**
 * Who may read a product's code: whoever can edit it, and everyone else only once they made it public. Private by default,
 * since the secret check only knows key shapes and a password typed into code would be readable. A taken-down product has
 * no page for anyone; one its owner switched off stays theirs.
 */
export function canReadCode(product: { status: string; takenDownAt: Date | null; sourcePublic: boolean }, canEdit: boolean): boolean {
  if (product.takenDownAt) return false;
  if (canEdit) return true;
  return product.sourcePublic && product.status !== "disabled";
}

/** The one file a request names, only ever found by exact match in the version's list, so a crafted path finds nothing. */
export function findFile(files: readonly VersionFile[], path: string | null | undefined): VersionFile | null {
  if (!path || isHiddenPath(path)) return null;
  return files.find((f) => f.path === path) ?? null;
}

/** A saved list as it may be shown: anything hidden is dropped again, in case the rules grew since it was saved. */
export const visibleFiles = (files: readonly VersionFile[]): VersionFile[] => files.filter((f) => !isHiddenPath(f.path));

// ---------- Commits ----------

export interface CommitBuild {
  id: string;
  kind: "build" | "refine";
  status: string;
  message: string | null;
  startedAt: Date;
  costUsd: number;
}

export interface Commit extends CommitBuild {
  /** 1 for the first build, counted over every build, so a number never changes. */
  number: number;
  kept: boolean;
}

/** One commit per build, newest first. */
export function commitsFrom(builds: readonly CommitBuild[], kept: ReadonlySet<string>): Commit[] {
  return [...builds]
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .map((b, i) => ({ ...b, number: i + 1, kept: kept.has(b.id) }))
    .reverse();
}

/** The nearest earlier commit with saved files: what this one is compared with. */
export function previousKept(commits: readonly Commit[], number: number): Commit | null {
  return commits.find((c) => c.number < number && c.kept) ?? null;
}

// ---------- Changes between versions ----------

export type Change = { path: string; change: "added" | "changed" | "removed" };

export function changedFiles(before: readonly VersionFile[], after: readonly VersionFile[]): Change[] {
  const old = new Map(before.map((f) => [f.path, f.sha]));
  const now = new Map(after.map((f) => [f.path, f.sha]));
  const changes: Change[] = [];
  for (const [path, sha] of now) {
    if (!old.has(path)) changes.push({ path, change: "added" });
    else if (old.get(path) !== sha) changes.push({ path, change: "changed" });
  }
  for (const path of old.keys()) if (!now.has(path)) changes.push({ path, change: "removed" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export type DiffLine = { kind: "same" | "add" | "del"; text: string; oldLine: number | null; newLine: number | null };

/** The biggest table the line diff fills; past this a file says it's too big to compare. */
const DIFF_CELLS = 4_000_000;

/** A line diff by longest common subsequence after trimming what matches at both ends. Null when too big to compare. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > DIFF_CELLS) return null;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[start + i] === b[start + j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  const same = (text: string) => out.push({ kind: "same", text, oldLine: oldLine++, newLine: newLine++ });
  for (let k = 0; k < start; k++) same(a[k]!);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      same(a[start + i]!);
      i++;
      j++;
    } else if (j < m && (i === n || table[i]![j + 1]! >= table[i + 1]![j]!)) {
      out.push({ kind: "add", text: b[start + j]!, oldLine: null, newLine: newLine++ });
      j++;
    } else {
      out.push({ kind: "del", text: a[start + i]!, oldLine: oldLine++, newLine: null });
      i++;
    }
  }
  for (let k = endA; k < a.length; k++) same(a[k]!);
  return out;
}

/** Only the changed lines and three around each, with null where lines were skipped. */
export function diffHunks(lines: readonly DiffLine[], around = 3): Array<DiffLine | null> {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.kind !== "same") for (let k = Math.max(0, i - around); k <= Math.min(lines.length - 1, i + around); k++) keep[k] = 1;
  });
  const out: Array<DiffLine | null> = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.at(-1) !== null && out.length) out.push(null);
  });
  if (out.at(-1) === null) out.pop();
  return out;
}

// ---------- Restore ----------

/**
 * What a restore does to the sandbox. The target's stored files that differ get written; other files go, except hidden
 * ones and held ones, which stay as they are (they were never saved, so nothing could put them back).
 */
export function restorePlan(current: ReadonlyArray<{ path: string; sha: string }>, target: readonly VersionFile[]): { write: VersionFile[]; remove: string[] } {
  const now = new Map(current.map((f) => [f.path, f.sha]));
  const wanted = new Set(target.map((f) => f.path));
  return {
    write: target.filter((f) => !f.held && f.url && !isHiddenPath(f.path) && now.get(f.path) !== f.sha),
    remove: current.map((f) => f.path).filter((p) => !wanted.has(p) && !isHiddenPath(p)),
  };
}

// ---------- The file tree ----------

export interface TreeNode {
  name: string;
  path: string;
  file: VersionFile | null;
  children: TreeNode[];
}

/** Folders first, then files, each by name. */
export function fileTree(files: readonly VersionFile[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", file: null, children: [] };
  for (const f of files) {
    let at = root;
    const parts = f.path.split("/");
    parts.forEach((name, i) => {
      const last = i === parts.length - 1;
      let next = last ? undefined : at.children.find((c) => c.name === name && !c.file);
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join("/"), file: last ? f : null, children: [] };
        at.children.push(next);
      }
      at = next;
    });
  }
  const sort = (n: TreeNode[]) => {
    n.sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
    n.forEach((c) => sort(c.children));
  };
  sort(root.children);
  return root.children;
}

/** True for bytes that read as text: no NUL in the first 8 KB. */
export const isText = (b: Buffer) => !b.subarray(0, 8192).includes(0);

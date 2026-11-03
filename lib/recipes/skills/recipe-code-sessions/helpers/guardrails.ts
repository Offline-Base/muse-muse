/**
 * Which writes may touch the files that hold an agent's own rules, after Meta's immutable-guardrails recipe (04/05), for
 * a product's own agent on a workspace held in memory (recipe-code-sessions, Part 2). Copy it to lib/sim/guardrails.ts.
 * It imports nothing.
 *
 * Two checks, both decided on the path before the write runs:
 * - a mediated write (edit_file, write_file) to a guardrail path stops for a person, who may allow this one write or
 *   reject it, and nothing is ever recorded that would allow a later one;
 * - a shell write to a read-only directory fails as the OS sandbox would fail it: "Read-only file system".
 */

/** Components that make a path a guardrail path for the mediated-write review. */
export const REVIEW_DIRS: readonly string[] = [".git", ".muse", ".agents", ".husky"];
/** Directories the simulated sandbox keeps read-only under the workspace root. */
export const READ_ONLY_DIRS: readonly string[] = [".git", ".muse", ".agents", ".sl", ".hg", ".eden"];
/** Shell startup files, checked by name. */
export const STARTUP_FILES: readonly string[] = [".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".gitconfig"];

/** A workspace-relative path with `.` and `..` resolved, or null when it climbs out of the workspace. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** True when a mediated write to this path must stop for a person. A path outside the workspace counts as one. */
export function needsReview(path: string): boolean {
  const p = normalizePath(path);
  if (p === null) return true;
  const parts = p.split("/");
  if (parts.some((c) => REVIEW_DIRS.includes(c))) return true;
  if (p === ".envrc") return true;
  return STARTUP_FILES.includes(parts[parts.length - 1] ?? "");
}

/** True when the simulated sandbox refuses a shell write here. */
export function readOnlyForShell(path: string): boolean {
  const p = normalizePath(path);
  if (p === null) return true;
  return READ_ONLY_DIRS.includes(p.split("/")[0] ?? "");
}

export type WriteRoute = "apply" | "review" | "read_only";

/** What happens to a write: it applies, it waits for a person, or the sandbox refuses it. */
export function routeWrite(path: string, via: "edit_file" | "write_file" | "shell"): WriteRoute {
  if (via === "shell") return readOnlyForShell(path) ? "read_only" : "apply";
  return needsReview(path) ? "review" : "apply";
}

/** The only two answers a guardrail review offers. There is no "always allow". */
export const REVIEW_CHOICES = ["allow_once", "reject"] as const;
export type ReviewChoice = (typeof REVIEW_CHOICES)[number];

/** The error text a refused shell write returns to the model, as the OS would. */
export function readOnlyError(path: string): string {
  return `${path}: Read-only file system`;
}

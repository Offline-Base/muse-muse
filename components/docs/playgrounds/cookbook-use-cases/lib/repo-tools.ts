import type { FnToolDef } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { exactEdit, globFiles, grepFiles, listDir, normalizePath, readNumbered, unifiedDiff } from "@/components/docs/playgrounds/cookbook-use-cases/lib/vfs";

/**
 * OpenCode's built-in file tools (read, grep, glob, list, edit, write) over a virtual checkout, for the agent demos
 * that work in a repo: the error-screenshot fix and the GitHub agent. Their names and behavior follow what the
 * recipes show: read returns numbered lines, grep returns "path:line:text", edit needs oldString to match exactly
 * once. Nothing here touches a real disk.
 */

const s = (description: string) => ({ type: "string", description });

export const REPO_TOOL_DEFS: Record<"read" | "grep" | "glob" | "list" | "edit" | "write", FnToolDef> = {
  read: {
    name: "read",
    description: "Read a file from the repository. Returns its lines numbered like cat -n. Use offset and limit for long files.",
    parameters: {
      type: "object",
      properties: { path: s("File path relative to the repo root"), offset: { type: "integer" }, limit: { type: "integer" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  grep: {
    name: "grep",
    description: "Search file contents with a regular expression. Returns matching lines as path:line:text.",
    parameters: {
      type: "object",
      properties: { pattern: s("A regular expression"), include: s("Optional glob to limit the files, such as *.{ts,tsx}") },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  glob: {
    name: "glob",
    description: "Find files by glob pattern, such as **/*.tsx.",
    parameters: { type: "object", properties: { pattern: s("A glob pattern") }, required: ["pattern"], additionalProperties: false },
  },
  list: {
    name: "list",
    description: "List the files and folders in a directory of the repository.",
    parameters: { type: "object", properties: { path: s("Directory path; empty for the root") }, required: ["path"], additionalProperties: false },
  },
  edit: {
    name: "edit",
    description: "Replace oldString with newString in a file. oldString must match the file's text exactly once; read the file first.",
    parameters: {
      type: "object",
      properties: { path: s("File path"), oldString: s("The exact text to replace"), newString: s("The replacement text") },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
  },
  write: {
    name: "write",
    description: "Create or overwrite a whole file.",
    parameters: { type: "object", properties: { path: s("File path"), content: s("The complete file") }, required: ["path", "content"], additionalProperties: false },
  },
};

export interface RepoToolResult {
  output: string;
  ok: boolean;
  /** The file tree after the call (unchanged for reads). */
  files: Record<string, string>;
  /** For edits and writes: the unified diff of the change. */
  diff?: string;
}

/** Runs one repo tool call. Unknown names return null, so a demo can handle its own tools first. */
export function runRepoTool(name: string, args: Record<string, unknown>, files: Record<string, string>): RepoToolResult | null {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  switch (name) {
    case "read": {
      const out = readNumbered(files, str("path"), Number(args.offset) || 1, Number(args.limit) || 400);
      return out === null ? { output: `Error: file not found: ${str("path")}`, ok: false, files } : { output: out, ok: true, files };
    }
    case "grep": {
      const hits = grepFiles(files, str("pattern"), { include: str("include") || undefined, max: 60 });
      return { output: hits.length ? hits.join("\n") : "No matches found", ok: true, files };
    }
    case "glob": {
      const hits = globFiles(files, str("pattern") || "**/*");
      return { output: hits.length ? hits.join("\n") : "No files found", ok: true, files };
    }
    case "list": {
      const entries = listDir(files, str("path"));
      return { output: entries.length ? entries.join("\n") : `Error: no such directory: ${str("path")}`, ok: entries.length > 0, files };
    }
    case "edit": {
      const path = normalizePath(str("path"));
      const before = files[path];
      if (before === undefined) return { output: `Error: file not found: ${path}`, ok: false, files };
      const r = exactEdit(before, str("oldString"), str("newString"));
      if (!r.ok) return { output: `Error: ${r.error}`, ok: false, files };
      const next = { ...files, [path]: r.content };
      return { output: `Edited ${path}.`, ok: true, files: next, diff: unifiedDiff(path, before, r.content) };
    }
    case "write": {
      const path = normalizePath(str("path"));
      if (!path) return { output: "Error: path is required", ok: false, files };
      const next = { ...files, [path]: str("content") };
      return { output: `Wrote ${path}.`, ok: true, files: next, diff: unifiedDiff(path, files[path], str("content")) };
    }
    default:
      return null;
  }
}

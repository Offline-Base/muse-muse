/**
 * Shell text for the Muse Code builders: quoting a prompt so it survives the reader's shell, and setting an
 * environment variable, in POSIX shells (macOS, Linux, CI runners) and PowerShell (Windows, where Muse Code itself
 * runs agent commands through PowerShell). Pure, so the builders and their tests agree on every character.
 */

export type Shell = "posix" | "powershell";

/** Arguments that need no quotes in either shell: flags, ids, paths and numbers. */
const BARE = /^[A-Za-z0-9_\-./:=@%+,]+$/;

/**
 * One argument as the shell should see it. Double quotes when they read naturally (Meta's examples write prompts
 * that way), single quotes when the text holds characters a double-quoted string would expand or end on.
 */
export function quoteArg(value: string, shell: Shell = "posix"): string {
  if (value && BARE.test(value)) return value;
  if (shell === "powershell") {
    if (!/["$`]/.test(value)) return `"${value}"`;
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (!/["$`\\!]/.test(value)) return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A command line from its parts: each part is quoted unless it's already shell syntax (a {raw} part). */
export function commandLine(parts: ReadonlyArray<string | { raw: string }>, shell: Shell = "posix"): string {
  return parts
    .filter((p) => (typeof p === "string" ? p.length > 0 : p.raw.length > 0))
    .map((p) => (typeof p === "string" ? quoteArg(p, shell) : p.raw))
    .join(" ");
}

/** `export NAME="value"` in a POSIX shell, `$env:NAME = "value"` in PowerShell. `value` is written as given. */
export function setEnv(name: string, value: string, shell: Shell = "posix"): string {
  return shell === "powershell" ? `$env:${name} = ${value}` : `export ${name}=${value}`;
}

/** Bytes a string takes as UTF-8, for limits the docs state in bytes (session messages, workflow files). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

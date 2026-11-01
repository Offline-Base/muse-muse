// Platform file (Muse Muse platform services). Don't edit: use runPython, runJavaScript and runOnServer, which return this.
//
// What one run of a program gives back, wherever it ran, so CodeOutput shows them all the same way.

export type CodeRuntime = "pyodide" | "quickjs" | "exec";

export interface CodeRun {
  runtime: CodeRuntime;
  /** ok: it finished. error: it raised or exited with a code. timeout: it was stopped at its limit. */
  status: "ok" | "error" | "timeout";
  stdout: string;
  stderr: string;
  /** The exit code, for a program run on the platform. */
  exitCode?: number | null;
  /** True when stdout or stderr was cut at 64 KB. */
  truncated: boolean;
  /** How long the program itself ran. */
  ms: number;
}

/** Each stream is cut here, as on the platform. */
export const OUTPUT_MAX_CHARS = 64 * 1024;

/** Appends to a stream without going past OUTPUT_MAX_CHARS. Returns the new text and whether it was cut. */
export function appendCapped(current: string, more: string): { text: string; cut: boolean } {
  if (current.length >= OUTPUT_MAX_CHARS) return { text: current, cut: more.length > 0 };
  const room = OUTPUT_MAX_CHARS - current.length;
  return more.length > room ? { text: current + more.slice(0, room), cut: true } : { text: current + more, cut: false };
}

interface RunNotes {
  pyodide: number;
  quickjs: number;
  last: { runtime: CodeRuntime; status: CodeRun["status"]; stdout: string } | null;
}

declare global {
  interface Window {
    __musemuseCode?: RunNotes;
  }
}

/**
 * Counts in-page runs on the page itself, for the smoke test's check (tests/caps/code.ts expectInPageRun): which engine
 * ran and the start of its output. Nothing leaves the browser.
 */
export function noteRun(run: CodeRun): void {
  if (typeof window === "undefined" || run.runtime === "exec") return;
  const notes = (window.__musemuseCode ??= { pyodide: 0, quickjs: 0, last: null });
  notes[run.runtime] += 1;
  notes.last = { runtime: run.runtime, status: run.status, stdout: run.stdout.slice(0, 2000) };
}

// Platform file (Muse Muse platform services). Don't edit: call runPython from client components.
//
// Python in the visitor's browser, with Pyodide. It runs in a worker, so the page stays responsive, and a run that goes
// past its time is stopped by ending the worker. The first run loads Pyodide (about 10 MB) from this product's own
// /api/musemuse/pyodide/ route, so it never reaches another site. The standard library only: no numpy, no pip.
//   const run = await runPython(code, { stdin });
//   <CodeOutput run={run} />
import { appendCapped, noteRun, type CodeRun } from "@/lib/platform/code-run";

export interface PythonOptions {
  /** What the program reads with input() or sys.stdin. */
  stdin?: string;
  /** The run's own limit, after Pyodide has loaded. 10 seconds by default, 30 at most. */
  timeoutMs?: number;
}

/** Where the product serves Pyodide's files from (app/api/musemuse/pyodide/[file]/route.ts). */
export const PYODIDE_PATH = "/api/musemuse/pyodide/";
const LOAD_TIMEOUT_MS = 90_000;

/**
 * The worker. Each run gets a fresh globals dict, so one run's names don't leak into the next. stdin is handed over
 * whole, then end of file.
 */
export const WORKER_SOURCE = `
let py = null;
async function load(base) {
  if (!py) {
    const { loadPyodide } = await import(base + "pyodide.mjs");
    py = await loadPyodide({ indexURL: base });
  }
  return py;
}
self.onmessage = async (event) => {
  const { id, kind, base, code, stdin } = event.data;
  if (kind === "load") {
    try { await load(base); self.postMessage({ id, ok: true }); }
    catch (err) { self.postMessage({ id, ok: false, error: String((err && err.message) || err) }); }
    return;
  }
  let stdout = "";
  let stderr = "";
  const started = performance.now();
  try {
    const pyodide = await load(base);
    pyodide.setStdout({ batched: (s) => { stdout += s + "\\n"; } });
    pyodide.setStderr({ batched: (s) => { stderr += s + "\\n"; } });
    let given = !stdin;
    pyodide.setStdin({ stdin: () => { if (given) return null; given = true; return stdin; } });
    const globals = pyodide.globals.get("dict")();
    try { await pyodide.runPythonAsync(code, { globals }); }
    finally { globals.destroy(); }
    self.postMessage({ id, ok: true, stdout, stderr, ms: performance.now() - started });
  } catch (err) {
    self.postMessage({ id, ok: false, stdout, stderr: stderr + String((err && err.message) || err), ms: performance.now() - started });
  }
};
`;

let worker: Worker | null = null;
let loaded: Promise<void> | null = null;
let nextId = 1;

function ask<T>(w: Worker, message: Record<string, unknown>, timeoutMs: number): Promise<T | "timeout"> {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      w.removeEventListener("message", onMessage);
      resolve("timeout");
    }, timeoutMs);
    function onMessage(event: MessageEvent) {
      if ((event.data as { id?: number })?.id !== id) return;
      clearTimeout(timer);
      w.removeEventListener("message", onMessage);
      resolve(event.data as T);
    }
    w.addEventListener("message", onMessage);
    w.postMessage({ id, ...message });
  });
}

function reset(): void {
  worker?.terminate();
  worker = null;
  loaded = null;
}

function base(): string {
  return new URL(PYODIDE_PATH, window.location.origin).href;
}

/** Starts loading Pyodide ahead of the first run, for a page that knows it will need it. */
export function preloadPython(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!worker) {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(url, { type: "module" });
    URL.revokeObjectURL(url);
  }
  const w = worker;
  loaded ??= ask<{ ok: boolean; error?: string }>(w, { kind: "load", base: base() }, LOAD_TIMEOUT_MS).then((reply) => {
    if (reply === "timeout" || !reply.ok) {
      reset();
      throw new Error("Python couldn't load in this browser. Reload the page and try again.");
    }
  });
  return loaded;
}

/** Runs a Python program in this browser. Never throws for the program's own errors: they come back in stderr. */
export async function runPython(code: string, opts: PythonOptions = {}): Promise<CodeRun> {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 10_000, 500), 30_000);
  await preloadPython();
  const w = worker!;
  const reply = await ask<{ ok: boolean; stdout: string; stderr: string; ms: number }>(w, { kind: "run", code, stdin: opts.stdin ?? "", base: base() }, timeoutMs);
  let run: CodeRun;
  if (reply === "timeout") {
    // The only way to stop Python mid-run here is to end its worker. The next run loads Pyodide again.
    reset();
    run = { runtime: "pyodide", status: "timeout", stdout: "", stderr: `The program was stopped after ${Math.round(timeoutMs / 1000)} seconds.`, truncated: false, ms: timeoutMs };
  } else {
    const out = appendCapped("", reply.stdout ?? "");
    const err = appendCapped("", reply.stderr ?? "");
    run = { runtime: "pyodide", status: reply.ok ? "ok" : "error", stdout: out.text, stderr: err.text, truncated: out.cut || err.cut, ms: Math.round(reply.ms ?? 0) };
  }
  noteRun(run);
  return run;
}

// Platform file (Muse Muse platform services). Don't edit: call runPython from client components.
//
// Python in the visitor's browser, with Pyodide, sealed off from the page. The page reads Pyodide's files from this
// product's own static folder (public/musemuse/pyodide/, copied from the pyodide package when the code overlay is
// installed) and hands their bytes to a hidden frame with sandbox="allow-scripts" and no other permission. That frame
// has an origin of its own, so it has no cookies, no storage and no way into the page or the product's routes. Its
// content security policy allows no network at all, and Pyodide runs in a worker inside it. After Pyodide loads, the
// worker also deletes fetch, XMLHttpRequest, WebSocket and the other ways out from its own scope, and the program's
// `js` module is an empty object. A run that goes past its time is stopped by removing the frame.
//   const run = await runPython(code, { stdin });
//   <CodeOutput run={run} />
import { appendCapped, noteRun, type CodeRun } from "@/lib/platform/code-run";

export interface PythonOptions {
  /** What the program reads with input() or sys.stdin. */
  stdin?: string;
  /** The run's own limit, after Pyodide has loaded. 10 seconds by default, 30 at most. */
  timeoutMs?: number;
}

/** Where the product serves Pyodide's files from: static files in public/, never a function route. */
export const PYODIDE_PATH = "/musemuse/pyodide/";
/** The five files Pyodide needs, all handed to the frame as bytes. */
export const PYODIDE_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"] as const;
const LOAD_TIMEOUT_MS = 90_000;

/**
 * A base that is never fetched. Pyodide asks for `indexURL + "pyodide.asm.wasm"`, and the worker's own fetch answers
 * only that, from the bytes it was handed. Everything else fails.
 */
export const PYODIDE_BASE = "https://pyodide.invalid/";

/** What the worker deletes from its own scope once Pyodide has loaded: every way it could reach a network or storage. */
export const SEALED_NAMES = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "EventSource",
  "WebTransport",
  "importScripts",
  "indexedDB",
  "caches",
  "cookieStore",
  "BroadcastChannel",
  "Worker",
  "SharedWorker",
  "FontFace",
  "fonts",
  "navigator",
  "postMessage",
] as const;

/**
 * The worker. It loads Pyodide from the bytes it was handed, then seals its scope. Each run gets a fresh globals dict, so
 * one run's names don't leak into the next. stdin is handed over whole, then end of file.
 */
export const WORKER_SOURCE = `
const BASE = ${JSON.stringify(PYODIDE_BASE)};
const SEALED = ${JSON.stringify(SEALED_NAMES)};
const post = self.postMessage.bind(self);
let py = null;
let files = null;
const bytesUrl = (name, type) => URL.createObjectURL(new Blob([files[name]], { type }));
function seal() {
  for (const name of SEALED) {
    for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      try { if (Object.getOwnPropertyDescriptor(o, name)) delete o[name]; } catch {}
    }
    try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch {}
  }
}
async function load(given) {
  if (py) return py;
  files = given;
  // Pyodide reads its wasm with fetch(indexURL + name). Here fetch answers only from the files handed in.
  self.fetch = async (input) => {
    const url = String((input && input.url) || input);
    const name = url.startsWith(BASE) ? url.slice(BASE.length) : "";
    if (!name || !Object.hasOwn(files, name)) throw new TypeError("Python in the browser has no network.");
    return new Response(files[name], { headers: { "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
  };
  const { loadPyodide } = await import(bytesUrl("pyodide.mjs", "text/javascript"));
  const asm = await import(bytesUrl("pyodide.asm.mjs", "text/javascript"));
  py = await loadPyodide({
    indexURL: BASE,
    lockFileContents: new TextDecoder().decode(files["pyodide-lock.json"]),
    stdLibURL: BASE + "python_stdlib.zip",
    createPyodideModule: asm.default,
    // The program's js module: nothing from this scope.
    jsglobals: {},
    packages: [],
  });
  files = null;
  seal();
  return py;
}
self.onmessage = async (event) => {
  const { id, kind, code, stdin } = event.data || {};
  if (kind === "load") {
    try { await load(event.data.files); post({ mm: "pyodide", id, ok: true }); }
    catch (err) { post({ mm: "pyodide", id, ok: false, error: String((err && err.message) || err) }); }
    return;
  }
  if (kind !== "run" || !py) return;
  let stdout = "";
  let stderr = "";
  const started = performance.now();
  try {
    py.setStdout({ batched: (s) => { stdout += s + "\\n"; } });
    py.setStderr({ batched: (s) => { stderr += s + "\\n"; } });
    let given = !stdin;
    py.setStdin({ stdin: () => { if (given) return null; given = true; return stdin; } });
    const globals = py.globals.get("dict")();
    try { await py.runPythonAsync(code, { globals }); }
    finally { globals.destroy(); }
    post({ mm: "pyodide", id, ok: true, stdout, stderr, ms: performance.now() - started });
  } catch (err) {
    post({ mm: "pyodide", id, ok: false, stdout, stderr: stderr + String((err && err.message) || err), ms: performance.now() - started });
  }
};
`;

/**
 * The frame's content security policy: scripts and the worker only from its own inline script and blob: URLs, wasm
 * allowed, and no network of any kind.
 */
export const FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The frame's page: it starts the worker and passes messages between it and the product's page, nothing else. A classic
 * worker, since Chromium won't start a module worker from a blob: URL in a frame with an opaque origin; the worker
 * imports Pyodide's modules with import(), which works there.
 */
export const FRAME_HTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><script>
const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER_SOURCE).replace(/</g, "\\u003c")}], { type: "text/javascript" })));
worker.onmessage = (event) => parent.postMessage(event.data, "*");
worker.onerror = (event) => parent.postMessage({ mm: "pyodide", kind: "crash", error: String(event.message || "error") }, "*");
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const files = event.data && event.data.files;
  worker.postMessage(event.data, files ? Object.values(files) : []);
});
parent.postMessage({ mm: "pyodide", kind: "ready" }, "*");
</script>`;

/** The frame's sandbox: scripts only. Never allow-same-origin, which would give it the product's cookies and routes. */
export const FRAME_SANDBOX = "allow-scripts";

let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
let loaded: Promise<void> | null = null;
let bytes: Promise<Record<string, ArrayBuffer>> | null = null;
let nextId = 1;

function fromFrame(event: MessageEvent): Record<string, unknown> | null {
  if (!frame || event.source !== frame.contentWindow) return null;
  const data = event.data as Record<string, unknown> | null;
  return data && typeof data === "object" && data.mm === "pyodide" ? data : null;
}

function ask<T>(message: Record<string, unknown>, transfer: Transferable[], timeoutMs: number): Promise<T | "timeout"> {
  const id = nextId++;
  const target = frame;
  return new Promise((resolve) => {
    const done = (value: T | "timeout") => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };
    const timer = setTimeout(() => done("timeout"), timeoutMs);
    function onMessage(event: MessageEvent) {
      const data = fromFrame(event);
      if (!data) return;
      if (data.kind === "crash") return done("timeout");
      if (data.id === id) done(data as T);
    }
    window.addEventListener("message", onMessage);
    // The frame has an opaque origin, so "*" is the only target that reaches it. It is our own frame, by reference.
    target?.contentWindow?.postMessage({ id, ...message }, "*", transfer);
  });
}

function reset(): void {
  frame?.remove();
  frame = null;
  ready = null;
  loaded = null;
}

/** Pyodide's five files from the product's own static folder, read once a page. */
function pyodideBytes(): Promise<Record<string, ArrayBuffer>> {
  bytes ??= Promise.all(
    PYODIDE_FILES.map(async (name) => {
      const res = await fetch(new URL(PYODIDE_PATH + name, window.location.origin), { credentials: "omit" });
      if (!res.ok) throw new Error(`${name}: ${res.status}`);
      return [name, await res.arrayBuffer()] as const;
    }),
  ).then(Object.fromEntries, (err) => {
    bytes = null;
    throw err;
  });
  return bytes;
}

function openFrame(): Promise<void> {
  if (ready) return ready;
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", FRAME_SANDBOX);
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  f.style.display = "none";
  f.srcdoc = FRAME_HTML;
  frame = f;
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("frame"));
    }, 15_000);
    function onMessage(event: MessageEvent) {
      if (fromFrame(event)?.kind !== "ready") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve();
    }
    window.addEventListener("message", onMessage);
  });
  document.body.appendChild(f);
  return ready;
}

/** Starts loading Pyodide ahead of the first run, for a page that knows it will need it. */
export function preloadPython(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  loaded ??= (async () => {
    const [files] = await Promise.all([pyodideBytes(), openFrame()]);
    // Copies go to the frame, so a reload after a timeout needs no second download.
    const copies = Object.fromEntries(Object.entries(files).map(([name, buf]) => [name, buf.slice(0)]));
    const reply = await ask<{ ok: boolean; error?: string }>({ kind: "load", files: copies }, Object.values(copies), LOAD_TIMEOUT_MS);
    if (reply === "timeout" || !reply.ok) throw new Error("load");
  })().catch(() => {
    reset();
    throw new Error("Python couldn't load in this browser. Reload the page and try again.");
  });
  return loaded;
}

/** Runs a Python program in this browser. Never throws for the program's own errors: they come back in stderr. */
export async function runPython(code: string, opts: PythonOptions = {}): Promise<CodeRun> {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 10_000, 500), 30_000);
  await preloadPython();
  const reply = await ask<{ ok: boolean; stdout: string; stderr: string; ms: number }>({ kind: "run", code, stdin: opts.stdin ?? "" }, [], timeoutMs);
  let run: CodeRun;
  if (reply === "timeout") {
    // The only way to stop Python mid-run here is to end its frame. The next run starts Pyodide again.
    reset();
    run = { runtime: "pyodide", status: "timeout", stdout: "", stderr: `The program was stopped after ${Math.round(timeoutMs / 1000)} seconds.`, truncated: false, ms: timeoutMs };
  } else {
    const out = appendCapped("", typeof reply.stdout === "string" ? reply.stdout : "");
    const err = appendCapped("", typeof reply.stderr === "string" ? reply.stderr : "");
    run = { runtime: "pyodide", status: reply.ok ? "ok" : "error", stdout: out.text, stderr: err.text, truncated: out.cut || err.cut, ms: Math.round(typeof reply.ms === "number" ? reply.ms : 0) };
  }
  noteRun(run);
  return run;
}

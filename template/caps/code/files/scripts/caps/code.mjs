// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for running code. Which ones apply comes from the gateway's record of this build's brief
// (`brief:pyodide`, `brief:quickjs`, `brief:exec`, `brief:browse`), which product code can't write:
//   in-page       the smoke test ran the platform's fixture in the browser and the page showed its exact output
//                 (tests/caps/code.ts expectInPageRun), when the brief has pyodide or quickjs
//   pyodide-files the product serves Pyodide's five files as static files (public/musemuse/pyodide/), each the same
//                 bytes as the installed pyodide package's, when the brief has pyodide. The live product loads them
//                 from there, so a deploy needs them in the product, not behind a function route
//   exec-output   the page showed the fixture's exact output from a server run, and the gateway saw a run finish in
//                 this build's space since this verify started, when the brief has exec
//   browse-page   the page showed a recorded sample page, and the gateway handed this build one since this verify
//                 started, when the brief has browse
//   muse-code-run the page showed a Muse Code task's files and final answer (tests/caps/muse-code.ts
//                 expectMuseCodeRun), and the gateway saw a real session in this build that worked: it made files and said
//                 what it did. In this build, not this verify: a build gets 2 real tasks and many verifies, and once they
//                 are used the page plays the recording, so a verify after them rests on the real run before it. An exit
//                 code alone never counts. When the brief has museCode
//
// What these checks rest on: the fixture's numbers change every run, so its output can't be written into the product
// ahead of time; the in-page counts are the page's own, which a product that wanted to could fake. The run counts come
// from the gateway.

import { readFileSync } from "node:fs";
import path from "node:path";

/** The files lib/platform/pyodide.ts reads, and where the code overlay's copies.json puts them. */
export const PYODIDE_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
export const PYODIDE_STATIC_DIR = "public/musemuse/pyodide";

/** Each static copy against the installed package: missing or changed ones by name, or null when all match. */
export function pyodideFilesProblem(root) {
  const bad = [];
  for (const name of PYODIDE_FILES) {
    let served = null;
    let installed = null;
    try {
      served = readFileSync(path.join(root, PYODIDE_STATIC_DIR, name));
    } catch {}
    try {
      installed = readFileSync(path.join(root, "node_modules", "pyodide", name));
    } catch {}
    if (!served || !installed || !served.equals(installed)) bad.push(name);
  }
  return bad.length ? `${PYODIDE_STATIC_DIR}/ is missing or changed: ${bad.join(", ")}` : null;
}

const recorded = (record, id) => (Array.isArray(record?.checks) ? record.checks.find((c) => c?.id === id) : undefined);
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function check({ record, proof, root = process.cwd() }) {
  if (!proof) return [{ id: "brief", ok: false, detail: "the gateway's record of this build is missing" }];
  const wants = (part) => n(proof[`brief:${part}`]) > 0;
  const out = [];
  if (wants("pyodide") || wants("quickjs")) {
    const c = recorded(record, "in-page");
    out.push({ id: "in-page", ok: c?.ok === true, detail: c?.detail ?? "the smoke test didn't run the fixture in the page (expectInPageRun)" });
  }
  if (wants("pyodide")) {
    const problem = pyodideFilesProblem(root);
    out.push({ id: "pyodide-files", ok: !problem, detail: problem ?? `Pyodide's ${PYODIDE_FILES.length} files are static files in ${PYODIDE_STATIC_DIR}/` });
  }
  if (wants("exec")) {
    const c = recorded(record, "exec-output");
    const ok = n(proof.execOk);
    out.push({
      id: "exec-output",
      ok: c?.ok === true && ok > 0,
      detail: c?.ok !== true ? (c?.detail ?? "the smoke test didn't check a server run's output (expectExecOutput)") : ok > 0 ? `${c.detail}; the gateway saw ${ok} finished run${ok === 1 ? "" : "s"}` : "the gateway saw no program finish in this build",
    });
  }
  if (wants("browse")) {
    const c = recorded(record, "browse-page");
    const pages = n(proof.browse);
    out.push({
      id: "browse-page",
      ok: c?.ok === true && pages > 0,
      detail: c?.ok !== true ? (c?.detail ?? "the smoke test didn't check an opened page (expectBrowsePage)") : pages > 0 ? c.detail : "the gateway opened no page for this build",
    });
  }
  if (wants("museCode")) {
    const c = recorded(record, "muse-code-run");
    const worked = n(proof.museCodeWorked);
    const ran = n(proof.museCode);
    out.push({
      id: "muse-code-run",
      ok: c?.ok === true && worked > 0,
      detail:
        c?.ok !== true
          ? (c?.detail ?? "the smoke test didn't check a real Muse Code task (expectMuseCodeRun)")
          : worked > 0
            ? `${c.detail}; the gateway saw ${worked} task${worked === 1 ? "" : "s"} make files`
            : ran > 0
              ? "the gateway saw the task end without making files"
              : "the gateway ran no real Muse Code task for this build",
    });
  }
  if (!out.length) out.push({ id: "brief", ok: false, detail: "the gateway's record names nothing this build runs" });
  return out;
}

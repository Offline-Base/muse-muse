// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for running code. Which ones apply comes from the gateway's record of this build's brief
// (`brief:pyodide`, `brief:quickjs`, `brief:exec`, `brief:browse`), which product code can't write:
//   in-page       the smoke test ran the platform's fixture in the browser and the page showed its exact output
//                 (tests/caps/code.ts expectInPageRun), when the brief has pyodide or quickjs
//   exec-output   the page showed the fixture's exact output from a server run, and the gateway saw a run finish in
//                 this build's space since this verify started, when the brief has exec
//   browse-page   the page showed a recorded sample page, and the gateway handed this build one since this verify
//                 started, when the brief has browse
//
// What these checks rest on: the fixture's numbers change every run, so its output can't be written into the product
// ahead of time; the in-page counts are the page's own, which a product that wanted to could fake. The run counts come
// from the gateway.

const recorded = (record, id) => (Array.isArray(record?.checks) ? record.checks.find((c) => c?.id === id) : undefined);
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function check({ record, proof }) {
  if (!proof) return [{ id: "brief", ok: false, detail: "the gateway's record of this build is missing" }];
  const wants = (part) => n(proof[`brief:${part}`]) > 0;
  const out = [];
  if (wants("pyodide") || wants("quickjs")) {
    const c = recorded(record, "in-page");
    out.push({ id: "in-page", ok: c?.ok === true, detail: c?.detail ?? "the smoke test didn't run the fixture in the page (expectInPageRun)" });
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
  if (!out.length) out.push({ id: "brief", ok: false, detail: "the gateway's record names nothing this build runs" });
  return out;
}

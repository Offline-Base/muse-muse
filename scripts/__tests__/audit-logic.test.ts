/**
 * The audit's pure parts (scripts/batch/audit-logic.ts): flagged answers, a run's problems, pass or fail, the focus
 * paragraph, the markdown summary and the in-page scripts. Made-up runs, no browser.
 *   npx tsx --test scripts/__tests__/audit-logic.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FLOW_STATE_SCRIPT,
  LAYOUT_SCRIPT,
  MARK_PRIMARY_SCRIPT,
  answerFlags,
  auditMarkdown,
  countedConsoleError,
  fileSafe,
  judgeProduct,
  runProblems,
  type ViewportRun,
} from "../batch/audit-logic";
import { focusMap } from "../batch/logic";
import { playwrightDirs } from "../audit-batch";

const clean = (viewport: ViewportRun["viewport"], extra: Partial<ViewportRun> = {}): ViewportRun => ({
  viewport,
  loaded: true,
  sampleLabel: "Try the sample",
  actionLabel: "Make my board",
  result: "shown",
  resultText: "Three boards for the made-up bakery",
  seconds: 18,
  consoleErrors: [],
  failedApi: [],
  flaggedAnswers: [],
  sidewaysPx: 0,
  smallTaps: [],
  cutOff: [],
  screenshots: [],
  ...extra,
});
const base = { label: "boards", buildId: "00000000-0000-4000-8000-000000000001", slug: "rustic-bakery-boards", name: "Rustic Bakery Boards", liveUrl: "https://boards.example.app" };

describe("answer flags", () => {
  it("names model: false, fallback, estimate and error, one level down too", () => {
    assert.deepEqual(answerFlags({ model: false, fallback: true }), ["model: false", "fallback: true"]);
    assert.deepEqual(answerFlags({ result: { estimate: true }, items: [{ fallback: true }] }), ["result.estimate: true"]);
    assert.deepEqual(answerFlags({ error: "Model timed out" }), ['error: "Model timed out"']);
    assert.deepEqual(answerFlags({ error: { code: "rate_limited" } }), ['error: {"code":"rate_limited"}']);
  });
  it("leaves a clean answer alone", () => {
    assert.deepEqual(answerFlags({ model: true, fallback: false, estimate: false, error: null, text: "ok" }), []);
    assert.deepEqual(answerFlags([{ fallback: true }]), []);
    assert.deepEqual(answerFlags(null), []);
  });
});

describe("a run's problems", () => {
  it("passes a clean run on both sizes", () => {
    assert.deepEqual(runProblems(clean("desktop")), []);
    assert.deepEqual(runProblems(clean("phone")), []);
  });
  it("names every problem the spec lists", () => {
    const p = runProblems(
      clean("phone", {
        result: "timeout",
        seconds: 150,
        consoleErrors: ["TypeError: x is undefined"],
        failedApi: [{ path: "/api/board", status: 500 }],
        flaggedAnswers: [{ path: "/api/board", flags: ["fallback: true"] }],
        sidewaysPx: 38,
        smallTaps: ["Reset (32x32)", "x (20x20)"],
        cutOff: ["Total for the week"],
      }),
    );
    assert.equal(p.length, 7);
    assert.match(p[0], /"Try the sample" then "Make my board" showed no finished result within 150 s on a phone/);
    assert.match(p.join("\n"), /\/api\/board 500/);
    assert.match(p.join("\n"), /\/api\/board: fallback: true/);
    assert.match(p.join("\n"), /scrolls sideways by 38 px/);
    assert.match(p.join("\n"), /2 control\(s\) are under 44x44 px to tap: "Reset \(32x32\)", "x \(20x20\)"/);
    assert.match(p.join("\n"), /cut off at the right edge on a phone \(390x844\): "Total for the week"/);
  });
  it("counts small tap targets only on the phone", () => {
    assert.deepEqual(runProblems(clean("desktop", { smallTaps: ["Reset (32x32)"] })), []);
  });
  it("fails a page that didn't load, a missing sample, an error box and a flow with nothing to press", () => {
    assert.deepEqual(runProblems(clean("desktop", { loaded: false, loadNote: "HTTP 500" })), ["the page didn't load on desktop (1440x900) (HTTP 500)"]);
    assert.match(runProblems(clean("desktop", { sampleLabel: null, result: "none" })).join(), /no "Try the sample" control/);
    assert.match(runProblems(clean("desktop", { result: "error", errorText: "Couldn't read the photo" })).join(), /ended on an error on desktop \(1440x900\): "Couldn't read the photo"/);
    assert.match(runProblems(clean("desktop", { result: "none", actionLabel: null })).join(), /no main button to press and no result/);
  });
});

describe("pass, fail and focus", () => {
  it("passes a product with clean runs and gives it no focus", () => {
    const a = judgeProduct({ ...base, runs: [clean("desktop"), clean("phone")] });
    assert.equal(a.pass, true);
    assert.equal(a.focus, undefined);
  });
  it("fails with one focus paragraph that names what to fix, without em dashes", () => {
    const a = judgeProduct({ ...base, runs: [clean("desktop"), clean("phone", { sidewaysPx: 12, smallTaps: ["Reset (30x30)"] })] });
    assert.equal(a.pass, false);
    assert.equal(a.problems.length, 2);
    assert.match(a.focus!, /^An automated audit opened Rustic Bakery Boards on desktop at 1440x900 and on a phone at 390x844 and pressed "Try the sample", then "Make my board"\./);
    assert.match(a.focus!, /\(1\) the page scrolls sideways by 12 px on a phone \(390x844\); \(2\) 1 control\(s\) are under 44x44 px/);
    assert.match(a.focus!, /Keep the Meta UI look/);
    assert.doesNotMatch(a.focus!, /—|\n/);
  });
  it("fails a product with no runs", () => {
    assert.equal(judgeProduct({ ...base, runs: [] }).pass, false);
  });
  it("writes a summary polish can read back as a focus file", () => {
    const fail = judgeProduct({ ...base, runs: [clean("desktop", { consoleErrors: ["Uncaught boom"] })] });
    const ok = judgeProduct({ ...base, label: "ok", buildId: "00000000-0000-4000-8000-000000000002", slug: "ok-one", runs: [clean("desktop"), clean("phone")] });
    const report = { site: "https://www.example.com", startedAt: "2026-11-03T18:00:00Z", timeoutSeconds: 150, products: [fail, ok], skipped: [{ label: "late", buildId: "x", reason: "no live address yet (build building)" }] };
    const md = auditMarkdown(report, ".data/audit-x.json");
    assert.match(md, /1 of 2 products pass/);
    assert.match(md, /\| \*\*fail\*\* \| fail \(1\) \| not run \|/);
    assert.match(md, /\| pass \| pass, 18 s \| pass, 18 s \|/);
    assert.match(md, /## Skipped\n\n- late \(x\): no live address yet/);
    assert.match(md, /### Rustic Bakery Boards\n\nAn automated audit/);
    assert.doesNotMatch(md, /—/);
    const focus = focusMap(JSON.parse(JSON.stringify(report)));
    assert.equal(focus.get(base.buildId), fail.focus);
    assert.equal(focus.has("ok-one"), false);
  });
});

describe("small helpers and the in-page scripts", () => {
  it("skips favicon and resource-load noise in the console", () => {
    assert.equal(countedConsoleError("Failed to load resource: the server responded with a status of 500"), false);
    assert.equal(countedConsoleError("GET /favicon.ico 404"), false);
    assert.equal(countedConsoleError("Uncaught TypeError: x"), true);
  });
  it("makes safe screenshot names", () => {
    assert.equal(fileSafe("Rustic Bakery Boards!"), "rustic-bakery-boards");
    assert.equal(fileSafe("///"), "product");
  });
  it("in-page scripts are valid expressions with no runner helpers in them", () => {
    for (const s of [MARK_PRIMARY_SCRIPT, FLOW_STATE_SCRIPT, LAYOUT_SCRIPT]) {
      assert.doesNotThrow(() => new Function(`return ${s};`));
      assert.doesNotMatch(s, /__name|__publicField/);
    }
    assert.match(LAYOUT_SCRIPT, /44 - 0\.5/);
  });
  it("looks for playwright in the given folder first, then the repo's and the template's", () => {
    const dirs = playwrightDirs("/repo", "pw/node_modules");
    assert.equal(dirs[0], "/repo/pw/node_modules");
    assert.ok(dirs.includes("/repo/node_modules"));
    assert.ok(dirs.includes("/repo/template/node_modules"));
  });
});

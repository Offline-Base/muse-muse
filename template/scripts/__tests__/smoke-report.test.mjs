// Unit tests for scripts/smoke-report.mjs. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { finalShotProblems, glassesGateProblems, glassesProblems, judgeShotNotes, judgeShotProblems, reportTests, smokeReportProblems } from "../smoke-report.mjs";

/** A Playwright JSON report with one file suite per spec file, shaped like reporter "json" writes it. */
function report(files) {
  return {
    suites: Object.entries(files).map(([file, tests]) => ({
      title: file,
      file,
      specs: tests.map(([title, status, expectedStatus = status === "skipped" ? "skipped" : "passed"]) => ({
        title,
        file,
        tests: [{ projectName: "smoke", status, expectedStatus, results: [] }],
      })),
    })),
    stats: {},
  };
}

test("a run where every test passed has no problems", () => {
  const r = report({ "smoke.spec.ts": [["primary flow", "expected"]], "actions.spec.ts": [["count_birds", "expected"]] });
  assert.deepEqual(smokeReportProblems(r, { requireActions: true }), []);
});

test("skipped and fixme tests fail the step even though Playwright exited 0", () => {
  const r = report({ "smoke.spec.ts": [["primary flow", "expected"], ["needs gateway", "skipped"]] });
  const problems = smokeReportProblems(r);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 test\(s\) did not run/);
  assert.match(problems[0], /needs gateway/);
});

test("a smoke spec whose only test was skipped counts as not run", () => {
  const problems = smokeReportProblems(report({ "smoke.spec.ts": [["primary flow", "skipped"]] }));
  assert.ok(problems.some((p) => /smoke\.spec\.ts ran no tests/.test(p)));
});

test("a report with no smoke spec at all fails", () => {
  const problems = smokeReportProblems(report({ "actions.spec.ts": [["count_birds", "expected"]] }));
  assert.ok(problems.some((p) => /smoke\.spec\.ts ran no tests/.test(p)));
  assert.ok(smokeReportProblems({}).some((p) => /smoke\.spec\.ts ran no tests/.test(p)));
});

test("test.fail() tests that fail as expected don't count as passing", () => {
  const problems = smokeReportProblems(report({ "smoke.spec.ts": [["primary flow", "expected", "failed"]] }));
  assert.ok(problems.some((p) => /test\.fail\(\)/.test(p)));
});

test("actions.spec.ts must run when the product has actions", () => {
  const r = report({ "smoke.spec.ts": [["primary flow", "expected"]] });
  assert.deepEqual(smokeReportProblems(r), []);
  assert.ok(smokeReportProblems(r, { requireActions: true }).some((p) => /actions\.spec\.ts ran no tests/.test(p)));
});

test("nested describe suites and other projects are handled", () => {
  const r = {
    suites: [
      {
        title: "smoke.spec.ts",
        file: "smoke.spec.ts",
        specs: [],
        suites: [
          {
            title: "flow",
            file: "smoke.spec.ts",
            specs: [
              {
                title: "primary flow",
                file: "smoke.spec.ts",
                tests: [
                  { projectName: "smoke", status: "expected", expectedStatus: "passed" },
                  { projectName: "demo", status: "skipped", expectedStatus: "skipped" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(reportTests(r), [{ title: "primary flow", file: "smoke.spec.ts", status: "expected", expectedStatus: "passed" }]);
  assert.deepEqual(smokeReportProblems(r), []);
});

test("spec paths with a directory still match by file name", () => {
  const r = report({ "tests/smoke.spec.ts": [["primary flow", "flaky"]] });
  assert.deepEqual(smokeReportProblems(r), []);
});

test("judge screenshots must come from judgeShot", () => {
  assert.deepEqual(judgeShotProblems(["01-start.png", "01-start.checked", "02-result.png", "02-result.checked"]), []);
  assert.match(judgeShotProblems(["01-start.png", "01-start.checked", "02-result.png"])[0], /without judgeShot\(\): 02-result\.png/);
  assert.match(judgeShotProblems([])[0], /saved no judge screenshots/);
});

/**
 * A judge folder: each shot's .checked holds the errors and empty states judgeShot found on it (an array), or what
 * judgeShot measured (an object), or raw text.
 */
function judgeDir(shots) {
  const files = Object.fromEntries(
    Object.entries(shots).flatMap(([name, found]) => [
      [`${name}.png`, ""],
      [
        `${name}.checked`,
        typeof found === "string"
          ? found
          : JSON.stringify(Array.isArray(found) ? { problems: [], errorsAndEmpty: found } : { problems: [], errorsAndEmpty: [], ...found }),
      ],
    ]),
  );
  return [Object.keys(files), (f) => files[f]];
}

test("the last judge screenshot fails the run when it shows an error, an invalid field or an empty state", () => {
  const [names, read] = judgeDir({
    "01-start": ['an empty state: "No plan yet"'],
    "03-explained": ['an error: "Use two cell names like A1:A6."', 'an empty state: "No numbers to chart yet"'],
    "02-chart": [],
  });
  const problems = finalShotProblems(names, read);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^The last judge screenshot, 03-explained\.png, shows an error: "Use two cell names like A1:A6\."; an empty state: "No numbers to chart yet"\./);
  assert.match(problems[0], /even when showing it is correct/);
  assert.match(problems[0], /Take judge screenshots only in the primary flow in tests\/smoke\.spec\.ts\.$/);
  assert.ok(!problems[0].includes("\u2014"));
});

test("an empty state on an earlier screen is fine, and so is a clean last one", () => {
  const [names, read] = judgeDir({ "01-start": ['an empty state: "No plan yet"'], "02-plan": [] });
  assert.deepEqual(finalShotProblems(names, read), []);
});

test("the final screen check reads only the numbered order, and skips what it can't read", () => {
  // 10-done sorts after 09-review, so it is the last one.
  let [names, read] = judgeDir({ "09-review": ['an error: "Try again"'], "10-done": [] });
  assert.deepEqual(finalShotProblems(names, read), []);
  // .checked files from an older judgeShot have no errorsAndEmpty, and one that isn't JSON is skipped.
  [names, read] = judgeDir({ "01-start": '{"problems":[]}' });
  assert.deepEqual(finalShotProblems(names, read), []);
  [names, read] = judgeDir({ "01-start": "not json" });
  assert.deepEqual(finalShotProblems(names, read), []);
  assert.deepEqual(finalShotProblems([], () => ""), []);
});

test("the last judge screenshot fails when its result starts past 1,000 px or the page is over 4,000 px", () => {
  const [names, read] = judgeDir({
    "01-start": { resultTop: null, pageHeight: 1286 },
    "02-draft": { resultTop: 1340, pageHeight: 5321 },
  });
  const problems = finalShotProblems(names, read);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^The last judge screenshot, 02-draft\.png, starts its result 1,340 px down the page, past the 1,000 px/);
  assert.match(problems[0], /first element marked data-result, or else the first \.card\.ai/);
  assert.match(problems[0], /summary row with an Edit button/);
  assert.match(problems[1], /^The last judge screenshot, 02-draft\.png, is 5,321 px tall on a phone, more than 4,000 px\./);
  assert.match(problems[1], /Collapse long lists into <details> or a pager/);
  for (const p of problems) assert.ok(!p.includes("\u2014"));
});

test("a result near the top of a page up to 4,000 px passes, and so does a page with no result card", () => {
  for (const measured of [{ resultTop: 1000, pageHeight: 4000 }, { resultTop: 336, pageHeight: 1259 }, { resultTop: null, pageHeight: 3446 }, {}]) {
    const [names, read] = judgeDir({ "01-start": { resultTop: 2000, pageHeight: 9000 }, "02-result": measured });
    assert.deepEqual(finalShotProblems(names, read), [], JSON.stringify(measured));
  }
});

test("an error on the last screen and a buried result are both reported", () => {
  const [names, read] = judgeDir({ "03-done": { errorsAndEmpty: ['an empty state: "No plan yet"'], resultTop: 1302, pageHeight: 2350 } });
  const problems = finalShotProblems(names, read);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /shows an empty state: "No plan yet"/);
  assert.match(problems[1], /starts its result 1,302 px down the page/);
});

test("notes from any screenshot are listed with the screenshot's name", () => {
  const [names, read] = judgeDir({ "01-start": { notes: ['The start screen has no "Try the sample" button.'] }, "02-result": {}, "03-x": "not json" });
  assert.deepEqual(judgeShotNotes(names, read), ['01-start.png: The start screen has no "Try the sample" button.']);
  assert.deepEqual(judgeShotNotes([], () => ""), []);
});

/** One line of test-results/glasses/calls.jsonl, as tests/glasses.ts writes it. */
const glassesCall = (fields) => JSON.stringify({ t: 2000, project: "smoke", test: "primary flow", method: "capturePhoto", ok: true, ms: 500, ...fields });

test("a smoke run that took a photo through the glasses has no glasses problems", () => {
  const calls = [glassesCall({ method: "connect" }), glassesCall({}), ""].join("\n");
  assert.deepEqual(glassesProblems(calls), []);
});

test("no photo through the glasses is a problem that says how to fix it", () => {
  for (const calls of [null, undefined, "", glassesCall({ method: "connect" }), glassesCall({ method: "speak" })]) {
    const problems = glassesProblems(calls);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /installGlasses/);
    assert.match(problems[0], /tests\/glasses\.ts/);
  }
});

test("a photo that failed doesn't count", () => {
  assert.equal(glassesProblems(glassesCall({ ok: false, error: "capture_failed" })).length, 1);
});

test("only this run's smoke project counts", () => {
  assert.equal(glassesProblems(glassesCall({ project: "demo" })).length, 1);
  assert.equal(glassesProblems(glassesCall({ project: "studio" })).length, 1);
  assert.equal(glassesProblems(glassesCall({ t: 999 }), { since: 1000 }).length, 1);
  assert.deepEqual(glassesProblems(glassesCall({ t: 1000 }), { since: 1000 }), []);
});

test("verify's glasses check only runs for a glasses product, and only counts this run", () => {
  const files = (target, calls = null) => (file) => (file === "musemuse.target.json" ? target : file === "test-results/glasses/calls.jsonl" ? calls : null);
  // A web product, and every way of not being a glasses product.
  for (const target of [null, "not json", "null", '{"target":"web"}', '{"targets":["web","vr"]}']) {
    assert.deepEqual(glassesGateProblems(files(target)), [], String(target));
  }
  for (const target of ['{"target":"glasses"}', '{"targets":["web","glasses"]}']) {
    assert.equal(glassesGateProblems(files(target)).length, 1, "no calls at all");
    assert.equal(glassesGateProblems(files(target, glassesCall({ t: 999 })), { since: 1000 }).length, 1, "an older run's photo");
    assert.deepEqual(glassesGateProblems(files(target, glassesCall({ t: 1000 })), { since: 1000 }), []);
  }
});

test("verify runs the glasses check, timed from before Playwright starts", () => {
  const verify = readFileSync(new URL("../verify.mjs", import.meta.url), "utf8");
  assert.match(verify, /\bglassesGateProblems\b[^]*from "\.\/smoke-report\.mjs"/);
  const started = verify.indexOf("const smokeStarted = Date.now()");
  assert.ok(started > 0 && started < verify.indexOf('run(BIN("playwright"), ["test", "--project=smoke"'));
  assert.match(verify, /\.\.\.glassesGateProblems\(readText, \{ since: smokeStarted \}\)/);
});

test("a broken line in the call log is ignored", () => {
  assert.deepEqual(glassesProblems(`{"t":\n${glassesCall({})}\nnot json`), []);
  assert.equal(glassesProblems(`{"t":\nnull\n7`).length, 1);
});

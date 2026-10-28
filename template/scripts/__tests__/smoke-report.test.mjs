// Unit tests for scripts/smoke-report.mjs. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeShotProblems, reportTests, smokeReportProblems } from "../smoke-report.mjs";

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

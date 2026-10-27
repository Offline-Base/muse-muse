// Reads Playwright's JSON report (test-results/report.json) for verify's smoke step. Don't edit this file.
//
// Playwright exits 0 when tests are skipped, so verify checks the report as well: every test must have run and
// passed, and tests/smoke.spec.ts (plus tests/actions.spec.ts when the product has actions) must have run at least one.

const fileName = (file) => String(file ?? "").split(/[\\/]/).pop();

/** Every test in the report for one project: { title, file, status, expectedStatus }. */
export function reportTests(report, project = "smoke") {
  const tests = [];
  const visit = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.projectName && t.projectName !== project) continue;
        tests.push({ title: spec.title ?? "", file: fileName(spec.file ?? here), status: t.status, expectedStatus: t.expectedStatus });
      }
    }
    for (const child of suite.suites ?? []) visit(child, here);
  };
  for (const suite of report?.suites ?? []) visit(suite, suite.file);
  return tests;
}

/** Reasons a green Playwright run doesn't count. Empty when every test ran and passed. */
export function smokeReportProblems(report, { project = "smoke", requireActions = false } = {}) {
  const tests = reportTests(report, project);
  const name = (t) => `${t.file} "${t.title}"`;
  const problems = [];

  const skipped = tests.filter((t) => t.status === "skipped");
  if (skipped.length) {
    problems.push(
      `${skipped.length} test(s) did not run (skipped or fixme): ${skipped.map(name).join(", ")}. ` +
        "Every test must run with real model calls. Remove test.skip and test.fixme and fix the product instead.",
    );
  }
  const expectedToFail = tests.filter((t) => t.status !== "skipped" && t.expectedStatus && t.expectedStatus !== "passed");
  if (expectedToFail.length) {
    problems.push(`${expectedToFail.length} test(s) are marked test.fail(): ${expectedToFail.map(name).join(", ")}. Remove it and fix the product.`);
  }
  const ran = (file) => tests.some((t) => t.file === file && t.status !== "skipped");
  if (!ran("smoke.spec.ts")) problems.push("tests/smoke.spec.ts ran no tests. It must run the brief's primary flow.");
  if (requireActions && !ran("actions.spec.ts")) {
    problems.push("tests/actions.spec.ts ran no tests. It needs one request test per action in musemuse.json.");
  }
  return problems;
}

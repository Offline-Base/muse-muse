// Reads Playwright's JSON report (test-results/report.json) for verify's smoke step. Don't edit this file.
//
// Playwright exits 0 when tests are skipped, so verify checks the report as well: every test must have run and
// passed, and tests/smoke.spec.ts (plus tests/actions.spec.ts when the product has actions) must have run at least one.
// It also checks the judge screenshots: each one taken by judgeShot(), and the last one free of errors and empty states.

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

/**
 * Every judge screenshot must come from judgeShot() in tests/judge-shot.ts, which checks the screen first and leaves
 * a <name>.checked file next to the PNG. Takes the file names in test-results/judge/.
 */
export function judgeShotProblems(fileNames) {
  const shots = fileNames.filter((f) => f.endsWith(".png"));
  if (!shots.length) return ['The smoke test saved no judge screenshots. Take them with judgeShot(page, "01-start") from tests/judge-shot.ts.'];
  const unchecked = shots.filter((f) => !fileNames.includes(f.replace(/\.png$/, ".checked")));
  return unchecked.length
    ? [`Judge screenshots taken without judgeShot(): ${unchecked.join(", ")}. Take every one with judgeShot(page, "02-result") from tests/judge-shot.ts.`]
    : [];
}

/**
 * The judge fails a final screen that shows an error, a field marked invalid or an empty state anywhere on it, even
 * when showing it is correct. judgeShot() lists them as `errorsAndEmpty` in each <name>.checked, and this reads the
 * last screenshot's (they sort in order: 01-start, 02-result, ...). Takes the file names in test-results/judge/ and a
 * function that reads one of them as text.
 */
export function finalShotProblems(fileNames, read) {
  const last = fileNames.filter((f) => f.endsWith(".png")).sort().at(-1);
  if (!last) return [];
  let found;
  try {
    found = JSON.parse(read(last.replace(/\.png$/, ".checked"))).errorsAndEmpty;
  } catch {
    return [];
  }
  if (!Array.isArray(found) || !found.length) return [];
  return [
    `The last judge screenshot, ${last}, shows ${found.join("; ")}. Each is a visible role="alert", .error, ` +
      'aria-invalid="true" field or .empty with text in it, and the judge fails a final screen with one anywhere on it, ' +
      "even when showing it is correct. Change the product so the primary flow ends on its finished result with none " +
      "of them on screen: a later step shouldn't break an earlier input, an error clears once its input is fixed, a " +
      'confirmation like "Saved" is role="status", a result that found nothing says so in its result card, not as an ' +
      ".empty, and a section with nothing in it yet is filled first (the test presses its button) or stays hidden. " +
      "Take judge screenshots only in the primary flow in tests/smoke.spec.ts.",
  ];
}

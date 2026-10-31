// Reads Playwright's JSON report (test-results/report.json) for verify's smoke step. Don't edit this file.
//
// Playwright exits 0 when tests are skipped, so verify checks the report as well: every test must have run and
// passed, and tests/smoke.spec.ts (plus tests/actions.spec.ts when the product has actions) must have run at least one.
// It also checks the judge screenshots: each one taken by judgeShot(), and the last one free of errors and empty states,
// with its result near the top and the page not too long.

/** At phone size, the last screenshot's result must start within this many px of the top of the page. */
export const RESULT_TOP_MAX = 1000;
/** At phone size, the last screenshot's page must be at most this tall. */
export const PAGE_HEIGHT_MAX = 4000;

const fileName = (file) => String(file ?? "").split(/[\\/]/).pop();
const px = (n) => `${n.toLocaleString("en-US")} px`;

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

/** Each judge screenshot's <name>.checked, parsed, in order. Skips any it can't read. */
function checkedFiles(fileNames, read) {
  return fileNames
    .filter((f) => f.endsWith(".png"))
    .sort()
    .flatMap((shot) => {
      try {
        return [{ shot, checked: JSON.parse(read(shot.replace(/\.png$/, ".checked"))) ?? {} }];
      } catch {
        return [];
      }
    });
}

/**
 * What the judge marks down on the final screen. It fails one that shows an error, a field marked invalid or an empty
 * state anywhere on it, even when showing it is correct, and judges see a result far down a long page as buried.
 * judgeShot() writes `errorsAndEmpty`, `resultTop` and `pageHeight` in each <name>.checked, and this reads the last
 * screenshot's (they sort in order: 01-start, 02-result, ...). Takes the file names in test-results/judge/ and a
 * function that reads one of them as text.
 */
export function finalShotProblems(fileNames, read) {
  const last = fileNames.filter((f) => f.endsWith(".png")).sort().at(-1);
  const checked = checkedFiles(fileNames, read).find((c) => c.shot === last)?.checked;
  if (!checked) return [];
  const problems = [];
  const found = checked.errorsAndEmpty;
  if (Array.isArray(found) && found.length) {
    problems.push(
      `The last judge screenshot, ${last}, shows ${found.join("; ")}. Each is a visible role="alert", .error, ` +
        'aria-invalid="true" field or .empty with text in it, and the judge fails a final screen with one anywhere on it, ' +
        "even when showing it is correct. Change the product so the primary flow ends on its finished result with none " +
        "of them on screen: a later step shouldn't break an earlier input, an error clears once its input is fixed, a " +
        'confirmation like "Saved" is role="status", a result that found nothing says so in its result card, not as an ' +
        ".empty, and a section with nothing in it yet is filled first (the test presses its button) or stays hidden. " +
        "Take judge screenshots only in the primary flow in tests/smoke.spec.ts.",
    );
  }
  if (typeof checked.resultTop === "number" && checked.resultTop > RESULT_TOP_MAX) {
    problems.push(
      `The last judge screenshot, ${last}, starts its result ${px(checked.resultTop)} down the page, past the ` +
        `${px(RESULT_TOP_MAX)} the judge looks at first. The result is the first element marked data-result, or else the ` +
        "first .card.ai. Collapse the form that started the run into its summary row with an Edit button (meta-ui, The " +
        "result replaces the input). A tool the person keeps working in, like a board or a timer, marks its own surface " +
        "with data-result.",
    );
  }
  if (typeof checked.pageHeight === "number" && checked.pageHeight > PAGE_HEIGHT_MAX) {
    problems.push(
      `The last judge screenshot, ${last}, is ${px(checked.pageHeight)} tall on a phone, more than ${px(PAGE_HEIGHT_MAX)}. ` +
        "Collapse long lists into <details> or a pager, show each figure once, and keep extras that aren't the result " +
        "out of the primary flow.",
    );
  }
  return problems;
}

/**
 * A glasses product's smoke test must take a photo through tests/glasses.ts, or nothing has shown the product works
 * with glasses at all. Takes the text of test-results/glasses/calls.jsonl, or null when there is no such file. Only
 * the smoke project's calls count, from `since` (ms) on, so an older run's log can't pass for this one.
 */
export function glassesProblems(callsText, { since = 0, project = "smoke" } = {}) {
  const calls = String(callsText ?? "")
    .split("\n")
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  const took = calls.some((c) => c?.method === "capturePhoto" && c.ok === true && c.project === project && Number(c.t) >= since);
  return took
    ? []
    : [
        "A glasses product's smoke test must take at least one photo through the glasses. Call installGlasses(page, " +
          '{ photos: ["fixtures/pov-1.jpg"], question: "fixtures/question.wav" }) from tests/glasses.ts before page.goto, ' +
          "connect the glasses, then press the primary button so the product calls capture() (muse-glasses skill).",
      ];
}

/** Notes judgeShot() left on any screenshot, for verify to print without failing. */
export function judgeShotNotes(fileNames, read) {
  return checkedFiles(fileNames, read).flatMap(({ shot, checked }) =>
    Array.isArray(checked.notes) ? checked.notes.map((note) => `${shot}: ${note}`) : [],
  );
}

// Reads Playwright's JSON report (test-results/report.json) for verify's smoke step. Don't edit this file.
//
// Playwright exits 0 when tests are skipped, so verify checks the report as well: every test must have run and
// passed, and tests/smoke.spec.ts (plus tests/actions.spec.ts when the product has actions) must have run at least one.
// It also checks the judge screenshots: each one taken by judgeShot(), and the last one free of errors and empty states,
// with its result near the top and the page not too long. A VR product must also have a judge screenshot taken inside VR
// that isn't blank. And no action may answer the built-in sample with a fallback instead of the model, and no page may
// keep photos, audio or video in localStorage or sessionStorage.

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

/** Where judgeShot() records what each /api/actions/* route answered in the smoke run, one JSON line per answer. */
export const ACTION_LOG = "test-results/actions/responses.jsonl";

/** The fallback marks on one recorded answer's fields, as short phrases. Empty when it came from the model. */
export function fallbackMarks(fields) {
  const f = fields && typeof fields === "object" ? fields : {};
  const marks = [];
  if (f.model === false) marks.push('"model": false');
  if (f.fallback === true) marks.push('"fallback": true');
  if (f.estimate === true) marks.push('"estimate": true');
  if (typeof f.error === "string" && f.error.trim()) marks.push(`"error": "${f.error.trim().slice(0, 120)}"`);
  return marks;
}

/**
 * Actions that answered the smoke run's built-in sample with a fallback instead of the model: a 2xx JSON answer with
 * "model": false, "fallback": true, "estimate": true, or an "error" string next to the result. On the sample the model
 * works, so a fallback there means the model call failed and the page hid it. One line per action, then what to do.
 * Takes the text of ACTION_LOG, or null when there is none. Only the smoke project's answers from `since` (ms) on count.
 */
export function actionFallbackProblems(logText, { since = 0, project = "smoke" } = {}) {
  const byAction = new Map();
  for (const line of String(logText ?? "").split("\n")) {
    let rec;
    try {
      rec = line.trim() ? JSON.parse(line) : null;
    } catch {
      rec = null;
    }
    if (!rec || rec.project !== project || Number(rec.t) < since || typeof rec.action !== "string") continue;
    const entry = byAction.get(rec.action) ?? { calls: 0, fell: 0, marks: [] };
    entry.calls += 1;
    const marks = Number(rec.status) >= 200 && Number(rec.status) < 300 ? fallbackMarks(rec.fields) : [];
    if (marks.length) {
      entry.fell += 1;
      if (!entry.marks.length) entry.marks = marks;
    }
    byAction.set(rec.action, entry);
  }
  const bad = [...byAction].filter(([, e]) => e.fell > 0);
  if (!bad.length) return [];
  return [
    ...bad.map(
      ([action, e]) =>
        `The ${action} action answered ${e.fell} of ${e.calls} call(s) in the smoke run with a fallback, not the model: ${e.marks.join(", ")}.`,
    ),
    "On the built-in sample the model must answer every action. Find why the model call failed (the error above and the " +
      "server log's [model] lines say why: an image type Meta can't read, a timeout, a run limit) and fix that. The main " +
      "model action never has a local substitute: when the model fails, the route answers with an error status " +
      '(modelErrorResponse from lib/meta/errors) and the page shows it in a role="alert" with a retry (AGENTS.md).',
  ];
}

/**
 * Photos, audio or video a page saved in localStorage or sessionStorage, which judgeShot() writes as `storedMedia` in
 * each <name>.checked. Storage holds about 5 MB per site, so a few saves fill it and the next setItem throws, losing
 * the result. Takes the file names in test-results/judge/ and a function that reads one of them as text.
 */
export function storedMediaProblems(fileNames, read) {
  const seen = new Map();
  for (const { checked } of checkedFiles(fileNames, read)) {
    for (const item of Array.isArray(checked.storedMedia) ? checked.storedMedia : []) {
      const id = `${item?.storage}:${item?.key}`;
      if (!seen.has(id) || seen.get(id).chars < item.chars) seen.set(id, item);
    }
  }
  if (!seen.size) return [];
  const listed = [...seen.values()].map((m) => `${m.storage} "${m.key}" (${Math.round(Number(m.chars) / 1000).toLocaleString("en-US")}K characters)`);
  return [
    `The page keeps photos, audio or video in browser storage: ${listed.slice(0, 3).join(", ")}. localStorage and ` +
      "sessionStorage hold about 5 MB per site, so a few saves fill them and the next setItem throws, losing the result. " +
      "Keep media in IndexedDB (or only in memory) and save just text and ids in localStorage, inside a try/catch.",
  ];
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

/**
 * Where the product runs, from musemuse.target.json. `read` takes a path under the product and returns its text, or null
 * when it isn't there. A product without that file is a web product with nothing extra to check.
 */
export function productTargets(read) {
  try {
    const parsed = JSON.parse(read("musemuse.target.json") ?? "null");
    if (Array.isArray(parsed?.targets)) return parsed.targets.filter((t) => typeof t === "string");
    return typeof parsed?.target === "string" ? [parsed.target] : [];
  } catch {
    return [];
  }
}

/** The glasses check as verify runs it. `read` is as in productTargets. */
export function glassesGateProblems(read, { since = 0 } = {}) {
  return productTargets(read).includes("glasses") ? glassesProblems(read("test-results/glasses/calls.jsonl"), { since }) : [];
}

/**
 * A VR product's judge screenshots. judgeShot() in a session leaves `xr: true` and what it measured in <name>.checked. At
 * least one must be from inside VR, none blank or with nothing of the scene in view, and the last one free of alerts. Those
 * views also fail judgeShot itself, so this catches a report from a test that got round it. Takes the file names in test-results/judge/ and a function that
 * reads one of them as text. These stay failures when MUSEMUSE_SCREEN_CHECK=warn: a blank view isn't a matter of layout.
 */
export function xrShotProblems(fileNames, read) {
  const shots = checkedFiles(fileNames, read).filter(({ checked }) => checked.xr === true);
  if (!shots.length) {
    return ["A VR product's smoke test must enter VR with xr.enter(page) from tests/xr.ts and take at least one judgeShot inside it."];
  }
  const problems = [];
  const blank = shots.filter(({ checked }) => checked.canvas?.blank !== false).map(({ shot }) => shot);
  if (blank.length) problems.push(`These VR screenshots show a blank view: ${blank.join(", ")}. Light the scene and put something in front of the person.`);
  const empty = shots.filter(({ checked }) => checked.sceneObjects === 0).map(({ shot }) => shot);
  if (empty.length) problems.push(`Nothing is in front of the person in these VR screenshots: ${empty.join(", ")}. Put a lit scene 1 to 3 m ahead of where they arrive, or turn the head to it first with xr.look.`);
  const last = shots.at(-1);
  if (Array.isArray(last.checked.xrAlerts) && last.checked.xrAlerts.length) {
    problems.push(`The last VR screenshot, ${last.shot}, has an alert up: ${last.checked.xrAlerts.join("; ")}. The primary flow must end on its finished result.`);
  }
  return problems;
}

/** The VR check as verify runs it. `readText` is as in productTargets, and `fileNames` and `readShot` as in xrShotProblems. */
export function xrGateProblems(readText, fileNames, readShot) {
  return productTargets(readText).includes("vr") ? xrShotProblems(fileNames, readShot) : [];
}

/**
 * What Chromium launches with for this product: a target's settings in scripts/browser.json, or nothing for a web product.
 * `read` is as in productTargets.
 */
export function browserLaunchOptions(read) {
  if (!productTargets(read).includes("vr")) return {};
  try {
    const args = JSON.parse(read("scripts/browser.json") ?? "null")?.vr?.args;
    return Array.isArray(args) ? { args } : {};
  } catch {
    return {};
  }
}

/** The muse-vr skill's budget, and the frame rate under which a scene is too heavy for the sandbox's recording. */
export const XR_BUDGET = { drawCalls: 50, triangles: 30_000, fps: 15 };

/** What a VR shot's measurements say about the budget. Past it a scene still passes, and may stutter on a Quest. */
function xrBudgetNotes(checked) {
  if (checked.xr !== true) return [];
  const notes = [];
  if (checked.drawCalls > XR_BUDGET.drawCalls) notes.push(`The scene uses ${checked.drawCalls} draw calls, over the limit of ${XR_BUDGET.drawCalls} (muse-vr). Repeat a shape with one instancedMesh.`);
  if (checked.triangles > XR_BUDGET.triangles) notes.push(`The scene uses ${checked.triangles} triangles, over the limit of ${XR_BUDGET.triangles} (muse-vr). Use simpler shapes.`);
  if (checked.canvas?.fps < XR_BUDGET.fps) notes.push(`The view drew ${checked.canvas.fps} frames a second, which is too few for a smooth demo. Make the scene lighter (muse-vr).`);
  return notes;
}

/** Notes judgeShot() left on any screenshot, and a VR shot's budget notes, for verify to print without failing. */
export function judgeShotNotes(fileNames, read) {
  return checkedFiles(fileNames, read).flatMap(({ shot, checked }) =>
    [...(Array.isArray(checked.notes) ? checked.notes : []), ...xrBudgetNotes(checked)].map((note) => `${shot}: ${note}`),
  );
}

// ---------- Platform services (docs/CAPABILITIES.md, 2.8). Nothing here applies to a product without musemuse.caps.json ----------

/** verify's steps, in order. A product with platform services gets a caps step after smoke. */
export function verifyStepNames(capsActive, requirementsActive = false) {
  return ["typecheck", "build", "start", "console", "smoke", ...(capsActive ? ["caps"] : []), ...(requirementsActive ? ["requirements"] : []), "manifest"];
}

/** musemuse.requirements.json's list ({ id, savesData }), or null for a product without one, which verifies as before. */
export function readRequirementsFile(readText) {
  const text = readText("musemuse.requirements.json");
  if (text === null) return null;
  try {
    const list = JSON.parse(text)?.requirements;
    return Array.isArray(list) ? list.filter((r) => typeof r?.id === "string" && /^R[1-9][0-9]*$/.test(r.id)).map((r) => ({ id: r.id, savesData: r.savesData === true })) : [];
  } catch {
    return [];
  }
}

/** The id a requirement test's title starts with ("R3: edit a trip"), or null. */
function requirementIdOf(title) {
  return /^(R[1-9][0-9]*)\b/.exec(String(title ?? ""))?.[1] ?? null;
}

const testPassed = (t) => t.status === "expected" || t.status === "flaky" || t.status === "passed";

/** The source of a test with this id: from its title to the next test in the file. */
function requirementTestBody(source, id) {
  const at = source.search(new RegExp(`test\\s*\\(\\s*[\`'"]${id}\\b`));
  if (at < 0) return null;
  const next = source.slice(at + 1).search(/\btest\s*\(/);
  return next < 0 ? source.slice(at) : source.slice(at, at + 1 + next);
}

/**
 * What each requirement's own test did: one result per requirement. A requirement with no test, or any test of it that
 * failed, isn't met. One that saves data must call reload() in its own test's body.
 */
export function requirementResults(report, requirements, readSpec, { project = "smoke" } = {}) {
  const tests = reportTests(report, project);
  return requirements.map(({ id, savesData }) => {
    const own = tests.filter((t) => requirementIdOf(t.title) === id);
    if (!own.length) return { id, ok: false, detail: "No test is titled with this id." };
    const bad = own.find((t) => !testPassed(t));
    if (bad) return { id, ok: false, detail: `"${bad.title}" did not pass.` };
    if (savesData) {
      const body = own.map((t) => requirementTestBody(readSpec(t.file) ?? "", id)).find(Boolean);
      if (!body || !/\.reload\s*\(/.test(body)) return { id, ok: false, detail: "It saves data, but its test never reloads the page to see that it stayed." };
    }
    return { id, ok: true };
  });
}

/** True when the only tests that failed are these requirements' own, so everything else about the product still ran. */
export function onlyRequirementTestsFailed(report, requirements, { project = "smoke" } = {}) {
  const ids = new Set(requirements.map((r) => r.id));
  const failed = reportTests(report, project).filter((t) => t.status !== "skipped" && !testPassed(t));
  return failed.length > 0 && failed.every((t) => ids.has(requirementIdOf(t.title)));
}

/** musemuse.caps.json as { caps, overlays }, or null when the product has none (or it isn't valid). */
export function readCapsFile(readText) {
  const text = readText("musemuse.caps.json");
  if (text === null) return null;
  try {
    const file = JSON.parse(text);
    const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && /^[a-z][a-z0-9-]*$/.test(x)) : []);
    return { caps: ids(file?.caps), overlays: ids(file?.overlays) };
  } catch {
    return { caps: [], overlays: [] };
  }
}

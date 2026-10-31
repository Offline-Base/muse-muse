import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { autopilotFinished, evaluateCheck, evaluateGlasses, normalizeReport, parseAutopilot } from "../lib/rules.mjs";

const ORIGIN = "https://demo.vercel.app";
const SCREEN = { stddev: 40, dominantShare: 0.4, mean: 120, levels: 20 };
const REPORT = { finalUrl: `${ORIGIN}/`, httpStatus: 200, loadMs: 2100, textLength: 400, handshake: true, errors: [], crashed: false, loadError: null };
const base = { launched: true, report: REPORT, screen: SCREEN, expectOrigin: ORIGIN };
const verdict = (facts) => evaluateCheck({ ...base, ...facts });
const failing = (result) => result.checks.filter((c) => c.ok === false).map((c) => c.id);

describe("evaluateCheck", () => {
  test("passes a healthy run", () => {
    const result = verdict({});
    assert.equal(result.passed, true);
    assert.deepEqual(result.reasons, []);
    assert.equal(result.informational, false);
  });

  test("fails when the app didn't open", () => {
    const result = verdict({ launched: false, report: null });
    assert.equal(result.passed, false);
    assert.deepEqual(failing(result), ["launched"]);
  });

  test("a crash fails, whoever saw it", () => {
    assert.deepEqual(failing(verdict({ crashed: true })), ["no_crash"]);
    assert.deepEqual(failing(verdict({ report: { ...REPORT, crashed: true } })), ["no_crash"]);
  });

  test("a timeout fails", () => assert.ok(failing(verdict({ timedOut: true })).includes("no_timeout")));

  test("HTTP 400 and up fails, 399 passes", () => {
    assert.ok(failing(verdict({ report: { ...REPORT, httpStatus: 400 } })).includes("loaded"));
    assert.ok(failing(verdict({ report: { ...REPORT, httpStatus: 503 } })).includes("loaded"));
    assert.equal(verdict({ report: { ...REPORT, httpStatus: 399 } }).passed, true);
  });

  test("a missing status still passes on a loaded page: the shell can't always see it", () => {
    assert.equal(verdict({ report: { ...REPORT, httpStatus: null } }).passed, true);
  });

  test("an error page fails", () => {
    assert.ok(failing(verdict({ report: { ...REPORT, loadError: "net::ERR_FAILED" } })).includes("loaded"));
  });

  test("no final URL fails", () => {
    assert.ok(failing(verdict({ report: { ...REPORT, finalUrl: null } })).includes("loaded"));
  });

  test("landing on another site fails, including a lookalike", () => {
    assert.ok(failing(verdict({ report: { ...REPORT, finalUrl: "https://evil.example/" } })).includes("origin"));
    assert.ok(failing(verdict({ report: { ...REPORT, finalUrl: "https://demo.vercel.app.evil.example/" } })).includes("origin"));
    assert.ok(failing(verdict({ report: { ...REPORT, finalUrl: "http://demo.vercel.app/" } })).includes("origin"));
  });

  test("a blank screen fails", () => {
    const flat = { stddev: 0.2, dominantShare: 1, mean: 255, levels: 1 };
    assert.ok(failing(verdict({ screen: flat })).includes("not_blank"));
  });

  test("a canvas page with no text isn't blank", () => {
    assert.equal(verdict({ report: { ...REPORT, textLength: 0 } }).passed, true);
  });

  test("the shell's own blank verdict doesn't count", () => {
    assert.equal(verdict({ report: { ...REPORT, ok: false, problems: ["The page looks blank."] } }).passed, true);
  });

  test("no bridge answer fails", () => {
    assert.ok(failing(verdict({ report: { ...REPORT, handshake: false } })).includes("bridge"));
  });

  test("console errors only warn", () => {
    const result = verdict({ report: { ...REPORT, errors: ["a", "b", "c", "d", "e"] } });
    assert.equal(result.passed, true);
    assert.equal(result.warnings.length, 4);
    assert.match(result.warnings[3], /2 more/);
  });

  test("errors the device log line left out still count in the warning", () => {
    const report = { ...REPORT, errors: Array.from({ length: 9 }, (_, i) => `e${i}`), errorsLeftOut: 41 };
    const result = verdict({ report });
    assert.equal(result.passed, true);
    assert.equal(result.warnings.at(-1), "And 47 more console errors.");
    assert.equal(result.warnings.length, 4);
  });

  test("a log line with no room for any error still says how many there were", () => {
    assert.deepEqual(verdict({ report: { ...REPORT, errors: [], errorsLeftOut: 50 } }).warnings, ["And 50 more console errors."]);
  });

  test("a nonsense left-out count is ignored", () => {
    for (const errorsLeftOut of [-3, 1.5, "9", null]) {
      assert.deepEqual(verdict({ report: { ...REPORT, errors: ["a"], errorsLeftOut } }).warnings, ["Console error: a"]);
    }
  });

  test("no report fails a lab shell", () => {
    assert.deepEqual(failing(verdict({ report: null })), ["health_report"]);
  });

  test("a product APK has no report, so it rests on the screen and says so", () => {
    const result = verdict({ report: null, expectReport: false });
    assert.equal(result.passed, true);
    assert.equal(result.checks.find((c) => c.id === "health_report").ok, null);
    const blank = verdict({ report: null, expectReport: false, screen: { stddev: 0, dominantShare: 1 } });
    assert.ok(failing(blank).includes("not_blank"));
    assert.ok(failing(verdict({ report: null, expectReport: false, screen: null })).includes("not_blank"));
  });

  test("on a Mac a bad signature fails and Gatekeeper's rejection is only recorded", () => {
    const gatekeeper = { accepted: false, detail: "Gatekeeper rejected the app, as expected without notarization." };
    const good = verdict({ codesign: { ok: true, detail: "ok" }, gatekeeper });
    assert.equal(good.passed, true);
    assert.equal(good.checks.find((c) => c.id === "gatekeeper").ok, null);
    assert.ok(failing(verdict({ codesign: { ok: false, detail: "no" }, gatekeeper })).includes("codesign"));
  });
});

describe("normalizeReport", () => {
  test("reads the phone shell's report", () => {
    assert.equal(normalizeReport(REPORT).handshake, true);
  });
  test("reads the older nested names too", () => {
    const report = normalizeReport({ finalUrl: "https://a.b", bridge: { handshake: true }, consoleErrors: ["x"] });
    assert.equal(report.handshake, true);
    assert.deepEqual(report.errors, ["x"]);
  });
  test("wrong types don't get through", () => {
    const report = normalizeReport({ finalUrl: 3, httpStatus: "200", handshake: "yes", crashed: 1, errors: "x" });
    assert.deepEqual(report, { finalUrl: null, httpStatus: null, loadMs: null, textLength: null, crashed: false, loadError: null, handshake: false, errors: [], errorsLeftOut: 0 });
    assert.equal(normalizeReport(null), null);
    assert.equal(normalizeReport("nope"), null);
  });
});

describe("the glasses check", () => {
  const launchedAtMs = Date.parse("2026-11-01T10:00:00.000Z");
  const at = (seconds) => new Date(launchedAtMs + seconds * 1000).toISOString();
  const good = [
    { step: "start", ok: true, at: at(5) },
    { step: "connect", ok: true, detail: "mock", at: at(12) },
    { step: "primary", ok: true, at: at(13) },
    { step: "result", ok: true, detail: "A red mug", at: at(30) },
  ];
  const evaluate = (events, extra = {}) => evaluateGlasses({ launched: true, launchedAtMs, events, ...extra });
  const bad = (result) => result.checks.filter((c) => !c.ok).map((c) => c.id);

  test("passes the full path and is always informational", () => {
    const result = evaluate(good);
    assert.equal(result.passed, true);
    assert.equal(result.informational, true);
    assert.equal(result.loadMs, 5000);
    assert.equal(evaluate([]).informational, true);
  });

  test("the page's errors on the last checkpoint only warn", () => {
    const withErrors = good.map((e) => (e.step === "result" ? { ...e, errors: ["ReferenceError: boom", "x".repeat(400)] } : e));
    const result = evaluate(withErrors);
    assert.equal(result.passed, true);
    assert.equal(result.warnings.length, 2);
    assert.equal(result.warnings[0], "Console error: ReferenceError: boom");
    assert.ok(result.warnings[1].length < 250);
    assert.deepEqual(evaluate(good).warnings, []);
    assert.deepEqual(evaluate(good.map((e) => ({ ...e, errors: "boom" }))).warnings, []);
  });

  test("a page's errors still warn on a run that stopped", () => {
    const result = evaluate([...good.slice(0, 2), { step: "timeout", ok: false, detail: "timeout: x", errors: ["boom"], at: at(60) }]);
    assert.equal(result.passed, false);
    assert.deepEqual(result.warnings, ["Console error: boom"]);
  });

  test("a page that loads after 60 s fails", () => {
    const late = [{ ...good[0], at: at(61) }, ...good.slice(1)];
    assert.deepEqual(bad(evaluate(late)), ["loaded"]);
  });

  test("a result more than 120 s after the load fails", () => {
    const late = [...good.slice(0, 3), { ...good[3], at: at(126) }];
    assert.deepEqual(bad(evaluate(late)), ["result"]);
  });

  test("real glasses instead of the mock fail: this check only knows the mock", () => {
    const real = [good[0], { ...good[1], detail: "real" }, good[2], good[3]];
    assert.deepEqual(bad(evaluate(real)), ["glasses_ready"]);
  });

  test("a stop along the way names the reason", () => {
    const result = evaluate([good[0], { step: "timeout", ok: false, detail: "timeout: glasses are connecting", at: at(125) }]);
    assert.deepEqual(bad(result), ["glasses_ready", "primary", "result", "no_errors"]);
    assert.match(result.reasons.at(-1), /glasses are connecting/);
  });

  test("a failed checkpoint doesn't count as done", () => {
    assert.ok(bad(evaluate([{ ...good[0], ok: false }])).includes("loaded"));
  });

  test("a crash and no launch both fail", () => {
    assert.ok(bad(evaluate(good, { crashed: true })).includes("no_crash"));
    assert.ok(bad(evaluate([], { launched: false })).includes("launched"));
  });

  test("parseAutopilot skips half-written lines", () => {
    const text = `${JSON.stringify(good[0])}\n{"step":"conn\n\n[]\n${JSON.stringify(good[3])}\n`;
    assert.deepEqual(parseAutopilot(text).map((e) => e.step), ["start", "result"]);
    assert.deepEqual(parseAutopilot(null), []);
  });

  test("autopilotFinished", () => {
    assert.equal(autopilotFinished(good.slice(0, 3)), false);
    assert.equal(autopilotFinished(good), true);
    assert.equal(autopilotFinished([{ step: "timeout" }]), true);
    assert.equal(autopilotFinished([{ step: "error" }]), true);
  });
});

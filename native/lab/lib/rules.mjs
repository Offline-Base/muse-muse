// When a check passes (docs/NATIVE_LAB.md, "Pass rules"). Pure: the runners collect the facts and these decide.
//
// A check passes when the app launched, the page loaded below HTTP 400 on the product's own origin, the screen isn't
// blank and the bridge handshake answered. Console errors only warn. A crash, an error page or a timeout fails it.

import { isBlankScreen } from "./pixels.mjs";

/** Limits for the glasses check, from the launch of the app. */
export const GLASSES_LOAD_MS = 60_000;
export const GLASSES_RESULT_MS = 120_000;

const MAX_WARNINGS = 3;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The fields a pass rests on, from either shell's report. Both write the SelftestReport fields in
 * native/shell-mobile/src/selftest.ts. A report's own `ok` and `problems` are ignored: its blank test has no pixels, and
 * the lab decides for itself.
 */
export function normalizeReport(report) {
  if (!report || typeof report !== "object") return null;
  const handshake = report.handshake === true || report.bridge?.handshake === true;
  const errors = Array.isArray(report.errors) ? report.errors : Array.isArray(report.consoleErrors) ? report.consoleErrors : [];
  return {
    finalUrl: typeof report.finalUrl === "string" ? report.finalUrl : null,
    httpStatus: typeof report.httpStatus === "number" ? report.httpStatus : null,
    loadMs: typeof report.loadMs === "number" ? report.loadMs : null,
    textLength: typeof report.textLength === "number" ? report.textLength : null,
    crashed: report.crashed === true,
    loadError: typeof report.loadError === "string" && report.loadError ? report.loadError : null,
    handshake,
    errors,
  };
}

function consoleWarnings(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return [];
  const shown = errors.slice(0, MAX_WARNINGS).map((e) => `Console error: ${String(e).slice(0, 200)}`);
  const more = errors.length - shown.length;
  return more > 0 ? [...shown, `And ${more} more console errors.`] : shown;
}

/**
 * The verdict for a phone or desktop check.
 *
 * @param {object} facts
 * @param {boolean} facts.launched the app started
 * @param {boolean} [facts.crashed] the app died during the check
 * @param {boolean} [facts.timedOut] the check ran out of time waiting for the app
 * @param {object | null} facts.report the shell's selftest report
 * @param {boolean} [facts.expectReport] false for a per-product APK, which has no selftest: the verdict then rests on
 *   the launch, on no crash and on the pixels, and says so
 * @param {object | null} [facts.screen] screenStats of the last screenshot
 * @param {string} facts.expectOrigin the origin the page must end up on
 * @param {{ ok: boolean, detail: string }} [facts.codesign] Mac only: the signature check, which must pass
 * @param {{ accepted: boolean, detail: string }} [facts.gatekeeper] Mac only: recorded, and a rejection is expected
 */
export function evaluateCheck(facts) {
  const checks = [];
  const reasons = [];
  const add = (id, ok, detail, reason) => {
    checks.push({ id, ok, detail });
    if (ok === false) reasons.push(reason ?? detail);
  };
  const report = normalizeReport(facts.report);

  add("launched", !!facts.launched, facts.launched ? "The app opened." : "The app didn't open.");
  if (facts.crashed || report?.crashed) add("no_crash", false, "The app crashed during the check.");
  else add("no_crash", true, "The app kept running.");
  if (facts.timedOut) add("no_timeout", false, "The app took too long to answer.");

  if (facts.codesign) add("codesign", facts.codesign.ok, facts.codesign.detail, "The app's signature didn't verify.");
  if (facts.gatekeeper) checks.push({ id: "gatekeeper", ok: null, detail: facts.gatekeeper.detail });

  if (!report) {
    const blank = isBlankScreen(facts.screen ?? null, null);
    if (facts.expectReport === false) {
      checks.push({ id: "health_report", ok: null, detail: "A product build sends no health report, so this rests on the screen." });
      if (blank === true) add("not_blank", false, "The screen stayed blank.");
      else if (blank === false) add("not_blank", true, "The screen shows something.");
      else add("not_blank", false, "The lab couldn't read the screen.");
      return verdict(checks, reasons, []);
    }
    if (facts.launched && !facts.crashed) add("health_report", false, "The app didn't send its health report.");
    if (blank === true) add("not_blank", false, "The screen stayed blank.");
    return verdict(checks, reasons, []);
  }

  const status = report.httpStatus;
  const badStatus = typeof status === "number" && status >= 400;
  if (report.loadError || badStatus) {
    add("loaded", false, badStatus ? `The page answered with HTTP ${status}.` : "The app showed an error page instead of the product.");
  } else if (!report.finalUrl) {
    add("loaded", false, "The page didn't load.");
  } else {
    add("loaded", true, typeof status === "number" ? `The page answered with HTTP ${status}.` : "The page loaded.");
  }

  const finalOrigin = originOf(report.finalUrl);
  if (report.finalUrl && finalOrigin !== facts.expectOrigin) {
    add("origin", false, `The app ended up on another site: ${finalOrigin ?? "an invalid address"}.`);
  } else if (report.finalUrl) {
    add("origin", true, "It stayed on the product's own site.");
  }

  const blank = isBlankScreen(facts.screen ?? null, report.textLength);
  if (blank === true) add("not_blank", false, "The screen stayed blank.");
  else if (blank === false) add("not_blank", true, "The screen shows the product.");

  add("bridge", report.handshake, report.handshake ? "The app bridge answered." : "The app bridge didn't answer.");

  return verdict(checks, reasons, consoleWarnings(report.errors));
}

function verdict(checks, reasons, warnings) {
  return { passed: reasons.length === 0, informational: false, checks, reasons, warnings };
}

/**
 * The checkpoints the glasses autopilot wrote, one JSON object per line: `{ step, ok, detail?, at }`, with the steps from
 * native/shell-mobile/src/glasses/autopilot.ts. Bad lines are ignored.
 */
export function parseAutopilot(text) {
  const events = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === "object" && typeof event.step === "string") events.push(event);
    } catch {
      // A line being written while we read it. The next read has all of it.
    }
  }
  return events;
}

/** The autopilot stops after a result, a timeout or an error. */
export function autopilotFinished(events) {
  return events.some((e) => e.step === "result" || e.step === "timeout" || e.step === "error");
}

/**
 * The verdict for the glasses check (vr-glasses design, 3.5). It's informational: it never blocks shipping, and the
 * platform shows it as a clip and a note. The autopilot runs once the page has loaded, so its `start` checkpoint is the
 * load. It has no checkpoint for the capture itself, so that's covered by the result that follows from it. Its checkpoints
 * don't carry page errors either, so the design's "no window.onerror" isn't checked here (docs/NATIVE_LAB.md, "Pass rules").
 *
 * @param {{ launched: boolean, crashed?: boolean, timedOut?: boolean, launchedAtMs?: number | null, events: object[] }} facts
 */
export function evaluateGlasses(facts) {
  const checks = [];
  const reasons = [];
  const add = (id, ok, detail, reason) => {
    checks.push({ id, ok, detail });
    if (!ok) reasons.push(reason ?? detail);
  };
  const events = facts.events ?? [];
  const find = (step) => events.find((e) => e.step === step && e.ok === true);
  const atMs = (event) => {
    const t = Date.parse(event?.at);
    return Number.isFinite(t) ? t : null;
  };

  add("launched", !!facts.launched, facts.launched ? "The app opened." : "The app didn't open.");
  if (facts.crashed) add("no_crash", false, "The app crashed during the check.");
  if (facts.timedOut) add("no_timeout", false, "The autopilot ran out of time.");

  const started = find("start");
  const startedAt = atMs(started);
  const loadMs = started && startedAt !== null && Number.isFinite(facts.launchedAtMs) ? startedAt - facts.launchedAtMs : null;
  const loadOk = !!started && (loadMs === null || loadMs <= GLASSES_LOAD_MS);
  add("loaded", loadOk, loadOk ? "The page loaded." : started ? "The page took more than 60 s to load." : "The page didn't load.");

  const connected = find("connect");
  const mock = connected?.detail === "mock";
  add(
    "glasses_ready",
    mock,
    mock ? "The simulated glasses connected." : connected ? "Glasses connected, but not the simulated ones." : "The simulated glasses didn't connect.",
  );

  const pressed = find("primary");
  add("primary", !!pressed, pressed ? "The main button was pressed." : "The main button never showed up.");

  const result = find("result");
  const resultMs = result && atMs(result) !== null && startedAt !== null ? atMs(result) - startedAt : null;
  const resultOk = !!result && (resultMs === null || resultMs <= GLASSES_RESULT_MS);
  add(
    "result",
    resultOk,
    resultOk ? "The product showed a result." : result ? "The result took more than 120 s." : "The product showed no result.",
  );

  const stopped = events.find((e) => e.step === "timeout" || e.step === "error");
  if (stopped) add("no_errors", false, `The autopilot stopped: ${String(stopped.detail ?? stopped.step).slice(0, 200)}`);
  else add("no_errors", true, "The autopilot hit no errors.");

  return { passed: reasons.length === 0, informational: true, checks, reasons, warnings: [], loadMs };
}

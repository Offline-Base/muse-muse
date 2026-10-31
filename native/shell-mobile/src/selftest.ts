// The lab variant's health check. It scrolls the page, then posts a report the device lab can read.
//
// The report mixes two sources. What the page says about itself (text length, errors) is only a hint, since an agent
// wrote that page. What the shell saw natively (final URL, HTTP status, a crash, whether the bridge answered this page)
// is what a pass rests on. A page can still claim a text length, so the lab's pixel check stays the proof of that.

import type { MuseCapabilities, MusePlatform } from "./bridge/protocol";

export const SELFTEST_SCROLL_MS = 8_000;
/** Fewer visible characters than this looks like a blank page. */
export const MIN_TEXT_LENGTH = 20;
const MAX_ERRORS = 50;
const MAX_ERROR_CHARS = 300;
/** Logcat cuts lines at about 4 KB, and a cut line can't be parsed. */
export const MAX_LOG_LINE_BYTES = 3_500;
/** What a long URL or title is cut to in the log line, once dropping errors wasn't enough. */
const LOG_FIELD_CHARS = 400;

/** What the shell's own WebView events recorded. */
export interface NativeObservations {
  variant: string;
  shellVersion: string;
  platform: MusePlatform;
  capabilities: MuseCapabilities;
  url: string;
  finalUrl: string | null;
  productOrigin: string;
  httpStatus: number | null;
  loadMs: number | null;
  crashed: boolean;
  loadError: string | null;
}

/** What the script in the page sent back. */
export interface PageObservations {
  title: string;
  textLength: number;
  scrollHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  handshake: boolean;
  errors: string[];
}

export interface SelftestReport extends NativeObservations, PageObservations {
  v: 1;
  ok: boolean;
  /** The reasons it failed, in plain words. Empty when ok. */
  problems: string[];
  /** Page errors that only warn. */
  warnings: string[];
  at: string;
  /** Only in the device log line: how many page errors it left out to fit. */
  errorsLeftOut?: number;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Page input is untrusted, so only known fields of the right type and size get through. */
export function cleanPageObservations(raw: unknown): PageObservations {
  const page = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    title: text(page.title, 200),
    textLength: count(page.textLength),
    scrollHeight: count(page.scrollHeight),
    viewportWidth: count(page.viewportWidth),
    viewportHeight: count(page.viewportHeight),
    handshake: page.handshake === true,
    errors: Array.isArray(page.errors)
      ? page.errors.slice(0, MAX_ERRORS).map((error) => text(error, MAX_ERROR_CHARS))
      : [],
  };
}

/**
 * The page holds the report call, so it could end the check early with a good story. A report counts only after the
 * page has loaded and the scroll has had its time.
 */
export function canAcceptPageReport(loadEndedAt: number | null, now: number, scrollMs: number = SELFTEST_SCROLL_MS): boolean {
  return loadEndedAt !== null && now - loadEndedAt >= scrollMs;
}

/** Pass rules from the plan: it loaded below 400 on its own origin, isn't blank, and the bridge answered. */
export function finishReport(native: NativeObservations, page: PageObservations, at: Date): SelftestReport {
  const problems: string[] = [];
  if (native.crashed) problems.push("The page crashed.");
  if (native.loadError) problems.push(`The page didn't load: ${native.loadError}`);
  if (native.httpStatus !== null && native.httpStatus >= 400) problems.push(`The page answered ${native.httpStatus}.`);
  if (!native.finalUrl || !sameOrigin(native.finalUrl, native.productOrigin)) {
    problems.push("The page ended up on another site.");
  }
  if (page.textLength < MIN_TEXT_LENGTH) problems.push("The page looks blank.");
  if (!page.handshake) problems.push("The page and the app couldn't talk to each other.");

  return {
    ...native,
    ...page,
    v: 1,
    ok: problems.length === 0,
    problems,
    warnings: page.errors,
    at: at.toISOString(),
  };
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Runs in the page after it loads. Scrolls down and back, then reports through the bridge. */
export function buildSelftestScript(scrollMs: number = SELFTEST_SCROLL_MS): string {
  return `(function () {
  var internal = window.__museNative;
  if (!internal || !internal.report || window.__museSelftestStarted) return;
  window.__museSelftestStarted = true;
  var total = ${Math.max(0, Math.floor(scrollMs))};
  var started = Date.now();
  function settle() {
    return window.MuseNative.hello().then(function () { return true; }, function () { return false; });
  }
  function send() {
    return settle().then(function (handshake) {
      var doc = document.documentElement;
      return internal.report({
        title: document.title,
        textLength: document.body ? document.body.innerText.trim().length : 0,
        scrollHeight: doc.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        handshake: handshake,
        errors: internal.pageErrors ? internal.pageErrors() : [],
      });
    });
  }
  function step() {
    var elapsed = Date.now() - started;
    var doc = document.documentElement;
    var room = Math.max(0, doc.scrollHeight - window.innerHeight);
    var phase = total > 0 ? Math.min(1, elapsed / total) : 1;
    var position = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
    window.scrollTo(0, room * position);
    if (phase < 1) setTimeout(step, 100);
    else send();
  }
  step();
})();
true;`;
}

function logLine(report: SelftestReport): string {
  // Everything is ASCII once escaped, so the length is the size in bytes.
  const json = JSON.stringify(report).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `MUSE_SELFTEST ${json}`;
}

/**
 * The report as one device log line the lab can read. The platform's copy and the file keep everything. Past the limit it
 * keeps as many page errors as fit and says how many it left out, and only then shortens the long text fields.
 */
export function selftestLogLine(report: SelftestReport, maxBytes: number = MAX_LOG_LINE_BYTES): string {
  const whole = logLine(report);
  if (whole.length <= maxBytes) return whole;
  // warnings repeats errors, and the lab reads errors.
  const withErrors = (kept: number): SelftestReport => {
    const left = report.errors.length - kept;
    return { ...report, warnings: [], errors: report.errors.slice(0, kept), ...(left > 0 ? { errorsLeftOut: left } : {}) };
  };
  for (let kept = report.errors.length; kept >= 0; kept -= 1) {
    const line = logLine(withErrors(kept));
    if (line.length <= maxBytes) return line;
  }
  const cut = (value: string | null) => (value ? value.slice(0, LOG_FIELD_CHARS) : value);
  return logLine({
    ...withErrors(0),
    title: report.title.slice(0, LOG_FIELD_CHARS),
    url: report.url.slice(0, LOG_FIELD_CHARS),
    finalUrl: cut(report.finalUrl),
    loadError: cut(report.loadError),
    problems: report.problems.map((problem) => problem.slice(0, LOG_FIELD_CHARS)),
  });
}

/** Posts to the platform. A lost report isn't fatal, since the lab also reads the MUSE_SELFTEST log line. */
export async function postSelftestReport(input: {
  platformUrl: string;
  token: string | null;
  report: SelftestReport;
  fetch?: typeof fetch;
}): Promise<boolean> {
  const doFetch = input.fetch ?? fetch;
  try {
    const response = await doFetch(`${input.platformUrl.replace(/\/+$/, "")}/api/native/selftest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      body: JSON.stringify(input.report),
    });
    return response.ok;
  } catch {
    return false;
  }
}

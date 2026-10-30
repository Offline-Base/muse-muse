/**
 * Runs a small JavaScript project's tests for the agent demos (basic-agent-loop, interleaved reasoning): the recipes
 * use pytest and the TypeScript compiler as the oracle for "done", and this is the page's oracle. The code the model
 * writes runs in a Web Worker with the network taken away (fetch, XHR, sockets, importScripts and the rest are deleted
 * before any project code runs), a one-second limit per test, and a hard stop for the whole run, so an infinite loop
 * the model writes ends the worker instead of the page.
 *
 * The runner itself is plain JavaScript in a string (RUNNER_SOURCE), so the browser worker and the node tests run
 * exactly the same code, untouched by any build step.
 *
 * The report is the oracle for "done", so code the model writes shouldn't be able to fake it: the page accepts only
 * the reply that carries the run's random nonce, which only the handler sees (the runner is strict-mode code, so
 * project code can't walk up the call stack to it), and the assert object the tests use is frozen. That keeps an
 * agent's shortcuts out of the verdict; the security boundary itself is the network lockdown.
 */

export interface TestResult {
  file: string;
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface TestReport {
  results: TestResult[];
  passed: number;
  failed: number;
  /** Files that threw while loading (a syntax error, a bad require), with the message. */
  loadErrors: Array<{ file: string; error: string }>;
  /** console output from the project and its tests, a few hundred lines at most. */
  logs: string[];
  timedOut: boolean;
  ms: number;
}

/**
 * The runner: a tiny CommonJS loader over the in-memory files, an `assert` like node's (ok, equal, strictEqual,
 * deepStrictEqual, throws, rejects), and `test(name, fn)` that collects sync and async tests. `runSuite(files, only,
 * perTestMs)` resolves to a report shaped like TestReport.
 */
export const RUNNER_SOURCE = String.raw`"use strict";
function __makeAssert() {
  function fail(message) { var e = new Error(message); e.name = "AssertionError"; throw e; }
  function show(v, depth) {
    depth = depth || 0;
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
    if (typeof v === "function") return "[Function]";
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (depth > 5) return Array.isArray(v) ? "[...]" : "{...}";
    if (Array.isArray(v)) return "[" + v.map(function (x) { return show(x, depth + 1); }).join(",") + "]";
    if (v instanceof Error) return v.name + ": " + v.message;
    try {
      return "{" + Object.keys(v).map(function (k) { return JSON.stringify(k) + ":" + show(v[k], depth + 1); }).join(",") + "}";
    } catch (_) { return String(v); }
  }
  function same(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !same(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }
  var assert = function (value, message) { if (!value) fail(message || "Expected a truthy value, got " + show(value)); };
  assert.ok = assert;
  assert.equal = function (a, b, m) { if (a != b) fail(m || "Expected " + show(b) + ", got " + show(a)); };
  assert.notEqual = function (a, b, m) { if (a == b) fail(m || "Expected a value other than " + show(b)); };
  assert.strictEqual = function (a, b, m) { if (!Object.is(a, b)) fail(m || "Expected " + show(b) + ", got " + show(a)); };
  assert.notStrictEqual = function (a, b, m) { if (Object.is(a, b)) fail(m || "Expected a value other than " + show(b)); };
  assert.deepStrictEqual = function (a, b, m) { if (!same(a, b)) fail(m || "Expected " + show(b) + ", got " + show(a)); };
  assert.deepEqual = assert.deepStrictEqual;
  assert.throws = function (fn, m) {
    var threw = false;
    try { fn(); } catch (_) { threw = true; }
    if (!threw) fail(typeof m === "string" ? m : "Expected the function to throw");
  };
  assert.rejects = function (p, m) {
    var promise = typeof p === "function" ? p() : p;
    return Promise.resolve(promise).then(
      function () { fail(typeof m === "string" ? m : "Expected the promise to reject"); },
      function () {}
    );
  };
  assert.fail = function (m) { fail(m || "Failed"); };
  assert.strict = assert;
  return assert;
}

function __normalize(parts) {
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p || p === ".") continue;
    if (p === "..") out.pop(); else out.push(p);
  }
  return out.join("/");
}

function runSuite(files, only, perTestMs) {
  var started = Date.now();
  // Frozen, so project code that requires "assert" can't swap strictEqual for a no-op.
  var assert = Object.freeze(__makeAssert());
  var cache = {};
  var tests = [];
  var logs = [];
  var loadErrors = [];
  var current = "";
  function log() {
    if (logs.length >= 300) return;
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      parts.push(typeof a === "string" ? a : (function () { try { return JSON.stringify(a); } catch (_) { return String(a); } })());
    }
    logs.push(parts.join(" "));
  }
  var consoleLike = { log: log, info: log, warn: log, error: log, debug: log };
  function test(name, fn) { tests.push({ file: current, name: String(name), fn: fn }); }
  function describe(_name, fn) { fn(); }
  function resolve(from, spec) {
    if (spec === "assert" || spec === "node:assert" || spec === "assert/strict" || spec === "node:assert/strict") return "assert";
    if (spec === "util" || spec === "node:util") return "util";
    if (spec.charAt(0) !== ".") throw new Error("Cannot find module '" + spec + "' (only the project's own files can be required here)");
    var dir = from.split("/").slice(0, -1);
    var base = __normalize(dir.concat(spec.split("/")));
    var options = [base, base + ".js", base + "/index.js"];
    for (var i = 0; i < options.length; i++) if (Object.prototype.hasOwnProperty.call(files, options[i])) return options[i];
    throw new Error("Cannot find module '" + spec + "' from " + from);
  }
  var util = {
    promisify: function (fn) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        var self = this;
        return new Promise(function (resolve, reject) {
          args.push(function (err, value) { if (err) reject(err); else resolve(value); });
          fn.apply(self, args);
        });
      };
    }
  };
  function load(path) {
    if (path === "assert") return assert;
    if (path === "util") return util;
    if (cache[path]) return cache[path].exports;
    var module = { exports: {} };
    cache[path] = module;
    var fn = new Function("module", "exports", "require", "test", "it", "describe", "console", files[path] + "\n//# sourceURL=" + path);
    fn(module, module.exports, function (spec) { return load(resolve(path, spec)); }, test, test, describe, consoleLike);
    return module.exports;
  }
  var testFiles = Object.keys(files).filter(function (p) { return /^tests?\/.*\.js$/.test(p) && (!only || p === only); }).sort();
  if (only && testFiles.length === 0) loadErrors.push({ file: only, error: "No such test file." });
  for (var t = 0; t < testFiles.length; t++) {
    current = testFiles[t];
    try { load(testFiles[t]); } catch (err) {
      loadErrors.push({ file: testFiles[t], error: (err && err.name ? err.name + ": " : "") + (err && err.message ? err.message : String(err)) });
    }
  }
  var results = [];
  var chain = Promise.resolve();
  tests.forEach(function (tc) {
    chain = chain.then(function () {
      var t0 = Date.now();
      return new Promise(function (done) {
        var finished = false;
        var timer = setTimeout(function () {
          if (finished) return;
          finished = true;
          done({ file: tc.file, name: tc.name, ok: false, error: "Timed out after " + perTestMs + " ms (a promise that never settles?)", ms: Date.now() - t0 });
        }, perTestMs);
        function settle(ok, err) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          var r = { file: tc.file, name: tc.name, ok: ok, ms: Date.now() - t0 };
          if (!ok) r.error = (err && err.name && err.name !== "Error" && err.name !== "AssertionError" ? err.name + ": " : "") + (err && err.message ? err.message : String(err));
          done(r);
        }
        try {
          Promise.resolve(tc.fn()).then(function () { settle(true); }, function (e) { settle(false, e); });
        } catch (e) { settle(false, e); }
      }).then(function (r) { results.push(r); });
    });
  });
  return chain.then(function () {
    var passed = results.filter(function (r) { return r.ok; }).length;
    return { results: results, passed: passed, failed: results.length - passed, loadErrors: loadErrors, logs: logs, timedOut: false, ms: Date.now() - started };
  });
}
`;

/** Takes every network door away before project code runs: on the worker's global and up its prototype chain. */
const LOCKDOWN = String.raw`
(function () {
  var names = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches",
    "BroadcastChannel", "Worker", "SharedWorker", "WebTransport", "RTCPeerConnection", "Request", "Response",
    "Notification", "navigator", "close"];
  var target = self;
  while (target) {
    for (var i = 0; i < names.length; i++) {
      try { delete target[names[i]]; } catch (_) {}
    }
    target = Object.getPrototypeOf(target);
  }
  for (var j = 0; j < names.length; j++) {
    try { Object.defineProperty(self, names[j], { value: undefined, writable: false, configurable: false }); } catch (_) {}
  }
})();
`;

const HANDLER = String.raw`
var __post = self.postMessage.bind(self);
var __unhandled = [];
// A promise the project rejects with nobody listening (a caller left on the old callback API) is reported, not lost.
self.addEventListener("unhandledrejection", function (e) {
  e.preventDefault();
  var r = e.reason;
  if (__unhandled.length < 20) __unhandled.push("Unhandled promise rejection: " + (r && r.message ? r.message : String(r)));
});
self.onmessage = function (e) {
  var data = e.data || {};
  // The page's nonce for this run goes back with the report and nowhere else, so a message project code posts
  // itself can't pass for the report.
  var nonce = data.nonce;
  runSuite(data.files || {}, data.only || null, data.perTestMs || 1000).then(
    function (report) {
      report.logs = report.logs.concat(__unhandled);
      __post({ nonce: nonce, ok: true, report: report });
    },
    function (err) { __post({ nonce: nonce, ok: false, error: String(err && err.message ? err.message : err) }); }
  );
};
`;

export const WORKER_SOURCE = `${RUNNER_SOURCE}\n${HANDLER}\n${LOCKDOWN}`;

export interface RunOptions {
  /** Run one test file instead of every tests/*.js. */
  only?: string | null;
  perTestMs?: number;
  /** The whole run's hard stop. */
  timeoutMs?: number;
}

/**
 * Files that would load code at run time (a dynamic import(), importScripts), which the worker's lockdown can't take
 * away, so the page refuses to run them. The demo projects never need either.
 */
export function networkLoads(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([, source]) => /\bimport\s*\(|\bimportScripts\b/.test(source))
    .map(([path]) => path);
}

/** A random id for one test run, from crypto when the browser has it. */
export function runNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Runs the project's tests in a locked-down worker. Never rejects: a timeout or a crash comes back as a report. */
export function runTestsInWorker(files: Record<string, string>, opts: RunOptions = {}): Promise<TestReport> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const failure = (error: string, timedOut = false): TestReport => ({
    results: [],
    passed: 0,
    failed: 0,
    loadErrors: [{ file: opts.only ?? "tests", error }],
    logs: [],
    timedOut,
    ms: Date.now() - started,
  });
  const loads = networkLoads(files);
  if (loads.length) {
    return Promise.resolve(failure(`${loads.join(", ")} loads code at run time (import() or importScripts), which the page's sandbox doesn't run. Use require with a relative path.`));
  }
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
    return Promise.resolve(failure("This browser can't run the tests (no Web Worker)."));
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (err) {
      URL.revokeObjectURL(url);
      resolve(failure(err instanceof Error ? err.message : "The test worker didn't start."));
      return;
    }
    const finish = (report: TestReport) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(report);
    };
    const timer = setTimeout(
      () => finish(failure(`The test run took longer than ${Math.round(timeoutMs / 1000)} s and was stopped (an infinite loop?).`, true)),
      timeoutMs,
    );
    const nonce = runNonce();
    worker.onmessage = (e: MessageEvent<{ nonce?: string; ok: boolean; report?: TestReport; error?: string }>) => {
      const data = e.data;
      // Anything without this run's nonce came from project code, not the handler: ignore it and keep waiting.
      if (data?.nonce !== nonce) return;
      if (data.ok && data.report) finish({ ...data.report, ms: Date.now() - started });
      else finish(failure(data.error ?? "The tests couldn't run."));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      finish(failure(e.message || "The test worker crashed."));
    };
    worker.postMessage({ files, only: opts.only ?? null, perTestMs: opts.perTestMs ?? 1000, nonce });
  });
}

/** The report as a test runner prints it: the text the run_tests tool hands back to the model. */
export function formatReport(report: TestReport): string {
  const lines: string[] = [];
  for (const e of report.loadErrors) lines.push(`ERROR ${e.file}: ${e.error}`);
  let file = "";
  for (const r of report.results) {
    if (r.file !== file) {
      file = r.file;
      lines.push(file);
    }
    lines.push(r.ok ? `  ok    ${r.name}` : `  FAIL  ${r.name}: ${r.error ?? "failed"}`);
  }
  if (report.logs.length) lines.push("console:", ...report.logs.slice(0, 20).map((l) => `  ${l}`));
  const total = report.passed + report.failed;
  lines.push(
    report.timedOut
      ? "Stopped: the run timed out."
      : total === 0 && report.loadErrors.length
        ? "No tests ran."
        : `${report.passed} passed, ${report.failed} failed${report.loadErrors.length ? `, ${report.loadErrors.length} file${report.loadErrors.length === 1 ? "" : "s"} failed to load` : ""}`,
  );
  return lines.join("\n");
}

/** True when every test ran and passed. */
export function allGreen(report: TestReport): boolean {
  return !report.timedOut && report.loadErrors.length === 0 && report.failed === 0 && report.passed > 0;
}

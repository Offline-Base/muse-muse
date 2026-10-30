/**
 * What runs inside the sandboxed iframes where these demos put model-written code: an <iframe sandbox="allow-scripts">
 * with srcdoc, so the code gets an opaque origin (no cookies, no storage, no access to this page) and can only talk
 * back with postMessage. The harness is injected before the model's own scripts and:
 *
 * - reports console output, uncaught errors and unhandled rejections (the "read the browser console" step);
 * - stands in for localStorage and sessionStorage, which throw in an opaque origin, so a game's high score works;
 * - keeps WebGL frames readable (preserveDrawingBuffer), so a Three.js canvas can be captured;
 * - on request, plays input (held keys, a mouse path, a click), then captures the page as a JPEG (the DOM drawn
 *   through an SVG foreignObject, canvases included) plus a text snapshot of what's on screen, the way the
 *   Playwright MCP's snapshot and screenshot tools do in the recipes;
 * - in run mode, loads CommonJS-style files from a virtual tree and runs one, like `node file.js` in a sandbox.
 *
 * Every message carries a per-frame nonce, and the parent also checks event.source, so other frames can't pose as it.
 * The model's code can read the nonce too, which is fine: the parent treats everything it gets as untrusted data.
 */

export type Probe =
  | { type: "keys"; keys: string[]; holdMs: number }
  | { type: "mouse"; path: "across-logo" | "across-center" | Array<[number, number]>; ms?: number }
  | { type: "click"; x: number; y: number }
  | { type: "wait"; ms: number }
  /**
   * Holds keys like "keys" and, every `everyMs`, calls the page's own window[fn]() and logs what it returns as a
   * console line ("[sample 3 at 300 ms] {...}"), the way the recipe's agent samples values with browser_evaluate.
   * `fn` must be a plain identifier; the page decides what it exposes.
   */
  | { type: "sample"; fn: string; keys: string[]; holdMs: number; everyMs?: number };

export interface LogLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export interface CaptureResult {
  screenshot: string | null;
  snapshot: string;
  width: number;
  height: number;
  error: string | null;
}

export interface RunResult {
  code: number;
  stdout: string;
  timedOut: boolean;
  error: string | null;
}

/** A random id for one frame's messages. */
export function makeNonce(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Escapes a value for an inline <script> so "</script>" in a string can't end the tag. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The part both modes share: messaging, console capture, storage stand-ins. Plain ES2017, no imports. */
function commonSource(nonce: string): string {
  return `
var __N = ${inlineJson(nonce)};
function __send(m) { try { m.__cuc = __N; parent.postMessage(m, "*"); } catch (e) {} }
function __fmt(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return (v.name || "Error") + ": " + v.message + (v.stack ? "\\n" + String(v.stack).split("\\n").slice(1, 4).join("\\n") : "");
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
["log", "info", "warn", "error"].forEach(function (level) {
  var orig = console[level];
  console[level] = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(__fmt(arguments[i]));
    __send({ type: "console", level: level, text: parts.join(" ").slice(0, 2000) });
    try { return orig.apply(console, arguments); } catch (e) {}
  };
});
window.addEventListener("error", function (e) {
  var where = e.filename ? " (" + (e.filename.indexOf("about:srcdoc") === 0 ? "index.html" : e.filename) + ":" + e.lineno + ":" + e.colno + ")" : "";
  var target = e.target && e.target !== window && e.target.tagName ? " loading <" + e.target.tagName.toLowerCase() + "> " + (e.target.src || e.target.href || "") : "";
  __send({ type: "console", level: "error", text: (e.message || "Error" + target) + where });
}, true);
window.addEventListener("unhandledrejection", function (e) {
  __send({ type: "console", level: "error", text: "Unhandled promise rejection: " + __fmt(e.reason) });
});
(function () {
  function memoryStore() {
    var m = {};
    return {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[String(k)] = String(v); },
      removeItem: function (k) { delete m[String(k)]; },
      clear: function () { m = {}; },
      key: function (i) { var ks = Object.keys(m); return i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(m).length; }
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var ok = false;
    try { ok = !!window[name] && (window[name].getItem("__probe"), true); } catch (e) { ok = false; }
    if (!ok) { try { Object.defineProperty(window, name, { value: memoryStore(), configurable: true }); } catch (e) {} }
  });
})();
`;
}

/** Page mode: the capture and input player. */
function pageSource(): string {
  return `
(function () {
  var getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (typeof type === "string" && type.indexOf("webgl") === 0) {
      var a = {}; if (attrs) for (var k in attrs) a[k] = attrs[k];
      a.preserveDrawingBuffer = true;
      return getContext.call(this, type, a);
    }
    return getContext.apply(this, arguments);
  };
})();
var __KEYS = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, " ": 32, Space: 32, Enter: 13, Escape: 27, w: 87, a: 65, s: 83, d: 68, W: 87, A: 65, S: 83, D: 68, v: 86, V: 86, r: 82, R: 82, p: 80, P: 80 };
function __codeOf(key) {
  if (key === " " || key === "Space") return "Space";
  if (/^Arrow/.test(key) || key === "Enter" || key === "Escape") return key;
  if (/^[a-zA-Z]$/.test(key)) return "Key" + key.toUpperCase();
  return key;
}
function __key(type, key) {
  var k = key === "Space" ? " " : key;
  var ev = new KeyboardEvent(type, { key: k, code: __codeOf(key), bubbles: true, cancelable: true });
  var kc = __KEYS[key] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  try { Object.defineProperty(ev, "keyCode", { get: function () { return kc; } }); Object.defineProperty(ev, "which", { get: function () { return kc; } }); } catch (e) {}
  (document.activeElement || document.body || document).dispatchEvent(ev);
}
function __sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// Chrome stops rAF in a cross-origin frame that is off screen, so a frame wait must not hang on it.
function __frame() { return new Promise(function (r) { var done = false; function go() { if (!done) { done = true; r(); } } requestAnimationFrame(go); setTimeout(go, 150); }); }
function __pointer(type, x, y) {
  var el = document.elementFromPoint(x, y) || document.body;
  var init = { clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true, cancelable: true, view: window, pointerId: 1, isPrimary: true, pointerType: "mouse", buttons: type.indexOf("down") >= 0 ? 1 : 0 };
  var Ctor = type.indexOf("pointer") === 0 && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  el.dispatchEvent(new Ctor(type, init));
}
function __logoCenter() {
  // The biggest visible element that looks like the logo or hero, by area and how much it holds; header and nav count less.
  var sel = "pre, canvas, svg, [class*=logo], [id*=logo], [class*=ascii], [id*=ascii], [class*=stage], [id*=stage], [class*=hero], [id*=hero]";
  var els = document.querySelectorAll(sel), best = null, bestScore = 0;
  for (var i = 0; i < els.length; i++) {
    var r = els[i].getBoundingClientRect();
    var left = Math.max(r.left, 0), top = Math.max(r.top, 0);
    var w = Math.min(r.right, innerWidth) - left, h = Math.min(r.bottom, innerHeight) - top;
    if (w < 60 || h < 30) continue;
    var held = (els[i].textContent || "").length + els[i].getElementsByTagName("*").length;
    var score = w * h * (1 + Math.min(held, 3000) / 300);
    if (els[i].closest && els[i].closest("header, nav")) score *= 0.2;
    if (score > bestScore) { bestScore = score; best = { left: left, top: top, w: w, h: h }; }
  }
  if (!best) return null;
  return { x: best.left + best.w / 2, y: best.top + best.h / 2, w: best.w };
}
async function __probe(p) {
  if (p.type === "wait") { await __sleep(Math.min(p.ms || 0, 5000)); return; }
  if (p.type === "keys") {
    var keys = p.keys || [];
    for (var i = 0; i < keys.length; i++) __key("keydown", keys[i]);
    var end = Date.now() + Math.min(p.holdMs || 300, 5000);
    while (Date.now() < end) { await __sleep(60); for (var j = 0; j < keys.length; j++) __key("keydown", keys[j]); }
    for (var k = keys.length - 1; k >= 0; k--) __key("keyup", keys[k]);
    return;
  }
  if (p.type === "sample") {
    var held = p.keys || [], fn = /^[A-Za-z_$][\\w$]*$/.test(p.fn || "") ? p.fn : "";
    for (var h = 0; h < held.length; h++) __key("keydown", held[h]);
    var start = Date.now(), stop = start + Math.min(p.holdMs || 1000, 5000), every = Math.max(30, p.everyMs || 100), n = 0, warned = false;
    while (Date.now() < stop) {
      await __sleep(every);
      for (var hk = 0; hk < held.length; hk++) __key("keydown", held[hk]);
      if (fn && typeof window[fn] === "function") {
        try { n++; console.log("[sample " + n + " at " + (Date.now() - start) + " ms] " + __fmt(window[fn]())); } catch (err) { console.warn("[sample] window." + fn + "() threw: " + __fmt(err)); }
      } else if (!warned) { warned = true; console.warn("[sample] window." + (fn || p.fn) + " isn't a function on this page, so nothing was sampled."); }
    }
    for (var hr = held.length - 1; hr >= 0; hr--) __key("keyup", held[hr]);
    return;
  }
  if (p.type === "click") {
    __pointer("pointerdown", p.x, p.y); __pointer("mousedown", p.x, p.y);
    __pointer("pointerup", p.x, p.y); __pointer("mouseup", p.x, p.y); __pointer("click", p.x, p.y);
    return;
  }
  if (p.type === "mouse") {
    var pts = [];
    if (p.path === "across-logo" || p.path === "across-center") {
      var c = p.path === "across-logo" ? __logoCenter() : null;
      var cy = c ? c.y : innerHeight / 2, cx = c ? c.x : innerWidth / 2, half = c ? Math.max(40, c.w / 2) : innerWidth * 0.3;
      for (var s = 0; s <= 12; s++) pts.push([cx - half + (half * s) / 12, cy]);
    } else pts = p.path || [];
    var stepMs = Math.max(16, Math.round((p.ms || 600) / Math.max(1, pts.length)));
    for (var q = 0; q < pts.length; q++) { __pointer("pointermove", pts[q][0], pts[q][1]); __pointer("mousemove", pts[q][0], pts[q][1]); await __sleep(stepMs); }
  }
}
function __snapshot() {
  var out = [];
  out.push("title: " + (document.title || "(none)"));
  var de = document.documentElement;
  out.push("viewport: " + innerWidth + "x" + innerHeight + ", page " + de.scrollWidth + "x" + de.scrollHeight);
  if (de.scrollWidth > innerWidth + 2) out.push("warning: horizontal overflow of " + (de.scrollWidth - innerWidth) + " px");
  var sel = "h1,h2,h3,h4,h5,h6,p,li,pre,button,a,input,textarea,select,canvas,img,svg,[role=button],label";
  var els = document.querySelectorAll(sel);
  var n = 0;
  for (var i = 0; i < els.length && n < 70; i++) {
    var el = els[i];
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var hidden = cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0 || r.width === 0 || r.height === 0;
    var tag = el.tagName.toLowerCase();
    var raw = el.getAttribute("aria-label") || (typeof el.value === "string" ? el.value : "") || el.alt || el.textContent || "";
    var text = String(raw).replace(/\\s+/g, " ").trim();
    if (!text && ["canvas", "img", "svg", "input", "textarea"].indexOf(tag) < 0) continue;
    if (tag === "pre" && text.length > 60) text = text.slice(0, 60) + "... (" + text.length + " chars)";
    else if (text.length > 90) text = text.slice(0, 90) + "...";
    var where = Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height);
    var flags = hidden ? " [hidden]" : (r.bottom < 0 || r.top > innerHeight ? " [offscreen]" : "");
    out.push("- " + tag + (text ? ' "' + text + '"' : "") + " @" + where + flags + (tag !== "canvas" ? " color " + cs.color + " on " + cs.backgroundColor : ""));
    n++;
  }
  return out.join("\\n");
}
function __rasterize(maxSide) {
  return new Promise(function (resolve, reject) {
    var w = innerWidth, h = innerHeight;
    var clone = document.documentElement.cloneNode(true);
    var src = document.querySelectorAll("canvas"), dst = clone.querySelectorAll("canvas");
    for (var i = 0; i < src.length && i < dst.length; i++) {
      try {
        var img = document.createElement("img");
        img.src = src[i].toDataURL("image/png");
        var r = src[i].getBoundingClientRect();
        img.setAttribute("style", (src[i].getAttribute("style") || "") + ";width:" + r.width + "px;height:" + r.height + "px;");
        img.className = src[i].className;
        dst[i].parentNode.replaceChild(img, dst[i]);
      } catch (e) {}
    }
    var inputs = document.querySelectorAll("input, textarea"), cin = clone.querySelectorAll("input, textarea");
    for (var j = 0; j < inputs.length && j < cin.length; j++) { try { if (inputs[j].tagName === "TEXTAREA") cin[j].textContent = inputs[j].value; else cin[j].setAttribute("value", inputs[j].value); } catch (e) {} }
    var scripts = clone.querySelectorAll("script");
    for (var k = 0; k < scripts.length; k++) scripts[k].parentNode.removeChild(scripts[k]);
    var body = clone.querySelector("body");
    if (body && (scrollX || scrollY)) body.setAttribute("style", (body.getAttribute("style") || "") + ";transform:translate(" + -scrollX + "px," + -scrollY + "px);");
    var xml = new XMLSerializer().serializeToString(clone);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject x="0" y="0" width="100%" height="100%">' + xml + "</foreignObject></svg>";
    var image = new Image();
    image.onload = function () {
      try {
        var scale = Math.min(1, maxSide / Math.max(w, h));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
        var ctx = c.getContext("2d");
        var bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
        ctx.fillStyle = !bg || bg === "rgba(0, 0, 0, 0)" ? (getComputedStyle(document.documentElement).backgroundColor || "#fff") : bg;
        if (ctx.fillStyle === "rgba(0, 0, 0, 0)") ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(image, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.85));
      } catch (e) { reject(e); }
    };
    image.onerror = function () { reject(new Error("The page couldn't be drawn for a screenshot.")); };
    image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}
function __canvasShot(maxSide) {
  var cs = document.querySelectorAll("canvas"), best = null, area = 0;
  for (var i = 0; i < cs.length; i++) { var a = cs[i].width * cs[i].height; if (a > area) { area = a; best = cs[i]; } }
  if (!best) return null;
  var scale = Math.min(1, maxSide / Math.max(best.width, best.height));
  var c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(best.width * scale)); c.height = Math.max(1, Math.round(best.height * scale));
  c.getContext("2d").drawImage(best, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}
window.addEventListener("message", async function (e) {
  if (e.source !== parent || !e.data || e.data.__cuc !== __N || e.data.type !== "capture") return;
  var probes = e.data.probes || [];
  for (var i = 0; i < probes.length; i++) { try { await __probe(probes[i]); } catch (err) { __send({ type: "console", level: "warn", text: "Input step failed: " + __fmt(err) }); } }
  await __frame(); await __frame();
  var shot = null, error = null;
  try { shot = await __rasterize(e.data.maxSide || 1024); } catch (err) { error = String(err && err.message || err); }
  if (!shot) { try { shot = __canvasShot(e.data.maxSide || 1024); } catch (err2) {} }
  var snap = ""; try { snap = __snapshot(); } catch (err3) { snap = "snapshot failed: " + __fmt(err3); }
  __send({ type: "capture-result", id: e.data.id, screenshot: shot, snapshot: snap, width: innerWidth, height: innerHeight, error: error });
});
window.addEventListener("load", function () { __send({ type: "ready" }); });
`;
}

/** Run mode: a CommonJS loader over a virtual tree, then `node <entry>`. */
function runSource(files: Record<string, string>, entry: string, argv: string[]): string {
  return `
(function () {
  var FILES = ${inlineJson(files)};
  var ENTRY = ${inlineJson(entry)};
  function norm(p) {
    var parts = [], segs = p.split("/");
    for (var i = 0; i < segs.length; i++) { var s = segs[i]; if (!s || s === ".") continue; if (s === "..") parts.pop(); else parts.push(s); }
    return parts.join("/");
  }
  function dirname(p) { var i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
  function deepEqual(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return a === b; } }
  function AssertionError(msg) { var e = new Error(msg); e.name = "AssertionError"; return e; }
  var assert = function (v, m) { if (!v) throw AssertionError(m || "Expected a truthy value"); };
  assert.ok = assert;
  assert.equal = function (a, b, m) { if (a != b) throw AssertionError(m || ("Expected " + __fmt(a) + " == " + __fmt(b))); };
  assert.strictEqual = function (a, b, m) { if (a !== b) throw AssertionError(m || ("Expected " + __fmt(b) + ", got " + __fmt(a))); };
  assert.notStrictEqual = function (a, b, m) { if (a === b) throw AssertionError(m || ("Expected a value other than " + __fmt(b))); };
  assert.deepStrictEqual = function (a, b, m) { if (!deepEqual(a, b)) throw AssertionError(m || ("Expected " + __fmt(b) + ", got " + __fmt(a))); };
  assert.deepEqual = assert.deepStrictEqual;
  assert.match = function (s, re, m) { if (!re.test(s)) throw AssertionError(m || ("Expected " + __fmt(s) + " to match " + re)); };
  assert.throws = function (fn, m) { try { fn(); } catch (e) { return; } throw AssertionError(m || "Expected the function to throw"); };
  assert.strict = assert;
  var cache = {};
  function ExitSignal(code) { this.code = code; }
  var proc = { argv: ["node", ENTRY].concat(${inlineJson(argv)}), env: {}, exitCode: 0, platform: "linux", cwd: function () { return "/testbed"; }, exit: function (c) { throw new ExitSignal(c === undefined ? proc.exitCode : c); }, stdout: { write: function (s) { console.log(String(s).replace(/\\n$/, "")); return true; } } };
  function load(path, from) {
    if (path === "assert" || path === "node:assert" || path === "assert/strict" || path === "node:assert/strict") return assert;
    if (path === "process" || path === "node:process") return proc;
    if (path === "path" || path === "node:path") return { join: function () { return norm(Array.prototype.join.call(arguments, "/")); }, dirname: dirname, basename: function (p) { return p.split("/").pop(); } };
    var base = path.charAt(0) === "." ? norm(dirname(from) + "/" + path) : norm(path);
    var tries = [base, base + ".js", base + "/index.js"];
    var found = null;
    for (var i = 0; i < tries.length; i++) if (Object.prototype.hasOwnProperty.call(FILES, tries[i])) { found = tries[i]; break; }
    if (!found) { var err = new Error("Cannot find module '" + path + "' from '" + (from || ".") + "'"); err.code = "MODULE_NOT_FOUND"; throw err; }
    if (cache[found]) return cache[found].exports;
    var module = { exports: {} };
    cache[found] = module;
    var fn = new Function("module", "exports", "require", "process", "__filename", "__dirname", FILES[found] + "\\n//# sourceURL=" + found);
    fn(module, module.exports, function (p) { return load(p, found); }, proc, "/testbed/" + found, "/testbed/" + dirname(found));
    return module.exports;
  }
  var code = 0;
  Promise.resolve().then(function () { return load(ENTRY.charAt(0) === "." ? ENTRY : "./" + ENTRY, ""); }).then(function () {
    return new Promise(function (r) { setTimeout(r, 30); });
  }).catch(function (e) {
    if (e instanceof ExitSignal) { code = e.code; return; }
    console.error(__fmt(e)); code = 1;
  }).then(function () {
    if (!code && proc.exitCode) code = proc.exitCode;
    __send({ type: "done", code: code });
  });
})();
`;
}

/** Puts the harness at the very start of a model-written page, so it is installed before the page's own scripts. */
export function wrapPage(html: string, nonce: string): string {
  const tag = `<script>${commonSource(nonce)}${pageSource()}</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype.index + doctype[0].length) + `<head>${tag}</head>` + html.slice(doctype.index + doctype[0].length);
  return `<!doctype html><html><head>${tag}</head><body>${html}</body></html>`;
}

/** A blank page that runs `entry` from `files`, for the sandboxed-execution demo's `node` command. */
export function runPage(files: Record<string, string>, entry: string, argv: string[], nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${commonSource(nonce)}${runSource(files, entry, argv)}</script></body></html>`;
}

/** The harness sources on their own, for tests that check they compile. */
export const harnessSources = { commonSource, pageSource, runSource };

/** A capture result from a message, or null when the message isn't one (or isn't safe to show). */
export function readCapture(data: unknown): CaptureResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "capture-result") return null;
  const shot = typeof d.screenshot === "string" && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(d.screenshot) && d.screenshot.length < 4_000_000 ? d.screenshot : null;
  return {
    screenshot: shot,
    snapshot: typeof d.snapshot === "string" ? d.snapshot.slice(0, 8000) : "",
    width: typeof d.width === "number" ? d.width : 0,
    height: typeof d.height === "number" ? d.height : 0,
    error: typeof d.error === "string" ? d.error.slice(0, 300) : null,
  };
}

/** A console line from a message, or null. */
export function readLog(data: unknown): LogLine | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "console" || typeof d.text !== "string") return null;
  const level = d.level === "error" || d.level === "warn" || d.level === "info" ? d.level : "log";
  return { level, text: d.text.slice(0, 2000) };
}

/** Pulls the HTML document out of a model reply: a fenced ```html block, else the text from <!doctype or <html. */
export function extractHtml(text: string): string | null {
  const fence = /```(?:html|htm)?\s*\n([\s\S]*?)```/i.exec(text);
  const candidate = fence ? fence[1] : text;
  const start = candidate.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return fence && /<(body|div|canvas|script)[\s>]/i.test(fence[1]) ? fence[1].trim() : null;
  const end = candidate.toLowerCase().lastIndexOf("</html>");
  return (end > start ? candidate.slice(start, end + 7) : candidate.slice(start)).trim();
}

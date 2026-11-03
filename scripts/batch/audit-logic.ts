/**
 * The pure parts of scripts/audit-batch.ts: which product answers count as not the model's work, what one run found,
 * pass or fail, the focus text a failing product's polish gets, and the markdown summary. The in-page scripts are plain
 * strings, so nothing the TypeScript runner adds to compiled functions ever reaches the page.
 */

export type ViewportName = "desktop" | "phone";

export const VIEWPORTS: Record<ViewportName, { width: number; height: number; mobile: boolean }> = {
  desktop: { width: 1440, height: 900, mobile: false },
  phone: { width: 390, height: 844, mobile: true },
};

/** The smallest tap target on a phone (product-ui, Accessibility; template/tests/judge-shot.ts TAP_MIN). */
export const TAP_MIN = 44;

/**
 * Why a product's /api answer isn't plainly the model's work: `model: false`, `fallback: true`, `estimate: true`, or an
 * `error` field, at the top level or one object down (like `{result: {fallback: true}}`). Empty for a clean answer.
 */
export function answerFlags(json: unknown): string[] {
  const out: string[] = [];
  const look = (o: Record<string, unknown>, at: string) => {
    if (o.model === false) out.push(`${at}model: false`);
    if (o.fallback === true) out.push(`${at}fallback: true`);
    if (o.estimate === true) out.push(`${at}estimate: true`);
    const e = o.error;
    if (e !== undefined && e !== null && e !== false && e !== "") out.push(`${at}error: ${typeof e === "string" ? JSON.stringify(e.slice(0, 120)) : JSON.stringify(e).slice(0, 120)}`);
  };
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  const top = json as Record<string, unknown>;
  look(top, "");
  for (const [k, v] of Object.entries(top)) if (v && typeof v === "object" && !Array.isArray(v)) look(v as Record<string, unknown>, `${k}.`);
  return out;
}

export interface ViewportRun {
  viewport: ViewportName;
  /** The page answered and rendered. */
  loaded: boolean;
  loadNote?: string;
  sampleLabel: string | null;
  actionLabel: string | null;
  /** shown: a result card with content. error: an error box. timeout: still busy or empty at the limit. none: no flow ran. */
  result: "shown" | "error" | "timeout" | "none";
  resultText?: string;
  errorText?: string;
  seconds: number;
  consoleErrors: string[];
  failedApi: Array<{ path: string; status: number | string }>;
  flaggedAnswers: Array<{ path: string; flags: string[] }>;
  sidewaysPx: number;
  smallTaps: string[];
  cutOff: string[];
  screenshots: string[];
}

const list = (xs: readonly string[], n = 4) => `${xs.slice(0, n).map((x) => `"${x}"`).join(", ")}${xs.length > n ? ` and ${xs.length - n} more` : ""}`;

/** What one run found wrong, each as a short clause. Tap targets count only on the phone, as judgeShot does. */
export function runProblems(r: ViewportRun): string[] {
  const at = r.viewport === "desktop" ? "on desktop (1440x900)" : "on a phone (390x844)";
  const p: string[] = [];
  if (!r.loaded) return [`the page didn't load ${at}${r.loadNote ? ` (${r.loadNote})` : ""}`];
  if (!r.sampleLabel) p.push(`there is no "Try the sample" control ${at}`);
  if (r.result === "error") p.push(`the main flow ended on an error ${at}${r.errorText ? `: "${r.errorText}"` : ""}`);
  else if (r.result === "timeout") p.push(`${r.sampleLabel ? `"${r.sampleLabel}"` : "the start screen"}${r.actionLabel ? ` then "${r.actionLabel}"` : ""} showed no finished result within ${r.seconds} s ${at}`);
  else if (r.result === "none" && r.sampleLabel) p.push(`after "${r.sampleLabel}" there was no main button to press and no result ${at}`);
  if (r.failedApi.length) p.push(`${r.failedApi.length} call(s) to the product's /api failed ${at} (${r.failedApi.slice(0, 3).map((f) => `${f.path} ${f.status}`).join(", ")})`);
  if (r.flaggedAnswers.length) p.push(`answers that weren't the model's real work ${at} (${r.flaggedAnswers.slice(0, 3).map((f) => `${f.path}: ${f.flags.join(", ")}`).join("; ")})`);
  if (r.consoleErrors.length) p.push(`${r.consoleErrors.length} console error(s) ${at}, first: "${r.consoleErrors[0].slice(0, 160)}"`);
  if (r.sidewaysPx > 0) p.push(`the page scrolls sideways by ${r.sidewaysPx} px ${at}`);
  if (r.viewport === "phone" && r.smallTaps.length) p.push(`${r.smallTaps.length} control(s) are under ${TAP_MIN}x${TAP_MIN} px to tap: ${list(r.smallTaps)}`);
  if (r.cutOff.length) p.push(`text is cut off at the right edge ${at}: ${list(r.cutOff, 3)}`);
  return p;
}

export interface ProductAudit {
  label: string;
  buildId: string;
  slug: string | null;
  name: string | null;
  liveUrl: string;
  pass: boolean;
  problems: string[];
  /** One paragraph for polish --focus-file, only when it fails. */
  focus?: string;
  runs: ViewportRun[];
}

/** Pass or fail for a product from its runs, with the focus paragraph when it fails. */
export function judgeProduct(base: Omit<ProductAudit, "pass" | "problems" | "focus">): ProductAudit {
  const problems = base.runs.flatMap(runProblems);
  const pass = problems.length === 0 && base.runs.length > 0;
  const out: ProductAudit = { ...base, pass, problems: base.runs.length ? problems : ["no viewport ran"] };
  if (!pass) out.focus = focusText(out);
  return out;
}

/**
 * The paragraph a failing product's polish gets: what the audit did, each problem it found, and what done looks like.
 * Written for Muse Code, in plain words, with no em dashes.
 */
export function focusText(a: Pick<ProductAudit, "name" | "slug" | "problems" | "runs">): string {
  const flow = a.runs.find((r) => r.sampleLabel);
  const how = flow ? `pressed "${flow.sampleLabel}"${flow.actionLabel ? `, then "${flow.actionLabel}"` : ""}` : "opened the start screen";
  const found = a.problems.length ? a.problems.map((p, i) => `(${i + 1}) ${p}`).join("; ") : "(1) no viewport ran";
  return [
    `An automated audit opened ${a.name ?? a.slug ?? "the product"} on desktop at 1440x900 and on a phone at 390x844 and ${how}.`,
    `It found: ${found}.`,
    `Fix each one so that Try the sample, then the main button, finishes on both sizes with a real answer from the model (no fallback, estimate or canned text), no console errors or failed calls, no sideways scroll, every control at least ${TAP_MIN} px to tap on a phone, and no text cut off.`,
    "Keep the Meta UI look (meta-ui tokens and components), and change nothing that already works.",
  ].join(" ");
}

export interface AuditReport {
  site: string;
  startedAt: string;
  finishedAt?: string;
  timeoutSeconds: number;
  products: ProductAudit[];
  skipped: Array<{ label: string; buildId: string; reason: string }>;
}

/** The summary: a table with pass or fail per product, then each failing product's focus paragraph. */
export function auditMarkdown(r: AuditReport, jsonPath: string): string {
  const cell = (a: ProductAudit, v: ViewportName) => {
    const run = a.runs.find((x) => x.viewport === v);
    if (!run) return "not run";
    const n = runProblems(run).length;
    return n ? `fail (${n})` : `pass, ${run.seconds} s`;
  };
  const pass = r.products.filter((p) => p.pass).length;
  const lines = [
    `# Product audit, ${r.startedAt}`,
    "",
    `${pass} of ${r.products.length} products pass on ${r.site}. ${r.skipped.length} skipped. Made-up data only: the audit presses each product's own sample and main button and types nothing. Full results: ${jsonPath}.`,
    "",
    "| Product | Result | Desktop | Phone | Problems |",
    "|---|---|---|---|---|",
    ...r.products.map((a) => `| [${a.name ?? a.label}](${a.liveUrl}) (${a.label}) | ${a.pass ? "pass" : "**fail**"} | ${cell(a, "desktop")} | ${cell(a, "phone")} | ${a.problems.length} |`),
    "",
  ];
  if (r.skipped.length) lines.push("## Skipped", "", ...r.skipped.map((s) => `- ${s.label} (${s.buildId}): ${s.reason}`), "");
  const failing = r.products.filter((p) => !p.pass);
  if (failing.length) {
    lines.push("## Focus text for polish", "", "Pass this file's JSON to `scripts/polish-batch.ts --focus-file=` to send each paragraph with that product's polish.", "");
    for (const a of failing) lines.push(`### ${a.name ?? a.label}`, "", a.focus ?? "", "");
  }
  return `${lines.join("\n")}\n`;
}

/** Turns a label into a file name part for screenshots. */
export const fileSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "product";

/** A console line worth counting: not a favicon miss, and not the browser's echo of an /api failure already counted. */
export function countedConsoleError(text: string): boolean {
  if (/favicon\.ico/i.test(text)) return false;
  if (/^Failed to load resource/i.test(text)) return false;
  return text.trim().length > 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// In-page scripts, as strings. Each is an expression page.evaluate runs and returns plain JSON.

const VISIBLE_FN = `function vis(el) { var r = el.getBoundingClientRect(); if (r.width <= 2 || r.height <= 2) return false; return el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true; }`;
const LABEL_FN = `function lab(el) { var field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName); var named = el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title"); var t = ((field ? named || el.getAttribute("name") || el.tagName.toLowerCase() + " field" : el.innerText || named || el.value) || "").trim().replace(/\\s+/g, " "); return t.slice(0, 60) || el.tagName.toLowerCase(); }`;

/**
 * Marks the main action after the sample with data-mm-audit="primary" and returns its label, or null. Prefers
 * `button.primary.ai`, then `.primary`, `.tinted.ai`, a submit button, then `.tinted`, skipping the sample control,
 * utilities (Reset, Clear, Start over, Make another) and anything disabled, busy or in the header or nav.
 */
export const MARK_PRIMARY_SCRIPT = `(() => {
  ${VISIBLE_FN}
  ${LABEL_FN}
  document.querySelectorAll("[data-mm-audit]").forEach(function (el) { el.removeAttribute("data-mm-audit"); });
  var skip = /^(try\\b|reset|clear|start over|make another|new |cancel|back|close|menu|sign in|log in|copy|download|share|edit)/i;
  var best = null, bestScore = 0;
  document.querySelectorAll("button, [role='button'], input[type='submit']").forEach(function (el) {
    if (!vis(el) || el.disabled || el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-busy") === "true") return;
    if (el.closest("nav, header, footer, [role='dialog'][aria-hidden='true']")) return;
    var label = lab(el);
    if (skip.test(label)) return;
    var c = el.classList, score = 0;
    if (c.contains("primary") && c.contains("ai")) score = 6; else if (c.contains("primary")) score = 5;
    else if (c.contains("tinted") && c.contains("ai")) score = 4; else if (el.type === "submit") score = 3; else if (c.contains("tinted")) score = 2;
    if (score > bestScore) { best = el; bestScore = score; }
  });
  if (!best) return null;
  best.setAttribute("data-mm-audit", "primary");
  return lab(best);
})()`;

/**
 * Where the flow stands: busy while any visible aria-busy, .working or skeleton is on screen; an error box's text; a
 * result's text (the first visible [data-result], else .card.ai, with at least 20 characters).
 */
export const FLOW_STATE_SCRIPT = `(() => {
  ${VISIBLE_FN}
  var any = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(vis); };
  var busy = any("[aria-busy='true'], .working, .skeleton, [data-skeleton]").length > 0;
  var err = any(".error[role='alert'], [role='alert'].error, .error")[0];
  var res = any("[data-result]").concat(any(".card.ai")).filter(function (el) { return (el.innerText || "").trim().length >= 20; })[0];
  return { busy: busy, error: err ? (err.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 200) : null, result: res ? (res.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 300) : null };
})()`;

/** Sideways scroll in px, controls under TAP_MIN (labels in a sentence are exempt), and text cut off at the right edge. */
export const LAYOUT_SCRIPT = `(() => {
  ${VISIBLE_FN}
  ${LABEL_FN}
  var vw = document.documentElement.clientWidth;
  var sideways = Math.max(0, Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) - vw);
  var small = [], cut = [], seen = new Set();
  document.querySelectorAll("button, [role='button'], a[href], input:not([type='hidden']), select, textarea, summary").forEach(function (el) {
    var box = el;
    if (el.tagName === "INPUT" && /checkbox|radio/.test(el.type)) box = el.closest("label") || (el.id && document.querySelector("label[for='" + el.id + "']")) || el;
    if (!vis(box)) return;
    if (el.tagName === "A") { var p = el.parentElement; if (p && (p.innerText || "").trim().length > (el.innerText || "").trim().length + 3 && getComputedStyle(el).display === "inline") return; }
    var r = box.getBoundingClientRect();
    if ((r.width < ${TAP_MIN} - 0.5 || r.height < ${TAP_MIN} - 0.5) && !seen.has(box)) { seen.add(box); small.push(lab(el) + " (" + Math.round(r.width) + "x" + Math.round(r.height) + ")"); }
  });
  var all = document.body ? document.body.querySelectorAll("*") : [];
  for (var i = 0; i < all.length && cut.length < 8; i++) {
    var el = all[i];
    var own = Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && n.textContent.trim().length > 1; });
    if (!own || !vis(el)) continue;
    var s = getComputedStyle(el), r = el.getBoundingClientRect();
    var scroller = el.closest("pre, code, table, [style*='overflow']");
    var past = r.right > vw + 1 && r.left < vw;
    var clipped = s.overflowX !== "visible" && s.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1 && !/auto|scroll/.test(s.overflowX);
    if ((past && !scroller) || clipped) cut.push((el.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 50));
  }
  return { sidewaysPx: Math.round(sideways), smallTaps: small.slice(0, 12), cutOff: cut };
})()`;

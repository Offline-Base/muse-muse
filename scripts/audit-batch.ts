/**
 * A hands-on audit of each live product a batch made, in headless Chromium: desktop 1440x900 and phone 390x844. For each
 * size it loads the product, presses its "Try the sample" control and then the next main button, waits for the result
 * (up to --timeout), and records console errors, failed /api calls, answers marked model: false, fallback: true,
 * estimate: true or with an error field, sideways scroll, controls under 44 px on the phone and text cut off at the
 * right edge, with screenshots. Then it writes .data/audit-<time>.json and .data/audit-<time>.md: pass or fail per
 * product, and for each failing one a focus paragraph that scripts/polish-batch.ts --focus-file sends with its polish.
 *   npx tsx scripts/audit-batch.ts .data/demo-batch-A.json .data/demo-batch-B.json
 *   npx tsx scripts/audit-batch.ts <buildId> <buildId>
 *   npx tsx scripts/audit-batch.ts https://<product address>   a product by its address (label from the address)
 *   --dry                 list what would be audited; open no browser
 *   --viewports=desktop,phone   one or both (each is one main-flow run, so at most 2 per product)
 *   --concurrency=4       products at once (at most 4)
 *   --timeout=150         seconds to wait for a result after the main button
 *   --playwright=<dir>    a node_modules folder with playwright (default: this repo's, then template/node_modules)
 *   --url=<site>          another deployment
 * Made-up data only: it presses the product's own sample and types nothing. Each sample run calls the product's models
 * through its live token, so an audit spends a little Meta money on the products' own budgets (not in build costUsd).
 */
import { existsSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, siteArg, words } from "./automation";
import {
  FLOW_STATE_SCRIPT,
  LAYOUT_SCRIPT,
  MARK_PRIMARY_SCRIPT,
  VIEWPORTS,
  answerFlags,
  auditMarkdown,
  countedConsoleError,
  fileSafe,
  judgeProduct,
  type AuditReport,
  type ProductAudit,
  type ViewportName,
  type ViewportRun,
} from "./batch/audit-logic";
import { mapLimit, type BatchBuild, type BuildView } from "./batch/logic";
import { readBatchArgs, siteFetcher } from "./spend-ledger";

// The few Playwright shapes this uses, so the typecheck doesn't need playwright's types in the root node_modules.
interface PwResponse { url(): string; status(): number; headers(): Record<string, string>; json(): Promise<unknown>; request(): { resourceType(): string } }
interface PwRequest { url(): string; failure(): { errorText: string } | null; resourceType(): string }
interface PwLocator { first(): PwLocator; count(): Promise<number>; isVisible(): Promise<boolean>; click(o?: { timeout?: number }): Promise<void>; innerText(): Promise<string>; nth(i: number): PwLocator }
interface PwPage {
  on(ev: "console", fn: (m: { type(): string; text(): string }) => void): void;
  on(ev: "pageerror", fn: (e: Error) => void): void;
  on(ev: "response", fn: (r: PwResponse) => void): void;
  on(ev: "requestfailed", fn: (r: PwRequest) => void): void;
  goto(url: string, o: { waitUntil: string; timeout: number }): Promise<{ status(): number } | null>;
  waitForLoadState(s: string, o: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
  getByRole(role: string, o: { name: RegExp }): PwLocator;
  locator(sel: string): PwLocator;
  screenshot(o: { path: string; fullPage: boolean }): Promise<unknown>;
}
interface PwContext { newPage(): Promise<PwPage>; close(): Promise<void> }
interface PwBrowser { newContext(o: Record<string, unknown>): Promise<PwContext>; close(): Promise<void> }
interface Pw { chromium: { launch(o: { headless: boolean }): Promise<PwBrowser> } }

/** The folders to look for playwright in, in order. */
export function playwrightDirs(cwd = process.cwd(), given = arg("playwright")): string[] {
  const dirs: string[] = [];
  if (given) dirs.push(isAbsolute(given) ? given : resolve(cwd, given));
  dirs.push(join(cwd, "node_modules"), join(cwd, "template", "node_modules"));
  // A worktree's node_modules is often a link to the main checkout's; that checkout's template may have playwright.
  const nm = join(cwd, "node_modules");
  try { dirs.push(join(dirname(resolve(cwd, readlinkSync(nm))), "template", "node_modules")); } catch { /* not a link */ }
  try { dirs.push(join(dirname(realpathSync(nm)), "template", "node_modules")); } catch { /* none */ }
  dirs.push(join(homedir(), "mm-wt", "recipe-models", "template", "node_modules"));
  return [...new Set(dirs)];
}

function loadPlaywright(): Pw {
  for (const dir of playwrightDirs()) {
    if (!existsSync(dir)) continue;
    const req = createRequire(join(dir, "noop.js"));
    for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
      try { return req(name) as Pw; } catch { /* next */ }
    }
  }
  throw new Error(`Playwright isn't in any of: ${playwrightDirs().join(", ")}. Pass --playwright=<node_modules folder> (template/node_modules has it once installed).`);
}

const pathOf = (url: string) => { try { const u = new URL(url); return u.pathname; } catch { return url; } };

/** One main-flow run of one product at one size. */
async function runOnce(browser: PwBrowser, liveUrl: string, viewport: ViewportName, shotBase: string, timeoutS: number): Promise<ViewportRun> {
  const v = VIEWPORTS[viewport];
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, isMobile: v.mobile, hasTouch: v.mobile, deviceScaleFactor: v.mobile ? 2 : 1, ignoreHTTPSErrors: false });
  const page = await ctx.newPage();
  const origin = new URL(liveUrl).origin;
  const run: ViewportRun = { viewport, loaded: false, sampleLabel: null, actionLabel: null, result: "none", seconds: 0, consoleErrors: [], failedApi: [], flaggedAnswers: [], sidewaysPx: 0, smallTaps: [], cutOff: [], screenshots: [] };
  const isApi = (url: string) => url.startsWith(origin) && pathOf(url).startsWith("/api/");
  page.on("console", (m) => { if (m.type() === "error" && countedConsoleError(m.text())) run.consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => run.consoleErrors.push(`Uncaught ${e.message}`.slice(0, 300)));
  page.on("requestfailed", (r) => { const f = r.failure()?.errorText ?? "failed"; if (isApi(r.url()) && !/ERR_ABORTED/.test(f)) run.failedApi.push({ path: pathOf(r.url()), status: f }); });
  page.on("response", (r) => {
    if (!isApi(r.url())) return;
    if (r.status() >= 400) run.failedApi.push({ path: pathOf(r.url()), status: r.status() });
    if (!/json/.test(r.headers()["content-type"] ?? "")) return;
    void r.json().then((j) => { const flags = answerFlags(j); if (flags.length) run.flaggedAnswers.push({ path: pathOf(r.url()), flags }); }).catch(() => undefined);
  });
  const shot = async (name: string) => {
    const path = `${shotBase}-${viewport}-${name}.png`;
    await page.screenshot({ path, fullPage: true }).then(() => run.screenshots.push(path)).catch(() => undefined);
  };
  const t0 = Date.now();
  try {
    const res = await page.goto(liveUrl, { waitUntil: "load", timeout: 45_000 });
    if (res && res.status() >= 400) {
      run.loadNote = `HTTP ${res.status()}`;
      await shot("start");
      return run;
    }
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    run.loaded = true;
    await shot("start");

    // The sample: a visible button or link whose text starts with "Try".
    const tries = page.getByRole("button", { name: /^\s*try\b/i });
    const links = page.getByRole("link", { name: /^\s*try\b/i });
    let sample: PwLocator | null = null;
    for (const loc of [tries, links]) {
      const n = await loc.count();
      for (let i = 0; i < n && !sample; i++) if (await loc.nth(i).isVisible()) sample = loc.nth(i);
      if (sample) break;
    }
    if (sample) {
      run.sampleLabel = (await sample.innerText()).trim().replace(/\s+/g, " ").slice(0, 60) || "Try the sample";
      await sample.click({ timeout: 10_000 });
      await page.waitForTimeout(1500);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      // Some samples run the flow themselves; wait for them to settle before looking for the next button.
      for (let i = 0; i < 20; i++) { const s = await page.evaluate<{ busy: boolean }>(FLOW_STATE_SCRIPT); if (!s.busy) break; await page.waitForTimeout(1000); }
      run.actionLabel = await page.evaluate<string | null>(MARK_PRIMARY_SCRIPT);
      const started = Date.now();
      if (run.actionLabel) await page.locator("[data-mm-audit='primary']").first().click({ timeout: 10_000 });
      // Wait for the flow to finish: nothing busy, and a result or an error on screen.
      await page.waitForTimeout(1500);
      let last: { busy: boolean; error: string | null; result: string | null } = { busy: true, error: null, result: null };
      while (Date.now() - started < timeoutS * 1000) {
        last = await page.evaluate(FLOW_STATE_SCRIPT);
        if (!last.busy && (last.result || last.error)) break;
        if (!last.busy && !run.actionLabel && Date.now() - started > 15_000) break;
        await page.waitForTimeout(1500);
      }
      run.seconds = Math.round((Date.now() - started) / 1000);
      if (last.error && !last.busy) { run.result = "error"; run.errorText = last.error; }
      else if (last.result && !last.busy) { run.result = "shown"; run.resultText = last.result; }
      else if (run.actionLabel || last.busy) run.result = "timeout";
      else run.result = "none";
    }
    await page.waitForTimeout(800);
    const layout = await page.evaluate<{ sidewaysPx: number; smallTaps: string[]; cutOff: string[] }>(LAYOUT_SCRIPT);
    Object.assign(run, layout);
    await shot("result");
  } catch (err) {
    if (!run.loaded) run.loadNote = err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : String(err);
    else run.consoleErrors.push(`audit: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err)}`);
    await shot("stopped");
  } finally {
    if (!run.seconds) run.seconds = Math.round((Date.now() - t0) / 1000);
    await ctx.close().catch(() => undefined);
  }
  return run;
}

function viewportsArg(): ViewportName[] {
  const raw = arg("viewports");
  if (raw === undefined) return ["desktop", "phone"];
  const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !(n in VIEWPORTS));
  if (bad.length || !names.length) throw new Error(`--viewports takes desktop, phone or both, not ${raw}.`);
  return [...new Set(names)] as ViewportName[];
}

async function main(): Promise<void> {
  // Product addresses on the command line are audited as they are (a featured product, or a local fake for a check).
  const urls = words().filter((w) => /^https?:\/\//.test(w));
  const rest = process.argv.filter((a) => !urls.includes(a));
  const builds = urls.length && words(rest).length === 0 ? [] : readBatchArgs(rest);
  const site = siteArg();
  const views = viewportsArg();
  const concurrency = Math.min(4, Math.max(1, Math.floor(Number(arg("concurrency") ?? 4)) || 4));
  const timeoutS = Math.max(10, Number(arg("timeout") ?? 150) || 150);
  const fetch = siteFetcher(site);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report: AuditReport = { site, startedAt: new Date().toISOString(), timeoutSeconds: timeoutS, products: [], skipped: [] };

  const targets: Array<BatchBuild & { view: BuildView; liveUrl: string }> = [];
  const read = await mapLimit(builds, 8, (b) => fetch(b.buildId));
  for (const u of urls) {
    const label = fileSafe(new URL(u).host + new URL(u).pathname);
    targets.push({ label, buildId: "", liveUrl: u, view: { buildId: "", kind: "build", status: "live", terminal: true, shipped: true, costUsd: null, error: null, productId: null, slug: label, name: null, liveUrl: u, productStatus: null, latestBuildId: null } });
  }
  builds.forEach((b, i) => {
    const v = read[i];
    if (!("status" in v)) return void report.skipped.push({ label: b.label, buildId: b.buildId, reason: `couldn't read the build: ${v.error}` });
    const view = v as BuildView;
    if (!view.liveUrl) return void report.skipped.push({ label: b.label, buildId: b.buildId, reason: `no live address yet (build ${view.status})` });
    if (view.productStatus === "disabled") return void report.skipped.push({ label: b.label, buildId: b.buildId, reason: "the product is disabled" });
    targets.push({ ...b, view, liveUrl: view.liveUrl.startsWith("/") ? `${site}${view.liveUrl}` : view.liveUrl });
  });

  if (process.argv.includes("--dry")) {
    for (const t of targets) console.log(`audit  ${t.label.padEnd(34)} ${t.liveUrl}`);
    for (const s of report.skipped) console.log(`skip   ${s.label.padEnd(34)} ${s.reason}`);
    console.log(`\n${targets.length} to audit at ${views.join(" and ")} (${targets.length * views.length} main-flow runs, ${concurrency} at once). --dry opened no browser.`);
    return;
  }

  const shotsDir = join(".data", `audit-${stamp}`);
  mkdirSync(shotsDir, { recursive: true });
  const jsonPath = join(".data", `audit-${stamp}.json`);
  const mdPath = join(".data", `audit-${stamp}.md`);
  const save = () => {
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(mdPath, auditMarkdown(report, jsonPath));
  };
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  try {
    await mapLimit(targets, concurrency, async (t) => {
      const runs: ViewportRun[] = [];
      for (const v of views) runs.push(await runOnce(browser, t.liveUrl, v, join(shotsDir, fileSafe(t.view.slug ?? t.label)), timeoutS));
      const audit: ProductAudit = judgeProduct({ label: t.label, buildId: t.buildId, slug: t.view.slug, name: t.view.name, liveUrl: t.liveUrl, runs });
      report.products.push(audit);
      save();
      console.log(`${audit.pass ? "pass" : "FAIL"}  ${t.label.padEnd(34)} ${audit.pass ? "" : audit.problems.slice(0, 2).join("; ")}`);
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
  report.products.sort((a, b) => Number(a.pass) - Number(b.pass) || a.label.localeCompare(b.label));
  report.finishedAt = new Date().toISOString();
  save();
  const pass = report.products.filter((p) => p.pass).length;
  console.log(`\n${pass} of ${report.products.length} pass, ${report.skipped.length} skipped. ${mdPath}, ${jsonPath}, screenshots in ${shotsDir}/.`);
  if (pass < report.products.length) console.log(`Polish the failing ones with: npm run polish-batch -- <the same files> --focus-file=${jsonPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

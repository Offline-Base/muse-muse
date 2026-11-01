// Platform file (Muse Muse platform services). Don't edit: use these helpers in tests/smoke.spec.ts.
//
// openExtension builds extension/ for the test server's address (scripts/extension-pack.mjs build), loads it into its
// own Chromium the way Load unpacked does, and waits for its service worker. openPopup opens its popup or side panel
// as a page at popup size. expectExtensionAction runs a step in that page and checks that it called one of the
// product's actions and got JSON back. Each records its check for verify's caps step, which also loads the extension
// itself and opens the popup.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { recordCapCheck } from "./index";

const ROOT = process.cwd();
const PACKER = path.join(ROOT, "scripts", "extension-pack.mjs");
const OUT = path.join(ROOT, "test-results", "caps", "extension-build");

export interface ExtensionSession {
  context: BrowserContext;
  /** The extension's id, as in chrome-extension://<id>/. */
  id: string;
  /** The built manifest Chrome loaded. */
  manifest: { action?: { default_popup?: string }; side_panel?: { default_path?: string } };
  close(): Promise<void>;
}

const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.replace(/^extension: /, "").slice(0, 240) ?? "";

/**
 * Builds and loads the extension for the test server at `baseURL` (the `baseURL` fixture), in a Chromium of its own:
 * extensions load only in a persistent context, with Chromium's full headless mode.
 */
export async function openExtension(baseURL: string | undefined): Promise<ExtensionSession> {
  const origin = new URL(baseURL ?? "http://localhost:3100").origin;
  const built = spawnSync(process.execPath, [PACKER, "build", "--origin", origin, "--out", OUT], { cwd: ROOT, encoding: "utf8" });
  if (built.status !== 0) {
    const why = firstLine(built.stderr || built.stdout) || "the packer stopped";
    recordCapCheck("extension", { id: "loaded", ok: false, detail: `It didn't build: ${why}` });
    throw new Error(`The extension didn't build: ${why}`);
  }
  const userDataDir = mkdtempSync(path.join(tmpdir(), "mm-extension-"));
  // MUSEMUSE_EXTENSION_CHROMIUM points at another Chromium on a machine without Playwright's own; never needed in a build.
  const executablePath = process.env.MUSEMUSE_EXTENSION_CHROMIUM || undefined;
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      args: [`--disable-extensions-except=${OUT}`, `--load-extension=${OUT}`],
    });
  } catch (err) {
    rmSync(userDataDir, { recursive: true, force: true });
    recordCapCheck("extension", { id: "loaded", ok: false, detail: `Chromium didn't start: ${String((err as Error).message ?? err).split("\n")[0]!.slice(0, 200)}` });
    throw err;
  }
  const close = async () => {
    await context.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  };
  let worker: Worker | undefined = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => undefined);
  if (!worker) {
    await close();
    recordCapCheck("extension", { id: "loaded", ok: false, detail: "Chrome didn't start the extension's service worker, so it didn't load" });
    throw new Error("The extension didn't load: its service worker never started.");
  }
  const id = new URL(worker.url()).host;
  const manifest = JSON.parse(readFileSync(path.join(OUT, "manifest.json"), "utf8")) as ExtensionSession["manifest"];
  recordCapCheck("extension", { id: "loaded", ok: true, detail: "Chrome loaded the extension and started its service worker" });
  return { context, id, manifest, close };
}

/**
 * Opens the extension's popup (or its side panel, or `file`) as a page at popup size, and checks it rendered: no
 * script error, and something on it to read or press. Open the page to act on first, in the same context, so the
 * popup's currentPage() finds it.
 */
export async function openPopup(session: ExtensionSession, file?: string): Promise<Page> {
  const target = file ?? session.manifest.action?.default_popup ?? session.manifest.side_panel?.default_path ?? "popup.html";
  const page = await session.context.newPage();
  await page.setViewportSize({ width: 380, height: 600 });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`chrome-extension://${session.id}/${target}`);
  await page.waitForLoadState("load");
  await page.waitForTimeout(500);
  const shown = await page.evaluate(() => (document.body?.innerText ?? "").trim().length > 0 || Boolean(document.querySelector("button, input, textarea, select")));
  const ok = shown && !errors.length;
  recordCapCheck("extension", {
    id: "popup",
    ok,
    detail: ok ? `${target} rendered in the test browser` : errors.length ? `${target} threw: ${errors[0]!.slice(0, 200)}` : `${target} rendered nothing`,
  });
  expect(errors, `${target} threw an error`).toEqual([]);
  expect(shown, `${target} rendered nothing`).toBeTruthy();
  return page;
}

/**
 * Runs `step` (clicks in the popup) and expects it to call the product's action `action` and get JSON back. Returns
 * the reply. Assert what the popup shows for it, never a model's exact words.
 */
export async function expectExtensionAction<T = unknown>(page: Page, action: string, step: () => Promise<void>): Promise<T> {
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/actions/${action}`, { timeout: 150_000 });
  await step();
  const res = await answered.catch(() => null);
  const reply = res ? ((await res.json().catch(() => undefined)) as T | undefined) : undefined;
  const ok = Boolean(res?.ok()) && reply !== undefined;
  recordCapCheck("extension", {
    id: "action",
    ok,
    detail: ok ? `The popup called ${action} and got its reply` : !res ? `The popup never called ${action}` : !res.ok() ? `${action} answered HTTP ${res.status()}` : `${action} didn't answer with JSON`,
  });
  expect(res, `the popup never called ${action}`).not.toBeNull();
  expect(res!.ok(), `${action} answered HTTP ${res!.status()}`).toBeTruthy();
  expect(reply, `${action} didn't answer with JSON`).not.toBeUndefined();
  return reply as T;
}

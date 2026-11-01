// Platform file (Muse Muse platform services). Don't edit. scripts/caps/extension.mjs runs it in a process of its own.
//
//   node scripts/caps/extension-load.mjs --root <product>
//
// Builds the product's extension with the platform's packer beside this file (../extension-pack.mjs), pointed at a
// closed port so no product answers, loads it into Chromium the way Load unpacked does, waits for its service worker
// and opens its popup (or side panel). The last line of stdout is one JSON result:
//   {"musemuse_extension_load":1,"loaded":bool,"popup":bool,"detail":"..."}
//
// It runs apart from the caps check because compiling uses the product's TypeScript and loading uses the product's
// Playwright, both from the product's node_modules. Whatever they do stays in this process, so they can't change any
// other check's result.
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const CLOSED_PORT_ORIGIN = "http://127.0.0.1:9";

/** Loads the built extension in Chromium and opens `page`. { loaded, popup, detail }. */
async function loadAndOpen({ root, dir, page: target }) {
  let chromium;
  try {
    chromium = createRequire(path.join(root, "package.json"))("@playwright/test").chromium;
  } catch {
    return { loaded: false, popup: false, detail: "Playwright isn't installed in the product, so the extension couldn't be loaded" };
  }
  const userDataDir = mkdtempSync(path.join(tmpdir(), "mm-extension-check-"));
  const executablePath = process.env.MUSEMUSE_EXTENSION_CHROMIUM || undefined;
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
    });
  } catch (err) {
    rmSync(userDataDir, { recursive: true, force: true });
    return { loaded: false, popup: false, detail: `Chromium didn't start: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}` };
  }
  try {
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 }).catch(() => undefined);
    if (!worker) return { loaded: false, popup: false, detail: "Chrome didn't start its service worker, so the extension didn't load" };
    const id = new URL(worker.url()).host;
    const tab = await context.newPage();
    await tab.setViewportSize({ width: 380, height: 600 });
    const errors = [];
    tab.on("pageerror", (err) => errors.push(err.message));
    await tab.goto(`chrome-extension://${id}/${target}`, { timeout: 15_000 });
    await tab.waitForLoadState("load");
    await tab.waitForTimeout(750);
    const shown = await tab.evaluate(() => (document.body?.innerText ?? "").trim().length > 0 || Boolean(document.querySelector("button, input, textarea, select")));
    if (errors.length) return { loaded: true, popup: false, detail: `${target} threw: ${errors[0].slice(0, 200)}` };
    return shown ? { loaded: true, popup: true, detail: `${target} rendered` } : { loaded: true, popup: false, detail: `${target} rendered nothing` };
  } catch (err) {
    return { loaded: true, popup: false, detail: `${target} couldn't be opened: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}` };
  } finally {
    await context.close().catch(() => undefined);
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  const at = process.argv.indexOf("--root");
  const root = at > 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : null;
  if (!root) return { loaded: false, popup: false, detail: "the loader needs --root <product>" };
  const { buildExtension } = await import(new URL("../extension-pack.mjs", import.meta.url).href);
  const dir = mkdtempSync(path.join(tmpdir(), "mm-extension-built-"));
  try {
    const built = buildExtension({ root, origin: CLOSED_PORT_ORIGIN, out: dir });
    if (!built.ok) return { loaded: false, popup: false, detail: built.problems[0] ?? "it didn't build" };
    const page = built.manifest?.action?.default_popup ?? built.manifest?.side_panel?.default_path ?? "popup.html";
    return await loadAndOpen({ root, dir, page });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const result = await main().catch((err) => ({ loaded: false, popup: false, detail: `the loader stopped: ${String(err?.message ?? err).split("\n")[0].slice(0, 200)}` }));
process.stdout.write(`\n${JSON.stringify({ musemuse_extension_load: 1, ...result })}\n`, () => process.exit(0));

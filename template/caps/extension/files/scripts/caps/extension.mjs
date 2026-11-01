// Platform file (Muse Muse platform services). Don't edit. verify's caps step runs it through scripts/caps-check.mjs.
//
// The fixed checks for a browser extension. In a build sandbox this is the platform's read-only copy, with the
// platform's own packer beside it (../extension-pack.mjs), never the product's copy:
//   manifest  extension/ compiles, and its manifest and files pass the rules the platform packages by: Manifest V3, only
//             the permissions brief.md lists, no host permissions of its own, no remote or inline code, and network
//             calls only through productAction() in extension/platform.ts
//   loaded    the platform builds it and loads it into Chromium itself, the way Load unpacked does, and its service
//             worker starts
//   popup     the platform opens its popup (or side panel) itself, and it renders with no script error
//   action    the smoke test ran a step in the popup that called one of the product's actions and got JSON back
//             (tests/caps/extension.ts, expectExtensionAction)
//
// What these rest on: manifest, loaded and popup are the platform's own, from the product's files as they are now.
// action reads the smoke test's record, which a product test could write itself. The gateway keeps no record of
// extension calls: they reach the product's own action routes.
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const packer = () => import(new URL("../extension-pack.mjs", import.meta.url).href);

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

export async function check({ record, root }) {
  const { checkExtension, buildExtension } = await packer();
  const checks = [];
  const { problems } = checkExtension({ root });
  checks.push({
    id: "manifest",
    ok: problems.length === 0,
    detail: problems.length ? problems.slice(0, 3).join("; ") : "Manifest V3, only its listed permissions, no remote or inline code, network calls only through productAction",
  });
  if (problems.length) {
    checks.push({ id: "loaded", ok: false, detail: "Not loaded, since the manifest check failed" }, { id: "popup", ok: false, detail: "Not opened, since the manifest check failed" });
  } else {
    // A closed port: the popup must render without the product answering, as it does while a page loads.
    const dir = mkdtempSync(path.join(tmpdir(), "mm-extension-built-"));
    try {
      const built = buildExtension({ root, origin: "http://127.0.0.1:9", out: dir });
      const page = built.manifest?.action?.default_popup ?? built.manifest?.side_panel?.default_path ?? "popup.html";
      const seen = built.ok ? await loadAndOpen({ root, dir, page }) : { loaded: false, popup: false, detail: built.problems[0] ?? "it didn't build" };
      checks.push({ id: "loaded", ok: seen.loaded, detail: seen.loaded ? "The platform loaded it into Chromium and its service worker started" : seen.detail });
      checks.push({ id: "popup", ok: seen.popup, detail: seen.detail });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const action = (record?.checks ?? []).find((c) => c?.id === "action");
  checks.push({
    id: "action",
    ok: action?.ok === true,
    detail: action ? String(action.detail ?? "").slice(0, 200) : "The smoke test didn't run a popup step with expectExtensionAction from tests/caps/extension.ts",
  });
  return checks;
}

// A product without musemuse.caps.json gets the Playwright config it had before platform services (docs/CAPABILITIES.md,
// section 1): the same projects, base URL and web server, for a web product and for a VR product. Both goldens were
// written by this file run against d8ffec4 (wave 2) alone, so it uses nothing from wave 3. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
// and to rewrite them on purpose: UPDATE_GOLDEN=1 GOLDEN_DIR=<dir> npx tsx --test template/scripts/__tests__/playwright-off.test.mjs
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GOLDEN = process.env.GOLDEN_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "golden");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** JSON with each RegExp as "re:<source>", so a config compares as text. */
const serialize = (value) => `${JSON.stringify(value, (_k, v) => (v instanceof RegExp ? `re:${v.source}` : v), 2)}\n`;

/** The config template/playwright.config.ts exports in a product folder with these files, defineConfig stubbed. */
async function loadConfig(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-pw-off-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "node_modules/@playwright/test"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules/@playwright/test/package.json"), JSON.stringify({ name: "@playwright/test", type: "module", main: "index.js" }));
  writeFileSync(path.join(dir, "node_modules/@playwright/test/index.js"), "export const defineConfig = (c) => c;\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(path.join(TEMPLATE, "playwright.config.ts"), path.join(dir, "playwright.config.ts"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  const saved = { MUSEMUSE_PORT: process.env.MUSEMUSE_PORT, MUSEMUSE_BASE_URL: process.env.MUSEMUSE_BASE_URL };
  delete process.env.MUSEMUSE_PORT;
  delete process.env.MUSEMUSE_BASE_URL;
  // Playwright runs the config from the product folder, which is where it reads musemuse.target.json.
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return (await import(`${pathToFileURL(path.join(dir, "playwright.config.ts")).href}?t=${Math.random()}`)).default;
  } finally {
    process.chdir(cwd);
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

function golden(name, text) {
  if (process.env.UPDATE_GOLDEN) writeFileSync(path.join(GOLDEN, name), text);
  assert.equal(text, readFileSync(path.join(GOLDEN, name), "utf8"), `${name} changed`);
}

test("a web product's Playwright config is what it was before platform services", async () => {
  golden("playwright-config.json", serialize(await loadConfig()));
});

test("a VR product's Playwright config is what it was before platform services", async () => {
  const files = {
    "musemuse.target.json": JSON.stringify({ targets: ["web", "vr"] }),
    "scripts/browser.json": readFileSync(path.join(TEMPLATE, "scripts/browser.json"), "utf8"),
  };
  golden("playwright-config-vr.json", serialize(await loadConfig(files)));
});

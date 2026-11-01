// A product without musemuse.caps.json verifies and records exactly as before platform services existed
// (docs/CAPABILITIES.md, section 1): verify's summary has the same steps. Playwright's config is checked against goldens
// from d8ffec4 in playwright-off.test.mjs. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCapsFile, verifyStepNames } from "../smoke-report.mjs";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "mm-caps-off-"));
  dirs.push(d);
  return d;
};

/** JSON with each RegExp as "re:<source>", so a config compares as text. */
const serialize = (value) => `${JSON.stringify(value, (_k, v) => (v instanceof RegExp ? `re:${v.source}` : v), 2)}\n`;

/** The config template/playwright.config.ts exports, with @playwright/test's defineConfig stubbed and these files around it. */
async function loadConfig(files = {}, env = {}) {
  const dir = temp();
  mkdirSync(path.join(dir, "node_modules/@playwright/test"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules/@playwright/test/package.json"), JSON.stringify({ name: "@playwright/test", type: "module", main: "index.js" }));
  writeFileSync(path.join(dir, "node_modules/@playwright/test/index.js"), "export const defineConfig = (c) => c;\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(path.join(TEMPLATE, "playwright.config.ts"), path.join(dir, "playwright.config.ts"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  const saved = Object.fromEntries(["MUSEMUSE_PORT", "MUSEMUSE_BASE_URL", ...Object.keys(env)].map((k) => [k, process.env[k]]));
  delete process.env.MUSEMUSE_PORT;
  delete process.env.MUSEMUSE_BASE_URL;
  Object.assign(process.env, env);
  try {
    return (await import(`${pathToFileURL(path.join(dir, "playwright.config.ts")).href}?t=${Math.random()}`)).default;
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

describe("a product without platform services", () => {
  test("verify's steps are the six it always had", () => {
    assert.deepEqual(verifyStepNames(false), ["typecheck", "build", "start", "console", "smoke", "manifest"]);
    assert.equal(readCapsFile(() => null), null);
  });

  test("verify, run for real in a bare folder, reports exactly those steps and no caps", () => {
    const dir = temp();
    mkdirSync(path.join(dir, "scripts"));
    for (const f of ["verify.mjs", "smoke-report.mjs"]) copyFileSync(path.join(TEMPLATE, "scripts", f), path.join(dir, "scripts", f));
    const res = spawnSync(process.execPath, [path.join(dir, "scripts/verify.mjs")], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    const summary = JSON.parse(res.stdout.trim().split("\n").at(-1));
    assert.equal(summary.musemuse_verify, 1);
    assert.equal(summary.passed, false);
    assert.deepEqual(summary.steps.map((s) => s.name), ["typecheck", "build", "start", "console", "smoke", "manifest"]);
    assert.ok(!("caps" in summary));
  });
});

describe("a product with platform services", () => {
  test("verify gets a caps step after smoke, skipped when the app never started", () => {
    assert.deepEqual(verifyStepNames(true), ["typecheck", "build", "start", "console", "smoke", "caps", "manifest"]);
    const dir = temp();
    mkdirSync(path.join(dir, "scripts"));
    for (const f of ["verify.mjs", "smoke-report.mjs"]) copyFileSync(path.join(TEMPLATE, "scripts", f), path.join(dir, "scripts", f));
    writeFileSync(path.join(dir, "musemuse.caps.json"), JSON.stringify({ caps: ["data"], overlays: ["core", "data"] }));
    const res = spawnSync(process.execPath, [path.join(dir, "scripts/verify.mjs")], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    const summary = JSON.parse(res.stdout.trim().split("\n").at(-1));
    assert.deepEqual(summary.steps.map((s) => s.name), ["typecheck", "build", "start", "console", "smoke", "caps", "manifest"]);
    assert.equal(summary.steps.find((s) => s.name === "caps").detail, "skipped because an earlier step failed");
  });

  test("the smoke project gets the caps' browser args, each once, and nothing else changes", async () => {
    const files = {
      "musemuse.caps.json": JSON.stringify({ caps: ["live", "hardware"], overlays: ["core", "live", "hardware"] }),
      "scripts/caps/live.browser.json": JSON.stringify({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }),
      "scripts/caps/hardware.browser.json": JSON.stringify({ args: ["--use-fake-ui-for-media-stream", "not-a-flag"] }),
    };
    const config = await loadConfig(files);
    const smoke = config.projects.find((p) => p.name === "smoke");
    assert.deepEqual(smoke.use.launchOptions, { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    const plain = await loadConfig();
    // Unit 7: the demo runs replay the smoke test, so they need the same browser (a fake microphone). Only the args differ.
    const withoutArgs = (p) => ({ ...p, use: { ...p.use, launchOptions: { ...p.use.launchOptions, args: undefined } } });
    const others = (c) => c.projects.filter((p) => p.name !== "smoke").map(withoutArgs);
    assert.deepEqual(others(config), others(plain));
    const caps = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
    assert.deepEqual(config.projects.find((p) => p.name === "demo").use.launchOptions.args, caps);
    assert.deepEqual(config.projects.find((p) => p.name === "studio").use.launchOptions.args, ["--force-device-scale-factor=2", ...caps]);
    assert.deepEqual(plain.projects.find((p) => p.name === "studio").use.launchOptions.args, ["--force-device-scale-factor=2"]);
    assert.equal(plain.projects.find((p) => p.name === "demo").use.launchOptions.args, undefined);
  });

  test("MUSEMUSE_BASE_URL points the tests at a live link with no local server", async () => {
    const config = await loadConfig({}, { MUSEMUSE_BASE_URL: "https://musemuse-bird-count.vercel.app/" });
    assert.equal(config.use.baseURL, "https://musemuse-bird-count.vercel.app");
    assert.equal(config.webServer, undefined);
    const junk = await loadConfig({}, { MUSEMUSE_BASE_URL: "not a url" });
    assert.equal(junk.use.baseURL, "http://localhost:3100");
    assert.ok(junk.webServer);
  });
});

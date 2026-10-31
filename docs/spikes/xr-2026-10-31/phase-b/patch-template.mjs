// Prototype of the template changes U4 and U6 will make, applied to the snapshot's own platform files. Each edit names
// the exact text it replaces and fails loudly when it's gone, so a run can't silently test the unpatched file.
import { readFileSync, writeFileSync } from "node:fs";

function edit(file, pairs) {
  let text = readFileSync(file, "utf8");
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${file}: not found: ${from}`);
    text = text.replace(from, to);
  }
  writeFileSync(file, text);
  console.log(`patched ${file}, ${pairs.length} edit(s)`);
}

// Browser flags live in one JSON file so the TypeScript config and plain Node scripts can both read them.
edit("playwright.config.ts", [
  [
    `import { defineConfig } from "@playwright/test";`,
    `import { readFileSync } from "node:fs";\nimport { defineConfig } from "@playwright/test";\n\nconst browser = JSON.parse(readFileSync("scripts/browser.json", "utf8")) as { channel?: string; args: string[] };`,
  ],
  [`use: { viewport: { width: 390, height: 844 } },`, `use: { viewport: { width: 1280, height: 720 }, channel: browser.channel, launchOptions: { args: browser.args } },`],
  [`deviceScaleFactor: 2,`, `deviceScaleFactor: 1,\n        channel: browser.channel,`],
  [`launchOptions: { args: ["--force-device-scale-factor=2"] },`, `launchOptions: { args: browser.args },`],
]);

edit("scripts/verify.mjs", [
  [`const browser = await chromium.launch();`, `const browser = await chromium.launch(JSON.parse(readFileSync(path.join(ROOT, "scripts", "browser.json"), "utf8")));`],
]);

edit("tests/judge-shot.ts", [
  [`import { expect, test, type Page } from "@playwright/test";`, `import { expect, test, type Page } from "@playwright/test";\nimport { xrJudgeShot } from "./xr";`],
  [
    `  if (DEMO_PROJECTS.has(test.info().project.name)) {`,
    `  const inVR = await page.evaluate(() => (window as unknown as { __musemuseXR?: { inSession(): boolean } }).__musemuseXR?.inSession() === true);\n` +
      `  if (inVR && !DEMO_PROJECTS.has(test.info().project.name)) return xrJudgeShot(page, name);\n` +
      `  if (DEMO_PROJECTS.has(test.info().project.name)) {`,
  ],
]);

edit("tests/demo-fixtures.ts", [
  [`type ActionKind = "goto" | "click" | "type" | "upload" | "select" | "check" | "press" | "hover";`, `type ActionKind = "goto" | "click" | "type" | "upload" | "select" | "check" | "press" | "hover" | "xr";`],
  [
    `  /** Ends the recording: restores Playwright, holds the final state, stops the screencast and writes the timeline. */`,
    `  /** One motion in VR. ready = t1, so Demo Studio keeps all of it at real speed, and "xr" isn't a kind the camera cuts to. */
  async xrAction<T>(label: string, run: () => Promise<T>): Promise<T> {
    // The 3D preview on the landing page looks like a result to the recorder. It would get the zoom and the poster.
    if (!this.actions.some((a) => a.kind === "xr")) this.results.length = 0;
    if (!this.stepStart) this.beginStep(Date.now());
    this.active();
    await this.start();
    await this.cursor("rest");
    const entry: ActionEntry = { kind: "xr", t0: Date.now(), ready: 0, t1: 0, label, waited: 0 };
    try {
      return await run();
    } finally {
      entry.ready = entry.t1 = Date.now();
      this.actions.push(entry);
      this.quiet();
    }
  }

  /** A result that fills the whole view: held a moment. The planner doesn't zoom past 60%. */
  async holdXr(): Promise<void> {
    await this.start();
    const now = Date.now();
    const rect = { x: 0, y: 0, w: this.viewport.width, h: this.viewport.height };
    this.results.push({ t: now, at: now, rect, scrollY: 0, waited: 0, busy: true, media: 1, heads: [], blanks: [], pressed: null });
    this.active();
    this.extendTimeout(RESULT_HOLD_MS);
    await sleep(RESULT_HOLD_MS);
    this.quiet();
  }

  /** Ends the recording: restores Playwright, holds the final state, stops the screencast and writes the timeline. */`,
  ],
  [
    `/** The recording runs only in the studio project, and only for the first test a worker runs. */`,
    `/** Records one motion in VR on the demo's timeline. Outside the studio project it only runs it. */
export function recordXrAction<T>(page: Page, label: string, run: () => Promise<T>): Promise<T> {
  return current?.page === page ? current.xrAction(label, run) : run();
}

/** Holds a result that fills the view. Outside the studio project it does nothing. */
export async function holdXrResult(page: Page): Promise<void> {
  if (current?.page === page) await current.holdXr();
}

/** The recording runs only in the studio project, and only for the first test a worker runs. */`,
  ],
]);

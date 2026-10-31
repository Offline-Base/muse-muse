import { defineConfig } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Three runs of the same test:
//   smoke:  phone-sized check that the primary flow works (npm run verify runs every spec in tests/ except the studio
//           copy below)
//   demo:   tests/smoke.spec.ts at 1280x720 with Playwright's own video and a little slow motion (npm run demo). The old
//           demo video, and the fallback when the studio run records nothing. Platform code from before Demo Studio
//           runs this project by name, so it keeps the name.
//   studio: tests/smoke.demo.spec.ts, the platform's copy of tests/smoke.spec.ts with its imports pointed at
//           tests/demo-fixtures.ts, at 1280x720 with 2x pixels. demo-fixtures records it for Demo Studio: screencast
//           frames, a cursor, typing and a timeline in test-results/demo
// verify picks a free port, starts the server itself and passes the port as MUSEMUSE_PORT. Playwright's own output goes
// to test-results/playwright, so the judge screenshots in test-results/judge and the demo recording in
// test-results/demo survive its cleanup. A VR product (musemuse.target.json) runs all three with the browser settings in
// scripts/browser.json: the simulated headset needs software WebGL, and its smoke and studio runs are at the headset's
// window size with 1x pixels, since a screen twice as big halves its frame rate.
const port = Number(process.env.MUSEMUSE_PORT) || 3100;
// Platform services (musemuse.caps.json): Chromium args the active caps ask for, merged into the smoke project. And
// MUSEMUSE_BASE_URL, set only by the platform, points the tests at a live link with no local server. Neither applies to a
// product without platform services.
const root = path.dirname(fileURLToPath(import.meta.url));
function capsLaunchArgs(): string[] {
  const read = (file: string): unknown => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  if (!existsSync(path.join(root, "musemuse.caps.json"))) return [];
  const args: string[] = [];
  try {
    for (const id of (read("musemuse.caps.json") as { caps?: unknown[] }).caps ?? []) {
      const file = `scripts/caps/${String(id)}.browser.json`;
      if (!/^[a-z][a-z0-9-]*$/.test(String(id)) || !existsSync(path.join(root, file))) continue;
      for (const a of (read(file) as { args?: unknown[] }).args ?? []) if (typeof a === "string" && a.startsWith("--") && !args.includes(a)) args.push(a);
    }
  } catch {
    // A caps file that isn't JSON adds nothing here; verify's caps step reports it.
  }
  return args;
}
const capsArgs = capsLaunchArgs();
const liveBase = (process.env.MUSEMUSE_BASE_URL ?? "").trim().replace(/\/+$/, "");
const target = /^https?:\/\/[^\s/]+/.test(liveBase) ? { baseURL: liveBase, localServer: false } : { baseURL: `http://localhost:${port}`, localServer: true };

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const targets = readJson("musemuse.target.json")?.targets;
const vr = Array.isArray(targets) && targets.includes("vr") ? (readJson("scripts/browser.json")?.vr as { args: string[]; viewport: { width: number; height: number } }) : null;

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results/playwright",
  // A test.only left in a spec would silently drop every other test.
  forbidOnly: true,
  timeout: 180_000,
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  use: {
    baseURL: target.baseURL,
  },
  projects: [
    {
      name: "smoke",
      testIgnore: /\.demo\.spec\.ts$/,
      // A VR product's smoke run keeps the headset's args first; the active caps' args follow, each once.
      use: vr
        ? { viewport: vr.viewport, launchOptions: { args: [...vr.args, ...capsArgs.filter((a) => !vr.args.includes(a))] } }
        : { viewport: { width: 390, height: 844 }, ...(capsArgs.length ? { launchOptions: { args: capsArgs } } : {}) },
    },
    {
      name: "demo",
      testMatch: /(^|[\\/])smoke\.spec\.ts$/,
      use: {
        viewport: { width: 1280, height: 720 },
        video: { mode: "on", size: { width: 1280, height: 720 } },
        launchOptions: vr ? { slowMo: 250, args: vr.args } : { slowMo: 250 },
      },
    },
    {
      name: "studio",
      testMatch: /\.demo\.spec\.ts$/,
      // The recorder gives a test back the time its choreography adds, so this only covers a test with no timeout of
      // its own.
      timeout: 240_000,
      use: {
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: vr ? 1 : 2,
        video: "off",
        // Without it Chromium's screencast sends 1280x720 frames even at deviceScaleFactor 2.
        launchOptions: { args: vr ? vr.args : ["--force-device-scale-factor=2"] },
      },
    },
  ],
  webServer: target.localServer ? {
    command: `npx next start -p ${port}`,
    url: `http://localhost:${port}`,
    // Reuse only verify's own server. npm run demo and test:smoke start a fresh one, so a stale server left on 3100
    // makes them fail instead of testing or recording an old build.
    reuseExistingServer: Boolean(process.env.MUSEMUSE_PORT),
    timeout: 60_000,
  } : undefined,
});

import { defineConfig } from "@playwright/test";

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
// test-results/demo survive its cleanup.
const port = Number(process.env.MUSEMUSE_PORT) || 3100;

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results/playwright",
  // A test.only left in a spec would silently drop every other test.
  forbidOnly: true,
  timeout: 180_000,
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  use: {
    baseURL: `http://localhost:${port}`,
  },
  projects: [
    {
      name: "smoke",
      testIgnore: /\.demo\.spec\.ts$/,
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: "demo",
      testMatch: /(^|[\\/])smoke\.spec\.ts$/,
      use: {
        viewport: { width: 1280, height: 720 },
        video: { mode: "on", size: { width: 1280, height: 720 } },
        launchOptions: { slowMo: 250 },
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
        deviceScaleFactor: 2,
        video: "off",
        // Without it Chromium's screencast sends 1280x720 frames even at deviceScaleFactor 2.
        launchOptions: { args: ["--force-device-scale-factor=2"] },
      },
    },
  ],
  webServer: {
    command: `npx next start -p ${port}`,
    url: `http://localhost:${port}`,
    // Reuse only verify's own server. npm run demo and test:smoke start a fresh one, so a stale server left on 3100
    // makes them fail instead of testing or recording an old build.
    reuseExistingServer: Boolean(process.env.MUSEMUSE_PORT),
    timeout: 60_000,
  },
});

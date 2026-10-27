import { defineConfig } from "@playwright/test";

// Two runs of the same test:
//   smoke: phone-sized check that the primary flow works (npm run verify runs every spec in tests/)
//   demo:  tests/smoke.spec.ts at 1280x720 with video recording and a little slow motion (npm run demo)
// verify picks a free port, starts the server itself and passes the port as MUSEMUSE_PORT. Playwright's own output goes
// to test-results/playwright, so the judge screenshots in test-results/judge survive its cleanup.
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
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: "demo",
      use: {
        viewport: { width: 1280, height: 720 },
        video: { mode: "on", size: { width: 1280, height: 720 } },
        launchOptions: { slowMo: 250 },
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

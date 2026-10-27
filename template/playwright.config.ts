import { defineConfig } from "@playwright/test";

// Two runs of the same test:
//   smoke: phone-sized check that the primary flow works (npm run verify runs every spec in tests/)
//   demo:  tests/smoke.spec.ts at 1280x720 with video recording and a little slow motion (npm run demo)
// verify picks a free port and passes it as MUSEMUSE_PORT. Playwright's own output goes to test-results/playwright,
// so the judge screenshots in test-results/judge survive its cleanup.
const port = Number(process.env.MUSEMUSE_PORT) || 3100;

export default defineConfig({
  testDir: "tests",
  outputDir: "test-results/playwright",
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
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

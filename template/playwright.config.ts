import { defineConfig } from "@playwright/test";

// Two runs of the same test:
//   smoke: phone-sized check that the primary flow works (npm run verify)
//   demo:  the same flow at 1280x720 with video recording and a little slow motion (npm run demo)
export default defineConfig({
  testDir: "tests",
  timeout: 180_000,
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  use: {
    baseURL: "http://localhost:3100",
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
    command: "npm run start",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

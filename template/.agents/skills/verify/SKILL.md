---
name: verify
description: Use before finishing any build. Explains what npm run verify checks, how to write the smoke test, and which screenshots the judge needs.
---

# Verify

## What `npm run verify` runs

1. `tsc --noEmit`
2. `next build`
3. Starts the built app on port 3100 and checks that `/` returns 200 with no console errors
4. `playwright test tests/smoke.spec.ts --project=smoke`, at phone size
5. Validates `musemuse.json` against `musemuse.schema.json`

It exits 0 only when every step passes. The platform runs the same script, then a judge model looks at your screenshots.

## Smoke test

`tests/smoke.spec.ts` runs the brief's primary flow the way a user would, with the files in `fixtures/` and real model calls through the gateway.

```ts
import { test, expect } from "@playwright/test";

test("primary flow works with the sample photo", async ({ page }) => {
  await test.step("Open the shelf planner", async () => {
    await page.goto("/");
    await page.screenshot({ path: "test-results/judge/01-start.png", fullPage: true });
  });

  await test.step("Upload a photo of the wall", async () => {
    await page.getByLabel("Photo of your wall").setInputFiles("fixtures/wall.jpg");
  });

  await test.step("Find the wall and plan the shelf", async () => {
    await page.getByRole("button", { name: "Find the wall" }).click();
    await expect(page.getByText(/estimate/i)).toBeVisible({ timeout: 90_000 });
    await page.screenshot({ path: "test-results/judge/02-result.png", fullPage: true });
  });
});
```

- Find elements by role and label, not CSS classes.
- Model calls can take a while, so allow up to 90 seconds per step.
- Assert on the result the brief promises, not on loading text.
- Keep the whole test under 3 minutes and 5 model calls.

## The test is also the demo video

After checks pass, the platform runs `npm run demo`. It replays the same test at 1280×720 with video recording and a little slow motion, then turns the recording into an MP4 with a title card and captions. Write the test so it plays well as a video:

- Wrap each user action in `test.step("...")` with a title a viewer would understand, like "Upload a photo of the wall" or "Find the wall". Step titles become the captions.
- Follow one clear path from start to result, using the fixtures, with no detours or retries inside the test.
- End on the result the brief promises and keep it on screen. `await page.waitForTimeout(1500)` at the very end is fine.

## Screenshots for the judge

Save 2 to 4 full-page screenshots in `test-results/judge/`, numbered in order: `01-start.png`, then each key step, ending with the final result. The judge fails the build if the last screenshot shows an error, a spinner or an empty state. It also compares your screens with the files in `inspo/`, and fails anything that copies a name, logo, character or artwork from them.

## Action routes

Add one Playwright request test per action in `musemuse.json`. It should POST the example input to `/api/actions/<name>` and check that the response matches the output schema.

## Never

- Mock or stub Meta calls in the smoke test.
- Skip, delete or loosen a test to make verify pass.
- Hide errors behind a success message.

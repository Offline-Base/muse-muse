---
name: verify
description: Use before finishing any build. Explains what npm run verify checks, how to write the smoke test, and which screenshots the judge needs.
---

# Verify

## What `npm run verify` runs

| Step | Checks |
|---|---|
| typecheck | `next typegen`, then `tsc --noEmit` |
| build | `next build` |
| start | `next start` on port 3100 (or the next free port), and `GET /` returns 200 |
| console | Chromium loads `/` at phone size with no `console.error` and no uncaught page errors |
| smoke | `playwright test --project=smoke`: every spec in `tests/`, at phone size, with real model calls. Fails on `test.only`, on any test that didn't run (skipped or fixme) or is marked `test.fail`, and when `tests/smoke.spec.ts` (or `tests/actions.spec.ts`, once there are actions) ran no tests |
| manifest | `musemuse.json` is valid against `musemuse.schema.json`, every action has `app/api/actions/<name>/route.ts`, every fixture file exists |

It exits 0 only when every step passes. When a step fails it prints that step's output (tsc errors, build errors, the Playwright failure plus the server log), so read it and fix the cause. The last line is a JSON summary for the platform. The platform runs the same script, then a judge model looks at your screenshots. Don't edit anything in `scripts/` or `playwright.config.ts`.

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
- Use relative URLs (`page.goto("/")`, `request.post("/api/actions/...")`). verify may run the server on a port other than 3100.
- Model calls can take a while, so allow up to 90 seconds per step.
- Assert on the result the brief promises, not on loading text.
- Keep the whole test under 3 minutes and 5 model calls.
- Tests can't read `.env.local`, `GATEWAY_URL` or `PRODUCT_TOKEN`. Only the app server can. The tests reach Meta through the app's pages and routes, so never guard a test on an env var.
- `npm run test:smoke` starts its own server on port 3100 and fails if something already listens there. Stop any server you started yourself (`pkill -f "next start"`) before running it.

## The test is also the demo video

After checks pass, the platform runs `npm run demo`. It replays the same test at 1280×720 with video recording and a little slow motion, then turns the recording into an MP4 with a title card and captions. Write the test so it plays well as a video:

- Wrap each user action in `test.step("...")` with a title a viewer would understand, like "Upload a photo of the wall" or "Find the wall". Step titles become the captions.
- Follow one clear path from start to result, using the fixtures, with no detours or retries inside the test.
- End on the result the brief promises and keep it on screen. `await page.waitForTimeout(1500)` at the very end is fine.

## Screenshots for the judge

Save 2 to 4 full-page screenshots in `test-results/judge/`, numbered in order: `01-start.png`, then each key step, ending with the final result. The judge fails the build if the last screenshot shows an error, a spinner or an empty state. It also compares your screens with the files in `inspo/`, and fails anything that copies a name, logo, character or artwork from them.

## Action routes

Put one request test per action in `tests/actions.spec.ts`. It should POST the example input to `/api/actions/<name>` and check that the response matches the output schema. verify runs it with the smoke test. The demo video records only `tests/smoke.spec.ts`.

```ts
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

test("count_birds returns a tally", async ({ request }) => {
  const image = `data:image/jpeg;base64,${readFileSync("fixtures/feeder.jpg").toString("base64")}`;
  const res = await request.post("/api/actions/count_birds", { data: { image } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Number.isInteger(body.count)).toBe(true);
});
```

## Never

- Mock or stub Meta calls in the smoke test.
- Skip, delete or loosen a test to make verify pass.
- Hide errors behind a success message.

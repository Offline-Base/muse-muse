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
| smoke | `playwright test --project=smoke`: every spec in `tests/`, at phone size, with real model calls. Fails on `test.only`, on any test that didn't run (skipped or fixme) or is marked `test.fail`, when `tests/smoke.spec.ts` (or `tests/actions.spec.ts`, once there are actions) ran no tests, and when the last judge screenshot shows an error, a field marked invalid or an empty state |
| manifest | `musemuse.json` is valid against `musemuse.schema.json`, every action has `app/api/actions/<name>/route.ts`, every fixture file exists |

It exits 0 only when every step passes. When a step fails it prints that step's output (tsc errors, build errors, the Playwright failure plus the server log), so read it and fix the cause. The last line is a JSON summary for the platform. The platform runs the same script, then a judge model looks at your screenshots. Don't edit anything in `scripts/` or `playwright.config.ts`.

## Smoke test

`tests/smoke.spec.ts` runs the brief's primary flow the way a user would, with the files in `fixtures/` and real model calls through the gateway.

```ts
import { test, expect } from "@playwright/test";
import { judgeShot } from "./judge-shot";

test("primary flow works with the sample photo", async ({ page }) => {
  await test.step("Open the shelf planner", async () => {
    await page.goto("/");
    await judgeShot(page, "01-start");
  });

  await test.step("Upload a photo of the wall", async () => {
    await page.getByLabel("Photo of your wall").setInputFiles("fixtures/wall.jpg");
  });

  await test.step("Find the wall and plan the shelf", async () => {
    await page.getByRole("button", { name: "Find the wall" }).click();
    await expect(page.getByRole("heading", { name: "Your shelf plan" })).toBeVisible({ timeout: 90_000 });
    await judgeShot(page, "02-result");
  });
});
```

- Find elements by role and label, not CSS classes.
- Use relative URLs (`page.goto("/")`, `request.post("/api/actions/...")`). verify may run the server on a port other than 3100.
- Model calls can take a while, so allow up to 90 seconds per step.
- Assert on the result the brief promises, not on loading text: wait for something only the finished result has, like its heading, a total or its model chip.
- Keep the whole test under 3 minutes and 5 model calls.
- Tests can't read `.env.local`, `GATEWAY_URL` or `PRODUCT_TOKEN`. Only the app server can. The tests reach Meta through the app's pages and routes, so never guard a test on an env var.
- `npm run test:smoke` starts its own server on port 3100 and fails if something already listens there. Stop any server you started yourself (`pkill -f "next start"`) before running it.

## The test is also the demo video

After checks pass, the platform replays `tests/smoke.spec.ts` as the product's demo video: a 1280x720 window with a visible cursor that moves to each control, text typed key by key, the camera zooming in on each result, model waits sped up, and each step's title as a caption. The recording brings every new result on screen and holds it a few seconds before the next action, and ends on the last one, so the test needs no waits for the video. Write the test so it plays well:

- Wrap each user action in `test.step("...")` with a title a viewer would understand, like "Upload a photo of the wall" or "Find the wall". Step titles become the captions, so give each step one thing a person does, and keep its title under 50 characters.
- Write titles about what the person does with the product, not about the test: "Upload a photo of the wall", not "Upload the sample photo" or "Check the fixture".
- Use normal locator actions: `click`, `fill`, `check`, `selectOption`, `setInputFiles`, `press`. The cursor and the typing follow them. No `page.mouse`, no `force: true` and no clicks through `evaluate`: the video can't show those.
- Import `test` and `expect` from `@playwright/test` in `tests/smoke.spec.ts` itself, not from a helper module of your own: the recording attaches through that import.
- Follow one clear path from start to result, using the fixtures, with no detours or retries inside the test.
- After each model call, wait for its result in the same step (`await expect(...).toBeVisible()`), so the result plays under that step's caption.
- End on the result the brief promises. Don't end with a `page.waitForTimeout`: the recording holds the result by itself.

## Screenshots for the judge

Take 2 to 4 screenshots with `judgeShot(page, "NN-name")` from `tests/judge-shot.ts`, numbered in order: `01-start`, then each key step, ending with the final result. verify fails any screenshot in `test-results/judge/` taken another way. Don't edit `tests/judge-shot.ts`.

judgeShot waits for `aria-busy="true"` to clear, then fails the test when the screen has text cut off at the side of its box, a page that scrolls sideways, text shortened with "...", a one-line field hiding part of its text or placeholder, a text box hiding part of its text, a disabled button still saying it is working ("…"), a loading bar, or an em dash. Fix the product, not the check. Text the user typed or uploaded doesn't count when it sits inside an element with `data-user-text`.

Plan the screenshots so together they prove the tagline:

1. `01-start`: the start screen before any input. Its placeholder is not the sample.
2. The step that makes this product special, finished: the jailbreak blocked, the plan changed after a logged run, the list shared with its button saying "Copied", the CSV previewed. If the tagline or the primary flow names a feature, one screenshot shows it working.
3. The final result, finished, with its heading within the first 900 px under the app bar: a form that only starts the run is its summary row by then (meta-ui).

Each screenshot must look clearly different from the one before. A step that changes only a focus ring or one counter isn't worth a screenshot. Never take one while a `.toast` is showing: the full-page screenshot draws it in the middle of the page. Wait for it to go, or show the confirmation on the button itself. The judge fails the build if the last screenshot shows an error, a spinner or an empty state anywhere on it, and verify fails first when it has a visible `role="alert"`, `.error`, `aria-invalid="true"` field or `.empty` with text in it. It also compares your screens with the files in `inspo/`, and fails anything that copies a name, logo, character or artwork from them.

Before you stop, open each PNG in `test-results/judge/` with read_file and check it against the tagline: every promised part is drawn and not empty (bars have height, the image shows, the outline is there). Then make the smoke test assert what a picture can hide: a chart's or an overlay's tallest mark is taller than 4 px (its `boundingBox()`; for `.bars`, the check in meta-ui's components.md), and dates and totals on screen match the input (the race's weekday, a column's sum). If one fails, fix the product and run verify again.

## Bad input

Add `tests/errors.spec.ts` with one test that trips the product's own check without a model call, like choosing a text file where a photo goes (`setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a photo") })`) or pasting text past the length limit, and expects a `role="alert"` message in plain words. Next.js adds an empty alert of its own, so always filter by text: `await expect(page.getByRole("alert").filter({ hasText: "That is not a photo" })).toBeVisible()`. AI buttons stay disabled until there is enough input (product-ui): check that with `await expect(button).toBeDisabled()`, and never enable one just so this test can press it. Take no judge screenshots in it. verify runs it; the demo video doesn't.

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

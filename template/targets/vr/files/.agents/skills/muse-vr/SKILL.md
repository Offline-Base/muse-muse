---
name: muse-vr
description: Use when this product runs in VR on Meta Quest (the brief's targets list vr). It opens from its link in Quest Browser with nothing to install, runs in a simulated headset on a computer, and shows a 3D preview on a phone. Covers the parts, the performance and comfort budget, how to test, and the smoke test verify requires.
---

# Muse VR

## What it is

A normal web product, with the same pages, action routes and gateway calls as any other, plus a 3D scene a person steps into. It is built with React Three Fiber, `@react-three/xr` and `@react-three/uikit`, all installed. For anything these notes don't cover, read `node_modules/@react-three/xr/skills/react-three-xr/SKILL.md`. Patterns you can start from are in `reference/patterns.md`, next to this file.

| Where | What it shows |
|---|---|
| Meta Quest, in Quest Browser | Real VR. The 2D page opens first, then Enter VR. Controllers and hands both work |
| A computer | A simulated Meta Quest 3, with on-screen handles and play mode (WASD and mouse-look) |
| A phone | A 3D preview on the page. Drag to look around. There's no button to enter |

## The flow

- Text, photos and files are collected on the 2D page before VR. A headset is a poor keyboard.
- Inside VR it's buttons, pointing, grabbing and teleporting, and at most one short spoken request.
- Leaving VR comes back to the 2D page: show a summary card there, marked `data-result`. `useInVR()` from `@/lib/xr/emulator` says when.
- Model calls happen through the app's action routes, as in any product. Muse Image makes a backdrop or a texture and Muse Wonder plans a layout or writes a quiz, before or during the session. Show progress on a panel, and call `setXRStatus("Writing the quiz", true)` until it's done.

## The parts

| Part | Does |
|---|---|
| `components/xr/XRStage.tsx` | The canvas, the XR store, a floor and soft light. Waits until it knows which kind of headset this is. `teleport` turns on aiming at the floor and pressing to move there |
| `components/xr/EnterVRButton.tsx` | The way in, and the only one. Takes the store XRStage hands over, a `label` and `disabled` for while the page still needs something first. On a phone it shows nothing |
| `components/xr/HowToView.tsx` | One line of help for Quest, computer or phone. Put it under the button |
| `components/xr/Panel.tsx` | `Panel`, `PanelTitle`, `PanelText`, `PanelResult` and `PanelButton`: flat panels in the Meta look. `PanelResult` is for a model's answer, and is the only place the AI accent appears |
| `lib/xr/targets.ts` | `useXRTarget("Start game")` names an object |
| `lib/xr/status.ts` | `setXRStatus(text, busy?)` and `setXRAlert(text)`: lines only a screen reader and the tests read |

You may change the parts in `components/xr/` to fit the product. Keep the button's name starting with "Enter VR" and keep `pixelSize` on panels: at the default a panel's text wraps one word a line.

A canvas needs a browser, so load the scene with `dynamic(() => import("@/components/Room"), { ssr: false })` from a client component.

## Performance budget

Scenes must stay smooth on a Quest and in the sandbox's graphics-card-free recording. **At most 50 draw calls and 30k triangles.** `node scripts/xr-peek.mjs` prints both, and verify prints a note past either one. The controllers already use about 9k triangles and 15 draw calls, and the count is for one eye.

- Build scenes in code from simple shapes, panels and textures you generate. No large 3D model files, no remote assets. The build machine can't reach CDNs, and neither can `@react-three/drei` helpers that download things.
- Repeat a shape with one `instancedMesh`, which is a single draw call, rather than many meshes.
- No real-time shadows and no post-processing. Prefer `meshLambertMaterial` to `meshStandardMaterial`.
- Textures at most 2048 px.

## Comfort

- Never move the camera or the person on your own. They turn their head, teleport, or press a button that says it will move them.
- Keep content 1 to 3 m away, and panels 1.2 to 1.5 m away at about eye height (1.3 to 1.6 m). Nothing stands between the person and the panel, and nothing but what they hold comes closer than 1 m.
- Everything fits in front of the person when they arrive. Don't make them look behind them to start.
- Text at least 36 panel pixels, buttons at least 72. Panels are about 1 m wide, with a line or two of text.

## Test conventions

- Name every object a person can act on with `useXRTarget`. Tests aim at names, never at raw coordinates.
- Give every clickable mesh an `onClick`. It works the same for mouse, controller ray and fingertip.
- Mirror what the scene shows in `setXRStatus`, like "Score 3" or "Quiz finished". Tests can't read a canvas, so they assert on that line.
- When something fails, call `setXRAlert("...")`, say so on a panel, and clear it with `setXRAlert(null)` once it's fixed. Verify fails if the last VR shot has an alert.

## Looking while you build

With `next dev` running on port 3000:

```bash
node scripts/xr-peek.mjs --enter --look "Start game" --select "Start game" --out .muse-peek/start.png
```

It prints `{ mode, inSession, fps, blank, sceneObjects, stats, targets, status, consoleErrors }`. `sceneObjects` is how many of your scene's objects are in view, and 0 fails verify. Then open the PNG with `read_file` and look at it. Flags, in the order you give them: `--enter`, `--look [from:]to`, `--select <name>`, `--wait <status text>`, `--hand left|right`. Leave out `from` unless you are checking another spot, because it moves the head away from where the person arrives.

**Do this at least once before your first `npm run verify`, and again after changing the scene.** Verify can't tell whether a person can read the panel. This picture is what the judge and the demo video see: if you can't read the panel's text in it, or something blocks the view, fix that first. A fix round's failure from a VR judge screenshot starts here too.

## The smoke test

Verify runs at 1280x720 for this product. `tests/smoke.spec.ts` must enter VR and take at least one `judgeShot` inside it. Every shot in VR must have part of your scene in view, not just the floor, and the view must keep drawing.

```ts
import { expect, test } from "@playwright/test";
import { judgeShot } from "./judge-shot";
import { xr } from "./xr";

test("step in and start the game", async ({ page }) => {
  const status = page.locator("[data-xr-status]");
  await test.step("Open the room", async () => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /^Enter VR/ })).toBeEnabled({ timeout: 30_000 });
    await judgeShot(page, "01-start");
  });
  await test.step("Step into VR", async () => {
    await xr.enter(page);
    await judgeShot(page, "02-in-vr");
  });
  await test.step("Start the game", async () => {
    await xr.look(page, { to: "Start game" });
    await xr.select(page, "right", "Start game");
    await expect(status).toHaveText("Score 0", { timeout: 90_000 });
    await judgeShot(page, "03-result");
  });
});
```

Keep moves slow enough to follow: they become the demo video. End the session on the best moment, because the last VR view is the video's poster. After `xr.exit`, the card marked `data-result` comes on screen and gets its own hold. Screenshots: `01-start` on the page, one in VR, then the final result in VR, where the promised result is plainly in view. A view of just the floor fails verify with "Nothing is in front of the person".

| Call | Does |
|---|---|
| `xr.enter(page)` / `xr.exit(page)` | Press Enter VR and wait for it to draw, or end the session |
| `xr.look(page, { from?, to }, seconds?)` | Turn the head toward a name or a point, optionally stepping to `from` |
| `xr.aim(page, hand, target)` | Point a controller |
| `xr.select(page, hand, target)` | Point a controller and pull the trigger |
| `xr.press` / `xr.release(page, hand, button)` | Hold or let go of `"trigger"`, `"squeeze"`, `"thumbstick"`, `"a-button"`, `"b-button"` |
| `xr.grab(page, hand, from, to, seconds?)` | Reach, squeeze, carry, let go |
| `xr.stick(page, hand, x, y, seconds?)` | Push the thumbstick, then let it spring back |
| `xr.touch(page, hand, name)` | Switch to hands and press with a fingertip |
| `xr.pinch(page, hand, target)` | Switch to hands, point and pinch |
| `xr.controllers(page)` | Back to controllers after hands |
| `xr.targets(page)` | The named objects and where they are |
| `xr.remote(page, method, params)` | Any other call to the simulated headset's script |

The named positions are measured when you ask, so aim again after anything moves. A controller's ray stops at the first thing it hits: a grabbed object held in front of that controller blocks it, so use the other hand.

## Copy

- Say "Enter VR", "your controllers", "your hands". Say it's best on Meta Quest.
- Never offer "simulated" as a feature, and never claim it's in the Horizon Store.
- Text the person reads in VR is short: a title and a line or two.

## Don't edit

`lib/xr/*`, `tests/xr.ts`, `scripts/xr-peek.mjs`, `scripts/browser.json` and `public/xr/profiles/`. They're restored before every check.

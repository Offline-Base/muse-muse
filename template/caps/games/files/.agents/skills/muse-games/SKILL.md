---
name: muse-games
description: What every Muse Muse game on a game engine (Phaser or Babylon.js) shares - the canvas, controls, software rendering, 3D assets, notices and the checks verify runs. Read it, then the engine's own skill, when brief.md has a "Game engine" section.
---

# Games on a game engine

brief.md's "Game engine" section names the engine, why, and the controls. Read the engine's skill next:
`.agents/skills/muse-phaser/SKILL.md` for 2D or `.agents/skills/muse-babylon/SKILL.md` for 3D. This one covers what both
share.

## The page around the game

- The game is one client component with a canvas, inside an ordinary page built from the template's parts: the title,
  a start button, the score, how to play, settings, and the footer. Only the canvas is drawn by the engine.
- Phones first: the canvas fits 390x844 without scrolling sideways, and grows on wider screens.
- Every game plays with a keyboard and with touch. Show the touch controls on screen (or say "hold the left or right
  side to steer") next to the game, and the keys in the how-to-play line.
- The canvas has `tabIndex={0}` and is focused when the game starts, so keys reach it.
- Start on a button press, never on page load with sound. Pause when the tab is hidden.
- Keep progress only in the browser (`localStorage`): a best score, the last level. Say so where it shows.

## Software rendering

Tests, screenshots and the demo run in a browser with no graphics card (SwiftShader). It runs WebGL, slowly:

- Keep scenes small: a few thousand triangles, one or two lights, no shadows or post effects, textures at most 1024 px.
- Draw the first frame right away. A loading screen that waits on network files fails the canvas check.
- Plain lighting and jagged edges are expected in the screenshots. The judge is told so.

## Art and 3D assets

- Draw shapes in code, or make pictures with Muse Image when the brief lists it (sprites, backgrounds, textures).
- Never load an engine, a decoder, a model or a script from another site: no CDNs. The build machine can't reach them,
  and verify's `no-cdn` check fails on one.
- 3D models come from the platform's free asset set, in the "CC0 asset manifest, v1" shape (`3d/manifest.json`: CC0
  models, HDRIs and textures, each file with its size and sha256). `lib/platform/assets3d.ts` reads it:
  `parseAssetManifest(json)` keeps only CC0 assets within the limits, `fetchVerified(url, file)` checks a file's size and
  sha256 before anything uses it, and `checkGlb(bytes)` refuses a GLB that isn't self-contained or needs a decoder from
  another site (Draco, meshopt, KTX2). The engine skills show how each engine uses them.
- The asset set isn't reachable from the build machine yet. Until brief.md says where it is, build every scene from
  shapes and generated pictures, and don't fetch the asset list.
- Show the `attribution` line of every asset you use in the game's credits.

## Notices

The engine's license notice ships with the product in `public/notices/` (a platform file). Link it from the game's page
as "Open source notices": `/notices/phaser.txt` or `/notices/babylonjs.txt`. Verify's `notices` check looks for the link.

## The smoke test

After starting the game in `tests/smoke.spec.ts`, call `expectGameResponds(page, { key, shots })` from
`tests/caps/games.ts`:

```ts
import { expectGameResponds } from "./caps/games";

await test.step("Play: move with the arrow keys", async () => {
  await page.getByRole("button", { name: "Start" }).click();
  await expectGameResponds(page, { key: "ArrowRight", shots: ["03-game", "04-game-moved"] });
});
```

It checks the canvas drew something (not one flat color) and changed after one key press, records both, and takes the
two judge screenshots. Pick a key that visibly changes the scene within half a second.

## What verify checks

| Check | Passes when |
|---|---|
| `engine` | The engine is installed at the platform's exact version, and the game imports it |
| `no-cdn` | Nothing loads from another site |
| `notices` | `public/notices/<engine>.txt` is there and the page links to it |
| `canvas` | The smoke test saw the canvas draw |
| `key-press` | The smoke test saw it change after a key press |

## Platform files

`lib/platform/assets3d.ts`, `tests/caps/games.ts`, `scripts/caps/games.mjs`, `public/notices/*`, the engine's helper in
`lib/platform/` and these skills. Verify puts them back before every run, so an edit to one is lost.

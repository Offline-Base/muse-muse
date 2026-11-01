---
name: muse-phaser
description: How a Muse Muse product builds a 2D game with Phaser 4 inside its Next.js app. Read it with muse-games when brief.md's "Game engine" section says Phaser.
---

# Phaser 4

`phaser` 4.2.1 is installed at an exact version. Don't add another game, physics or rendering library. Phaser 4 keeps
Phaser 3's scene, game object and input APIs; its renderer is WebGL first (Canvas is deprecated), which runs on the
test browser's software WebGL.

## Mounting it in Next.js

`components/game/PhaserGame.tsx` is a working starting point. Keep its shape:

- A client component (`"use client"`). Phaser touches `window` when it loads, so import it inside `useEffect` with
  `import("phaser")`, never at the top of a file, and call `game.destroy(true)` in the effect's cleanup.
- `new Phaser.Game({ type: Phaser.AUTO, parent: element, width, height, scale: { mode: Phaser.Scale.FIT }, scene, banner: false })`.
  Pick a size for a phone first (390 px wide) and let `Scale.FIT` grow it.
- Types: `import type Phaser from "phaser"` at the top is fine. It's only types.
- Scenes are classes defined inside the effect, after the import, extending `Phaser.Scene` with `create()` and
  `update(time, delta)`. Move things by `delta` (milliseconds), so speed doesn't depend on the frame rate.

## Input

- Keys: `this.input.keyboard!.createCursorKeys()` for arrows, `this.input.keyboard!.addKey("SPACE")` for others. Phaser
  listens on the window, so keys work without focusing the canvas.
- Touch: `this.input.on("pointerdown", ...)` and `"pointerup"`. Big targets: half the screen, or on-screen buttons in
  the page around the game.

## Physics and levels

- Arcade physics for platformers and top-down games: `physics: { default: "arcade", arcade: { gravity: { x: 0, y: 600 } } }`
  in the game config, then `this.physics.add.sprite`, `this.physics.add.collider`.
- Tile levels: build them in code from a small array, or `this.make.tilemap({ data, tileWidth, tileHeight })`. A level
  a model makes must be checked by code (reachable exit, no blocked start) before it's played.

## Pictures

- Shapes: `this.add.rectangle`, `this.add.circle`, `this.add.graphics()`.
- A picture made with Muse Image: pass its data URL to `this.textures.addBase64(key, dataUrl)` and wait for the
  texture's `addtexture` event before using it.
- A 3D asset from the platform's free set shows as its 512 px preview picture: `addAssetPreview(scene, key, asset, base)`
  from `lib/platform/phaser-assets.ts` checks its size and sha256 first. Phaser doesn't draw 3D models.

## Text and the score

Keep words out of the canvas where you can: show the score, lives and messages in the page around it, from a callback
the scene calls (the starter's `onScore`). Words in the canvas can't be read by screen readers or the judge's checks.

---
name: recipe-games
description: Use for a 3D browser game built with three.js, such as a racer or a lane-crossing arcade game, built in one structured pass or with play-testing rounds.
---

# 3D games with three.js

Install `three` from npm with the normal install step. The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them, and don't download models or textures.

**Simple shapes only.** Build everything from boxes, spheres, cylinders and canvas textures. Say it in the limits, in plain words: "Uses simple shapes. It doesn't download 3D models."

## Write the rules before the code (both recipes)

First pass failures are mostly rules nobody wrote down. Put these at the top of `lib/game/rules.ts` as constants and comments, before any scene code:

- **Coordinates:** which axis is forward, up and right, and the size of one world unit.
- **Movement:** grid steps or free motion, and speeds in units per second, using delta time, never per frame.
- **Collision:** by grid row or world position, and which shapes count. Keep it in pure functions that a unit test can reach.
- **Spawning:** what spawns, where, how often, and when it's removed, so memory stays flat.
- **Camera:** fixed offset, and what the player must always be able to see.
- **Ending:** what ends a run, how the score counts, and how restart resets every list. **Every level ends on its own**, whatever the player does or doesn't do: reaching the end of the track or its distance, a timer running out, or falling off the world. A score or quota decides cleared or failed at that end; it is never the only way out. The Nov 3 audit's canal game ended only on its lantern quota or on lives, so a player who missed lanterns drifted forever past the end of the canal with no end screen.

Keep game state out of React. Use one `requestAnimationFrame` loop, stop it on unmount, and cap delta time so that a hidden tab doesn't teleport the player.

Every ending shows an end screen over the game with the result (cleared or not, the score, why it ended) and a Retry button that resets every list and puts the focus on it. Expose `window.__game` as a read-only state object with at least `status` (`"ready"`, `"playing"`, `"cleared"` or `"failed"`), `score`, the player's position and `levelEndsWithin`, the most seconds the level can last with no input (its length over its slowest speed, or its timer).

Show a WebGL error only when creating the renderer fails, never as a line that is always on screen.

## 03/06 Iterative game

Build in rounds: moving player first, then the world, then rules, then polish. Each round ends with a smoke test passing. Don't add features to a round that's failing.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/06_iterative_game_dev

## 03/09 One-shot game

Write the rules above in full, then the whole game in one pass, then fix only what the test shows.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/09_one-shot-game_dev

## Testing by playing

In the Playwright smoke test:

1. Start the game, and take a screenshot. Assert that the canvas isn't blank, by sampling pixels.
2. Hold a key: `keyboard.down("ArrowUp")`, wait, `keyboard.up("ArrowUp")`. Assert that the player moved, through a small `window.__game` read-only state object.
3. Force a collision or wait for one, and assert that the ending screen appears. Press restart, and assert that the state is reset.
4. **Idle until the level ends.** Start a level and press nothing. Wait for `window.__game.status` to leave `"playing"` within `levelEndsWithin` plus a few seconds (`expect.poll` with that `timeout`, and `test.setTimeout` above it), then assert that the end screen and its Retry button are visible. A level that never ends fails here. Keep the first level under about a minute at its slowest speed, so this stays short. Put this step in its own spec, `tests/level-end.spec.ts`, so the demo recorded from the smoke test doesn't sit through a minute of idling.
5. **On a phone.** At 390 x 844 with `hasTouch`, start a level without scrolling, and assert that every touch control is inside the viewport (`toBeInViewport({ ratio: 1 })`) and over the canvas. Hold one with `control.hover()`, `page.mouse.down()`, a wait and `page.mouse.up()`, which send real pointer events, and assert the player moved.
6. Fail on any console error.

Unit test the collision and spawn functions directly. WebGL in the test browser may need `--use-gl=swiftshader`.

## Touch and models

On touch devices (`(pointer: coarse)`), show on-screen controls with the same state as the keys, **laid over the canvas** in its lower corners, never below it. The canvas and its controls fit the first screen of a 390 x 844 phone together, so nobody scrolls to steer: size the canvas to about `min(100%, 70svh)` tall on phones. Each control is at least 56 px, uses pointer events with `setPointerCapture` (hold to steer, release or `pointercancel` to stop), and the canvas sets `touch-action: none`. Hide them on desktop.

These games call no model unless the brief wants one. If one writes level text or commentary, use `respondJson` on `muse-wonder-1.0`, and the game must still play when that call fails. Say so plainly when it does, and never show stand-in text as if the model wrote it.

## Limit

Simple shapes, one player, no online play, and speed that depends on the visitor's device.

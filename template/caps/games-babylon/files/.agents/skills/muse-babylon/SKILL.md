---
name: muse-babylon
description: How a Muse Muse product builds a 3D game or scene with Babylon.js 9 inside its Next.js app, and loads GLB models safely. Read it with muse-games when brief.md's "Game engine" section says Babylon.
---

# Babylon.js 9

`@babylonjs/core` and `@babylonjs/loaders` 9.29.0 are installed at exact versions. Don't add three.js, another engine
or a physics package. (A VR product uses the VR target and its own skill, never Babylon.)

## Mounting it in Next.js

`components/game/BabylonScene.tsx` is a working starting point. Keep its shape:

- A client component with its own `<canvas tabIndex={0}>`, sized by CSS (it has no size of its own), with
  `touchAction: "none"`.
- Import Babylon inside `useEffect`, one module at a time by its path, so the page loads only what the scene uses:
  `import("@babylonjs/core/Engines/engine")`, `@babylonjs/core/scene`, `@babylonjs/core/Meshes/meshBuilder`,
  `@babylonjs/core/Materials/standardMaterial`, `@babylonjs/core/Maths/math.vector`, `@babylonjs/core/Maths/math.color`,
  `@babylonjs/core/Lights/hemisphericLight`, `@babylonjs/core/Cameras/arcRotateCamera` or `freeCamera`,
  `@babylonjs/core/Events/keyboardEvents`. Never `import ... from "@babylonjs/core"` itself: that loads all of it.
- `new Engine(canvas, true, { stencil: false }, true)`, a `Scene`, then `engine.runRenderLoop(() => scene.render())`, and
  `engine.dispose()` in the effect's cleanup. Call `engine.resize()` on window resize.
- Move things in `scene.onBeforeRenderObservable` by `engine.getDeltaTime()`, so speed doesn't depend on the frame rate.

## Input

- Keys: `scene.onKeyboardObservable` (with `KeyboardEventTypes.KEYDOWN` and `KEYUP`). It listens on the canvas, so the
  canvas must have focus: focus it when the game starts.
- Touch: pointer events on the canvas, as in the starter, or buttons in the page around it.
- A camera the person can turn: `camera.attachControl(canvas, true)`. Then a drag turns the camera, so steer with keys
  and on-screen buttons instead of taps on the canvas.

## Looks, within software rendering

- `MeshBuilder.CreateBox`, `CreateSphere`, `CreateGround`, `CreateCylinder` and the like, with `StandardMaterial` colors.
- One `HemisphericLight`, maybe one `DirectionalLight`. No shadows, glow or post effects, and no PBR materials unless a
  model needs them (metals need an environment texture, which isn't available yet: they render dark).
- A picture made with Muse Image can be a texture: `new Texture(dataUrl, scene)` from `@babylonjs/core/Materials/Textures/texture`.

## GLB models

Use `lib/platform/babylon-glb.ts`, never Babylon's loaders directly with a URL:

- `loadAssetModel(scene, asset, base)`: a model from the platform's free set (an asset from `parseAssetManifest`, see
  muse-games). It checks the file's size and sha256, then that the GLB is self-contained, within 5 MB and 50k
  triangles, and needs no decoder from another site, before Babylon reads it.
- `loadOwnModel(scene, "/models/name.glb")`: a GLB the product ships in `public/models/`, checked the same way.
- Both return Babylon's `AssetContainer`: call `container.addAllToScene()`, then place, scale (models are in metres, Y
  up) and animate its meshes. They throw `AssetError` with a message to show as it is.
- Draco, meshopt and KTX2 compressed models are refused: Babylon would fetch their decoders from its own site.
- Show each asset's `attribution` in the game's credits.

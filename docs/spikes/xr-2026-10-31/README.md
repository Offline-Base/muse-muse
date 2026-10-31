# S1 spike: VR inside a Vercel Sandbox (Oct 31)

**Verdict: pass, with one condition. The sandbox can render, script, check and film WebXR with no GPU, so `VR_ENABLED` can go ahead on React Three Fiber.** The condition: the design's scene budget of 100 draw calls and 100k triangles misses 15 fps on the slower hosts. Lower the budget in the `muse-vr` skill, or give VR builds 8 vCPUs (see Decisions).

No model calls were made. The network was deny-all except npm. Every sandbox was stopped and deleted, and the last check found none left.

## Pass criteria

Final run, `results/phase-B.txt` and `results/phase-D.txt`: the builder snapshot, 4 vCPUs, the chosen flags, 1280x720 at device scale 1, under `next start`.

| Criterion | Target | Result | |
|---|---|---|---|
| Renderer | SwiftShader | ANGLE, Vulkan, SwiftShader (Subzero), WebGL 2 | Pass |
| Console errors on load | 0 | 0 (see the favicon note for `channel: "chromium"`) | Pass |
| Session starts | 5 s or less | 0.2 to 0.8 s without MSAA | Pass |
| Frame rate, ordinary scene (23 draws, 9k triangles) | 15 fps or more | 17.7 to 31 on entering, 26.9 to 39.8 later, over 4 runs | Pass |
| Frame rate, full budget (113 draws, 97k triangles) | 15 fps or more | 9.9 to 16.2 on entering, 13 to 20.5 later | **Host dependent** |
| Blank check | not blank | Every VR shot passes. An empty scene with controllers is caught (one color at 98.4%) | Pass |
| Two poses differ | 10% of pixels or more | 14.2% ordinary, 31% budget | Pass |
| `animate_to` lands | within 1 cm | 0 cm | Pass |
| `select` on a named object | changes state | Yes, on a mesh and on a uikit panel button | Pass |
| Screencast | 10 fps or more, not blank | 22.7 ordinary, 12.6 budget on the slow host. 8 of 8 sampled frames not blank | Pass |
| Requests leaving localhost | 0 | 0 in every probe, with controller models, hand models and uikit fonts all local | Pass |
| `verify` | 8 minutes or less | 23 to 32 s with no model calls | Pass |
| Demo Studio render (phase D) | valid video | 1920x1080 H.264, 26.5 s, 8 of 8 sampled frames not blank, 33 s to render, poster inside VR | Pass |

`verify` here has no model waits or action tests, so a real product will take longer, but it starts with about 7.5 minutes to spare. Motion in the recording runs at 17 to 29 fps depending on the host.

Phase C (IWSDK) was skipped on purpose. R3F passed first time, and IWSDK would add super-three overrides and tooling tied to Vite.

## Decisions

**3D library: R3F.** `three@0.184.0`, `@react-three/fiber@9.8.2`, `@react-three/xr@6.6.32`, `@react-three/uikit@1.0.78`, `iwer@2.7.0`, `@iwer/devui@2.7.0`, `@types/three@0.184.1`. They install in 12 s on top of the snapshot, and `next build` takes 14 s with Turbopack.

**Browser flags: `{ "args": ["--enable-unsafe-swiftshader"] }`, on Playwright's default headless shell.** No channel.
- All flag sets give the same renderer today, including none. This flag is the documented one, so it keeps working if Chrome drops the silent fallback.
- Don't use `--use-angle=swiftshader`. On the shell it cuts the screencast by more than half (7.8 fps against 16.4), which fails phase D's target. It also makes the frame rate look better than the recording will be.
- Don't use `channel: "chromium"` unless the template gets a favicon. It fetches `/favicon.ico`, and that 404 fails `verify`'s console step (seen in run 2). It runs at about the same speed, at most 15% faster.
- MSAA halves the frame rate (`shell-unsafe-budget-msaa`), so it stays off except on a real headset.

**Scene budget: pick one.** Rows are from `results/phase-T-*.txt` (frame rate on entering / after moving; screencast).

| Scene | Draws, triangles | 4 vCPUs, a faster host | 8 vCPUs |
|---|---|---|---|
| Ordinary | 23, 9k | 31 / 39.8; 33.6 | 38.8 / 46.4; 40.6 |
| Quarter | 45, 31k | 25.1 / 32.4; 29 | 32.4 / 38.5; 36.9 |
| Half | 68, 53k | 18.4 / 24.3; 21.8 | 24.4 / 30.4; 28.8 |
| Full budget | 113, 97k | 15.2 / 20.5; 19 | 21.3 / 24.9; 23.5 |

Hosts vary a lot: the same build at full budget got 9.9 / 13 on the slow host in the final run, about 0.65 of the fast one. The final run overlapped the 8 vCPU run for part of its time, but run 1 was just as slow with no other spike running. Applying that ratio (an estimate, not measured) gives half budget about 12 / 16 and quarter about 16 / 21 on a slow host.

- **Recommended:** change the skill's budget to 50 draw calls and 30k triangles. By that estimate it holds 15 fps even on a slow host, and it is plenty for scenes built from simple shapes.
- **Or:** keep the larger budget and give VR builds 8 vCPUs (about 2x the sandbox rate), which took full budget above 21 fps on the one host sampled. `verify` doesn't gate on frame rate, so this only affects the demo's smoothness.
- If a recording still falls short, the design's fallback of 960x540 helps: 13.4 / 19.8 and an 18.5 fps screencast at full budget on the slow host.
- Marking scenery `pointerEvents="none"` made no measurable difference. `meshLambertMaterial` helped by about 15% at half budget and not at full budget. The time goes on rasterizing.

## What the design needs to change

These all surfaced in the spike. The working code is in `phase-b/`.

1. **The canvas doesn't fill the view on its own (§0.3).** IWER moves the canvas into its full-screen container and sets the drawing size, but R3F has written the old box's size in px on the canvas's style. Without a fix the VR view shows squeezed into the old box, centered, with the page around it, and every screenshot and video shows that. `fillViewport()` in `lib/xr/emulator.ts` adds one CSS rule on IWER's container.
2. **Report one view (new).** With stereo off IWER still reports two views, the right one with a zero-width viewport, and three.js draws everything for it. `oneView()` wraps `XRFrame.getViewerPose`. Draw calls and triangles halve, and the budget scene gains about 20%, with no effect on `select` or the shots. Hiding the right camera through layers doesn't work: three.js resets the masks each frame and doesn't test them per view.
3. **`baseAssetPath` must be absolute (§2.2).** The loaders call `new URL(path, base)`, which throws on `/xr/profiles/`. Use `` `${location.origin}/xr/profiles/` ``.
4. **Controller assets:** `meta-quest-touch-plus`, `generic-hand`, `generic-trigger` and `profilesList.json`, 4.5 MB in all. The package's README and `LICENSE.md` say MIT, so the models can ship.
5. **Enable "Enter VR" only once `<XR>` is connected.** `store.enterVR()` rejects until the store has its renderer, so a quick click failed. `XRStage` hands the store to the button from an effect inside `<XR>`.
6. **Give the R3F camera a rotation.** Otherwise it aims at the origin, which from eye height means the 3D preview shows only the floor.
7. **uikit panels need `pixelSize={0.001}` (§2.2, Panel).** At the default 0.01 a panel of `sizeX={0.8}` is 80 px wide, and 40 px text wraps one word per line, far larger than the panel. Put this in the `Panel` part and the skill.
8. **DevUI (§2.3): `device.installDevUI(DevUI)`,** not `new DevUI(device)`. It adds 154 KB and shows a "Remote Control Active" chip while scripted. Tests never load it.
9. **Demo Studio (§2.7).** `recordXrAction` with `ready = t1` works as designed, with no change to `demo-plan.mjs`. Three changes:
   - The recorder takes the 3D preview on the landing page for a result, and zooms to it and picks it as the poster. `xrAction` clears earlier results on the first VR action, which fixes both.
   - The poster then lands at the end of the main part, so end the session on the best moment. `holdXrResult` still gives that moment its 2.8 s.
   - Silence the recorder's "frames are 1280x720" note for VR.

## Good to know

- **Two copies of three are installed, and one runs.** `@pmndrs/xr` depends on `@iwer/devui@1.1.2` and `@iwer/sem@0.2.5`, which bring `three@0.165.0`. Those end up in chunks for the built-in emulator, which `emulate: false` never requests. At runtime `window.__THREE__` is 184 and there's no multiple-copies warning. Of 8.3 MB of chunks a browser loads 2.5 MB (891 KB sent).
- **No frames during a still view is normal.** The screencast only sends changed frames, so a hold shows 0 fps and Demo Studio keeps the last frame. Judge frame rate on motion, not on the whole session.
- **The later frame rate is higher,** probably because by then the headset has turned away from part of the scene, so fewer pixels are lit. Both numbers are in the tables.
- **Bare three.js was about twice as fast** as this stack on a light scene in phase A (42 to 55 fps), which is the cost of R3F, pointers and controller models. It isn't enough to change the decision.
- Confirmed from §0: `installRuntime()` without `forceInstall` leaves `isSessionSupported` false (`*-force0` rows in phase A), and unpkg is blocked while npm answers.

## Not tested here

- A real product built by Muse Code, and `verify` with model calls. U12 covers those.
- A real Quest (S4). `navigator.xr` was never native in these runs, so the `native` path in `emulator.ts` hasn't run.
- `xr.grab`, `xr.stick`, `xr.touch` and `xr.pinch`. Hand mode was only switched on and checked for models and a picture.
- The `tests/xr.ts` prototype covers `enter`, `exit`, `look`, `aim`, `select` and the blank check.

## Layout

- `run-spike.ts`: creates the sandbox, runs phases, copies results, stops and deletes it, and keeps `cost-ledger.jsonl`. `run.sh` supplies the credentials without touching `.env.local`.
- `phase-a/`, `phase-a.sh`: bare three.js and IWER. `phase-a/probe.mjs` is the shared measurement, and its pass list is in `shortfalls()`.
- `phase-b/files/**.src`: the prototype overlay. The `.src` suffix keeps the main app's typecheck out of it, since its imports only exist in a product. The product's own typecheck covers them.
- `phase-b/patch-template.mjs`: the exact edits to `playwright.config.ts`, `verify.mjs`, `judge-shot.ts` and `demo-fixtures.ts`. U4 and U6 can start from these.
- `phase-b/matrix.mjs`, `phase-b/tune.mjs`, `phase-t.sh`: flag sets and scene sizes. `phase-d.sh`, `phase-d/check.mjs`: the render and its checks.
- `results/`: raw output. `phase-B.txt` and `phase-D.txt` are the final run on the committed files, `phase-B-one-view-run3.txt` is a faster host, and `phase-B-two-views-run1.txt` is before `oneView()`. `shots/` has the judge screenshots, the poster and `demo.mp4`.

## Cost

Six sandboxes, 2,456 s of sandbox time in all. At most **$0.51**, taking every vCPU as busy the whole time (`cost-ledger.jsonl`), against the $3 cap. The ledger leaves out network: each run downloads a few hundred MB from npm, which should be well under $0.50 in total.

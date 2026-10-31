# VR target

A VR product is a normal web product plus a 3D scene, built with React Three Fiber. It opens from its link in Quest Browser on a
Meta Quest, in a simulated Meta Quest 3 on a computer, and as a 3D preview on a phone. Why this stack, and the flags: `docs/spikes/xr-2026-10-31/README.md`.

## Target overlays

`template/targets/<target>/` holds `deps.json` (exact versions), `files/` (copied into the product) and `platform-files.json` (the
overlay files a build can't change). `TARGET_OVERLAYS` in `lib/sandbox/paths.ts` lists them: `vr` and `glasses`.

| When | What happens |
|---|---|
| Snapshot | `installTargets` copies them to `/vercel/musemuse/targets`, root-owned and read-only, and warms npm's cache. `readTemplateFiles` skips `targets/`, and `templateHash` still counts it. `make-builder-snapshot.ts` checks the copy |
| Provision | With a target other than web, `applyTargets` writes `active.json` (making the folder if this snapshot has none) and `applyTargetScript` copies the files, installs the deps, writes `musemuse.target.json` as `{"targets":[...]}` and commits `Target: ...`. A retry that finds this done changes nothing |
| Before every verify and demo | `restoreTargetFilesScript` rewrites the target file from `active.json` and restores each overlay's platform files, so an edit can't change which checks run |

With no target, or web alone, none of this runs and `active.json` doesn't exist.

**No new snapshot is needed on a local run.** A sandbox from an older snapshot gets the overlays and the newer platform files from
this checkout's `template/`. The live site has no `template/`, so it fails the build with a message saying to make a snapshot. Make
one before turning on `VR_ENABLED` or `GLASSES_ENABLED` anywhere but a local run. A brief with only phone, desktop or agent targets has no
overlay to install, so it works on any snapshot.

## What a VR product gets

- `lib/xr/emulator.ts` (`ensureXR`, `window.__musemuseXR`), `lib/xr/sessions.ts` (sees a session from `requestSession` or from Quest's own `offerSession` prompt), `lib/xr/targets.ts` (`useXRTarget`, `countInView`), `lib/xr/status.ts`: platform files.
- `components/xr/`: `XRStage`, `EnterVRButton`, `HowToView`, `Panel`. The build may change these.
- `public/xr/profiles/`: controller and hand models served locally, since the build firewall blocks CDNs. MIT, `LICENSE.md` beside them.
- `.agents/skills/muse-vr`. It points at `@react-three/xr`'s own skill in `node_modules` rather than a copy.
- For every product, as platform files: `tests/xr.ts`, `scripts/xr-peek.mjs`, `scripts/browser.json`. None of them import `iwer`.

The simulated view is 60 degrees tall (`SIMULATED_FOVY`), not IWER's default 90, which across a 16:9 window is 121 degrees wide. At
the default a panel at 1.5 m is about 240 px wide and its text is unreadable in screenshots and the demo. A real headset brings its own.

## Checks

- **`judgeShot` in a session** (`xrJudgeShot`): waits while `setXRStatus(text, true)` says a model is working, then fails on any of these,
  takes a viewport screenshot, skips the 2D layout checks and writes `.checked` with `xr: true`:
  - The view stopped drawing. It reads three.js's own draw counter, since the session's frames keep coming after a scene crashes.
  - Nothing is in front of the person. `XRStage` wraps its children in a group, and `countInView` counts what is visible and in the camera's
    view under it, without the floor and controllers, which fill a view by themselves. An object no light can show doesn't count. `xr.enter`
    checks this too.
  - The view is blank: brightness spread under 6, under 12 colors, or one color over 95%. With objects in view and at least 64 between the
    darkest and brightest pixel this doesn't apply, because a few stars on a black sky measure the same as a blank view.
- **`verify`**: the console check launches with the target's flags. `xrShotProblems` needs at least one VR shot, none blank or with nothing
  in view, and no alert in the last one. These stay failures under `MUSEMUSE_SCREEN_CHECK=warn`. `judgeShotNotes` prints a note, without
  failing, for a shot past 50 draw calls or 30k triangles or under 15 fps. A stage whose `XRStage` a build rewrote without the group or the
  reporter skips the checks it can no longer measure.
- **`playwright.config.ts`**: VR products run at 1280x720, device scale 1, with `--enable-unsafe-swiftshader`.
- **`collectVerifyResult`** adds "(VR view)" to those captions.

## Demo Studio

`tests/xr.ts` records each move as a `{ kind: "xr", ready: t1 }` action, so it plays at full speed and the camera doesn't cut to it.
A top-level step that moved in VR ends with a 2.8 s hold that fills the view, and the last one is the poster.

Things the recorder does differently for VR, all found by looking at a real render:

- The 3D preview on the page is never a result, or the video scrolls back to it and it takes the poster.
- What changes on the 2D page during a session isn't activity. It is behind the view, and the camera would zoom to nothing.
- Once a person has been in VR, the only thing left to hold on the page is the card marked `data-result`, which comes on screen and
  can't outrank a VR hold for the poster.
- Earlier results are cleared on the first VR move, so "Your quiz is ready" gets no hold of its own.

The note "Recorded in a simulated Meta Quest 3 headset." (`VR_DEMO_NOTE`, from `demoNoteFor`, for builds and `rerecord-demos.ts`) is on the
intro card and in the window's title bar, so it stays up for the whole main part and in the basic cut. If Chromium can't draw the window,
the VR render fails and the product ships with no video, rather than publishing one without the note. The old recorder's MP4 draws it over the
whole recording. The poster, a frame from inside VR, doesn't carry it.

## The product page

`liveFrameAllow` adds `xr-spatial-tracking` and `liveFrameSandbox` adds `allow-pointer-lock`, because the simulated headset's play mode
needs it for mouse-look. Both read the brief's `targets`, which are `{ id, why }` objects.

## The test build, Oct 31

One real build through the normal pipeline on a local dev server (`next dev --webpack`, PGlite, exec engine, Muse Wonder, the Oct 28
snapshot), from a brief written by hand: "Quiz Room", pick a topic, Muse Wonder writes three questions, answer them on a panel in VR.

| | |
|---|---|
| Outcome | live (publishing off), no fix round, judge pass, 479 s |
| Cost | $2.28 recorded: Muse Code $1.44, its reminders $0.79, judge $0.05 |
| verify | 45 s; smoke 26.7 s, 3 passed |
| Frame rate at the judge's shots | 19.9 to 21.8 fps, 23.1 to 24.9 after the field of view change |
| Video | 1920x1080 H.264, about 45 s, poster inside VR after the fixes |

The fixes above were then checked by re-running verify and the demo in that build's sandbox, without a new Muse Code round. The same
sandbox also ran the person's path with `navigator.webdriver` off: DevUI and the chip load, Exit VR ends the session, and a phone
emulation gets `preview`, which returns before IWER is imported.

Muse Code read the skill and followed its parts and smoke test, but never ran `xr-peek`. It put the panel past 1.5 m with pedestals in
front of it, and nothing it saw told it so. The skill now says to look before the first verify and gives a closer limit. That wording
has not been through a Muse Code build.

## Not tested

- A real Quest: the `native` path in `emulator.ts`, real controllers and hands (spike S4). `offerSession` was simulated with IWER behind a stub:
  the session is now seen, but Quest's own prompt wasn't. The store no longer asks for anchors, plane or mesh detection, hit test or DOM overlay,
  and whether that removes a permission prompt can only be seen on a device.
- DevUI's play mode with pointer lock, in a real browser or inside the product page's iframe.
- A build through the brief writer: the brief was by hand, and `renderBuildPrompt` and the judge have no VR wording in this branch.
- A new snapshot, including `installTargets`' warm step and `checkTargets`. The older-snapshot path is what ran.

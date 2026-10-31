# Native shells

Thin apps that open one live web product. All the source is in `native/`.

| Path | What it is |
|---|---|
| `native/shell-mobile` | Expo SDK 58 and react-native-webview. Phone shell, lab shell and glasses variant. |
| `native/shell-desktop` | Electron 45 and electron-builder 26.18. One locked-down window per product. |
| `native/bridge/protocol.ts` | The `window.MuseNative` v1 types, for the template to copy. A test keeps it identical to the shell's copy. |
| `native/releases.json` | EAS build ids and artifact URLs. |

## Phone shell

**Variants,** set in `app.config.ts`:

| Env | Bundle id | Opens |
|---|---|---|
| `APP_VARIANT=production` | `ai.musemuse.app` | Products by slug, through `GET <platform>/api/native/resolve/<slug>`. Raw URLs are refused. |
| `APP_VARIANT=lab` | `ai.musemuse.lab` | Any https URL, or http on the machine itself, with a selftest. Only this variant allows cleartext on Android. |
| `MUSE_GLASSES=1` | `app.musemuse.glasses` | Adds the wearables module and its Info.plist keys. Simulator only for now. |
| `MUSE_PRODUCT_URL=<url>` | | A per-product build. It opens only that URL and updates are off. |

With nothing to open, every variant shows the product list from `GET <platform>/api/native/catalog`. Those two routes
come from another unit. Until they are live, the list says it can't load. `MUSE_RESOLVE_STUB=1` at build time uses a
stand-in instead.

**Opening a product**

- Deep link: `musemuse://open?slug=<slug>`. Lab: `musemuse://check?url=<encoded>&selftest=1&token=<t>`.
- iOS launch arguments: `-museSlug`, `-museUrl`, `-museSelftest 1`, `-museToken`, `-musePlatform`, `-museMock 1`,
  `-museRun autopilot`.
- Lab machines should use launch arguments on the iPhone Simulator. `simctl openurl` stops at an "Open in Muse Lab?"
  dialog that nothing presses, on every link. On Android use `adb shell am start -d <deep link>`.

**The bridge.** The shim goes in the top frame only, and only on the product's origin. Each request carries a
per-WebView nonce and an id. `src/bridge/router.ts` drops anything from another origin or with a wrong nonce, without
replying. Everything else gets exactly one reply, even if its handler hangs. Parameters are checked in `validate.ts`
before native code sees them.

**When the bridge appears.** On iOS the shim runs before page code. On Android it does not: react-native-webview 14 calls
`evaluateJavascript` from `onPageStarted`, which is asynchronous, so a page's first inline script can run ahead of it. Product
code must look for `window.MuseNative` when it's about to use it, never cache a "no" at module load, and wait for the load
event before settling on a web fallback on Android. The first Android lab run reports how late it really is, with a page whose
inline head script records what it saw, because the selftest's handshake runs after load and can't catch this (`docs/NATIVE_LAB.md`,
"The Android bridge timing check").

**Leaving the product.** Top-level loads off the product's origin go to the system browser or nowhere. At most 3 opens go
out in any 10 s, and the rest are dropped. `tel:` and `sms:` links open only from a real click on iOS. Android always
reports `navigationType` as `other`, so there only the limit holds them back. Android also lets a load through if the JS
thread doesn't answer within 250 ms, so `onLoadStart` and `onNavigationStateChange` check again, stop the load and go back
to the product. A page that does this more than 3 times in 30 s gets the "This didn't open" screen.

**Camera and microphone.** On iOS a page gets the system's prompt for each page load, because one app opens many products.
**Known limit, accepted for this event, since per-product APKs are the default:** react-native-webview on Android grants a page's request as soon as the app holds
the OS permission, and has no hook to ask first. So in the generic Android shell, a yes given for Product A also covers
Product B. Per-product APKs don't have this problem, since each one opens one product. A real fix means patching
`RNCWebChromeClient.onPermissionRequest`.

**Selftest.** It scrolls the page, then logs a `MUSE_SELFTEST {json}` line, kept under 3.5 KB for logcat, and posts the whole
report to `<platform>/api/native/selftest`. On iOS it also writes the whole report to `Documents/selftest.json`. The pass rules are in `src/selftest.ts`. The handshake is what the shell's router saw,
not what the page said, and a report only counts after the page has loaded and the scroll has had its time. A page can
still claim a text length, so the lab's pixel check is the proof of that one.

**Per-product APKs: check before the first one ships.** `updates.enabled` is false only when `MUSE_PRODUCT_URL` is set at
build time, but the design repacks these from the production template, which is built without it. An update replaces the
config that `settings.js` reads, so if a repacked APK keeps updates on, the next `eas update --channel production` would
clear its `productUrl` and it would become the generic list. Spike S6 passes only if the repacked manifest has
`expo.modules.updates.ENABLED` false. If repack-app doesn't set that, the packager must.

**Why the React Native files are JavaScript.** The repo's root `tsc` reads every `**/*.ts`, and this project's packages
aren't installed at the root. So anything that imports React Native or Expo is `.js`, checked by the shell's own
`npm run typecheck`. Files with no such imports stay `.ts`. That's why `src/glasses/mock.js`, `Preview.js` and
`src/bridge/glasses.js` aren't `.ts`.

## Glasses variant

It runs on SDK 58 with `@chrisgocode/expo-meta-wearables-dat` 2.2.0, in the same project. No separate SDK 54 project is
needed. Two things make that work, and both have tests:

- The module's autolinking is excluded in `package.json`, so other builds never carry it.
  `scripts/glasses-autolink.mjs` turns it on for `MUSE_GLASSES=1`. It must be EAS's **pre-install** hook, because EAS
  installs pods before its post-install hook.
- `plugins/without-deterministic-uuids.js` takes `deterministic_uuids` back out of the Podfile. With it on React Native
  0.88, same-named codegen files collapse into one, webview's C++ never compiles, and the link fails.

The module only compiles Meta's mock glasses under `DEBUG`. `plugins/with-mock-glasses-in-release.js` turns that on for
the module alone when `MUSE_GLASSES_MOCK=1`, so a simulator build runs with no Metro. Never use it on a device build.

**Mock media.** Copy these into the app's Documents folder before launch: `mock-feed.mov` (H.265, `-tag:v hvc1`),
`mock-photo.jpg` and `mock-question.wav` (16 kHz mono). A capture has nothing to return without the photo. Mock mode never
touches the microphone, because preparing the recorder on a simulator can hang and stall every Expo async call behind it.
With no question file, `stopRecording` returns silence.

**Autopilot.** With `-museMock 1 -museRun autopilot`, it presses `[data-glasses-action="connect"]`, waits for
`[data-glasses-primary]` to be enabled and presses it. After 1.5 s it presses it again if it's still there, not disabled,
and there's no result yet, since the template's button listens between two taps. Then it waits for `[data-result]`.
Checkpoints go to `Documents/autopilot.jsonl` and to the log as `MUSE_AUTOPILOT` lines. The checkpoint that ends the run
carries the page's uncaught errors and `console.error` calls in `errors`, which the lab turns into warnings.

**A new page in the same WebView.** Its load start ends the old page's recording, live view and speech, in case the old page
didn't manage to, and a recording it was still starting never starts. Jumps within a page don't count. The glasses stay
connected. A failed photo or a stream timeout leaves the state at ready, so the next press can work, and that call's own
promise carries the failure.

**Cut for now.** The design's button for `glasses_app_update_required` isn't wired, so that error only tells the person to
open the Meta AI app. Only real glasses can hit it, and this build is simulator only. Wire `openDATGlassesAppUpdate` before
real glasses ship.

## Desktop shell

- **Config:** `resources/muse-product.json` outside the asar: `{ "name", "url", "shellVersion" }`. The packager rewrites
  this file for each product. The URL must be https, or http on the machine itself.
- **Fuses:** RunAsNode, NodeOptions and NodeCliInspect off. OnlyLoadAppFromAsar on.
- **Signing:** a Mac build must be ad hoc signed (`mac.identity: "-"`). Flipping fuses breaks the old signature, and macOS
  kills the app at launch with exit 137.
- **Profiles:** every packaged app has the same `productName`, so each product gets its own folder,
  `<appData>/Muse Muse/<sha256(origin), first 16 chars>`. That folder also holds the single-instance lock, so two products
  run side by side, and a second launch of one product brings the first forward. Check this with
  `npm run test:two-products`, which opens real windows.
- **Bridge:** `hello` and `notify`. Haptics, share and camera answer `unsupported`, and products fall back to web APIs.
  `delaySeconds` works up to 86400, but a notification still waiting is lost if the app closes. On a system with no
  notifications, `notify` answers `unsupported`.
- **Permissions:** camera, microphone and location show a dialog naming the product, and the answer lasts until the app
  quits. Until there's a yes, `navigator.permissions.query` reads `denied` and device labels stay hidden, but
  `getUserMedia` still asks. Selftests answer no, since nobody is there.
- **Leaving the product:** page navigations and redirects off the origin go to the system browser, at most 3 in any 10 s.
  Redirects inside an inner frame stay in that frame.
- **Downloads:** only the product's own page can start one, at most 3 in any 10 s, and the person picks where it goes.
- **Failed loads:** the window shows "This didn't open" with a Try again link.
- **Selftest:** `<app> --muse-selftest=<dir>` writes `selftest.json`, `stills/*.png` and `frames/*.jpg`, and exits 0 on a
  pass or 1 on a failure. Frames aren't evenly spaced, so use `frames / recordMs` for the rate.

```sh
cd native/shell-desktop
npm install
CSC_IDENTITY_AUTO_DISCOVERY=false npm run mac            # The template: a universal zip, about 215 MB.
CSC_IDENTITY_AUTO_DISCOVERY=false npm run mac:selftest   # This machine's architecture only, for a quick selftest.
npx electron-builder --linux AppImage --x64
npx electron-builder --win dir --x64
```

Shells started from a tool built on Electron can inherit `ELECTRON_RUN_AS_NODE=1`, which turns Electron into plain Node.
Unset it before launching the app from source.

## Building the phone shell

Run these from `native/shell-mobile` with `EXPO_TOKEN` set. `EAS_NO_VCS=1` uploads only this folder, filtered by
`.easignore`, instead of the whole repo. The EAS project is `@offline-base1/muse-hackathon`, so the slug stays
`muse-hackathon`.

```sh
EAS_NO_VCS=1 eas build --profile lab-android --platform android --non-interactive --no-wait
EAS_NO_VCS=1 eas build --profile lab-ios-sim --platform ios --non-interactive --no-wait
EAS_NO_VCS=1 eas build --profile glasses-ios-sim --platform ios --non-interactive --no-wait
APP_VARIANT=production EAS_NO_VCS=1 eas update --channel production --message "<what changed>" --environment production
```

The free plan allows 15 builds per platform each month, and a paid build isn't possible on it.

## Tests

```sh
npx tsx --test --test-concurrency=4 --experimental-test-module-mocks \
  native/shell-mobile/src/bridge/__tests__/*.test.ts native/shell-mobile/src/__tests__/*.test.ts
(cd native/shell-mobile && npm install && npm run typecheck)
(cd native/shell-desktop && npm install && npm test)
```

The glasses test mocks Expo's modules by name, so `native/shell-mobile` needs its `npm install` first.

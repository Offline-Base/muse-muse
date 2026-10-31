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
| `APP_VARIANT=lab` | `ai.musemuse.lab` | Any https URL, or http on the machine itself, with a selftest. |
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

**The bridge.** The shim goes in before page code, in the top frame only, and only on the product's origin. Each request
carries a per-WebView nonce and an id. `src/bridge/router.ts` drops anything from another origin or with a wrong nonce,
without replying. Everything else gets exactly one reply, even if its handler hangs. Parameters are checked in
`validate.ts` before native code sees them.

**Selftest.** It scrolls the page, then logs a `MUSE_SELFTEST {json}` line and posts the same report to
`<platform>/api/native/selftest`. The pass rules are in `src/selftest.ts`.

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

**Mock media.** Copy these into the app's Documents folder before launch: `mock-feed.mov` (H.265, `-tag:v hvc1`) and
`mock-photo.jpg`. A capture has nothing to return without the photo.

**Autopilot.** With `-museMock 1 -museRun autopilot`, it presses `[data-glasses-action="connect"]`, then
`[data-glasses-primary]`, and waits for `[data-result]`. Checkpoints go to `Documents/autopilot.jsonl` and to the log as
`MUSE_AUTOPILOT` lines.

## Desktop shell

- **Config:** `resources/muse-product.json` outside the asar: `{ "name", "url", "shellVersion" }`. The packager rewrites
  this file for each product. The URL must be https, or http on the machine itself.
- **Fuses:** RunAsNode, NodeOptions and NodeCliInspect off. OnlyLoadAppFromAsar on.
- **Signing:** a Mac build must be ad hoc signed (`mac.identity: "-"`). Flipping fuses breaks the old signature, and macOS
  kills the app at launch with exit 137.
- **Bridge:** `hello` and `notify`. Haptics, share and camera answer `unsupported`, and products fall back to web APIs.
- **Selftest:** `<app> --muse-selftest=<dir>` writes `selftest.json`, `stills/*.png` and `frames/*.jpg`, and exits 0 on a
  pass or 1 on a failure. Frames aren't evenly spaced, so use `frames / recordMs` for the rate.

```sh
cd native/shell-desktop
npm install
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --arm64
npx electron-builder --linux AppImage --x64
npx electron-builder --win dir --x64
```

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

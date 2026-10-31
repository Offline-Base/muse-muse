# Packager spike, Oct 31

Whether a Vercel Sandbox can turn the shell templates into a product's Android, Mac and Windows downloads, with no Wine, no
Android SDK and no credentials. It can, in about half a minute for all three. Everything ran in real sandboxes on the shells
built from 3e223ea.

## Results

| Spike | Result | What was really run |
|---|---|---|
| S6, repack-app | **Partly proven.** Built, signed and read back. **Install and launch not run** | `repackAppAndroidAsync` in the sandbox, then `aapt2 dump`, `apksigner verify` and a read of every library's offset. There's no emulator on this Mac, and Device Farm costs money |
| S6, updates off | **Pass** | `aapt2` reads `expo.modules.updates.ENABLED` as false, and no update URL. `package.mjs` refuses an APK that reads otherwise. `assets/app.config` has `productUrl` |
| S7, rcodesign | **Pass** | Signed in the sandbox, then on this Mac: `codesign --verify --deep --strict` passes, the entitlements are kept, `spctl` rejects it as expected, and `--muse-selftest` passes on arm64 and under Rosetta |
| S8, resedit | **Half.** Reads back right. **Launch on Windows not run** | On this Mac, resedit reads the exe from the zip: the name, version and all 7 icon sizes. `@electron/fuses` reads all four fuses as set. There's no Windows machine here yet |
| S10, images in a tool result | **Not run** | It needs a call to Meta, and this unit's cap there is $0 |
| S11, `start()` from a step | **Pass, on the local world** | A scratch workflow under `next dev --webpack` and workflow 5.2.3: its step called `start(child)`, the child ran and the parent finished. **Not run on Vercel's world** |
| Blob upload through the firewall | **Not run** | This laptop has no Blob credential, so no real slot could be made. The runs here used `keep` slots. See below |

## Time and size per product

Three products on a 4 vCPU sandbox, all three packages at once. "End to end" is on a laptop, including starting the sandbox and
copying files out, which a real run does through Blob instead.

| Step | Time |
|---|---|
| Start a sandbox from the snapshot | 3 s |
| Android | 7 to 10 s |
| Windows | 21 to 24 s, of which `zip` is 17 s |
| Mac | 29 to 41 s, of which `zip` is 22 to 32 s and `rcodesign` 2 to 4 s |
| All three, in the sandbox | 29 to 33 s |
| End to end | 54 to 70 s |

| Package | Output | Design said | Slot limit |
|---|---|---|---|
| Android | 38.6 MB | 30 to 50 MB | 120 MB |
| Mac, universal | 224.4 MB | 115 to 150 MB | 320 MB |
| Windows, x64 | 158.3 MB | 100 to 120 MB | 260 MB |

The snapshot is 3.2 GB. `zip -1` cuts the Mac's zip step to 9 s but makes the file 243 MB, so packages use the default level:
every download costs more than a sandbox's seconds.

## What this found

- **repack-app's defaults don't fit a release APK.** It runs Metro on any APK with a bundle, and writes the app's name into
  `strings.xml` unescaped, so "Fern & Moss" stops the build. Its `spawnAsync` option gets around both, without patching it.
- **aapt2 prints a value of false as `android:value(0x01010024)=false`, and an apostrophe in a label with no escape.** The first
  version of the check missed both and failed correct APKs.
- **A helper with a non-ASCII name fails `codesign --verify --strict`** after rcodesign signs it, though the app still launches.
  With the name `Tom's "A&B" <C> $(x) 日本語 ../é`, the verifier said "a sealed resource is missing or invalid" on the helper.
  "Fern & Moss" passed. The exact character wasn't narrowed down, because running rcodesign on this Mac was denied by the
  permission classifier, so each try needs a sandbox. Names inside the bundle are now plain ASCII, the real name stays on the
  `.app` folder and in `CFBundleDisplayName`, and that hostile name now verifies.
- **Info-ZIP doesn't mark UTF-8 names,** even with `-UN=UTF8`. Python read that name as garbage. `markUtf8Names` sets the flag
  on every entry, and the same name now reads correctly.
- **Native libraries stay stored and on 16 KB boundaries** after the rebuild, which `extractNativeLibs="false"` needs. Now checked on
  every APK.
- **Electron names its crash DLL after the exe,** so the packager renames `<name>_wer.dll` too.

## Checked in the sandbox

- **Firewall** with the packager's policy: `vercel.com` and `*.blob.vercel-storage.com` answer (404 on the paths tried, which is
  still an answer). `example.com`, `registry.npmjs.org`, `github.com` and `api.meta.ai` don't resolve.
- **Environment:** no variable's name in `env` has token, secret or key in it.
- **Hostile name:** `Tom's "A&B" <C> $(x) 日本語 ../é` went through all three packages. The label read back right, the file name lost
  only what isn't allowed, and no shell was involved.

## The platform's Android signature

`lib/native/apk-sign.ts` re-signed a real 38.6 MB APK in 71 ms. The real `apksigner verify --print-certs -v` then says v2 is
verified, with the throwaway key's certificate, and the libraries stay aligned. The full path also ran through `collectPackaging`
with a throwaway key: it read the file, signed it, checked it and stored it, and its certificate hash matched the key's.

**Not run on a phone.** Android's own check is the same algorithm, but no device has installed one of these.

## Not checked

- Installing and launching an APK (S6), on anything. This also means `settings.js` reading `productUrl` at run time was only
  checked by reading expo-constants and expo-updates: with updates off, `launchedUpdate` is null, so `Constants.expoConfig` is the
  file `assets/app.config`. The first Android lab run has to confirm the product opens.
- Launching the Windows package (S8).
- A real Blob upload from the sandbox. `uploadThroughSlot` is the lab's, whose tests compare its requests with the real SDK's, and
  the firewall lets its hosts through. Run `package-product.ts` from a place with a Blob credential to prove it. Do this before
  relying on the Mac's 224 MB multipart upload.
- The product's real `/icon/512`. The picture path ran with `--icon`, but no live product has that route until the targets unit
  ships. Today's products get the letter tile.
- Opening a Mac package that has the quarantine flag, as a browser download does. The Get it panel's steps for that are untested.

## Two things for the lab

- **The live site can answer a selftest with Vercel's Security Checkpoint.** After about 5 selftests in 20 minutes from this Mac,
  `muse-muse.vercel.app` gave Electron a 403 titled "Vercel Security Checkpoint". The app itself was fine: its handshake passed and it
  made 25 frames. Against `example.com` the same package passed. Product checks from the AWS boxes may meet this.
- **During that checkpoint one selftest exited 0 in 4 s with no `selftest.json`,** and another did so earlier. The next run on the same
  build exited 1 with a report. The lab must treat exit 0 with no report as a failed check.

## After the review

The review's fixes, checked on a refreshed snapshot with real packages named `Résumé Builder`, `product.zip` and `Aux.ai`:

- **Signature:** APKs have no `META-INF` signature files, and `aapt2` reads minSdk 24. With the real `apksigner verify
  --min-sdk-version 24`, the debug APK and the ones `apk-sign.ts` re-signed with RSA and EC keys all verify with v2 alone and show
  the right certificate. `keytool -printcert -jarfile` says "Not a signed jar file", so no debug certificate is left. With
  `--min-sdk-version 21` it says "Missing META-INF/MANIFEST.MF", which is expected: no shell goes below 24.
- **`assets/app.config`** holds the product's URL and real name, and `checkApk` now refuses an APK without that URL.
- **Polling real sandbox states:** running gives `running`, stopped gives "stopped before it finished", and deleted gives "gone".
- **Names:** `product.zip` makes all its packages, `Aux.ai` becomes a `Muse App` folder, and `Résumé Builder` has `Resume Builder`
  inside the bundle.
- **Tiles,** rendered with the snapshot's fonts and looked at: Latin, Greek, Cyrillic, Arabic and Hebrew draw their letter, and
  Japanese, Hindi and Korean names get "M".

**Still not run:** `head`, the streamed hash and the rest of the Blob path have only run against fakes, because this laptop has no
Blob credential. Installing on a phone and launching on Windows are still not run either, and no device has yet taken a v2-only APK.

## Cost

About $1.25 of the $2 cap at worst, counting every sandbox as busy for its whole life, and including the first run's, the review's
and the fixes' checks. $0 at Meta. All sandboxes are deleted. One snapshot is kept, at about $0.25 a month.

## Running it again

The snapshot this made is `snap_VcblDXLuhpigJ8ZeukmR38j2PupJ`, on the muse-muse project, from the shells at 3e223ea, with the
code from the review below. It has no expiry. Nothing has set it as `PACKAGER_SNAPSHOT_ID`.

```sh
PACKAGER_SNAPSHOT_ID=... npx tsx --env-file-if-exists=.env.local scripts/native/package-product.ts \
  --name "Fern & Moss" --url https://example.com/ --out /tmp/fern --delete
```

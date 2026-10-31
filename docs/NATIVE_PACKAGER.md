# The packager

Turns the shell templates into one product's Android, Mac and Windows downloads, in a Vercel Sandbox, in about a minute. No
Wine, no Android SDK and no Mac are involved. The lab boxes only test what comes out.

Spike results: `docs/spikes/packager-2026-10-31/README.md`.

| File | What it is |
|---|---|
| `scripts/native/release-shells.ts` | Publishes one shell version's templates to Blob or `.data/files`, and writes `lib/native/shells.json` |
| `scripts/native/make-packager-snapshot.ts` | Makes the snapshot every packager sandbox starts from |
| `scripts/native/package-product.ts` | Runs the real packager for one product by hand, with no database |
| `native/packager/package.mjs` | What runs in the sandbox. It reads job.json, makes the packages and uploads them |
| `lib/native/packager.ts` | The platform's side: `startPackaging`, `pollPackaging`, `collectPackaging`, `stopPackaging` |
| `lib/native/apk-sign.ts` | APK signature scheme v2, for the platform's Android key |
| `lib/native/shells.ts` | Reads `lib/native/shells.json`, which deploys with the platform. `native/` doesn't |

## Using it from a workflow

Each call takes and returns plain data, so each can be its own step. None of them holds a secret in what it returns.

```ts
const handle = await startPackaging({ runId, productId, slug, name, url, kinds: ["android", "mac", "windows"] });
try {
  // Every 10 s. `running`, `finished` with the result, or `failed` with a reason.
  const state = await pollPackaging(handle);
  // Once finished. A package that failed is in `failures`, in plain words, and the others still come back.
  const { files, failures } = await collectPackaging(handle, state.result);
} finally {
  await stopPackaging(handle);
}
```

- **`files`** has what `native_artifacts` needs: `artifactKind`, `url`, `pathname`, `bytes`, `sha256` and `shellVersion`.
  `signedWith` says who signed an APK. Each of these comes from the platform's own store, not from what the sandbox said (see
  "What the platform trusts").
- **`pollPackaging`** returns `failed` for a run that died: a deleted or stopped sandbox, a bad exit, or the 8-minute limit. It
  throws when the sandbox API has a hiccup, so leave it to the step's retries. Don't turn that throw into a failure.
- **`startPackaging`** throws `PackagerUnavailableError` without `PACKAGER_SNAPSHOT_ID`. It's safe to repeat: the sandbox is
  named after the run, and a retry replaces it.
- **A kind with no template** in this shell release lands in `failures`, and the rest still run.

## What's in the sandbox

Nothing but the snapshot, job.json and maybe the product's icon.

- **No credentials.** The only things that can write anywhere are the presigned slots in job.json, each for one exact
  pathname, type and size, good for 14 minutes.
- **Firewall:** Blob's hosts only (`vercel.com`, `*.blob.vercel-storage.com`).
- **Not persistent,** deleted after each run, with its own 12-minute timeout as a backstop.
- **Names and URLs are data.** They come from job.json, are checked in `lib/job.mjs`, reach tools only through argv arrays and
  are escaped for plists and Android resources.
- **Product bytes:** the only ones are the optional icon, which the platform fetches from `<product>/icon/512` with no
  redirects and which only `sharp` in the sandbox ever decodes. The platform stops reading at 8 MB and passes it on only if its
  first bytes say PNG, JPEG or WebP, whatever the headers say. A picture `sharp` can't read gets the letter tile.

## What the platform trusts

A parser exploit in the sandbox could hold its slots and rewrite its answer, so that answer decides nothing:

- **`head` on the slot's path** in the platform's own store gives each file's URL and size. A URL in the answer is ignored, so a
  download can't point at another store. A file that isn't there fails that kind.
- **The hash is the platform's.** It reads each file once as a stream, so a 224 MB zip never sits in a function's memory. That
  is about 380 MB of Blob traffic per product. The sandbox's size and hash only have to agree, or that kind fails, which also
  catches a bad upload.
- **`keptAt` counts only on a local run,** whose slot the platform marked `kept`.

**Still open:** a slot allows overwrites, so that a retried step can replace its own upload, and it stays good for its 14 minutes
even after the sandbox is deleted. A token that got out could change that one path's bytes during those minutes, after the
platform read them. The lab's download would catch it, because it checks `sha256`, but a person's download wouldn't.

## The three patches

**Android.** `@expo/repack-app` 0.10.4 on the production APK. Its spawn option is what lets this run without Metro or the
Android SDK: it skips the bundle step, because every product's JS is the shell's, and makes our edits just before the rebuild.
After that:

- `expo.modules.updates.ENABLED` is `false` and the update URL is gone, in the manifest and read back with `aapt2` on every
  package. A package that fails this isn't uploaded. This is the check `docs/NATIVE_SHELLS.md` asks for, so a later
  `eas update --channel production` can't turn a product's app into the generic list.
- The `musemuse://` links are gone, so products don't all answer them.
- x86 and x86_64 are dropped, because phones are ARM. **This means the x86_64 Android emulator can't run these.** The lab's
  arm64 AVD can.
- Every provider authority moves to the product's package, or a second product wouldn't install. `aapt2` checks that too.
- `assets/app.config` must hold the product's URL. Otherwise the app would open the generic list. Checked on every package.
- It's signed with v2 alone, because every shell's minSdk is 24. A JAR signature would stay behind naming the debug key after the
  platform re-signs. Its header also makes `apksigner verify` report a stripped v3 signature. Every package is checked for
  leftover `META-INF` signature files.

**Mac.** The universal template gets `muse-product.json`, the plist's name and id, an ICNS and renamed helpers, since Electron
finds `<CFBundleName> Helper.app` by name. Names inside the bundle are plain ASCII (`innerName`), because `codesign` refused a
helper with non-ASCII in its name. The real name stays on the `.app` folder and in `CFBundleDisplayName`. Then `rcodesign sign` with
no certificate, which is what `identity: "-"` does on a Mac and which keeps the template's entitlements. `zip -y` keeps the
framework symlinks.

**Windows.** The x64 template gets `muse-product.json`, and resedit sets the exe's icon and version text. The exe and its crash
DLL are renamed. It isn't signed, so SmartScreen warns.

The shell works out each product's `userData` folder from the URL in its config, so two products never share a profile or a
lock. The packager has nothing to do for that.

**Icons** come from the product's own `/icon/512` or a letter tile, cut to each platform's shape. The tile shows a name's first
letter the snapshot's fonts can draw, and "M" if there is none, so a Japanese, Korean or Hindi name gets "M".

## Sizes

Measured on Oct 31. The Mac zip is well over the design's estimate, so these are what Blob and download copy should expect.

| Package | Template | Output | Slot limit (`PACKAGE_MAX_BYTES`) | Design said |
|---|---|---|---|---|
| Android | 74 MB | 39 MB | 120 MB | 30 to 50 MB |
| Mac | 217 MB | 224 MB | 320 MB | 115 to 150 MB |
| Windows | 158 MB | 158 MB | 260 MB | 100 to 120 MB |

## The Android key

The sandbox signs with `@expo/repack-app`'s public debug key, using v2 alone, because it runs `apksigner` and that also aligns the
zip. That key
is public, so anyone could sign an update to a product's app with it. So when `NATIVE_APK_KEYSTORE_B64` is set, the platform
downloads the APK from an `unsigned/` path, replaces the signature in `lib/native/apk-sign.ts`, checks it and uploads it to the
real path. Without the key the APK is offered as it is, and `signedWith` says `debug`. It installs, but keep it for tests.

The key never enters a sandbox, and it needs to stay the same for good, because Android refuses an update signed by another
key. Make it once, on your own machine:

```sh
openssl req -x509 -nodes -newkey rsa:2048 -days 10000 -subj "/CN=Muse Muse" -keyout key.pem -out cert.pem
cat key.pem cert.pem | base64 | tr -d '\n'   # NATIVE_APK_KEYSTORE_B64
```

This replaces the design's JKS keystore, which Node can't read. `NATIVE_APK_KEY_ALIAS` is gone. `NATIVE_APK_KEYSTORE_PASSWORD`
is the PEM's passphrase, if it has one.

## Releasing a shell

```sh
# Needs a production-android build in native/releases.json. Local files go to .data/files when there's no Blob credential.
npx tsx --env-file-if-exists=.env.local scripts/native/release-shells.ts [--local] [--via https://muse-muse.vercel.app]
npx tsx --env-file-if-exists=.env.local scripts/native/make-packager-snapshot.ts
```

- **`--via`** asks the live site for the upload slots (`POST /api/admin/native/shell-upload`, with `AUTOMATION_SECRET`), since the
  live store isn't connected to a laptop's OIDC token.
- **A code-only change** to the packager doesn't need the templates baked again: `make-packager-snapshot.ts --from <old id>` takes
  10 s. Baking them from a laptop takes about 10 minutes.
- **`lib/native/shells.json`** names each file with its checksum, and the packager refuses any other bytes. It takes the copy
  baked into the snapshot when the checksum matches, and otherwise downloads the template.
- **Then** commit `shells.json` and set the printed `PACKAGER_SNAPSHOT_ID`.
- **EAS's artifact links last 14 days.** The Oct 31 links expire on Nov 14. The snapshot's copies don't expire.

## Tests

```sh
(cd native/packager && npm install && npm test)
npx tsx --test --experimental-test-module-mocks lib/native/__tests__/packager.test.ts lib/native/__tests__/apk-sign.test.ts
```

# Turning the native lane on

The owner's steps, in order, to make real Android, Mac and Windows downloads before Nov 4 noon ET. Written Nov 3 on branch
tg-r3-native-honest. Nothing here has been run by an agent. No EAS build, sandbox or upload was started to write it.

## Why no app was made on Nov 3

The Nov 3 audit's phone and desktop builds have no `native` events and no packages. These are the reasons, in order:

1. **`PACKAGER_SNAPSHOT_ID` isn't set in Production.** `ship()` in `lib/pipeline/workflow.ts` ran `packageProductStep` only with
   it, and `startPackaging` (`lib/native/packager.ts`) refuses without it. So nothing was packaged, and nothing said so.
2. **`lib/native/shells.json` has no Blob links (`url: null`).** This is not a blocker. Each template has its checksum, and the
   packager uses the copy baked into its snapshot when the checksum matches (docs/NATIVE_PACKAGER.md). It matters only when a
   new snapshot is made on a machine that doesn't have the template files.
3. **`SHELL_UPDATE_PUBLISHED` is false** (`lib/native/shell-links.ts`), because `productionUpdate` in `native/releases.json` is
   null. That only affects the owner's Expo Go code on the iPhone. The panel now hides that code until the update is published.

What this branch changed, so the site is honest until the steps below are done:

- Phone and desktop in `NATIVE_TARGETS` are offered to the brief writer and the composer only when the packager can make them
  (`env.offeredNativeTargets`, `lib/native/readiness.ts`). Until then the target picker says: "Only the web app and its phone
  home-screen install are available. Phone and desktop apps aren't made here, because the app packager isn't set up on this site."
  With VR, glasses, agent or edge also on, it drops the "Only the web app" sentence and says a phone can still add the web app
  to its home screen.
- A build whose brief still asks for apps (a refinement of an older product) gets one "skipped" line in the build room with that reason.
- The Get it panel says "Not made for this build: the app packager isn't set up on this site." in place of "isn't ready yet".
- The panel's Quest, MCP and connector links use the public site (`https://www.musemuse.dev`, or `PUBLIC_SITE_URL`), not
  `PLATFORM_URL`'s `muse-muse.vercel.app`.
- With `NATIVE_TARGETS` empty, nothing changes.

## What already exists (checked in the repo, Nov 3)

| Thing | Where | State |
|---|---|---|
| Android production shell, EAS build `a7995d6c` | `native/releases.json`, `production-android` | Built Oct 31 from `3e223ea`. Its EAS link expires Nov 14 |
| Lab Android, lab iOS simulator, glasses iOS simulator shells | `native/releases.json` | Built Oct 31 from `0ef03c0`. Links expire Nov 14. Only the device lab uses them |
| Shell templates (android 74 MB, mac 217 MB, windows 158 MB) | `lib/native/shells.json` | Checksums recorded, no Blob links |
| Packager snapshot `snap_VcblDXLuhpigJ8ZeukmR38j2PupJ` | docs/spikes/packager-2026-10-31/README.md | Made Oct 31 on the muse-muse project from the shells at `3e223ea`, no expiry. On Nov 1 it made all three packages for pantry-tally from the admin route (docs/BUILD_LOG.md). The packager code hasn't changed since (`git log native/packager`: last change `5fd89a0f`, Oct 31) |

So the shortest path needs **no EAS build and no Electron build.** Steps 4 to 6 are the fallback if step 2 fails.

## The steps

Run everything from the repo root of a checkout with `.env.local`, unless a step says otherwise. Times are estimates.

### 1. Merge this branch (5 min)

Merge `tg-r3-native-honest` into main and push, which deploys production. Step 7's command needs its admin route change
(`requireAdminOrAutomation`).

### 2. Check the existing packager snapshot still works (5 min, a few cents of sandbox time)

```sh
PACKAGER_SNAPSHOT_ID=snap_VcblDXLuhpigJ8ZeukmR38j2PupJ npx tsx --env-file-if-exists=.env.local scripts/native/package-product.ts \
  --name "Fern & Moss" --url https://example.com/ --kinds android --out /tmp/fern --delete
```

- A pass prints `android: made in ... s` and `android: ... MB, ..., signed with ...`, then `sandbox deleted`.
- It needs the sandbox credentials in `.env.local` for the muse-muse project, since the snapshot lives there.
- `--delete` removes the test APK from Blob afterward. With no Blob credential the file goes to `.data/files` instead.
- If it says the snapshot isn't found, or a checksum doesn't match, do steps 4 to 6 and use the new id.

### 3. Optional: the real Android signing key (5 min)

Without it, APKs carry the repack tool's public debug key. They install, but anyone could sign an update for them. Make the key
once on your own machine and keep it forever, since Android refuses an update signed by another key:

```sh
openssl req -x509 -nodes -newkey rsa:2048 -days 10000 -subj "/CN=Muse Muse" -keyout key.pem -out cert.pem
cat key.pem cert.pem | base64 | tr -d '\n'   # the value for NATIVE_APK_KEYSTORE_B64
```

Keep `key.pem` somewhere safe and out of the repo.

### 4. Fallback only: rebuild the Android and iOS simulator shells with EAS (20 to 45 min each, mostly the free tier's queue)

Only if the Oct 31 build is unusable. The EAS links last until Nov 14, so before Nov 4 they should be. Each build uses 1 of the
free plan's 15 builds per platform this month. A paid build isn't possible on the free plan.

```sh
cd native/shell-mobile
npm install
export EXPO_TOKEN="$(grep -E '^EXPO_TOKEN=' ../../.env.local | cut -d= -f2- | tr -d '"\r')"   # read, never printed; strips quotes
# The production shell. This is the one the packager patches into every product's APK.
EAS_NO_VCS=1 npx eas-cli@latest build --profile production-android --platform android --non-interactive --no-wait
# Only for the device lab (NATIVE_LAB). Not needed for downloads.
EAS_NO_VCS=1 npx eas-cli@latest build --profile lab-android --platform android --non-interactive --no-wait
EAS_NO_VCS=1 npx eas-cli@latest build --profile lab-ios-sim --platform ios --non-interactive --no-wait
```

- The profiles are in `native/shell-mobile/eas.json`. There is no iPhone device build: there is no Apple key, so iPhone is the
  web app on the Home Screen, plus simulator builds for the lab.
- When a build finishes, `npx eas-cli@latest build:view <build id> --json` gives its artifact link. Write the new `id`,
  `artifactUrl`, `sourceCommit`, `createdAt` and `expiresAt` into that profile's entry in `native/releases.json`.
- A new production-android build means a new android template, so do steps 5 and 6 after it.

### 5. Fallback only: build the desktop shells and publish all three templates (15 to 25 min)

`release-shells.ts` builds the Mac universal zip and the Windows x64 folder with electron-builder, downloads the production APK
from the EAS link in `native/releases.json`, uploads all three, and rewrites `lib/native/shells.json` with links and checksums.

```sh
(cd native/shell-desktop && npm install)
npx tsx --env-file-if-exists=.env.local scripts/native/release-shells.ts --via https://www.musemuse.dev
```

- `--via` asks the live site for presigned upload slots (`POST /api/admin/native/shell-upload`), with `AUTOMATION_SECRET` from
  `.env.local`. The live Blob store isn't reachable from a laptop's own token.
- A Mac build only works on a Mac. No Wine is needed for Windows.
- To rebuild only some, add `--only android` (or `mac,windows`). `--no-build` reuses what is already in `native/shell-desktop/dist`.
- Commit the new `lib/native/shells.json`. The templates' checksums change, so the old snapshot no longer matches: do step 6.

### 6. Fallback only: make a new packager snapshot (about 10 min)

```sh
npx tsx --env-file-if-exists=.env.local scripts/native/make-packager-snapshot.ts
```

It prints `PACKAGER_SNAPSHOT_ID=snap_...` at the end. For a change to the packager's code alone, with the same templates,
`--from <old id>` takes about 10 s instead. Run step 2 again with the new id.

### 7. Set the env vars in Production and redeploy (10 min)

From `lib/env.ts` and `lib/native/product-view.ts`. Each with `vercel env add <NAME> production`, which asks for the value:

| Variable | Value | Needed |
|---|---|---|
| `PACKAGER_SNAPSHOT_ID` | `snap_VcblDXLuhpigJ8ZeukmR38j2PupJ`, or step 6's id | Yes. Without it no app is made, and phone and desktop aren't offered |
| `NATIVE_TARGETS` | `phone,desktop` | Yes. The targets the writer and the composer may offer |
| `NATIVE_APK_KEYSTORE_B64` | step 3's base64 | Recommended |
| `NATIVE_APK_KEYSTORE_PASSWORD` | the PEM's passphrase | Only if the key has one (step 3's doesn't) |
| `PUBLIC_SITE_URL` | `https://www.musemuse.dev` | Optional. Production already defaults to it |
| `NATIVE_LAB`, `NATIVE_DEVICE_FARM`, `GLASSES_NATIVE_CHECKS` | leave unset | Only with the AWS lab running (docs/NATIVE_LAB.md) |

Env changes reach only new deployments, so redeploy production after: push to main, or Redeploy on the latest production
deployment in the Vercel dashboard. No builder snapshot is needed for phone and desktop: their template files are written in at
provision (docs/NATIVE.md). Check the composer: the target picker should list Phone and Desktop and no longer show the line
about the packager.

### 8. Test one phone app end to end (10 min, then 45 to 60 min for a fresh build)

**First, package the audit's phone product without a rebuild.** aisle-together's build is `6add62d3-43f5-4be3-a5ff-280d207f7375`.
The route waits for the packager, about 1 to 2 minutes.

```sh
AUTOMATION_SECRET="$(grep -E '^AUTOMATION_SECRET=' .env.local | cut -d= -f2- | tr -d '"\r')"   # strips quotes, as vercel env pull writes them
curl -sS -X POST https://www.musemuse.dev/api/admin/native/package \
  -H "authorization: Bearer $AUTOMATION_SECRET" -H "content-type: application/json" \
  -d '{"buildId":"6add62d3-43f5-4be3-a5ff-280d207f7375"}'
```

- A pass answers `"status":"done"` with an `android` package of about 39 MB. The first `ADMIN_EMAILS` user must have signed in once.
- Open `https://www.musemuse.dev/p/aisle-together`, Get it, Phone. It should show "Download for Android (APK, 39 MB)" and a QR code.
- `curl -sI https://www.musemuse.dev/p/aisle-together/get/android` should answer 200 (a HEAD isn't counted).
- Install it: on an Android phone, scan the QR code and allow installs from the browser. Or on an emulator,
  `adb install <file>.apk`. It has ARM code only, so use an arm64 emulator image, not x86_64. It should open the live product, not a list.

**Then one fresh phone build,** as a test build under the repo's rules (`TEST_MODEL`, made-up data). Pick Phone in the target
picker. After Live, the build room's Apps step should go from "Making the apps" to "Packaged the Android app (... MB)", and the
product's Get it panel should offer the APK. The audit's phone build took 46 minutes.

### 9. Optional: the Expo Go code for the owner (15 min)

```sh
cd native/shell-mobile
APP_VARIANT=production EAS_NO_VCS=1 npx eas-cli@latest update --channel production --message "Shell 1.0.0" --environment production
```

Then set `"productionUpdate"` in `native/releases.json` to the update's group id and date, set `SHELL_UPDATE_PUBLISHED = true` in
`lib/native/shell-links.ts`, and run `npx tsx --test lib/native/__tests__/shell-links.test.ts`, which keeps the two in step. Expo
Go opening the shell (spike S5) has never run, so the first scan is the proof.

### 10. Shorten the long live links (2 min)

```sh
npx tsx --env-file-if-exists=.env.local scripts/backfill-live-urls.ts           # dry run: says what would change
npx tsx --env-file-if-exists=.env.local scripts/backfill-live-urls.ts --apply   # changes products.live_url
```

It moves a product from `musemuse-<slug>-<team>.vercel.app` to `musemuse-<slug>.vercel.app` only when both answer 200 and name
the same deployment. The audit found crumb-ledger-weekly's. It works on the database `DATABASE_URL` names, so run it with
production's. If the dry run ends "0 long links of 0 vercel.app links", it is looking at another database.

## Total

The short path (steps 1, 2, 3, 7, 8 with the repackage, 10) is about 40 minutes, plus about an hour for the fresh build. The
fallback (steps 4 to 6) adds about 1 to 1.5 hours, mostly waiting on the EAS queue.

## Still not proven, whatever happens above

- The production Blob path for packages (`head` on the slot and the streamed hash) has only run against fakes and a local run.
  Step 8's repackage is its first real run.
- No phone has yet installed a v2-only signed APK, and no Windows machine has opened the Windows zip.
- Until step 8 passes, don't say in public that products come as Android, Mac or Windows apps. Say "is built so".

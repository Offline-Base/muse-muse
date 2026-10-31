---
name: muse-native
description: Use only when the brief's "Where it runs" lists Phone or Desktop. How the one web product works inside the Muse Muse phone and desktop apps, with lib/native/bridge.ts for haptics, sharing, the camera and notifications.
---

# Muse Native

## What it is

You build one web product. The platform wraps its live link in thin apps after it ships: an Android app and an iPhone home screen icon for Phone, a Mac app and a Windows app for Desktop. There is no native code to write and no second codebase. What you decide is how the page behaves when it fills a phone or a window.

These are already in the product. Don't remove them:

- `lib/native/bridge.ts`: the calls below.
- `app/manifest.ts`, `app/icon.tsx` and `app/apple-icon.tsx`: the home screen name and icon. The name comes from `musemuse.json`.

## The bridge

Client code only, from a person's action, such as a button's click.

```ts
import { haptic, notify, share, takePhoto } from "@/lib/native/bridge";

await haptic("success");                                       // true, or false when this device can't
const { shared, via } = await share({ title, url });           // the share sheet, or the clipboard
const photo = await takePhoto({ source: "camera", maxSize: 1600 }); // { dataUrl, width, height }, or null when canceled
const shown = await notify({ title: "Your plan is ready", delaySeconds: 60 }); // false when the person said no or this device can't
```

- Every call works in a browser too, through web APIs, so the product needs no second path.
- A missing feature is a result, not an error. Only `takePhoto` and `share` can reject, when the app refuses or fails. Show a plain message and what to try next.
- Never test for the app at module load or save the answer. `window.MuseNative` can appear after your first script on Android, which is why these calls look for it each time.
- Only reach for `nativeApp()` to change wording, like "Add to your phone". Don't build different features on it.
- A photo comes back as a data URL. Send it to your route like any other image, as the meta-reasoning skill shows.

What each place supports:

| | iPhone and Android apps | Mac and Windows apps | Browser |
|---|---|---|---|
| `haptic` | Yes | No, returns false | Where the browser can vibrate |
| `share` | The system sheet | Browser share or clipboard | Browser share or clipboard |
| `takePhoto` | Camera or library | A file picker | A file picker, or the camera on a phone |
| `notify` | Yes, with a delay | Yes, and a delayed one is lost if the app closes | Asks first, and a delayed one is lost if the tab closes. In a phone's browser a delayed one returns false, and some show none at all |

## Phone

- Design at 390x844 first. Nothing should need a bigger screen.
- Add `viewportFit: "cover"` to `viewport` in `app/layout.tsx`, and keep content inside the safe area with `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)`, most of all a bar pinned to the bottom.
- Make every button and link at least 44 px tall and wide.
- Set `appleWebApp: { capable: true, title: "<the product's name>" }` in `metadata`, with the title the brief gives.

## Desktop

- It must work from 900x600 up to a full 1920x1080 screen. Don't stretch a phone column across a wide window: use the room, or center it.
- Make the main flow work with the keyboard: Enter sends, Escape closes, and focus is visible.
- Downloads work from the product's own page, and the person picks where the file goes.

## Both

- Keep the main flow on one page: no `window.open`, no popups, no `target="_blank"` in it. A link off the product's own site leaves the app and opens in the system browser, and only a few may open at a time.
- Sign-ins and pages on other sites don't work inside the app.
- The app asks before the camera, microphone or location, so handle a no with a plain message.
- Save nothing that matters only in memory: people close apps. `localStorage` works in all of them.

## Testing

- The smoke test runs in a browser with no app, so it tests the web fallback. Never assert that a haptic fired or a notification appeared.
- For `takePhoto`, use `page.waitForEvent("filechooser")` around the click, then `fileChooser.setFiles("fixtures/...")`.
- Take at least one judge screenshot at 390x844 when the brief lists Phone: `page.setViewportSize({ width: 390, height: 844 })`.

---
name: product-ui
description: Use for every screen of a Muse Muse product. Covers the Meta-inspired look, layout, uploads, camera input, states, accessibility and the required footer.
---

# Product UI

## Look

- Use the tokens in `app/globals.css` and nothing else for color, radius and type. The look is Meta-inspired: bright blue accent, soft grey page, white cards, rounded pills and generous spacing. Light and dark themes both come from the tokens.
- Never use Meta logos, wordmarks or the Meta name as branding. Keep `components/Footer.tsx`. It says "Built with Muse Muse. Not an official Meta product."
- Name the product with the brief's name. One short headline that says what it does, one primary button.
- Take layout ideas and mood from `inspo/`, but use the tokens for every color and font, and never reuse a logo, name or artwork from it.

## Patterns

The same quiet style as the Muse Muse platform, which sits next to Meta's developer dashboard:

- **Cards:** `--surface` on the `--bg` page, 1 px `--line` border, `--radius-lg`, about 20 to 28 px padding, no shadows.
- **Buttons:** one `button.primary` pill per screen. Secondary actions are text buttons with no fill.
- **Chips:** 12 to 13 px, weight 600, `--pill` radius, `--accent-soft` fill with `--accent-text`. Use them for model credits and short statuses.
- **Tables:** a 1 px border around the whole table with `--radius` corners and clipped overflow, a `--surface-2` header row in bold, about 12 to 16 px cell padding. Wrap wide tables in their own scroll container so the page never scrolls sideways.
- **Big numbers:** a result count or total at about 28 to 36 px bold, with a short muted label under it.
- **Muted meta lines:** 13 to 14 px `--muted` text under a result, like `Took 4 s · 3 birds · estimate`.

## Layout

- Build for phones first (about 390 px wide), then let it widen to a 960 px column.
- Put one primary flow on the first screen: input, then action, then result. Put secondary things below or behind a link.
- Show which Meta model did what with a small chip next to each result, like "Outlined by SAM 3.1" or "Rendered by Muse Image".
- Show the brief's limits next to the result they affect.

## Inputs

| Input | How |
|---|---|
| Photo | `<input type="file" accept="image/*" capture="environment">` for the camera on phones. `resizeImage` from `@/lib/client/resize` (1600 px JPEG, fixes phone rotation), then `blobToDataUrl` from the same file, and send the data URL in your action's JSON body |
| Video | `<input type="file" accept="video/mp4,video/quicktime">`. Upload with `uploadMedia` from `@/lib/client/upload` and send the returned URL. Don't record video with MediaRecorder: it makes WebM, which SAM rejects |
| Audio | `<input type="file" accept="audio/*">`, or record with MediaRecorder. Always convert with `toWav16k` from `@/lib/client/wav` (Muse Voice takes only 16 kHz mono WAV). Up to 1 minute: `blobToDataUrl` and send it in JSON. Longer: `uploadMedia(wav, { fileName: "note.wav" })` and send the URL. See the meta-voice skill |
| PDF | `<input type="file" accept="application/pdf">`. Up to 2 MB: `blobToDataUrl`. Bigger: `uploadMedia` |
| Text | A labeled textarea with an example placeholder taken from the fixtures |

Vercel Functions accept at most 4.5 MB per request body, and base64 adds a third. Anything bigger goes through `uploadMedia`, which sends the file straight to storage through `app/api/upload/route.ts` (leave that route as it is) and returns a public URL the models can read for 24 hours.

### Recording audio

```ts
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const recorder = new MediaRecorder(stream);
const chunks: Blob[] = [];
recorder.ondataavailable = (e) => chunks.push(e.data);
recorder.onstop = async () => {
  stream.getTracks().forEach((t) => t.stop());
  const wav = await toWav16k(new Blob(chunks, { type: recorder.mimeType }));
  // send wav as above
};
```

Always offer a file input next to the record button: the smoke test uses the file input with a fixture, because a headless browser has no microphone.

## States

Every async action needs four states:

1. **Idle**, with a sample the user can try in one tap, using the fixtures.
2. **Working**, with a progress message that names the step, like "Finding the wall..."
3. **Done**, with the result and a way to start over.
4. **Error**, saying what went wrong in plain words and what to try next.

## Accessibility

- Every control has a visible label.
- Focus states are visible, and contrast passes WCAG AA in both themes.
- Results that are images need alt text. Overlays need a text summary too, like "Found 3 birds".
- Respect `prefers-reduced-motion`.

## Copy

Write plainly and name things the way a user would. Buttons say what happens, like "Find the wall" or "Make the cut list". Avoid jargon such as "inference", "segmentation mask" or "tokens" unless the brief's users are developers.

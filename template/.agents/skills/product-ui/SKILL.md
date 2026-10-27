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

## Layout

- Build for phones first (about 390 px wide), then let it widen to a 960 px column.
- Put one primary flow on the first screen: input, then action, then result. Put secondary things below or behind a link.
- Show which Meta model did what with a small chip next to each result, like "Outlined by SAM 3.1" or "Rendered by Muse Image".
- Show the brief's limits next to the result they affect.

## Inputs

| Input | How |
|---|---|
| Photo | `<input type="file" accept="image/*" capture="environment">` for the camera on phones. Resize in the browser to about 1600 px on the long side as JPEG with `resizeImage` from `@/lib/client/resize` before sending |
| Video | `<input type="file" accept="video/mp4,video/quicktime">`. Upload with `uploadMedia` from `@/lib/client/upload`. Don't record with MediaRecorder, because it makes WebM, which SAM rejects |
| Audio | `<input type="file" accept="audio/*">`, uploaded with `uploadMedia` |
| Text | A labeled textarea with an example placeholder taken from the fixtures |

Vercel Functions accept at most 4.5 MB per request body. Anything bigger goes through `uploadMedia`, which sends the file straight to storage and returns a URL.

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

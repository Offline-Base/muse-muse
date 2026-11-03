# Look: journal

A literary journal on cream paper. Light display type that gets authority from tight tracking rather than weight, a serif for subheads and long text, sharp corners, and one ember color for links and emphasis. It suits writing, reading, research summaries, and anything people read slowly.

## Palette
- Light: background `#f8f5ee`, surface `#fffdf8`, text `#1d1b17`, mutedText `#6a645a`, accent `#1d1b17` (ink-filled primary buttons) with onAccent `#fffdf8`, secondary `#b93c0b` (ember: links, highlighted words, the active tab underline).
- Hairline `#e2ddd2`. Soft warm shadow only on menus: `0 8px 24px rgba(60, 45, 20, 0.10)`.

## Type
- Display and UI: `@fontsource-variable/onest` (family "Onest Variable") at 300 to 400, tracking tightening to -0.03em on large sizes.
- Subheads and prose: `@fontsource-variable/newsreader` (family "Newsreader Variable") at 400, italic for quotes.
- Labels and metadata: `@fontsource-variable/jetbrains-mono` in small caps style, wide tracking.

## Parts
- Corners 4 px on every control and card.
- Buttons: ink-filled rectangles; links in ember with an underline on hover.
- Cards: hairline only, generous padding; a pull quote or a drop cap may open the result.
- Long text: max 68 characters a line.

## Motion
Quiet: fades and underline sweeps at 180 ms.

## Do
- Treat the result like a printed page: margins, a byline-style meta line, a clear reading order.

## Don't
- No bold display headlines, no rounded pills, no colored backgrounds behind sections.

# Look: research-desk

A scholar's desk behind clean glass. Parchment ground, calm sans type with generous line height, one restrained teal for navigation and active states, and the main input as the most important object on the screen. It suits search, question answering, research agents and anything with sources.

## Palette
- Light: background `#f9f7f3`, surface `#ffffff`, text `#22201c`, mutedText `#69655d`, accent `#0f6f68` with onAccent `#ffffff`, secondary `#8a6a32` (source and citation marks).
- Hairline `#e7e3dc`.

## Type
- Display and body: `@fontsource-variable/manrope` (family "Manrope Variable") at 500 for headings and 400 for text, line height 1.6.
- Citations and source chips: the same face at 12 px, or `@fontsource/ibm-plex-mono` for ids.

## Parts
- The input: a large white field with 16 px corners and a soft 1 px border, centered on the start screen, with example questions as pill chips under it.
- Answers: plain text blocks with numbered citation chips inline; a sources list as compact cards with the site name, title and one line.
- Cards: 16 px corners, hairline, no shadow; ghost buttons; pill chips for filters.

## Motion
Calm: a soft shimmer line while the answer streams, 200 ms fades.

## Do
- Keep density high in the answer, low around the input.
- Show where every claim came from.

## Don't
- No hero images, no gradients, no more than one accent.

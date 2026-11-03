# Look: typeset

A terminal printed on paper. Monochrome ink on near-white, hairline borders, and type doing all the work. It suits developer tools, logs, dashboards of numbers, and anything that should feel precise.

## Palette
- Light: background `#f7f7f5`, surface `#ffffff`, text `#161616`, mutedText `#5c5c5a`, accent `#161616` with onAccent `#ffffff`, secondary `#2e6b46` (small green highlights only), hairline `#e4e4e1`.
- Dark: background `#0f0f0f`, surface `#1a1a1a`, text `#ededeb`, mutedText `#a3a3a0`, accent `#ededeb` with onAccent `#111111`, secondary `#7fc79a`, hairline `#2a2a2a`.
- Depth comes from tone (page, then card, then an inverted ink panel), never from shadows.

## Type
- Display and body: `@fontsource-variable/geist` (family "Geist Variable"). Headlines at weight 450 to 500 with tracking around -0.04em; never bold for size alone.
- Labels, metadata, code and numbers: `@fontsource/geist-mono` (family "Geist Mono"), 11 to 13 px, uppercase eyebrows with +0.06em tracking.

## Parts
- Buttons: solid ink rectangles with 6 px corners for the one primary action; ghost buttons with a 1 px hairline for the rest.
- Cards: 1 px hairline border, 8 px corners, no shadow. An inverted ink card for the result or a terminal-style output panel in mono.
- Lists and tables: hairline row dividers, mono numbers right-aligned, compact 4 px grid.
- Charts: one ink series, the green only for the highlighted value.

## Motion
Short and functional: 120 to 160 ms fades and a blinking caret while a model writes. Nothing bounces.

## Do
- Let empty space and type size carry hierarchy.
- Use mono for anything a machine produced: ids, timings, counts.

## Don't
- No gradients, no colored panels, no rounded pills everywhere, no shadows.

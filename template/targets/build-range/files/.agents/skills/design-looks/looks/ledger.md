# Look: ledger

A finance desk in black and white with one highlighter. Near-monochrome pages, flat hairline cards, big plain numbers, and a single vivid yellow-green that appears only where action happens or money moves. It suits budgets, expenses, sales, inventory and any product built around numbers.

## Palette
- Light: background `#f6f5f1`, surface `#ffffff`, text `#121212`, mutedText `#5d5c58`, accent `#d4ec3a` (highlighter) with onAccent `#121212`, secondary `#121212`.
- Hairline `#e3e1db`. The highlighter also marks live counters and the active row, always with dark text on it.

## Type
- Display and body: `@fontsource-variable/archivo` (family "Archivo Variable") at 400 everywhere, display at 56 to 64 px with line height 1.0.
- Small uppercase labels with +0.08em tracking. Numbers use tabular figures.

## Parts
- Buttons: highlighter-filled rectangles with 6 px corners for the main action, ink outlines for the rest.
- Cards: white, hairline, 12 px corners, no shadow.
- Figures: one big number per card, its label above in small caps, the change beside it.
- Tables: dense rows, right-aligned tabular numbers, the total row on a highlighter tint.

## Motion
Utility only: counters tick up, rows highlight briefly when updated.

## Do
- Make the one highlighted thing on a screen the thing to act on.

## Don't
- Never use the highlighter for decoration or large areas. No shadows, no gradients, no second accent.

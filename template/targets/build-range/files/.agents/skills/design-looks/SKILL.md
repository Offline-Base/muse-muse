---
name: design-looks
description: Read when the brief's Design direction summary starts with "Look:". Eight worked looks, each with its palette for light and dark, a type pairing from @fontsource, the parts restyled, motion, and what to avoid. The direction in brief.md always wins where they differ.
---

# Design looks

Each file in `looks/` is one complete look: how it feels, its palette, its type, how the shared parts are restyled, and its do's and don'ts. They are starting points written for Muse Muse, not copies of any real product: never name a real company, and never copy a real product's logo, wording or exact screens.

## How to use one

1. Read the Design direction in `brief.md`. If its summary starts with `Look: <name>`, open `looks/<name>.md`.
2. The direction's palette and fonts win. Use the look's file for everything the direction doesn't say: how cards, buttons, inputs, lists, charts and the result surface are drawn, the spacing rhythm, motion, and the do's and don'ts.
3. Set every value through the tokens in `app/muse-app.css`, for light and dark. Keep the parts, the four states, labels, focus rings, 44 px targets and the footer from muse-app-ui and product-ui.
4. Finish each screen with Muse Code's `taste` pass. Where it disagrees with the look, the look wins.

## The looks

| Name | One line | Scheme |
|---|---|---|
| `typeset` | A terminal printed on paper: monochrome, hairlines, mono labels | light or dark |
| `notebook` | A warm paper notebook: soft cards, one blue action, sticky-note panels | light |
| `journal` | A literary journal: cream paper, light display type, serif subheads, sharp corners | light |
| `research-desk` | A calm research desk: parchment, one teal, the main input as the centerpiece | light |
| `ledger` | A finance ledger: black and white pages and one highlighter color where action happens | light |
| `voltage` | Forest and lime: heavy display type, pills, sections that flip dark | both |
| `classroom` | A storybook classroom: chunky rounded type, thick outlines, a "correct" green | light |
| `showcase` | A white gallery: the product's output huge in the middle, quiet type around it | light |

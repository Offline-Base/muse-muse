---
name: recipe-visual-reports
description: Use for a chart explainer, research that becomes slides, a polished marketing page checked by screenshots, or a photo with clickable points placed on what the model sees.
---

# Visual reports

Product code and tests name `muse-wonder-1.0` and nothing else: a test build runs those calls on a cheaper model by itself, and a token refuses that model by name. The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

## 03/01 Chart explainer

Build: upload a chart screenshot, and get a plain explanation and a clean summary drawn by the product.

1. `respondJson` with an image part returns `{ title, axes, values: [{ label, number, unit }], points: string[] }`.
2. A second pass gets the image and those numbers and returns only the ones it can't confirm. Mark each of those "Check this" in the page.
3. Code draws the summary from the JSON. Never ask the model for chart pixels.

Instructions and copy **explain and never advise**: no buy, sell or "you should", and the page says that this isn't financial advice. Say when numbers were read from an image, so they may be off. Check: a sample chart made at build time, with known values the test compares. Limit: dense or low-resolution charts read poorly.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/01_chart-explainer

## 03/04 Research to slides

Build: a topic becomes a slide deck with sources.

1. Call `web_search` directly (`tools: [{ type: "web_search" }]`), asking for 3 to 5 angles. Collect sources as in the search section of `recipe-api`.
2. `respondJson` turns the research into an outline: `{ title, slides: [{ title, bullets, sources }] }`. Code checks that each source URL is one the search returned, and drops any other.
3. Render slides from the outline in React. That is the default, and it's safe.
4. A model-written design is optional. If used, show model HTML **only** in `<iframe sandbox="allow-scripts" srcdoc=...>` with no `allow-same-origin`, and add a meta CSP that blocks network access. Never inject it into the product's own page. Load no remote scripts, so there's no reveal.js from a CDN.

Check: the outline test with one invented source URL, and an iframe test that the `sandbox` attribute has no `allow-same-origin`. Limit: this doesn't export PPTX unless the brief adds it, and research is only as good as what search returned.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/04_doc_generation

## 03/05 Web design

The recipe's look-and-fix loop is already what the build does: `verify` and the judge take the place of a browser MCP. Add these to the smoke test:

- A desktop-size screenshot at 1440 x 900, as well as the phone size.
- A mouse-path probe: move the mouse across the main sections with `page.mouse.move(x, y, { steps: 20 })`, and take a screenshot partway through, to prove that hover and scroll effects run with no errors.
- A check for no horizontal scroll at either size.

Limit: the page uses the product's platform look, unless the brief's `askedLook` says otherwise.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/05_web_design

## 03/10 Points on a photo

Build: upload a photo, and get dots placed right on each item, with a card for each.

- `respondJson` returns `{ items: [{ name, x, y, note }] }`, with `x` and `y` integers on a **0 to 1000 grid** across the image, where (0, 0) is the top left.
- Reject anything outside 0 to 1000 in the schema.
- Code draws the dots and tooltips over the image with `@/lib/client/overlay`: `toPercent(item, { units: "1000" })` for each dot, so it stays right at any size. If the schema also has a box per item, draw it with `toRect(box, { units: "1000", to: natural })` in an `svg.overlay` with `viewBox={viewBox(natural)}`, the same units as the dots. Never divide or scale by hand, and never ask the model for HTML here.
- Each dot is a button at least 44 x 44 px to tap on a phone (a small drawn dot with a larger clear ring). Tapping one scrolls its card into view and focuses it (product-ui, Layout).
- Keep tooltips inside the image frame near its edges.

If the notes touch on food or health, the page says "General information, not medical advice", and never tells a person what to eat for a condition. Check: unit tests for the schema and position math, including `assert.deepEqual(overlayProblems(natural, shapes), [])` on the sample's real output, so each box's center lands inside the image and near its dot; and a screenshot on a sample image. Limit: points are approximate. Use SAM only when exact outlines matter (`meta-sam`).
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/10_perception_grounding

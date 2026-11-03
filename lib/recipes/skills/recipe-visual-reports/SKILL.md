---
name: recipe-visual-reports
description: Use for a chart explainer, a bug found from a screenshot and fixed on a bundled page, research that becomes slides, a polished marketing page checked by screenshots, or a photo with clickable points placed on what the model sees.
---

# Visual reports

Product code and tests name `muse-wonder-1.0` and nothing else: a test build runs those calls on a cheaper model by itself, and a token refuses that model by name. The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

**Every image a model sees is a PNG, JPEG or WebP.** Meta's API refuses `data:image/svg+xml`. A sample drawn as SVG goes through `svgToPng` from `@/lib/client/raster` when that file is in the product; otherwise draw it on a canvas and send `canvas.toDataURL("image/png")`, or save a PNG at build time with Playwright. Samples live in `public/samples/`, and the smoke test clicks the page's own "Try the sample" control.

## 03/01 Chart explainer

Build: upload a chart screenshot, and get a plain explanation and a clean summary drawn by the product.

1. `respondJson` with an image part returns the reading. Name the **series and categories first** (which bars or lines belong together, and whether the x axis is time), then the values. For a price chart, use Meta's fields: `{ instrument, timeframe, trend: "up" | "down" | "sideways", keyLevels: [{ type: "support" | "resistance", value }], pctChangeVisible, notableEvents, unreadable }`. Otherwise `{ title, axes, series, values: [{ series, label, number, unit }], points: string[] }`. A value it can't read is `null` and named in `unreadable`, never a guess.
2. A second pass gets the image and those numbers and returns only the ones it can't confirm. Mark each of those "Check this" in the page.
3. Code draws the summary card from the JSON (trend badge, level pills, event chips, the chart beside it). Never ask the model for chart pixels, and never use an image model here.
4. Compare values **only within one series**, and call a change over time only when the x axis is time. The Nov 3 audit's explainer named "South Q1 against North Q3" its biggest mover.
5. Follow-up questions send the same image and the saved JSON, so a drill-down answers about this chart.

Instructions and copy **explain and never advise**: no buy, sell, predictions or "you should", and the page says that this isn't financial advice. Say when numbers were read from an image, so they may be off.

**The sample proves every step.** Draw it in code as a PNG with printed labels, so each field has a known answer: a title, axis labels, a printed change or total, two labeled levels or a legend with two series, and one deliberately faint value that the check pass should flag. A sample with no printed total can't show a totals check. The test compares the reading with the known values and asserts that the faint one is marked "Check this". Limit: dense or low-resolution charts read poorly.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/01_chart-explainer

## 03/02 Screenshot bug fix on a bundled page (no Muse Code)

Build: a small made-up web page with a visible layout bug ships with the product, plus a screenshot of the bug. The model reads the screenshot and the page's source, names the cause and proposes a fix; code applies it and proves it.

1. Write the sample page fresh (HTML and CSS, a few hundred lines at most) with one real bug a person can see at 390 x 844, like a sticky footer covering the main button. Mark the parts the check measures with `data-check` attributes. Save the bug's screenshot at build time with Playwright to `public/samples/`.
2. One `respondJson` call with the screenshot and the files returns `{ symptom, reproSteps: string[], cause, edits: [{ file, find, replace }] }`. Code applies an edit only when `find` occurs exactly once in that file, and refuses edits to anything outside the page's files. A refused edit goes back to the model once with the reason.
3. Show before and after side by side in `<iframe sandbox="allow-scripts" srcdoc=...>` at 390 px wide, with no `allow-same-origin`. A small probe script the product adds (never the model) measures the `data-check` boxes and posts them with `parent.postMessage`. The page checks `event.source`, then says Fixed only when the probe shows no overlap and the button inside the frame. The model's claim never decides it.
4. Show the cause, the steps, a unified diff and a download of the fixed files. The person may paste their own small page and screenshot instead of the sample.

Check: unit tests for the edit rules (zero or two matches refused) and for the overlap math, and a smoke test where the sample goes from "covered" to "Fixed". Limit: one small page, not a monorepo, and nothing runs but the page in a sandboxed frame. With the code cap, `recipe-code-sessions` runs the full recipe in a workspace instead.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/02_screenshot_bugfix

## 03/04 Research to slides

Build: a topic becomes a slide deck with sources.

1. Call `web_search` directly (`tools: [{ type: "web_search" }]`), asking for 3 to 5 angles. Collect sources as in the search section of `recipe-api`.
2. `respondJson` turns the research into an outline: `{ title, slides: [{ title, bullets, sources }] }`. Code checks that each source URL is one the search returned, and drops any other.
3. Render slides from the outline in React. That is the default, and it's safe.
4. A model-written design is optional. If used, show model HTML **only** in `<iframe sandbox="allow-scripts" srcdoc=...>` with no `allow-same-origin`, and add a meta CSP that blocks network access. Never inject it into the product's own page. Load no remote scripts, so there's no reveal.js from a CDN.

**It is a deck, not a page of cards.** One slide fills the stage at a time, with Previous and Next buttons, the arrow keys, and "3 of 6". Each slide shows its own numbered sources. Download is one self-contained HTML file with the slides, their sources, inline CSS and a few lines of inline script that page with the arrow keys, and print CSS that puts one slide on each page. Beside the deck, show the run's stats as Meta's recipe does: the queries searched, the sources kept, tokens and time.

Open on a sample deck from one real run in the smoke test, saved with its date and labeled as a sample, so looking costs nothing. Check: the outline test with one invented source URL, an iframe test that the `sandbox` attribute has no `allow-same-origin`, and a smoke test that the arrow key moves to slide 2. Limit: this doesn't export PPTX unless the brief adds it, and research is only as good as what search returned.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/04_doc_generation

## 03/05 Web design

The recipe's look-and-fix loop is already what the build does: `verify` and the judge take the place of a browser MCP. Add these to the smoke test:

- A desktop-size screenshot at 1440 x 900, as well as the phone size.
- A mouse-path probe: move the mouse across the main sections with `page.mouse.move(x, y, { steps: 20 })`, and take a screenshot partway through, to prove that hover and scroll effects run with no errors.
- A check for no horizontal scroll at either size.

ASCII art goes in a `<pre>` with a monospace font and a fixed line height, so spaces survive (the recipe's first draft lost them). A cursor effect such as scattering letters checks in the test that some characters moved partway along the mouse path and settled back after it left. On touch screens a tap or drag runs the same effect, and `prefers-reduced-motion` turns it off. Limit: the page uses the product's platform look, unless the brief's `askedLook` says otherwise.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/05_web_design

## 03/10 Points on a photo

Build: upload a photo, and get dots placed right on each item, with a card for each.

- `respondJson` returns `{ items: [{ name, x, y, note }] }`, with `x` and `y` integers on a **0 to 1000 grid** across the image, where (0, 0) is the top left. Meta's fridge recipe also asks for a score out of 10, green or red, and rough calories, carbs, protein and fat for each item.
- Reject anything outside 0 to 1000 in the schema.
- Code draws the dots and tooltips over the image with `@/lib/client/overlay`: `toPercent(item, { units: "1000" })` for each dot, so it stays right at any size. If the schema also has a box per item, draw it with `toRect(box, { units: "1000", to: natural })` in an `svg.overlay` with `viewBox={viewBox(natural)}`, the same units as the dots. Never divide or scale by hand, and never ask the model for HTML here.
- If `@/lib/client/overlay` isn't in the product, write one tested function in `lib/overlay.ts` that turns 0 to 1000 into percent (`v / 10`), and use it for every dot and box. One unit system per layer: the Nov 3 audit's fridge divided by 10 inside a 0 to 1000 viewBox, so every box drew at a tenth of its size. Don't ask for boxes unless the note does.
- Each dot is a button at least 44 x 44 px to tap on a phone (a small drawn dot with a larger clear ring). Tapping one scrolls its card into view and focuses it (product-ui, Layout).
- Keep tooltips inside the image frame near its edges.
- A download is one self-contained HTML file: the photo inlined, the dots, the score labels and the tooltips, as the recipe's output is.

If the notes touch on food or health, the page says "General information, not medical advice", and never tells a person what to eat for a condition. The samples are realistic photos, never drawings, with every item in plain view. Check: unit tests for the schema and position math, including `assert.deepEqual(overlayProblems(natural, shapes), [])` on the sample's real output (a check of your own that does the same when the helper isn't there), so each box's center lands inside the image and near its dot; and a screenshot on a sample image. Limit: points are approximate. Use SAM only when exact outlines matter (`meta-sam`).
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/10_perception_grounding

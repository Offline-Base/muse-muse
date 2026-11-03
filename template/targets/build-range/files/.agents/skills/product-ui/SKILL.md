---
name: product-ui
description: Use for every screen of a Muse Muse product, together with muse-app-ui. Covers layout, uploads, camera input, states, model output, accessibility, copy and the required footer. How things look comes from the brief's Design direction.
---

# Product UI

## Look

- The Design direction in `brief.md` sets how every screen looks. Set the tokens in `app/muse-app.css` from it, use the parts in `.agents/skills/muse-app-ui`, and add your own CSS. Light and dark mode come from the tokens.
- Signature elements and decoration follow the direction, and never reuse inspo artwork.
- Never use Meta logos, wordmarks or marks, or the Meta name as branding. Keep `components/Footer.tsx`. It says "Built with Muse Muse. Not an official Meta product."
- If the Design direction's summary starts with `Look: <name>`, read `.agents/skills/design-looks/looks/<name>.md` before you design: it holds that look's parts, spacing, motion and do's and don'ts. The direction's palette and fonts still win.
- Take layout ideas and mood from `inspo/`, and let the mood show in colors, fonts and decoration. Never reuse a logo, name or artwork from it.
- Before you call a screen done, use Muse Code's built-in `taste` skill (`/taste`) on it as a last pass: its checklist strips the defaults that make a UI look machine-made, such as a centered hero with a headline and two buttons, three identical feature cards, a stack of decorative gradients, and the same large radius on everything. The Design direction is the brand, and `taste` defers to a stated brand, so where they disagree the direction wins. If `taste` isn't installed, check the screen against that list yourself.

## Patterns

Every part below is a class in `app/globals.css` or a component in `components/`. Use them where they fit, restyled through tokens and CSS. The behavior rules hold however they look.

- **Page:** by default `<AppBar name="..." />`, then `<main className="stack">` with a `<header className="hero">` holding the `h1` and maybe a `.tagline`, then `.card` sections. The direction can change this shape.
- **Fields:** a `.field` holds a label, the control and a `.hint`. Two fields side by side only inside `.fields.two`, which stacks on phones so a long label never pushes its input out of line.
- **Buttons:** the roles are in muse-app-ui's Parts table; Start over lives only in the app bar. Icon-only actions are `button.icon` with an `aria-label`. Never a bare `<a>` or an unstyled `<button>` as an action.
- **Chips:** `<ModelChip model="sam-3.1" verb="Outlined" />` for model credits, `.chip` for short statuses, `.tag` for feature labels like "2 players", so features never look like model credits. `.ai-badge` labels an image a model made, where the card's ModelChip can't.
- **Tables:** `.table-wrap` around every table. It scrolls sideways inside itself. Never put `overflow: hidden` on a table's box. On phones keep a table to 3 columns, use `.kv` for label and value pairs, and `.rows` for rows the person edits (muse-app-ui).
- **Big numbers:** `.big-number` with a `.meta` line under it, like `Took 4 s · 3 birds · estimate`. Only for a result's main figure, never for a count that is still 0.
- **Model text:** ask for JSON fields and lay them out. A reply with parts (wins, themes, next steps) is one field per part, under `h3` headings or in a `.list`, never one string. When a reply is prose that may hold markdown or code, render it with `<Markdown text={...} />`, never as raw text with `#`, `**` or backticks showing; under a card's h2, pass it as `title` so a first heading that repeats it is left out. Model text the person may edit shows rendered first, with a `.secondary` Edit button (edit icon) that swaps in the textarea; never lead with raw markdown.
- **Notes and errors:** `.note` for a tip, `.error` with `role="alert"` for a failure, `.limits` for a short list of limits, `.empty` when a list or history has nothing in it yet. Once there is a result, leave out a list that is still empty.
- **Overlays:** place every dot, box and mask over an image with `@/lib/client/overlay`, never with your own math. Name the model's units once: `"1000"` for a 0 to 1000 grid, `"1"` for fractions, `"px"` with the size you sent for SAM's boxes. Then convert to the image's natural size with `toPoint`, `toRect` and `maskTransform`, in an `svg.overlay` with `viewBox={viewBox(natural)}`; dots that are HTML buttons use `toPercent`. Dots, boxes and masks go through the same space, so nothing is scaled twice. Add a unit test on the sample's real output: `assert.deepEqual(overlayProblems(natural, shapes), [])` checks that each box's center is inside the image and near its dot.
- **Tabs:** `<Tabs label="Run views" tabs={[{ id: "live", label: "Live" }, ...]} value={tab} onChange={setTab}>{view}</Tabs>` for views of one screen. Its tabs wrap to a second row on a phone, so all of them show at 390 px. Views that are their own pages use `<nav className="tab-bar">` with `aria-current="page"` on the current link. Never a tab bar of your own that scrolls sideways or runs off the screen, and keep each label to a word or two.
- **Saving:** media and big data (photos, versions, audio, clips, a long run's record) go in IndexedDB through `mediaStore` from `@/lib/client/media-store`, stored as Blobs, never as data URLs and never in localStorage: localStorage holds about 5 MB for the whole site, and a full one throws. `put` never throws and removes the oldest first; pass the item on screen in `keep`, and show a `.note` when it removed something or couldn't save. Small state (settings, checked items, ids) uses `saveSmall` and `loadSmall` from the same file. Save from an event handler or an effect, never inside a state updater, so a failed save can't take the page down.
- **Clear, delete and reset:** `<ConfirmButton label="Clear saved run" question="Clear this run?" detail="Its groups go too." onConfirm={clear} />`, a small `.text` button that always asks first in a dialog. Every clear, delete and reset in the product confirms the same way. Put it once, next to what it throws away, or in the app bar's action. Never a full-width or filled button, and never repeated on every page.
- **Cost and usage:** one `<UsageStrip usage={{ costUsd, input, output, cached }} />` under the result, with the totals for that result. It holds the cost, and the tokens and cached tokens when the brief asks for them. It is the only place cost shows: never a cost card, a second cost line or a cost in a heading. AgentRun's own cost line gives way to it by itself; to keep AgentRun's line instead, pass it `usage={{ input, output, cached }}`. Add up `input_tokens`, `output_tokens` and `input_tokens_details.cached_tokens` from each reply's `usage` in code. Format any other money on the page with `formatUsd` from the same file, so two numbers never round differently.

## Layout

- Build for phones first (about 390 px wide), and use the width the direction calls for on a desktop: panes, boards and wide tables are fine. Nothing may scroll the whole page sideways at any size.
- The product's name from the brief shows at the top. No model chips or cost before there is a result.
- Make the main flow easy to reach from the first screen. A landing section or dashboard can lead when the direction says so. It doesn't limit the product to one flow: every other flow and screen the brief lists gets its own place, one tap away.
- When a result arrives, scroll it into view and move focus to its heading: `resultRef.current?.scrollIntoView({ block: "start" })`. The demo video is 1280 x 720, so a result below the fold is a result nobody sees.
- When the person selects something (a dot, a row, a card) whose detail shows somewhere else on the page, do the same: `detailRef.current?.scrollIntoView({ block: "nearest" })`, then focus the detail's heading (give it `tabIndex={-1}`). On a phone, a detail under a long list is a detail nobody sees, so better still, show it right under what was tapped. The smoke test taps one at 390 x 844 and checks `await expect(detailHeading).toBeInViewport()`. A detail doesn't loosen the height rule below.
- Show each thing once. Above a result, a form that only starts one run becomes its summary row with an Edit button (muse-app-ui), with a photo as a `.thumb`, unless the product compares before and after: then the source is the same size as each result, in a `.gallery`. Show each number once. Put long extras (a full transcript, raw text, more tables) in `<details>`. Verify fails a last screen over 12,000 px tall on a phone.
- Show which model did what with one `ModelChip` in each result's `.card-head`, like "Outlined by SAM 3.1" or "Rendered by Muse Image", on a `.card.ai`. Only on output that model really made: never on a fallback, a sample or text the app wrote itself. After each check the platform holds every ModelChip and every "by <model>" line up against the models the gateway saw the smoke test call. A credit for a model it never saw fails the check, so call that model for real in the flow the smoke test runs, or drop the credit. A chip for muse-wonder-1.0 names the model that really serves it, so credit Muse Wonder only with the chip, never in plain words.
- Show each of the brief's limits that a user would run into once, next to the result it affects.

## Inputs

| Input | How |
|---|---|
| Photo | `<FilePicker label="Photo of your receipt" accept="image/*" button="Take or choose a photo" file={file} onFile={setFile} />`. Phones offer the camera and the photo library. Add `capture="environment"` only when it must be a new photo, and then say "Take a photo". `resizeImage` from `@/lib/client/resize` (1600 px JPEG, fixes phone rotation), then `blobToDataUrl` from the same file, and send the data URL in your action's JSON body |
| A screen the product draws | A canvas, an SVG or a simulated screen goes to a model as PNG: `canvasToPng(canvas)` or `await svgToPng(svg, { width, height })` from `@/lib/client/raster`. Meta refuses `data:image/svg+xml`, so a model call with an SVG fails in about a second. Check with `imageProblem(url)` before sending |
| Video | `<FilePicker accept="video/mp4,video/quicktime" ... />`. Upload with `uploadMedia` from `@/lib/client/upload` and send the returned URL. Don't record video with MediaRecorder: it makes WebM, which SAM rejects |
| Audio | `<FilePicker accept="audio/*" ... />`, or record with MediaRecorder. Always convert with `toWav16k` from `@/lib/client/wav` (Muse Voice takes only 16 kHz mono WAV). Up to 1 minute: `blobToDataUrl` and send it in JSON. Longer: `uploadMedia(wav, { fileName: "note.wav" })` and send the URL. See the meta-voice skill |
| PDF | `<FilePicker accept="application/pdf" ... />`. Up to 2 MB: `blobToDataUrl`. Bigger: `uploadMedia` |
| Text | A labeled textarea. The placeholder hints at the format in a few words, like "One item per line, with prices", and a one-line field's stays under about 32 characters. It is never the sample: the sample goes in with the Try the sample button, so the start screen and the filled screen look different |
| Date | Prefill a sensible default so the field never shows mm/dd/yyyy, and keep it in step with the result |
| Choice | `<Segmented>` for two to five options of a word or two: it lays them out to fit. A `select` for more, with option labels under about 30 characters, since a select can't wrap |

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

1. **Idle**, with a "Try the sample" button that fills the input from the fixtures in one tap.
2. **Working**: the result card appears at once with a `.working` line that names the step, like "Finding the wall…", and a `<Skeleton>` shaped like the result (muse-app-ui shows it). Give every busy button `aria-busy="true"` and end its label with "…" until it finishes; judgeShot waits for every `aria-busy` to clear.
3. **Done**, with the result and a way to start over. Clear or redo anything that depends on input that changed (a chart, a summary), so nothing on screen is stale.
4. **Error**, in an `.error` box with `role="alert"`, saying what went wrong in plain words and what to try next. If a model call fails, show this state, never canned text dressed up as the model's.

## Model output

The model's work is the reason the product exists, so make it specific and checkable.

- Send the model every piece of the user's data the answer depends on, and ask for specifics with `.describe()`: name the items, numbers and dates from the input. A habit nudge mentions the habit that is behind; a recap groups what was done.
- Do arithmetic, dates, counts, scaling and sorting in code. Use the model to read, write, judge and explain. Turn "tomorrow" or "Friday" into real dates in code.
- Ask for figures as number fields (startWeek, endWeek, page) and format them in code. Never build display text by stripping characters from model text, and never prefix a model field with a label it may already contain ("Week 2: Week 2").
- Never show a model's own confidence as a percentage. Use High, Medium or Low, or leave it out. Never show a verdict from too little data without saying so.
- Mark anything the model added that the user didn't give (a yield, a cook time, a tip) as a suggestion.
- When the model returns a value for something the person can edit (a speaker's name, a title, a tag, a due date), put it in that field as the starting value, marked as a suggestion they can change. Never leave the field empty while the model's value goes unused.
- Keep internal fields out of the UI: summaries for the next step, image prompts, boxes, indexes, debug lines.
- Keep a primary button disabled until its required input is there, and an AI button until there is enough for a useful answer.

## Accessibility

- Every control has a visible label.
- Every primary control is at least 44 x 44 px to tap at phone size: buttons, icon buttons, dots and pins on an image, and links that move between screens. Grow a small dot's tap area with padding or a clear ring rather than drawing it bigger, and keep tap areas from overlapping. A link inside a sentence is exempt.
- Focus states are visible, and contrast passes WCAG AA in light and dark mode. Keep text on the token pairs muse-app-ui lists.
- On a phone every control is at least 44 by 44 px: buttons, fields, selects, checkbox and radio rows, and any link that stands on its own, like a nav link, "Change it" or a title that opens a page. judgeShot fails a smaller one. A small dot, pin or icon keeps its look inside a 44 px box with padding and `background-clip: content-box`, as `button.icon` does. A link inside a sentence is fine. Put nav links in a `<nav>`, which `app/globals.css` sizes.
- judgeShot also measures each text color against what is behind it, and fails text under 4.5:1 (3:1 from 24 px, or 18.66 px bold). Text over a photo or a gradient is yours to check. When you change a part's background, change its text color with it: the person's chat bubble takes `--bubble-out` and `--on-bubble-out` together, never a new background alone.
- Results that are images need alt text. Overlays need a text summary too, like "Found 3 birds".
- Respect `prefers-reduced-motion`.

## Copy

Write plainly and name things the way a user would. Buttons say what happens, like "Find the wall" or "Make the cut list". Avoid jargon such as "inference", "segmentation mask", "tokens", "localStorage" or "JSON" unless the brief's users are developers. Follow "Product copy" in AGENTS.md: nothing about how the product was made, no em dashes, each limit once.

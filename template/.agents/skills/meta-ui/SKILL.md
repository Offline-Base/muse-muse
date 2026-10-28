---
name: meta-ui
description: Use for every screen of a Muse Muse product. The Meta design language this template ships (Facebook's product tokens, Inter and Montserrat, the parts in app/globals.css and components/) and the patterns to build each screen from, with dark mode and accessibility.
---

# Meta UI

Every product should look like it belongs in Meta's family of apps: a gray page, flat white cards, one Meta blue action, crisp Inter text under bold Montserrat headings, and a blue-to-violet mark wherever a model did the work. It is inspired by Meta's look, never a copy of Meta: no logos, no marks, never "Meta" as the brand. This skill is the look; product-ui is layout, inputs, states and model output. Open `reference/components.md` for the markup of a part this page doesn't show, and `reference/tokens.md` only to look up a value.

## Principles

1. **Flat and calm.** White cards on the gray wash, no card borders, no card shadows. Space separates things, not lines.
2. **Blue means act.** `--accent` and `--link` are only for the primary button, links, selection, focus and the person's own chat bubbles. The one decorative color is the signature hue, which is Meta brand blue until you set an accent.
3. **One gradient, only for AI.** The blue-to-violet gradient marks what a model made or is making: the model chip's outline, the AI card's cap, a busy AI button, the working dots. Never on anything else.
4. **Type carries the hierarchy.** Montserrat 700 for headings and big numbers, Inter for everything read or tapped. Body text uses 400 and 600 only.
5. **One signature element.** One drawn thing that fits the subject, in the product's accent hue.
6. **Phone first.** Design at 390 px, then let it widen to the 720 px column.

## Tokens

Use tokens in every style and inline SVG, never raw hex. Light and dark switch on their own.

| Token | Use |
|---|---|
| `--bg` | the page |
| `--surface` | cards, the app bar, dialogs |
| `--surface-2` | fills inside a card: notes, table heads, the dropzone, the composer |
| `--line` | dividers, table borders, tags |
| `--fg`, `--fg-2` | primary text; secondary text (tagline, hints, meta, limits) |
| `--accent`, `--on-accent` | the primary button, selected marks, progress; white on it |
| `--link` | links, text buttons |
| `--tinted-bg`, `--tinted-fg` | tinted buttons, selected chips and segments |
| `--secondary-bg` | secondary buttons, chips, segments, icon buttons, avatars |
| `--positive`, `--negative`, `--warning` | status text and icons (warning: icons only); `-soft` fills for chips and errors |
| `--ai-gradient`, `--ai-start`, `--ai-end` | AI only (principle 3) |
| `--signature`, `--signature-soft`, `--signature-ink` | the signature element, illustrations, one-series charts |
| `--cherry` `--grape` `--lemon` `--lime` `--pink` `--teal` | charts with several series, illustrations |
| `--on-media`, `--scrim` | white lines drawn over a photo; dark glass under a label on a photo |

**Accent hue.** Set one in app/layout.tsx, `<html lang="en" data-accent="lime">`, and write the choice in BUILD_NOTES.md. Leave it off for Meta blue. It changes only `--signature*` (and tints `.avatar` initials); buttons, links and focus stay Meta blue. `--signature` is a fill, so text in the signature element uses `--signature-ink` on `--signature-soft` or `--surface`.

| Accent | Fits |
|---|---|
| none | general tools, utilities, anything from Meta's own playbook |
| `cherry` | food, cooking, sports, events |
| `grape` | learning, music, reading, games, night |
| `lemon` | money, budgets, kids, sunny and playful things |
| `lime` | plants, gardens, fitness, health, habits |
| `pink` | gifts, social plans, beauty, celebrations |
| `teal` | travel, water, spreadsheets, calm planning |

## Type, space, shape, motion

- **Type.** `h1` hero, `h2` card title, `h3` headline: Montserrat 700. Inter for the rest: `--type-body`, `--type-label` (labels, buttons), `--type-meta` (`.meta`, `.hint`). `.big-number` for a figure. Sentence case: no all caps, italics or letter-spaced labels.
- **Space.** Built in: 16 px between cards and between the parts in a card, 12 under a heading, 8 above a hint or limits, 20 above the actions. Don't add margins to fight it; use `--space-*` when you need one.
- **Shape.** `--radius-lg` cards and dialogs, `--radius` buttons, fields, notes, tables and photos, `--radius-sm` thumbnails, `--pill` chips, segments and avatars.
- **Elevation.** Flat: only the app bar (`--shadow-base`), toasts (`--shadow-elevated`), menus and dialogs (`--shadow-menu`) have shadows. A card never gets a shadow or a border.
- **Motion.** `--ease-enter` with `--dur-short-in` to appear, `--ease-exit` with `--dur-short-out` to leave, `--dur-xxs` for hover and press. Reduced motion is handled.

## Parts

| Part | For |
|---|---|
| `<AppBar name action? />` | top of every page: the product's name and one optional action |
| `.hero` with `h1` and `.tagline` | the first thing under the app bar |
| `.card`, `.card-head` | each section; `.card-head` puts a title and a ModelChip on one row |
| `.card.ai` | a result a model made (gradient cap) |
| `.field`, `.fields.two`, `.hint` | labeled controls |
| `<FilePicker>` | every file input: a dropzone you tap, or drop a file on |
| `<Segmented>` | pick one of two to five short options |
| `button.primary` `.secondary` `.tinted` `.text` `.icon` | one primary per screen; add `.ai` to a primary that calls a model |
| `.actions` | a row of buttons |
| `.chip`, `.chip.positive`, `.chip.negative`, `.tag`, `button.chip[aria-pressed]` | statuses, feature labels, filters |
| `<ModelChip>`, `.ai-badge` | model credit; AI label on an image |
| `.working`, `<Skeleton>` | a model at work |
| `.table-wrap`, `.kv`, `.big-number`, `.meta` | data |
| `.list`, `.list-row`, `.list-text`, `.list-title`, `.avatar`, `.icon-circle`, `.thumb` | rows of things, small previews |
| `.thread`, `.bubble.in`, `.bubble.out`, `<Composer>` | chat |
| `.media`, `.overlay` | image results with overlays |
| `.note`, `.error`, `.limits`, `.empty` | tips, failures, limits, nothing yet |
| `.toast`, `dialog`, `details` | confirmations, one short question, long extras |
| `<Icon name />` | the only icons, listed below |
| `<Markdown text />` | model prose |

Icons: upload, camera, image, file, mic, sparkle, check, alert, info, copy, download, refresh, arrow-right, chevron-left, chevron-right, chevron-down, close, play, stop, send, search, plus, more, edit, external, calendar, clock, trash. `sparkle` is for AI.

## Patterns

**First screen: app bar, hero, then input, action and result.** The app bar carries the name, so the h1 says what the screen does in a few words, and the tagline is the brief's one line. The input card needs no heading: the field label names it.

```tsx
<AppBar name="Receipt Rows" action={result ? <button className="text" onClick={reset}>Start over</button> : undefined} />
<main className="stack">
  <header className="hero">
    <h1>Turn a receipt into a spreadsheet</h1>
    <p className="tagline">Take a photo and get every item and price as rows you can paste anywhere.</p>
  </header>
  <section className="card" aria-label="Your receipt">
    <FilePicker label="Photo of your receipt" accept="image/*" button="Take or choose a photo" change="Choose another photo"
      fileName={file?.name ?? null} onFile={setFile} />
    <p className="hint">Your photo is sent to Muse Spark 1.3 to read it. This app doesn't keep it.</p>
    <div className="actions">
      <button className="primary ai" disabled={!file || busy} aria-busy={busy} onClick={run}>{busy ? "Reading the receipt…" : "Read the receipt"}</button>
      <button className="text" onClick={trySample}>Try a sample receipt</button>
    </div>
  </section>
</main>
```

**Working.** The result card appears at once with a `.working` line naming the step and a `<Skeleton>` shaped like the result; Skeleton marks itself `aria-busy`, so judgeShot waits. Every busy button gets `aria-busy` and a label ending in "…"; a `.primary.ai` one shows the moving gradient.

```tsx
<section className="card ai" aria-labelledby="out">
  <div className="card-head"><h2 id="out">Your spreadsheet</h2></div>
  <p className="working" role="status">Reading the line items…</p>
  <Skeleton height={120} lines={3} />
</section>
```

**AI result card.** `.card.ai` and a ModelChip only on output a model made; a sample or app-written text gets a plain `.card`. Lead with the signature element or the answer, then details, the limit, then actions. Once it is up, drop the input card or shrink it to a `.thumb`, so there is one primary button.

```tsx
<section className="card ai" ref={resultRef} aria-labelledby="out">
  <div className="card-head">
    <h2 id="out" tabIndex={-1}>Your spreadsheet</h2>
    <ModelChip model="muse-spark-1.3" verb="Read" />
  </div>
  {/* signature element, then .table-wrap or .kv */}
  <ul className="limits"><li>Faded lines can be missed. Check the total before you file it.</li></ul>
  <div className="actions">
    <button className="primary"><Icon name="copy" /> Copy rows</button>
    <button className="secondary"><Icon name="download" /> Download CSV</button>
  </div>
</section>
```

**Errors** go where the result would have been, with the input still filled so a retry is one tap: `<div className="error" role="alert"><Icon name="alert" /> <strong>Couldn't read that receipt.</strong> The photo is too blurry. Retake it in brighter light.</div>`. A field error is `aria-invalid="true"` plus a `.hint` saying what to fix.

**Confirmations** like "Copied" change the button's own label for about 2 seconds. Never take a judge screenshot while a `.toast` is up: it floats mid-page.

**Other parts** (markup in components.md):
- Empty state: `.empty` with an `.icon-circle.lg`, an `h3`, one line on what to do and at most one `.tinted` button.
- Chat: a `.thread` of `.bubble.out` (the person) and `.bubble.in` (model text through `<Markdown>`) over a `<Composer>`. One ModelChip in the card head, not on every bubble.
- Lists: `.list-row`s led by an `.avatar`, `.icon-circle` or `.thumb`. Numbered steps put the number in the `.icon-circle`. A check means done, so a planned day or open task is a dot or an empty circle.
- Tables: `.table-wrap`, `.num` cells, the total in `<tfoot>`, three columns at most on phones; pairs go in `.kv`.
- Image results: `.media` with the image, an `svg.overlay` whose viewBox is the image's pixel size, drawn in `var(--on-media)` or `--signature`, an `.ai-badge` and a `figcaption` that says the result in words ("Found 3 birds").

**Signature element:** one drawn element made with tokens, CSS or inline SVG: a torn-edge receipt slip in `--signature-soft`, a week of watering dots, a chalkboard frame around a menu. Flat: `--signature`, `--signature-soft`, `--surface-2` and `--line`, 2 px round strokes, no gradients (those are AI's), no people or characters.

## Dark mode

Every token switches with `prefers-color-scheme`. Draw inline SVG with tokens (`fill="var(--signature-soft)"`) so it switches too. Photos stay as they are. Check both modes.

## Accessibility

- These text pairs pass WCAG AA in both modes; keep text on them: `--fg` and `--fg-2` on `--bg`, `--surface`, `--surface-2` or `--signature-soft`; `--link` on the first three; `--tinted-fg` on `--tinted-bg`; `--signature-ink` on `--signature-soft` or `--surface`; white on `--accent` or the gradient; `--on-media` on `--scrim`. Check anything else first.
- Every control has a label. FilePicker and Segmented show theirs. The Composer's label is for screen readers, so its placeholder says what to type. Icon-only buttons need `aria-label`.
- Never remove focus outlines. Status is never color alone: pair it with an icon and words (pressed chips and the chosen segment show a check by themselves).

## Do and don't

- Do give the screen one primary button, its result a ModelChip, and the product one signature element. Use `<Icon>` for every icon.
- Don't use Meta's logos, wordmarks, the infinity symbol, the Meta AI ring, flower or "M" marks, or "Meta" as the product's name. Keep the footer.
- Don't add colors, fonts, shadows, borders on cards, cards inside cards, emoji as icons, icon fonts, remote images or em dashes.

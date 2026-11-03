---
name: muse-app-ui
description: Use for every screen of this Muse Muse product. The UI kit: tokens in app/muse-app.css, parts in app/globals.css and components/, patterns for tools, forms, results, galleries and chat, states and accessibility. Its look is a set of defaults that the brief's Design direction overrides.
---

# Muse App UI

**The Design direction in brief.md decides how this product looks.** This skill supplies the parts, states, accessibility and contrast. Everything below about colors, fonts, weights, shadows, column width, card use and screen patterns is a default: use it where the direction says nothing, and override it wherever the direction says otherwise. No two Muse Muse products should look alike. The product is the person's own, with its own name. This skill is the kit and the patterns; product-ui is layout, inputs, states and model output. Open `reference/screens.md` to pick the pattern for this product, `reference/components.md` for the markup of a part, and `reference/tokens.md` only to look up a value.

When the direction's summary starts with `Look: <name>`, `.agents/skills/design-looks/looks/<name>.md` fills in what the direction leaves out.

## Defaults, unless the direction says otherwise

1. **The direction's ground.** Set `--bg` and `--surface` from its palette. With no word on it: a plain page, and a card edged by a 1 px hairline. Shadows, thick rules, color blocks and full-bleed sections are all fine when the direction calls for them.
2. **One color means act.** `--accent` and `--link` mark the primary button, links and text buttons, selection, focus and progress, so people can tell what's clickable. Set them from the direction's palette. `--signature` tokens may use its accent or secondary, and more colors can do real work beside them.
3. **Mark what AI made.** `--ai-gradient` marks what a model made or is making: the model chip's outline, the AI card's cap, a busy AI button, the working dots. Recolor it to fit the palette. Other gradients are fine when the direction calls for them.
4. **Type from the direction.** A display face and a body face from npm (`@fontsource` packages), with `--font-display` and `--font` set to them. Use any weight and size that suits the face, as long as it stays readable.
5. **Elevation from the direction.** By default only layers float (the composer, menus, dialogs, toasts). A direction with soft or layered shapes can give cards shadows.
6. **Signature elements hold real content.** The surface the result sits on, plus any decoration, pattern or imagery the direction asks for.
7. **Phone first, then use the room.** Design at 390 px, and it must work there. On a desktop use the width the direction calls for: two or three panes, boards, wide tables and full-bleed grids are all fine. The 720 px column is only a default.

## Which pattern

These five are starting points, not a list to choose from. A product can mix them or use its own page shape, such as a dashboard, a board, a map, a timeline, a long editorial page or a canvas. Most products aren't chat apps, so pick by what the person does. See `reference/screens.md`.

| The person | Pattern | Looks like |
|---|---|---|
| Gives one thing and gets one result (a photo, a file, some text) | **Tool** | Hero, an input card, a result card |
| Fills in a few fields, then runs it once | **Form** | Hero, a card of fields, the result under the summary row |
| Reads or checks figures, rows or a chart | **Results** | A result card with a big number, a table, `.kv` or bars |
| Gets several images, or compares before and after | **Gallery** | A `.gallery` of `.media` tiles |
| Goes back and forth in words | **Chat** | A centered start, then a thread over the glass composer |

A tool can end in a chat ("Ask about this receipt"), and a chat can end in a result card. A screen can do several related jobs when its layout keeps them clear, and pages don't have to be stacks of cards.

## Tokens

Set these from the Design direction first, in both color blocks of `app/muse-app.css`, which loads after `app/globals.css`. Add tokens of your own for extra colors. Then use tokens in every style and inline SVG, rather than raw hex.

| Token | Use |
|---|---|
| `--bg` | the page |
| `--surface` | cards, the app bar, dialogs (white on white, so cards carry a hairline) |
| `--surface-2` | fills: notes, table heads, the dropzone, the chart panel, the person's chat bubble |
| `--line` | every hairline: card edges, dividers, table borders, tags |
| `--fg`, `--fg-2` | primary text; secondary text (tagline, hints, meta, limits) |
| `--accent`, `--on-accent` | the primary button, selected marks, progress; white on it |
| `--bubble-out`, `--on-bubble-out` | the person's chat bubble and its text, a pair: set both or neither |
| `--link` | links, text buttons |
| `--tinted-bg`, `--tinted-fg` | tinted buttons, pressed filter chips |
| `--secondary-bg` | secondary buttons, chips, icon buttons, avatars, the segmented track |
| `--segment` | the chosen option in a segmented control |
| `--glass`, `--shadow-card` | the composer's surface and its shadow |
| `--send-from`, `--send-to` | the send button's gradient, icon only |
| `--positive`, `--negative`, `--warning` | status text and icons (warning: icons only); `-soft` fills for chips and errors |
| `--ai-gradient`, `--ai-start`, `--ai-end` | AI only (principle 3) |
| `--signature`, `--signature-soft`, `--signature-ink`, `--signature-line` | the signature element and `.bars`, in the action blue; `-line` for strokes and bars. Text in the signature element uses `--signature-ink` on `--signature-soft` or `--surface` |
| `--cherry` `--grape` `--lemon` `--lime` `--pink` `--teal` | only the series of a multi-series legend and overlays of several kinds of object, one hue per kind |
| `--on-media`, `--scrim` | white lines drawn over a photo; dark glass under a label on a photo |

## Type, space, shape, motion

- **Type.** Default scale: `h1` hero 28 px (30 px from 720 px), `h2` card title 20 px, `h3` headline 17 px, `--type-body` 16 px, `--type-label` 14 px, `--type-meta` 13 px, `.big-number` for a figure. Change the scale, weights, case and tracking to suit the direction. Body text stays at least 16 px on a phone, and an `h1` stays within 2 lines there (judgeShot fails a third).
- **Space.** Default rhythm: 16 px between cards and between the parts in a card, 12 under a heading, 8 above a hint or limits, 20 above the actions. Tighten or open it to match the direction's density. Keep it consistent with `--space-*` tokens or your own.
- **Shape.** Set `--radius-lg`, `--radius`, `--radius-sm` and `--pill` from the direction, from square corners to very round. Defaults: 16 for cards, 12 for fields and tables, 8 for thumbnails, pills for buttons and chips.
- **Elevation.** Default is flat, with shadows on the composer (`--shadow-card`), menus and dialogs (`--shadow-menu`) and toasts (`--shadow-elevated`). Follow the direction for cards and sections.
- **Motion.** `--ease-enter` with `--dur-short-in` to appear, `--ease-exit` with `--dur-short-out` to leave, `--dur-xxs` (150 ms) for hover and press. Add the richer motion the direction asks for, like staggered reveals, page transitions or animated charts, and an animation package from npm if it helps. Anything you add stops under `prefers-reduced-motion`, and nothing may still be moving when a judge screenshot is taken.

## Parts

| Part | For |
|---|---|
| `<AppBar name action? />` | top of every page: the product's name and one optional action |
| `.hero` with `h1` and maybe a `.tagline`; `.hero.center` | the first thing under the app bar; `.center` only for a chat product's start (screens.md) |
| `.card`, `.card-head` | a step of the flow (input, result, a tool), never a widget for one count (that is a `.chip` or `.kv` row in its card); `.card-head` puts a title and a ModelChip on one row |
| `.card.ai` | a result a model made (purple cap) |
| `.field`, `.fields.two`, `.hint` | labeled controls |
| `<FilePicker>` | every file input: a dropzone you tap, or drop a file on |
| `<Segmented>` | pick one of two to five options of a word or two: a gray track, the chosen one raised white with a check |
| `button.primary` `.secondary` `.tinted` `.text` `.icon` | one primary per screen, with `.ai` when it calls a model; once the result is up, it is the action that delivers it (Download CSV, Copy). A card's own main action is `.tinted` (`.tinted.ai` with the sparkle for a model), `.secondary` only a utility (Reset, a second export, Edit beside model text), `.text` a quiet one (Try the sample, Make another). At most two filled buttons in a phone's `.actions`: a third is `.text` |
| `.actions` | a row of buttons |
| `.chip`, `.chip.positive`, `.chip.negative`, `.tag`, `button.chip[aria-pressed]` | statuses, feature labels, filters |
| `<ModelChip>`, `.ai-badge` | model credit; AI label on an image |
| `.working`, `<Skeleton>` | a model at work |
| `.table-wrap`, `.kv`, `.rows`, `.big-number`, `.meta` | data; `.rows` for rows the person edits |
| `.bars`, `.bar` | a one-series bar chart |
| `.list`, `.list-row`, `.list-text`, `.list-title`, `.avatar`, `.icon-circle`, `.thumb` | rows of things, small previews |
| `.thread`, `.bubble.out`, `.bubble.in`, `<Composer>` | chat: the person's gray bubble, the answer as plain text, the glass composer |
| `.media`, `.overlay`, `.gallery` | image results with overlays; several images |
| `.note`, `.error`, `.limits`, `.empty` | tips, failures, limits, nothing yet |
| `.toast`, `dialog`, `details` | confirmations, one short question, long extras |
| `<Icon name />` | the kit's icons, listed below. An npm icon set or your own SVG is fine for what they miss |
| `<Markdown text />` | model prose |

Icons: upload, camera, image, file, mic, sparkle, check, alert, info, copy, download, refresh, arrow-right, chevron-left, chevron-right, chevron-down, close, play, stop, send, search, plus, more, edit, external, calendar, clock, trash. `sparkle` is for AI.

## Patterns

**First screen, by default: app bar, hero, then input, action and result.** A landing section, dashboard or board can lead instead when the direction says so, as long as the main action is easy to find. The app bar carries the name. The h1 says what the screen does in a few words, at most 2 lines on a phone (judgeShot fails a third): when the brief's tagline says that in 34 characters or fewer, it is the h1 and there is no `.tagline`. Otherwise the tagline adds what the h1 doesn't (who it's for, what you get) and shares none of its nouns or verbs. The input card needs no heading: the field label names it.

```tsx
<AppBar name="Receipt Rows" action={result ? <button className="text" onClick={reset}>Start over</button> : undefined} />
<main className="stack">
  <header className="hero">
    <h1>Turn a receipt into a spreadsheet</h1>
    <p className="tagline">Take a photo and get every item and price as rows you can paste anywhere.</p>
  </header>
  <section className="card" aria-label="Your receipt">
    <FilePicker label="Photo of your receipt" accept="image/*" button="Take or choose a photo" change="Choose another photo"
      file={file} onFile={setFile} />
    <p className="hint">Your photo is sent to Muse Wonder to read it. This app doesn't keep it.</p>
    <div className="actions">
      <button className="primary ai" disabled={!file || busy} aria-busy={busy} onClick={run}>{busy ? "Reading the receipt…" : "Read the receipt"}</button>
      <button className="text" onClick={trySample}>Try a sample receipt</button>
    </div>
  </section>
</main>
```

**Working.** The result card appears at once with a `.working` line naming the step and a `<Skeleton>` shaped like the result; Skeleton marks itself `aria-busy`, so judgeShot waits. Every busy button gets `aria-busy` and a label ending in "…"; a `.primary.ai` one shows the moving purple gradient.

```tsx
<section className="card ai" aria-labelledby="out">
  <div className="card-head"><h2 id="out">Your spreadsheet</h2></div>
  <p className="working" role="status">Reading the line items…</p>
  <Skeleton height={120} lines={3} />
</section>
```

**The result replaces the input.** When a form's only job is to start one run, it shows only until there is a result, then becomes one summary row whose Edit button brings the filled form back, so the result starts near the top of the page and of the demo video. A tool the person keeps working in (a sheet, a board, a chat) keeps its input on screen. The row's title is a short label ("Your receipt photo", "Your idea"). For typed input, lead with an `.icon-circle` holding an icon and put the person's words under the title in `<span className="meta clamp" data-user-text>` (two lines at most). Never cut text in code. A generative result keeps a `.text` "Make another" in its `.actions`.

```tsx
{result && !editing ? (
  <section className="card" aria-label="Your receipt">
    <ul className="list">
      <li className="list-row">
        <img className="thumb" src={photoUrl} alt="" />
        <div className="list-text"><span className="list-title">Your receipt photo</span><span className="meta">Items and prices</span></div>
        <button className="text" onClick={() => setEditing(true)}>Edit</button>
      </li>
    </ul>
  </section>
) : (
  <section className="card" aria-label="Your receipt">{/* the form, still filled; a new run ends with setEditing(false) */}</section>
)}
```

**AI result card.** `.card.ai` and a ModelChip only on output a model made; a sample or app-written text gets a plain `.card`. Lead with the answer (on the signature element, when there is one), then details, the limit, then actions. When the model names the result, that name is the h2. Mark the product's main result `data-result` (a tool marks its own surface): verify fails a last screenshot where it starts over 2,400 px down the page, or, with none marked, where the first `.card.ai` does.

```tsx
<section className="card ai" data-result ref={resultRef} aria-labelledby="out">
  <div className="card-head">
    <h2 id="out" tabIndex={-1}>Your spreadsheet</h2>
    <ModelChip model="muse-wonder-1.0" verb="Read" />
  </div>
  {/* the answer: .table-wrap or .kv, or .rows when the person fixes the rows (components.md) */}
  <ul className="limits"><li>Faded lines can be missed. Check the total before you file it.</li></ul>
  <div className="actions">
    <button className="primary"><Icon name="download" /> Download CSV</button>
    <button className="secondary"><Icon name="copy" /> Copy rows</button>
  </div>
</section>
```

**Ask, then answer.** A card that holds a model action and later its answer starts as an `.empty` whose one button is the `.tinted.ai` action. Every `.tinted.ai` button leads with the sparkle: `<button className="tinted ai"><Icon name="sparkle" /> Cook this</button>`. Once answered, the ModelChip sits right above the answer, and the action moves under it as a `.text` "Write it again" in `.actions`. Never put a model button between its chip and its answer. On the last judge screenshot it is answered: the smoke test presses its button first.

**Errors** go where the result would have been, with the input still filled so a retry is one tap: `<div className="error" role="alert"><Icon name="alert" /> <strong>Couldn't read that receipt.</strong> The photo is too blurry. Retake it in brighter light.</div>`. A field error is `aria-invalid="true"` plus a `.hint` saying what to fix.

**Confirmations** like "Copied" change the button's own label for about 2 seconds. Never take a judge screenshot while a `.toast` is up: it floats mid-page.

**Signature element:** the surface that holds the product's real output, drawn with tokens: the paper frame around the coloring page, a habit week grid (one row per habit, its name above seven 36 px dots, done dots filled with `--signature`), the torn-edge slip the receipt rows sit on. It never goes in `.hero` or above the h1. It is never a stand-alone icon, tile, squiggle or picture, and never rows of plain gray bars, which is the loading skeleton. If the result can't carry it, leave it out. Draw it in the direction's style with tokens. Original illustration, patterns and generated images are fine when the direction's imagery asks for them. Never a real brand's characters or artwork.

## The product is the person's own

- Its name is the brief's, in the app bar and `metadata.title`. No logo is needed: the name is the brand.
- No Meta logos, wordmarks or marks: not the infinity symbol, not the ring, not a flower, petal or pinwheel mark, not an "M". Never draw a mark that looks like one.
- Never "Meta" or "Meta AI" as the product's name or voice: no "Ask Meta AI", no "Meta (c)", no "Download Meta AI", and no links to Meta's legal pages as the product's own. A model's name appears only in a ModelChip or a privacy line ("sent to Muse Wonder").
- Keep the footer. It says "Built with Muse Muse. Not an official Meta product."
- No dead controls. Every button, chip, tab and menu item does something real in this product, under an honest name. No model picker or "Thinking" switch unless the product really switches, no notification bell, no profile or settings menu, no "Download the app", no thumbs up or down that store nothing, no history list with nothing behind it.
- Credit and disclose as before: one ModelChip on each result a model made and never on a sample or fallback; an `.ai-badge` on a model's image where no chip can; say where an input goes ("Your photo is sent to Muse Wonder to read it. This app doesn't keep it.").

## Dark mode

Every token switches with `prefers-color-scheme`. A direction with one fixed scheme sets both blocks to the same values. Draw inline SVG with tokens (`fill="var(--signature-soft)"`) so it follows. Photos stay as they are. Check every mode the product has.

## Accessibility

- With the default tokens, these text pairs pass WCAG AA in both modes. Once you change tokens, **check each text pair yourself: every text color on its ground reaches at least 4.5:1 (3:1 for large text)**: `--fg` and `--fg-2` on `--bg`, `--surface`, `--surface-2`, `--glass` or `--signature-soft`; `--link` on the first three; `--tinted-fg` on `--tinted-bg`; `--signature-ink` on `--signature-soft` or `--surface`; `--fg` on `--segment`; white on `--accent` or `--ai-gradient`; `--on-media` on `--scrim`; `--on-bubble-out` on `--bubble-out`. Check anything else first. White on the send gradient is for its icon only.
- Every control has a label. FilePicker and Segmented show theirs. The Composer's label is for screen readers, so its placeholder says what to type, in 30 characters or fewer: the box grows to fit its placeholder, and a longer one wraps to a second line on a phone. Icon-only buttons need `aria-label`.
- Never remove focus outlines, the composer's included. Status is never color alone: pair it with an icon and words (pressed chips and the chosen segment show a check by themselves).
- Controls stay 44 px tall and wide for fingers, even where the look could go smaller. Icon-only buttons and the composer's Send draw a 40 px circle inside a 44 px tap area, with padding and `background-clip: content-box`. Keep the tap area when you restyle them. judgeShot fails a control under 44 px on a phone.

## Do and don't

- Do give each screen one clear main action and each model result a ModelChip.
- Do keep these markers wherever they apply, however the page looks: verify and the judge's screenshots read `data-result`, `.card.ai`, `aria-busy`, `.error`, `.empty` and `role="alert"`.
- Don't use emoji as icons, icon fonts, remote images, CDNs, `next/font/google` or em dashes. Anything visual comes from npm or is drawn in the product, since the build machine can only reach npm.
- Don't copy any real product's screens, words, logo, characters, artwork, exact look or starter prompts. Take the idea from the direction and the words from the brief.

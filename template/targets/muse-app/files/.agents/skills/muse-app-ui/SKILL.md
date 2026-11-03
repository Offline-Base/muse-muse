---
name: muse-app-ui
description: Use for every screen of this Muse Muse product. The muse-app look (a white page, hairline cards, regular-weight Inter, one blue for actions, a purple gradient only for AI), its tokens in app/muse-app.css, the parts in app/globals.css and components/, and when to use each pattern for tools, forms, results, galleries and chat, with dark mode and accessibility.
---

# Muse App UI

Every product should look like it belongs beside the Muse Muse app: a white page, cards edged by one hairline, regular-weight Inter, one blue for actions, a floating glass composer when there is one, and a purple gradient wherever a model did the work. It is a way of laying out a page, not anyone's brand: the product is the person's own, with its own name. This skill is the look and the patterns; product-ui is layout, inputs, states and model output. Open `reference/screens.md` to pick the pattern for this product, `reference/components.md` for the markup of a part, and `reference/tokens.md` only to look up a value.

## Principles

1. **White and quiet.** A white page (near black in dark mode). A card is the same white with a 1 px hairline, never a shadow. Space separates things, not more lines.
2. **Blue means act.** `--accent` and `--link` are only for the primary button, links and text buttons, selection, focus and progress. The signature element and one-series charts use the `--signature` tokens, the same blue. There is no other signature color.
3. **Purple means AI.** `--ai-gradient` marks what a model made or is making: the model chip's outline, the AI card's cap, a busy AI button, the working dots. The send button's blue gradient is the only other gradient, and only on that icon.
4. **Regular weight carries it.** One family, Inter. `h1` is 400, `h2` and `h3` are 600, labels and buttons 500, body 400. Never 700, never a second font.
5. **Only layers float.** The composer, menus, dialogs and toasts have shadows. Nothing else does.
6. **One signature element, and it holds real content.** The surface the result sits on, never art on its own.
7. **Phone first, then use the width.** Design at 390 px in one column. At 1024 px and wider, let the page grow to about 1200 px with the input and the result side by side (the result pane sticky), never one tall narrow column.

## Which pattern

Most products aren't chat apps. Pick by what the person does, then follow that section of `reference/screens.md`.

| The person | Pattern | Looks like |
|---|---|---|
| Gives one thing and gets one result (a photo, a file, some text) | **Tool** | Hero, an input card, a result card |
| Fills in a few fields, then runs it once | **Form** | Hero, a card of fields, the result under the summary row |
| Reads or checks figures, rows or a chart | **Results** | A result card with a big number, a table, `.kv` or bars |
| Gets several images, or compares before and after | **Gallery** | A `.gallery` of `.media` tiles |
| Goes back and forth in words | **Chat** | A centered start, then a thread over the glass composer |

A tool can end in a chat ("Ask about this receipt"), and a chat can end in a result card: combine them, but give each screen one job.

## Tokens

Use tokens in every style and inline SVG, never raw hex. Light and dark switch on their own. The values are in `app/muse-app.css`, which loads after `app/globals.css`.

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

- **Type.** `h1` hero (400, 28 px, 30 px from 720 px), `h2` card title (600, 20 px), `h3` headline (600, 17 px), all Inter. `--type-body` (16 px), `--type-label` (labels, buttons: 500, 14 px), `--type-meta` (`.meta`, `.hint`: 13 px). `.big-number` for a figure, at 400. Text is tracked in by 1%. Sentence case: no all caps, italics or letter-spaced labels.
- **Space.** Built in: 16 px between cards and between the parts in a card, 12 under a heading, 8 above a hint or limits, 20 above the actions. Don't add margins to fight it; use `--space-*` when you need one, in JSX too: `style={{ marginTop: "var(--space-16)" }}`, never a bare number.
- **Shape.** `--radius-lg` (16) cards, the segmented track and toasts; `--radius` (12) fields, notes, tables and list rows; `--radius-sm` (8) thumbnails; `--pill` buttons, chips and avatars. The composer is 32 and dialogs 32, built in. Photos in `.media` are 18, built in.
- **Elevation.** Flat: only the composer (`--shadow-card`), menus and dialogs (`--shadow-menu`) and toasts (`--shadow-elevated`) have shadows. The app bar has a hairline under it. A card never gets a shadow.
- **Motion.** `--ease-enter` with `--dur-short-in` to appear, `--ease-exit` with `--dur-short-out` to leave, `--dur-xxs` (150 ms) for hover and press. Only the AI working state moves on its own. Reduced motion is handled.

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
| `<Icon name />` | the only icons, listed below |
| `<Markdown text />` | model prose |

Icons: upload, camera, image, file, mic, sparkle, check, alert, info, copy, download, refresh, arrow-right, chevron-left, chevron-right, chevron-down, close, play, stop, send, search, plus, more, edit, external, calendar, clock, trash. `sparkle` is for AI.

## Patterns

**First screen: app bar, hero, then input, action and result.** The app bar carries the name. The h1 says what the screen does in a few words, at most 2 lines on a phone (judgeShot fails a third): when the brief's tagline says that in 34 characters or fewer, it is the h1 and there is no `.tagline`. Otherwise the tagline adds what the h1 doesn't (who it's for, what you get) and shares none of its nouns or verbs. The input card needs no heading: the field label names it.

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

**AI result card.** `.card.ai` and a ModelChip only on output a model made; a sample or app-written text gets a plain `.card`. Lead with the answer (on the signature element, when there is one), then details, the limit, then actions. When the model names the result, that name is the h2. Mark the product's main result `data-result` (a tool marks its own surface): verify fails a last screenshot where it starts over 1,000 px down the page, or, with none marked, where the first `.card.ai` does.

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

**Signature element:** the surface that holds the product's real output, drawn with tokens: the paper frame around the coloring page, a habit week grid (one row per habit, its name above seven 36 px dots, done dots filled with `--signature`), the torn-edge slip the receipt rows sit on. It never goes in `.hero` or above the h1. It is never a stand-alone icon, tile, squiggle or picture, and never rows of plain gray bars, which is the loading skeleton. If the result can't carry it, leave it out. Flat: `--signature-soft` fills, 2 px round strokes in `--signature-line`, no gradients (those are AI's and the send button's), no people or characters.

## The product is the person's own

- Its name is the brief's, in the app bar and `metadata.title`. No logo is needed: the name is the brand.
- No Meta logos, wordmarks or marks: not the infinity symbol, not the ring, not a flower, petal or pinwheel mark, not an "M". Never draw a mark that looks like one.
- Never "Meta" or "Meta AI" as the product's name or voice: no "Ask Meta AI", no "Meta (c)", no "Download Meta AI", and no links to Meta's legal pages as the product's own. A model's name appears only in a ModelChip or a privacy line ("sent to Muse Wonder").
- Keep the footer. It says "Built with Muse Muse. Not an official Meta product."
- No dead controls. Every button, chip, tab and menu item does something real in this product, under an honest name. No model picker or "Thinking" switch unless the product really switches, no notification bell, no profile or settings menu, no "Download the app", no thumbs up or down that store nothing, no history list with nothing behind it.
- Credit and disclose as before: one ModelChip on each result a model made and never on a sample or fallback; an `.ai-badge` on a model's image where no chip can; say where an input goes ("Your photo is sent to Muse Wonder to read it. This app doesn't keep it.").

## Dark mode

Every token switches with `prefers-color-scheme`. Draw inline SVG with tokens (`fill="var(--signature-soft)"`) so it switches too. Photos stay as they are. Check both modes.

## Accessibility

- These text pairs pass WCAG AA in both modes; keep text on them: `--fg` and `--fg-2` on `--bg`, `--surface`, `--surface-2`, `--glass` or `--signature-soft`; `--link` on the first three; `--tinted-fg` on `--tinted-bg`; `--signature-ink` on `--signature-soft` or `--surface`; `--fg` on `--segment`; white on `--accent` or `--ai-gradient`; `--on-media` on `--scrim`; `--on-bubble-out` on `--bubble-out`. Check anything else first. White on the send gradient is for its icon only.
- Every control has a label. FilePicker and Segmented show theirs. The Composer's label is for screen readers, so its placeholder says what to type, in 30 characters or fewer: the box grows to fit its placeholder, and a longer one wraps to a second line on a phone. Icon-only buttons need `aria-label`.
- Never remove focus outlines, the composer's included. Status is never color alone: pair it with an icon and words (pressed chips and the chosen segment show a check by themselves).
- Controls stay 44 px tall and wide for fingers, even where the look could go smaller. Icon-only buttons and the composer's Send draw a 40 px circle inside a 44 px tap area, with padding and `background-clip: content-box`. Keep the tap area when you restyle them. judgeShot fails a control under 44 px on a phone.

## Do and don't

- Do give the screen one primary button, its result a ModelChip, and the result at most one signature element. Use `<Icon>` for every icon.
- Do keep the classes and components as they are: verify and the judge's screenshots read `data-result`, `.card.ai` and `aria-busy`.
- Don't add colors, fonts, weights above 600, shadows on cards, borders thicker than the hairline, cards inside cards, emoji as icons, icon fonts, remote images or em dashes.
- Don't copy any real product's screens, words or starter prompts. Take the layout from here and the words from the brief.

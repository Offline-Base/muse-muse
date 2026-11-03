# Meta UI parts

Markup for every class in `app/globals.css` and every component in `components/`. Copy it as it is and change the words. Components import from `@/components/<Name>`. The first screen, the working state and the AI result card are in SKILL.md.

## Page

```tsx
<>
  <AppBar name="Leafwise" action={<button className="text" onClick={reset}>Check another plant</button>} />
  <main className="stack">
    <header className="hero">
      <h1>What does your plant need?</h1>
      <p className="tagline">Take one photo and get a care plan for this week.</p>
    </header>
    <section className="card" aria-label="Your plant">…</section>
  </main>
</>
```

- `AppBar` props: `name` (the product's name), `action` (one optional button), `href` (optional, makes the name a link home). It sits at the top with the base shadow and scrolls away with the page. One per page, above `<main>`. With a long name, make the action `<button className="icon" aria-label="Start over"><Icon name="refresh" /></button>` so the name stays on one line on phones.
- `.stack` spaces cards 16 px apart. `.row` is a wrapping flex row with 12 px gaps.
- `scrollIntoView({ block: "start" })` lands a result 12 px below the top of the screen.
- The footer comes from app/layout.tsx. Never remove it.

## Cards

A section is `<section className="card" aria-labelledby="...">` with an `h2`, or `aria-label` when its field label already names it (an input card). A result a model made is `.card.ai` with a `.card-head` holding the `h2` and a ModelChip. Parts inside a card get 16 px between them, 12 px under a heading, 8 px above a `.hint` that follows a field or a `.limits` list, and 20 px above `.actions`, all automatically; parts wrapped in a `.stack` get its 16 px gap and nothing more. `.card.ai` adds the gradient cap; it moves while the card holds a `<Skeleton>` or anything with `aria-busy="true"`. Never put a card inside a card.

Ask, then answer: one card for a model action and its answer. The answer is structured, one field per part, each `.describe()`d to name the input's specifics ("Each win names a card in Done"); the empty state says what is ready.

```tsx
// recap: respondJson's z.object({ wins: z.array(z.string()), themes: z.array(z.string()), nextStep: z.string() })
<section className={recap ? "card ai" : "card"} aria-labelledby="sum">
  <div className="card-head"><h2 id="sum">Your week</h2>{recap ? <ModelChip model="muse-wonder-1.0" verb="Written" /> : null}</div>
  {recap ? (
    <>
      <div className="prose">
        <h3>Wins</h3>
        <ul>{recap.wins.map((w) => <li key={w}>{w}</li>)}</ul>
        <h3>Themes</h3>
        <ul>{recap.themes.map((t) => <li key={t}>{t}</li>)}</ul>
        <h3>Next step</h3>
        <p>{recap.nextStep}</p>
      </div>
      <div className="actions"><button className="text" onClick={write}>Write it again</button></div>
    </>
  ) : (
    <div className="empty">
      <span className="icon-circle lg"><Icon name="sparkle" size={24} /></span>
      <h3>No recap yet</h3>
      <p>{done.length ? `${done.length} ${done.length === 1 ? "card" : "cards"} in Done. Get a recap of your week.` : "Move a card to Done first."}</p>
      <div className="actions"><button className="tinted ai" disabled={!done.length} onClick={write}><Icon name="sparkle" /> Get my recap</button></div>
    </div>
  )}
</section>
```

## Fields

```tsx
<div className="field">
  <label htmlFor="store">Store name</label>
  <input id="store" value={store} onChange={(e) => setStore(e.target.value)} />
  <span className="hint">As printed at the top of the receipt.</span>
</div>

<div className="fields two">
  <div className="field"><label htmlFor="from">From</label><input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
  <div className="field"><label htmlFor="to">To</label><input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
</div>

<div className="field">
  <label htmlFor="notes">Anything else? (optional)</label>
  <textarea id="notes" placeholder="Yellow spots, a new pot, just moved rooms" />
</div>

<label style={{ display: "flex", gap: 10, alignItems: "center" }}>
  <input type="checkbox" checked={tax} onChange={(e) => setTax(e.target.checked)} /> Include tax in the total
</label>
```

- Prefill dates (today, or the week ahead) so a date field never shows mm/dd/yyyy.
- `select` gets a drawn chevron. Field borders darken on hover.
- A field with a problem gets `aria-invalid="true"` (red border) and a `.hint` saying what to fix, which turns red inside a card.
- Text areas grow with their text and have no resize grip; keep them that way.

## FilePicker

```tsx
<FilePicker
  label="Photo of your receipt"
  accept="image/*"
  button="Take or choose a photo"
  change="Choose another photo"
  hint="The whole receipt, flat and in good light"
  file={file}
  disabled={busy}
  onFile={(f) => setFile(f)}
/>
```

- A dropzone: tap or click to choose, or drop a file on it. On phones the chooser offers the camera and the photo library. `capture="environment"` skips the library and opens the camera, so use it only with words like "Take a photo".
- The icon follows `accept` (image, mic, play, file; camera with `capture`). After a pick a photo shows as a thumbnail titled "Your photo", and any other file shows its name, with `change` (default "Choose another") as the way to swap it.
- `file={file}` keeps it in step with the product's state, so Start over empties it. For a sample the product loads, name the File for people, and that name shows: `new File([blob], "Sample receipt", { type: blob.type })`. Never show a fixture's file name.
- Picking the same file again still calls `onFile`. Check the file type in `onFile` yourself and show an `.error` for the wrong kind.
- Tests: `page.getByLabel("Photo of your receipt").setInputFiles("fixtures/receipt.jpg")`.

## Segmented

```tsx
<Segmented
  label="Where it lives"
  value={place}
  onChange={setPlace}
  options={[
    { value: "indoors", label: "Indoors" },
    { value: "outdoors", label: "Outdoors" },
  ]}
/>
```

Two to five options of a word or two. It lays them out from their labels: one row at equal widths when each fits its share of a phone's row (two of up to about 13 characters, three of about 6, four only like S, M, L, XL, five like 1 to 5), two rows of two for four that don't, otherwise one full-width row per option. In the 720 px column they go back to one row when the labels fit. A label never wraps inside its pill; a longer one goes in a `select`. Options are gray pills; the chosen one is tinted blue with a check. It is a native radio group: arrow keys move the choice. Tests: `page.getByRole("radio", { name: "Outdoors" }).check()`.

## Buttons

```tsx
<div className="actions">
  <button className="primary ai" disabled={!ready || busy} aria-busy={busy} onClick={run}>
    {busy ? "Checking your plant…" : "Check my plant"}
  </button>
  <button className="text" onClick={trySample}>Try a sample photo</button>
</div>
<div className="actions">
  <button className="tinted"><Icon name="plus" /> Add a row</button>
  <button className="secondary"><Icon name="refresh" /> Reset</button>
</div>
<div className="actions">
  <button className="tinted ai" disabled={busy} aria-busy={busy} onClick={summarize}>
    <Icon name="sparkle" /> {busy ? "Writing your summary…" : "Get my summary"}
  </button>
  <button className="icon" aria-label="Search"><Icon name="search" /></button>
</div>
```

- `primary`: Meta blue, one per screen, the action that moves the flow on; once the result is up, the one that delivers it (Download CSV, Copy, Print). Add `.ai` when it calls a model: with `aria-busy="true"` it shows the moving AI gradient. Keep it disabled until its required input is there.
- `secondary`: gray, only for utility actions (Reset, a second export, Edit beside model text). A disabled button is a fainter gray with gray text.
- `tinted`: light blue, for a card's main action that isn't the primary (Add a row) or an empty state's action; `.tinted.ai` with the sparkle for a model action that isn't the primary.
- `text`: blue text, for quiet actions (Try the sample, Make another), and the app bar's Start over. On a phone an `.actions` row holds at most two filled buttons; a third action is `.text`.
- `icon`: a 40 px round gray button inside a 44 px tap area. Always with `aria-label`.
- Every busy button gets `aria-busy="true"` and a label ending in "…" until the work is done; judgeShot waits for it.
- To confirm a quick action, change the button's own label for about 2 seconds: `{copied ? <><Icon name="check" /> Copied</> : <><Icon name="copy" /> Copy rows</>}`.

## Chips, tags and badges

```tsx
<div className="chips">
  <span className="chip">9 items</span>
  <span className="chip positive"><Icon name="check" size={16} /> Totals match</span>
  <span className="chip negative"><Icon name="alert" size={16} /> 1 price unclear</span>
  <span className="tag">Works offline</span>
</div>

<div className="chips">
  {CATEGORIES.map((c) => (
    <button key={c} className="chip" aria-pressed={on.has(c)} onClick={() => toggle(c)}>{c}</button>
  ))}
</div>

<ModelChip model="sam-3.1" verb="Outlined" />
```

- `.chip`: a short status. `.positive` and `.negative` tint it; keep the icon so color is never the only signal.
- `.tag`: an outlined feature label ("2 players"), so features never look like model credits.
- `button.chip[aria-pressed]`: a filter you turn on and off. Pressed is tinted blue and shows a check by itself.
- `ModelChip` props: `model` (one of the brief's models) and `verb` ("Read", "Outlined", "Rendered", "Transcribed", "Checked"). A white pill outlined in the AI gradient with a sparkle. Only on output that model made.
- `.ai-badge`: a small label saying "AI" or "Made with AI". Right inside `.media` it is a dark label in the photo's corner (see Images); anywhere else, like a figcaption, it looks like a small ModelChip.

## Working and loading

- `.working`: a line led by three dots in the AI colors. Name the step and end with "…". Give it `role="status"`.
- `Skeleton` props: `lines` (text lines, default 3), `height` (a block first, for an image or a table), `style`. It is hidden from screen readers and marks itself `aria-busy`, so judgeShot waits until it is replaced by the result.
- `<progress value={percent} max={100} />` for uploads with a known size. Never a bar without a value.

## Data

Three ways to show figures. Each figure appears once per screen, as a big number, a table cell or a `.kv` row, never two of these.

```tsx
<div className="big-number">412</div>
<p className="meta">Steps logged this week · estimate</p>

<div className="table-wrap">
  <table>
    <thead><tr><th>Item</th><th className="num">Price</th></tr></thead>
    <tbody>
      <tr><td>Olive oil, 1 L</td><td className="num">12.49</td></tr>
      <tr><td>Bread</td><td className="num">4.29</td></tr>
    </tbody>
  </table>
</div>
<dl className="kv">
  <dt>Subtotal</dt><dd>16.78</dd>
  <dt>Tax</dt><dd>1.34</dd>
  <dt>Total</dt><dd>18.12</dd>
</dl>

<dl className="kv">
  <dt>Store</dt><dd>Corner Market</dd>
  <dt>Water</dt><dd>Twice a week, about one cup each time</dd>
</dl>
```

- A `tfoot` row is the sum of the column above it, and only that. A receipt's subtotal, tax and grand total go in one `.kv` under the table, as above.
- Tables scroll sideways inside `.table-wrap`, never the page. Up to three columns on phones; more goes in `.kv` or `<details>`. judgeShot fails a box that scrolls sideways on a phone; mark it `data-allow-clip` only when scrolling is the point, like a spreadsheet's grid, and it gets a shadow at an edge with more past it (tint it with `--cover`, not `background`).
- In `.kv` each column takes the room its words need, and a long label and a long value share the row. Join a page reference to its number with a no-break space: `Q4 costs p.{"\u00a0"}3`.

Editable rows: values the person checks and fixes, like a receipt's items. One header row for the eye, then per row a one-line textarea that wraps a long name, an 88 px `.num` field and a remove button, each named by its `aria-label`. Rows with no number drop that column.

```tsx
<ul className="rows" aria-label="Items and prices">
  <li className="rows-head" aria-hidden="true"><span>Item</span><span className="num">Price</span></li>
  {items.map((it, i) => (
    <li key={it.id}>
      <textarea rows={1} aria-label={`Item ${i + 1}`} value={it.name} onChange={(e) => edit(it.id, { name: e.target.value })} />
      <input className="num" aria-label={`Price of item ${i + 1}`} inputMode="decimal" value={it.price} onChange={(e) => edit(it.id, { price: e.target.value })} />
      <button className="icon" aria-label={`Remove item ${i + 1}`} onClick={() => remove(it.id)}><Icon name="trash" /></button>
    </li>
  ))}
</ul>
```

## Charts

```tsx
<div className="bars" role="img" aria-label="Revenue by quarter: Q1 412, Q2 468, Q3 521, Q4 603">
  {rows.map((r) => (
    <div className="bar" key={r.label} style={{ "--value": Math.round((r.value / max) * 100) } as CSSProperties}>
      {`${r.value}\n${r.label}`}
    </div>
  ))}
</div>
```

- One series: `--value` is each bar's height from 0 to 100, a number (import `CSSProperties` from "react"). The text under each bar is its value, a line break and its label, so every label takes two lines. The bars are `--signature-line` on a gray panel 160 px tall.
- Every bar shares the panel's width: up to 16 fit a phone. From 9 bars, keep each line under a bar to about 4 characters (Jan, 1.2k, W12); past 12, write the text on every other bar only. More than 16 values: group them (weeks into months) or use a table. judgeShot fails bar text that runs into the next bar's.
- The `aria-label` says what the chart shows, with every value. A legend is only for several series, each in one of the decorative hues.

```ts
// Smoke test: the bars drew. A bar is its ::before, and the tallest is checked because a small value is rightly short.
const heights = await page.getByRole("img", { name: /^Revenue by quarter/ }).locator(".bar")
  .evaluateAll((bars) => bars.map((b) => parseFloat(getComputedStyle(b, "::before").height)));
expect(Math.max(...heights)).toBeGreaterThan(4);
```

## Lists, avatars and thumbnails

```tsx
<ul className="list">
  <li className="list-row">
    <span className="avatar square">CM</span>
    <div className="list-text">
      <span className="list-title">Corner Market</span>
      <span className="meta">Oct 27 · 9 items</span>
    </div>
    <span className="meta">$48.30</span>
  </li>
  <li>
    <button className="list-row" onClick={() => open(id)}>
      <img className="thumb" src={photoUrl} alt="" />
      <span className="list-text">
        <span className="list-title">Office supplies</span>
        <span className="meta">Oct 18 · 12 items</span>
      </span>
      <Icon name="chevron-right" />
    </button>
  </li>
  <li className="list-row">
    <span className="icon-circle">1</span>
    <div className="list-text">
      <span className="list-title">Let the top 5 cm dry out</span>
      <span className="meta">Push a finger into the soil before you water.</span>
    </div>
  </li>
</ul>
```

- `.avatar`: a 40 px gray circle with initials, or `<img>` inside it. People are round; things (a plant, a store, a group) use `.avatar.square`. Sizes `.sm` (32) and `.lg` (56).
- `.icon-circle`: a 40 px gray circle holding an `<Icon>` or the step's own number, never a range, page number, date or count; `.lg` is 56 px, for empty states.
- `.thumb`: a 56 px rounded image, like the photo a result came from.
- Rows are at least 56 px tall with no dividers; a tappable row highlights on hover.

## Notes, errors, limits, empty states, toasts, dialogs, extras

```tsx
<p className="note"><Icon name="info" /> Your photo is sent to Muse Wonder to read it. This app doesn't keep it.</p>

<div className="error" role="alert"><Icon name="alert" /> <strong>No plant found in that photo.</strong> Try a closer photo with the leaves in focus.</div>

<ul className="limits"><li>A photo can't show the roots. If more leaves yellow in two weeks, check them.</li></ul>

<div className="empty">
  <span className="icon-circle lg"><Icon name="image" size={24} /></span>
  <h3>No receipts yet</h3>
  <p>Add a photo of a receipt and its rows show up here.</p>
  <div className="actions"><button className="tinted"><Icon name="plus" /> Add a receipt</button></div>
</div>

<div role="status">{toast ? <div className="toast"><Icon name="check" /> {toast}</div> : null}</div>

<dialog ref={dialogRef} aria-labelledby="del">
  <h2 id="del">Delete this receipt?</h2>
  <p>Its rows go too. This can't be undone.</p>
  <div className="actions">
    <button className="primary" onClick={remove}>Delete</button>
    <button className="secondary" onClick={() => dialogRef.current?.close()}>Keep it</button>
  </div>
</dialog>

<details>
  <summary>Full transcript</summary>
  <p className="meta">{transcript}</p>
</details>
```

- An `<Icon>` as the first child of `.note` or `.error` hangs to the left of the text. Directly in `.stack`, between cards, a note or error takes a card's shape.
- `.toast` floats at the bottom center with the elevated shadow. Keep the `role="status"` wrapper mounted from the start so screen readers hear it, and hide the toast after about 3 seconds. Never take a judge screenshot while it is up.
- `dialog`: open it with `dialogRef.current?.showModal()`, for one short question. Never a whole flow.
- `details` gets a chevron; use it for long extras like a transcript or raw text.

## Chat

```tsx
<div className="thread" aria-live="polite" aria-busy={waiting}>
  {messages.map((m, i) => (
    <div key={i} className={`bubble ${m.role === "user" ? "out" : "in"}`} data-user-text={m.role === "user" ? "" : undefined}>
      {m.role === "user" ? m.text : <Markdown text={m.text} />}
    </div>
  ))}
</div>
<Composer label="Message" placeholder="Ask a follow-up question" busy={waiting} onSend={send} />
```

- `.bubble.out` is the person (Meta blue, right), `.bubble.in` the app or model (gray, left). Back-to-back bubbles from one side join up.
- `Composer` props: `label` (for screen readers and tests), `onSend(text)`, `placeholder`, `busy` (send shows the AI working state), `disabled`, `maxLength`. Enter sends; Shift+Enter adds a line. The box empties as the message goes; return false from `onSend` (or a promise of false) when it failed, and the text comes back. Tests: `page.getByLabel("Message").fill("…")`, then `page.getByRole("button", { name: "Send" }).click()`.

## Images and overlays

```tsx
<figure className="media">
  <img src={photoUrl} alt="Your feeder, with 3 birds outlined" />
  <svg className="overlay" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    {paths.map((d, i) => <path key={i} d={d} fill="none" stroke="var(--on-media)" strokeWidth={3} />)}
  </svg>
  <figcaption>Found 3 birds.</figcaption>
</figure>

<figure className="media">
  <img src={pageRender} alt="Page 3 of your report, with its 2 charts outlined" />
  <svg className="overlay" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
    {boxes.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={8} fill="var(--signature)" fillOpacity={0.15} stroke="var(--signature-line)" strokeWidth={3} />)}
  </svg>
  <figcaption>Found 2 charts on page 3.</figcaption>
</figure>

{/* The model's title, "Happy Dino Skate Day", is the card's h2. */}
<figure className="media">
  <img src={pageUrl} alt="Your coloring page: a dinosaur on a skateboard" />
  <figcaption><span className="ai-badge"><Icon name="sparkle" size={12} /> Made with AI</span> Ready to print on letter paper.</figcaption>
</figure>

<div className="gallery">
  <figure className="media">
    <img src={photoUrl} alt="Your photo: a white mug" />
    <figcaption>Your photo</figcaption>
  </figure>
  {scenes.map((s, i) => (
    <figure className="media" key={s.url}>
      <img src={s.url} alt={s.alt} />
      <span className="ai-badge"><Icon name="sparkle" size={12} /> AI</span>
      <figcaption>
        <span>Scene {i + 1}</span>
        <button className="icon" aria-label={`Download scene ${i + 1}`} onClick={() => download(s)}><Icon name="download" /></button>
      </figcaption>
    </figure>
  ))}
</div>
```

- The overlay's viewBox is the image's pixel size; it takes its height from that, so shapes line up at any width, with or without a caption. `strokeWidth` is in screen pixels, however far the image is scaled down.
- Over a photo, draw in `var(--on-media)`: white lines get a soft dark halo, so they show on light photos too. Over a page render, a document, a drawing or another light image, draw in `var(--signature-line)` at 3 px with a 15% `--signature` fill, as above. For several kinds of object, stroke each kind with one of `--cherry`, `--grape`, `--lemon`, `--lime`, `--pink`, `--teal`.
- An image with nothing drawn over it fits the screen's height, centered with its caption, so a whole page shows at once.
- The figcaption is the one line that says the result in words, so there is no second status line. When the model names the image, that name is the card's h2, not the caption. The card's ModelChip credits the model for everything in the card, so an `.ai-badge` ("AI" or "Made with AI") goes only where it can't: on a model's tile in a gallery that also holds the person's photo, or on an image in a card with no ModelChip. Over a photo it is white on `--scrim` in the corner; on a page or printable, whose corner holds content, it leads the figcaption.
- `.gallery` is one column on phones and up to three across the 720 px column. When the point is to compare before and after, the source is its first tile, the same size as each result. Per-tile actions are `button.icon` with an `aria-label`.

## Icon

```tsx
<Icon name="camera" />                 // 20 px, decorative, takes the text color
<Icon name="info" size={16} />         // 16 in chips, 24 in icon circles
<Icon name="close" label="Close" />    // only when nothing else names it
```

Names: upload, camera, image, file, mic, sparkle, check, alert, info, copy, download, refresh, arrow-right, chevron-left, chevron-right, chevron-down, close, play, stop, send, search, plus, more, edit, external, calendar, clock, trash. `sparkle` is for AI; `check` means done. Need another? Draw it the same way in the product: 24 px viewBox, 20 px live area, `fill="none"`, `stroke="currentColor"`, round caps and joins, 1.75 to 2 px strokes.

## Markdown

```tsx
<Markdown text={reply} />

{editing ? (
  <div className="field">
    <label htmlFor="draft">Your draft</label>
    <textarea id="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
  </div>
) : (
  <Markdown text={draft} />
)}
<div className="actions">
  <button className="secondary" onClick={() => setEditing(!editing)}><Icon name={editing ? "check" : "edit"} /> {editing ? "Done" : "Edit"}</button>
</div>
```

Paragraphs, headings, lists, rules, code and bold from a model's reply, styled by `.prose`. A single line break stays a line break. Never print model text raw. Text the person may edit shows rendered first, and Edit swaps in the textarea, which shows all of it inside a `.card.ai`. Under a card whose h2 is the draft's title, `<Markdown text={draft} title={title} />` leaves out a first heading that repeats it.

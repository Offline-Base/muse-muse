# Meta UI parts

Markup for every class in `app/globals.css` and every component in `components/`. Copy it as it is and change the words. Components import from `@/components/<Name>`. The first screen, the working state and the AI result card are in SKILL.md.

## Page

```tsx
<>
  <AppBar name="Leafwise" action={<button className="text" onClick={reset}>Check another plant</button>} />
  <main className="stack">
    <header className="hero">
      <h1>What does your plant need?</h1>
      <p className="tagline">Take a photo of the whole plant and get a care plan for this week.</p>
    </header>
    <section className="card" aria-label="Your plant">…</section>
  </main>
</>
```

- `AppBar` props: `name` (the product's name), `action` (one optional button), `href` (optional, makes the name a link home). It sits at the top with the base shadow and scrolls away with the page. One per page, above `<main>`.
- `.stack` spaces cards 16 px apart. `.row` is a wrapping flex row with 12 px gaps.
- `scrollIntoView({ block: "start" })` lands a result 12 px below the top of the screen.
- The footer comes from app/layout.tsx. Never remove it.

## Cards

A section is `<section className="card" aria-labelledby="...">` with an `h2`, or `aria-label` when its field label already names it (an input card). A result a model made is `.card.ai` with a `.card-head` holding the `h2` and a ModelChip. Parts inside a card get 16 px between them, 12 px under a heading, 8 px above a `.hint` that follows a field or a `.limits` list, and 20 px above `.actions`, all automatically. `.card.ai` adds the gradient cap; it moves while the card holds a `<Skeleton>` or anything with `aria-busy="true"`. Never put a card inside a card.

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
  fileName={file?.name ?? null}
  disabled={busy}
  onFile={(f) => setFile(f)}
/>
```

- A dropzone: tap or click to choose, or drop a file on it. On phones the chooser offers the camera and the photo library. `capture="environment"` skips the library and opens the camera, so use it only with words like "Take a photo".
- The icon follows `accept` (image, mic, play, file; camera with `capture`). After a pick it shows the file name, with `change` (default "Choose another") as the way to swap it.
- `fileName={file?.name ?? null}` keeps it in step with the product's state, so Start over empties it. For a sample the product loads, name the File for people: `new File([blob], "Sample receipt", { type: blob.type })`. Never show a fixture's file name.
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

Two to five options of one or two words; a `select` for more. Options are gray pills; the chosen one is tinted blue with a check. It is a native radio group: arrow keys move the choice. Tests: `page.getByRole("radio", { name: "Outdoors" }).check()`.

## Buttons

```tsx
<div className="actions">
  <button className="primary ai" disabled={!ready || busy} aria-busy={busy} onClick={run}>
    {busy ? "Checking your plant…" : "Check my plant"}
  </button>
  <button className="secondary"><Icon name="download" /> Download CSV</button>
  <button className="tinted"><Icon name="copy" /> Copy rows</button>
  <button className="text" onClick={trySample}>Try a sample photo</button>
  <button className="icon" aria-label="Search"><Icon name="search" /></button>
</div>
```

- `primary`: Meta blue, one per screen, the action that moves the flow on. Add `.ai` when it calls a model: with `aria-busy="true"` it shows the moving AI gradient.
- `secondary`: gray, for other actions (Download, Edit).
- `tinted`: light blue, for a strong second action or an empty state's action.
- `text`: blue text, for quiet actions (Try the sample, Start over). Also the app bar's action.
- `icon`: a 40 px round gray button. Always with `aria-label`.
- Every busy button gets `aria-busy="true"` and a label ending in "…" until the work is done; judgeShot waits for it. Disabled buttons turn gray.
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
- `.ai-badge`: a small AI label. Over a photo in `.media` it is a dark label (see Images); anywhere else it looks like a small ModelChip.

## Working and loading

- `.working`: a line led by three dots in the AI colors. Name the step and end with "…". Give it `role="status"`.
- `Skeleton` props: `lines` (text lines, default 3), `height` (a block first, for an image or a table), `style`. It is hidden from screen readers and marks itself `aria-busy`, so judgeShot waits until it is replaced by the result.
- `<progress value={percent} max={100} />` for uploads with a known size. Never a bar without a value.

## Data

```tsx
<div className="big-number">$48.30</div>
<p className="meta">Took 4 s · 6 lines · estimate</p>

<div className="table-wrap">
  <table>
    <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th></tr></thead>
    <tbody><tr><td>Olive oil, 1 L</td><td className="num">1</td><td className="num">$12.49</td></tr></tbody>
    <tfoot><tr><td>Total</td><td className="num">12</td><td className="num">$48.30</td></tr></tfoot>
  </table>
</div>

<dl className="kv">
  <dt>Store</dt><dd>Corner Market</dd>
  <dt>Water</dt><dd>Twice a week, about one cup each time</dd>
</dl>
```

Tables scroll sideways inside `.table-wrap`, never the page. Up to three columns on phones; more goes in `.kv` or `<details>`. In `.kv` the labels take up to half the row and long values wrap.

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

- `.avatar`: a 40 px gray circle with initials (in the signature hue when `data-accent` is set), or `<img>` inside it. People are round; things (a plant, a store, a group) use `.avatar.square`. Sizes `.sm` (32) and `.lg` (56).
- `.icon-circle`: a 40 px gray circle holding an `<Icon>` or a step number; `.lg` is 56 px, for empty states.
- `.thumb`: a 56 px rounded image, like the photo a result came from.
- Rows are at least 56 px tall with no dividers; a tappable row highlights on hover.

## Notes, errors, limits, empty states, toasts, dialogs, extras

```tsx
<p className="note"><Icon name="info" /> Your photo is sent to Muse Spark 1.3 to read it. This app doesn't keep it.</p>

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
  <span className="ai-badge"><Icon name="sparkle" size={12} /> Outlined by SAM 3.1</span>
  <figcaption>Found 3 birds.</figcaption>
</figure>
```

- The overlay's viewBox is the image's pixel size; it takes its height from that, so shapes line up at any width, with or without a caption.
- White lines get a soft dark halo, so they show on light photos too. For several kinds of object, stroke each kind with one of `--cherry`, `--grape`, `--lemon`, `--lime`, `--pink`, `--teal`.
- Over a photo `.ai-badge` is white on `--scrim`. The caption says the result in words.

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
```

Paragraphs, headings, lists, code and bold from a model's reply, styled by `.prose`. Never print model text raw.

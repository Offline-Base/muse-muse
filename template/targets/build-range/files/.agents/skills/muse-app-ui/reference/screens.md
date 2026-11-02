# Muse App UI screens

Five starting patterns, using the parts in `components.md`. They aren't the only shapes a screen can take: mix them, or build your own page from the brief's Design direction. Pick by what the person does. Most products are a tool, a form or a gallery: a chat layout on a product that answers once makes people type when one button would do.

The default frame is `<AppBar>`, then `<main className="stack">` in the 720 px column, then the footer from app/layout.tsx. Only the footer is required: the direction can widen the page, drop the column, or replace cards with sections, panes and boards. Every screen works at 390 px and in each color mode the product has.

## Tool: one input, one result

**Fits** when the person gives one thing (a photo, a PDF, a recording, a paragraph) and gets one result back: read a receipt, outline the birds, transcribe a note, check a plant.

**Shape:** hero, one input card with the primary button, then the result card. Once the result is up, the input card becomes its summary row (SKILL.md, The result replaces the input), so the result starts near the top.

```tsx
<main className="stack">
  <header className="hero">
    <h1>Check a plant from one photo</h1>
    <p className="tagline">Get what it needs this week, in plain steps.</p>
  </header>
  <section className="card" aria-label="Your plant">
    <FilePicker label="Photo of your plant" accept="image/*" button="Take or choose a photo" file={file} onFile={setFile} />
    <p className="hint">Your photo is sent to Muse Wonder to read it. This app doesn't keep it.</p>
    <div className="actions">
      <button className="primary ai" disabled={!file || busy} aria-busy={busy} onClick={run}>{busy ? "Checking your plant…" : "Check my plant"}</button>
      <button className="text" onClick={trySample}>Try a sample photo</button>
    </div>
  </section>
  {/* then the .card.ai result, marked data-result */}
</main>
```

- One primary button on the screen. Before the result it runs the tool; after, it delivers the result (Download, Copy).
- The hint under the input says where the input goes.

## Form: a few fields, one run

**Fits** when the answer depends on several choices: a trip plan from dates and a budget, a training week from a goal and the days free, a cover letter from a role and a tone.

**Shape:** hero, one card of fields, the primary button at the bottom of that card, the result under it. Short choices are `<Segmented>`, longer lists a `select`, dates prefilled.

```tsx
<section className="card" aria-label="Your week">
  <div className="fields two">
    <div className="field"><label htmlFor="goal">Goal</label><input id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} /></div>
    <div className="field"><label htmlFor="start">Starting</label><input id="start" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
  </div>
  <Segmented label="Days free" value={days} onChange={setDays} options={[{ value: "3", label: "3" }, { value: "4", label: "4" }, { value: "5", label: "5" }]} />
  <div className="actions">
    <button className="primary ai" disabled={!goal || busy} aria-busy={busy} onClick={plan}>{busy ? "Planning your week…" : "Plan my week"}</button>
  </div>
</section>
```

- `.fields.two` puts two fields side by side only when there is room; on a phone they stack.
- After the run, the whole form folds into one summary row with Edit, as in the Tool pattern. A form the person keeps changing (a calculator, a filter) stays open instead.

## Results: figures, rows and charts

**Fits** when the result is data the person reads or checks: totals, a schedule, a comparison, a score with its reasons.

**Shape:** one `.card.ai` with the answer first. Pick one form per figure: a `.big-number` for the one figure that matters, a `.kv` for label and value pairs, a `.table-wrap` for rows (three columns at most on a phone), `.bars` for up to 16 values, `.rows` when the person fixes the values.

```tsx
<section className="card ai" data-result aria-labelledby="out">
  <div className="card-head"><h2 id="out">Your spending</h2><ModelChip model="muse-wonder-1.0" verb="Read" /></div>
  <div className="big-number">412.80</div>
  <p className="meta">Spent in October, from 9 receipts</p>
  <dl className="kv">
    <dt>Groceries</dt><dd>238.10</dd>
    <dt>Eating out</dt><dd>174.70</dd>
  </dl>
  <div className="actions"><button className="primary"><Icon name="download" /> Download CSV</button></div>
</section>
```

- Each figure shows once per screen. Totals are added up in code, not by the model.
- A result card is never a dashboard of small cards: one card, one answer, details under it.

## Gallery: several images

**Fits** when the result is images: scenes made from one photo, coloring pages, outlined frames from a video, or a before and after.

**Shape:** the result card holds a `.gallery` of `.media` tiles, each with a caption row and its own icon buttons. When the point is the change, the person's photo is the first tile, the same size as each result.

```tsx
<section className="card ai" data-result aria-labelledby="out">
  <div className="card-head"><h2 id="out">Your mug, three ways</h2><ModelChip model="muse-image-1.0" verb="Made" /></div>
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
</section>
```

- One column on a phone, up to three across the column. Captions sit under the image, never over it, so nothing in the picture is hidden.
- A single image with nothing drawn over it fits the screen's height, centered with its caption.

## Chat: back and forth in words

**Fits** only when the person's job is a conversation: practicing a language, talking through a decision, asking follow-ups about their own document. If the first answer is the whole result, use Tool or Form.

**Shape:** before the first message, a start screen: `.hero.center` with a short question as the h1, then the composer, then up to three `button.chip`s that each fill the composer with a real question for this product. After the first message, the hero goes and the thread takes its place, with the composer under it.

```tsx
<main className="stack">
  {messages.length === 0 ? (
    <header className="hero center">
      <h1>What should we practice today?</h1>
    </header>
  ) : (
    <section className="card" aria-label="Your conversation">
      <div className="card-head"><h2>Spanish practice</h2><ModelChip model="muse-wonder-1.0" verb="Answered" /></div>
      <div className="thread" aria-live="polite" aria-busy={waiting}>
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role === "user" ? "out" : "in"}`} data-user-text={m.role === "user" ? "" : undefined}>
            {m.role === "user" ? m.text : <Markdown text={m.text} />}
          </div>
        ))}
      </div>
    </section>
  )}
  <Composer label="Message" placeholder="Write in Spanish or English" busy={waiting} onSend={send} />
  {messages.length === 0 ? (
    <div className="chips">
      {STARTERS.map((q) => <button key={q} className="chip" onClick={() => send(q)}>{q}</button>)}
    </div>
  ) : null}
</main>
```

- The person's words are a gray bubble on the right. The answer is plain text across the column, with no bubble, rendered with `<Markdown>`.
- One ModelChip in the card head, not on every answer.
- Starter chips are the product's own questions, written for its users, and each one sends for real. Leave them out when there is nothing useful to suggest.
- The last judge screenshot shows a finished answer, not the start screen.

## Two patterns on one screen

A tool or a form can end in a short chat about its result ("Ask about this receipt"): the result card first, then a card holding the thread and the composer. Keep the result's own primary button; the composer's send is not a second primary. Never put a chat above the result it talks about.

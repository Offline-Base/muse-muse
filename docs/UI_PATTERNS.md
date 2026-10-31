# UI patterns from the Meta Model API dashboard

Ethan shared screenshots of Meta's developer dashboard on Oct 27, 2026: the Chat playground (twice) and the Usage page, then the Dashboard, Chat, Image and Audio pages at 2x. The second set was measured pixel by pixel, and the numbers below are in CSS pixels from those measurements. This file describes them so the Muse Muse platform UI can sit next to them like another tab. It follows "Dashboard-native UI" in DESIGN.md: copy the **patterns**, never the identity.

Since Oct 31 the platform's colors, type and control sizes come from `docs/BRAND.md`, measured from live meta.ai. The layouts below still hold. Where a value here differs from that file, that file wins.

## Hard rules (from DESIGN.md)

- No Meta logo (the infinity mark), no "Meta" wordmark or "Meta Model API" in our header, and no Meta proprietary font. Use the font in `app/globals.css` (Inter, vendored in `app/fonts/`, since Oct 31).
- The brand slot is our own two-sparkle mark, **Muse Muse** and a **Concept** pill. The sidebar foot says "Not an official Meta product." above the account chip.
- Our sign-in page must not look like a Meta sign-in or API-key page. Keep it plain and clearly ours, and never ask for a Meta key.
- Don't put "Ask Meta..." in our composer. Ours says something like "Describe it, or drop in your inspo...".

## Overall frame

- **Three zones** on wide screens: a fixed 260 px left sidebar, a centered main column, and on playground pages a 360 px right settings panel 20 px from the top and right edges.
- **Sidebar background** is `#f2f4f6` (`--bg`) with a 1 px `#e0e2e5` right border. The **main area is white** (`--surface`).
- Lots of whitespace. Borders are 1 px `#e0e2e5` (`--line`). Cards, the hero card, example cards and the right panel all have a 16 px radius. Inputs have 10 px, the composer 24 px and chat bubbles 28 px. Only the composer has a shadow.
- Text: `#111112` for body, `#676a71` for secondary text (`--muted`), 15 px base. The accent is `#2962d8` (`--accent`).

## Sidebar

- **Top:** a 40 px brand row (mark plus name, 18 px semibold) 12 px from the top, then 16 px of space. The sidebar has 8 px of side padding.
- **Nav rows:** 40 px tall with 2 px between them and an 8 px radius. The icon draws about 18 px wide at x = 17 (our 24 px icons with 6 px left padding), and the 15 px medium label starts at x = 45.
- **Active row:** `#cddbf4` fill (`--nav-active`) with the icon and label in `#2962d8`. Inactive rows are dark text with no fill, and hover gets a faint fill.
- **Groups** are separated by 1 px `#e0e2e5` dividers with 8 px above and below. Meta's groups are [Home ↗], [Dashboard, Chat, Image, Audio, Segment], [API keys, Usage, Models, Team members, Billing] and [Status, Documentation ↗].
- **External links** show a 20 px "open in new" icon pinned to the right edge of the row.
- **Bottom:** an account chip 16 px from the bottom: a 32 px accent-blue circle with white initials, the name in 15 px semibold, a muted 12.5 px second line ("Business account"), and a "⋯" menu button on the right.

**Muse Muse mapping:**

| Group | Rows |
|---|---|
| 1 | Dashboard (`/dashboard`) |
| 2 | Make (`/`), Builds (`/builds`, the signed-in user's builds), Rebuilds (`/rebuilds`), Gallery (`/gallery`) |
| 3 | Usage (`/usage`) |
| 4 | How it works (`/how-it-works`), Model API docs ↗ (`https://dev.meta.ai/docs/overview`) |
| Bottom | Signed-in chip with initials and email, and a ⋯ menu with Sign out. Signed out: a plain "Sign in" button. With sign-in off (`OPEN_ACCESS`): the shared account ("Guest", or the admin's email), "Admin, sign-in off" or "Builder, sign-in off", and Sign in in place of Sign out |

Use inline SVG icons drawn in the same outline style (1.5 px stroke, `currentColor`), not an icon font or a CDN.

## Playground layout (Chat page): the model for the build room

### Top toolbar

Above the main column, aligned to the right of the column: text buttons with a leading icon. Meta has "+ New chat", "⇄ Compare", "</> Get code" and "History". They are 16 px medium weight with no background, and hover gets a faint fill.

For the build room: "+ New muse", "Open preview ↗", "Get connector" (copies the MCP URL), "History" (the product's earlier builds).

### Main column (the conversation)

- Centered, 720 px wide, with 15 px text on a 28 px line height. Headings like "Quick verdict" are 18 px semibold, and the model's progress notes before the answer are muted italic lines.
- **User turn:** right-aligned. Attached images show first as a rounded thumbnail (about 140×90 px, 16 px radius). The text is in a light grey pill bubble below it (`#eef0f3`, about 20 px radius, 12 by 18 px padding, 16 px text).
- **Assistant turn:** left-aligned with **no bubble**, full column width. It's rich text: a bold lead phrase, bold mini headings ("What's in it:"), bullet lists with bold lead words, and tables.
- **Tables:** a 1 px border around the whole table with a 16 px radius and overflow clipped. The header row has a grey fill (`#e9edf1`), bold, centered text. Cells have about 20 px of padding, left-aligned text, and 1 px row and column lines. The last row can be a bold "Total" row.
- **Metadata line** under each assistant turn: thumbs-up and thumbs-down outline icons, then muted 13 px text such as `14.5 s · Input 1.4K · Output 417 · Reasoning 678`.
- **Scroll affordance:** a small round white button with a down chevron floats above the composer when there's more below.

For the build room, the user turn is the muse (inspo thumbnails plus the note). The assistant turns are, in order: the brief (rendered as rich text with a models table), then Muse Code's live log, then check results, then the shipped result. Each assistant turn ends with a metadata line, such as `4 m 12 s · Input 1.2M · Output 31K · $0.94 est.`.

### Composer

- Floats at the bottom of the main column: a white card about 880 px wide with an 18 to 20 px radius, a soft shadow and a faint border.
- The placeholder is on the first line. Below it, a 36 px round outlined "+" button on the left (attach) and a 36 px round accent-blue send button with an up arrow on the right. The send button is paler (about 50% opacity) when the input is empty.
- On Muse Muse's home page this composer **is** the muse box: "+" attaches inspo files, chips for each attached file show above the text, and send starts the build.

### Right settings panel

- A `#f9f9f9` card with a 1 px `#f2f2f2` border and a 16 px radius, 360 px wide, with 22 px padding.
- **Field label** is 15 px regular, and the control sits 12 px below or to the right of it. About 19 px separate one control from the next label.
- **Select:** white, 1 px `#ced0d4` border, 10 px radius, 44 px tall, value at 15 px, chevron on the right. A disabled select has `#858585` text.
- **Icon action** next to a label, such as "System instructions ✎" or "Model settings ↻": a 32 px round button with a `#e2e5e8` fill and the icon centered.
- **Slider with number box:** the label sits on the left with a 36 px tall number box (about 66 px wide, 10 px radius, white) on the right of the same row, and the slider underneath runs the full width. The track is `#cdd3da` with the filled part in the accent blue, and the thumb is a 20 px accent-blue circle.
- **Toggle:** a 44×24 px pill. On is accent blue with a white knob, off is `#cdd3da`.
- **Disclosure row:** "Advanced" with a chevron on the right.

For the build room, the panel becomes a read-only **build panel**:

- Status, as a vertical step rail: Brief, Provision, Build, Preview, Check, Record, Deploy. Each step shows a dot that is pending, active or done.
- Model chips from the brief.
- Build model, Muse Code session id, fix rounds, elapsed time, and running cost.
- Links: Preview, Live, Demo video, Connector URL.
- The live preview, in an iframe card below the panel or in a tab, once it exists.

## Dashboard page: the model for `/dashboard`

- A 1088 px column, centered in the main area, starting 18 px from the top. Gaps between blocks are 12 px.
- **Hero card:** `#f2f4f6` fill, 16 px radius, 24 px padding, about 253 px tall. Its head row has the title on the left (26 px semibold, accent blue) and a tab control on the right. A 1 px divider sits 16 px below, then a muted 16 px line, a second tab control and a 48 px white code block (1 px border, 10 px radius, 15 px mono, copy icon on the right). Meta's title is "Start building with Muse" with tabs for Muse Code, OpenCode, Claude Code, Codex, cURL and Python, and the code block holds the install command with its URL as a blue underlined link.
- **Tab control:** a `#e4e6ea` track with 4 px padding and a 20 px radius. Items are 32 px tall with 16 px side padding, 15 px semibold and muted. The selected item is white with a small shadow and dark text.
- **Range buttons:** "7d", "30d", "90d", 28 px tall, 8 px radius, 14 px text, 4 px apart. The selected one is filled `#28292c` with white text; the rest are white with a 1 px border.
- **Stat cards:** three per row, 200 px tall, white, 1 px border, 16 px radius, 12 px padding. A 26 px bold number, a 15 px semibold label, then bars with no axis or gridlines: one 24 px `#7489f7` bar per day with a 4 px top radius, 86 px tall at most, and muted day labels 12 px below. Meta's first row is Requests, Input tokens and Output tokens. Its second row is an API keys card (a 40 px outlined icon circle, a muted label, the count, and "Create or manage keys" at the bottom), Spend as a bar card, and a Documentation card (a filled icon circle, an 18 px semibold title and a muted line at the bottom).

For Muse Muse the hero card is **Use your products in Muse**, with tabs for Muse app, Claude Code and cURL, product tabs below, and the product's connector URL or command in the code block. It only offers published products, since an unpublished product's connector doesn't answer. The cards are Requests, Input tokens, Output tokens, then Products (opens the gallery), Spend (est.) and How it works.

## Image playground: the model for Make (`/`) until Oct 31

These bullets describe Meta's Image playground as captured on Oct 27. Make followed it until Oct 31 and no longer does: the last paragraph of this section says what it is now.

- The toolbar sits at the top right of the main area ("Get code", "History"; ours are "How it works" and "History").
- About 100 px below it, a centered 24 px semibold title ("Start from an example") and a muted 15 px line.
- Then three example cards, 960 px wide in all with 18 px gaps. Each has a photo about 160 px tall, a dark pill on the photo's top left ("Generate", "Image Edit", "Multi-Image"), a 19 px semibold title and a muted 14 px description. Clicking one loads its prompt and photo.
- The composer is pinned to the bottom of the column, about 750 px wide.
- The right panel holds a disabled Model select (grey text), more selects and switches.

For Muse Muse, the examples are Receipt to spreadsheet, Sketch to habit tracker and Bakery menu boards, with photos made by `muse-image-1.0` in `public/examples/`. A click fills the note and attaches the photo as inspo.

Since Oct 31 the Make page follows meta.ai's own home instead of this playground (`docs/BRAND.md`, "Layout"): a centered "What should Muse make?" headline, the composer under it, then the three examples as photo cards with their label on the photo, all centered in the window. The toolbar stays. The disabled controls looked like settings a person could change, so the build setup is now a folded list of facts under the examples: Model, Builder, Fix rounds, Screenshot judge, Demo video, Publish and Muse app connector (Publish and the connector are off when `VERCEL_TOKEN` isn't set).

## Usage page: the model for `/usage`

- **Title** "Usage", about 28 px semibold. **Subtitle** is muted 14 px ("New usage can take up to an hour to appear." For us: "Counts every Meta Model API call made by Muse Muse and the products it shipped.").
- **Filter row:**
  - Dropdowns: white, 1 px border, 8 px radius, about 36 px tall, with a chevron. Meta has "All API keys" and "All models". Ours: "All products" and "All models".
  - A **segmented control**, "Total | By model". It has a grey track with a white raised pill for the active option, 14 px text, and muted inactive text.
  - On the right: a download icon button, a date-range button with a calendar icon ("Oct 21 – Oct 27"), then two 36 px round prev and next chevron buttons on a grey fill.
- **Stat-chart cards:** white, 1 px border, about 24 px radius, about 28 px padding.
  - The big number is about 36 px bold ("$0.00", "344.3k"), with a 17 px medium label below it plus a 16 px info icon in a circle.
  - An optional muted sub-line ("Cache hit rate: 39.1%").
  - Then a **bar or line chart** with horizontal gridlines only (light grey), muted 13 px axis labels, one bar per day, and a legend row of colored dots below.
  - The first card spans the full width (Spend). The next two sit side by side, half width each (Input tokens, Output tokens).
- **Chart colors:** a periwinkle blue (about `#7b8cf5`) for the main series and a soft orange (about `#f2b97c`) for the second series, stacked. Meta stacks cached input over uncached input.
- Large numbers are abbreviated (`344.3k`, `10.5k`, `1.2M`).

For Muse Muse, the full-width headline card is **Meta tokens driven** (input plus output), stacked by source: products versus building. The two half-width cards are **Spend (est.)** and **Builds** (shipped versus failed). Below them is a table of products with tokens, calls and cost. Draw the charts as inline SVG.

## Other screens

- **Gallery and Rebuilds:** a grid of cards in the same card style (24 px radius, 1 px border, white). Each card has a 16:9 thumbnail or demo video poster at the top, then the name, a muted one-line tagline, model chips, and a row of meta text (`Built in 6 m · $1.12 · 2 fix rounds`). Rebuild cards add a fit pill (Clean, Reframe or Partial) and a link to the original video.
- **Product page:** a playground-like split. The left side holds the live product in a large iframe card with "Open ↗". The right panel holds models, limits, cost per run, the connector URL with a copy button, and "How it was built" (a summary of the Muse Code transcript, plus a download of the redacted export).
- **Pills and chips:** 12 to 13 px, 600 weight, pill radius. Model chips use `--accent-soft` with accent text. Status pills: live is green, partial is amber, failed is red, building is blue.

## Measured tokens in `app/globals.css`

```css
--bg: #f2f4f6;              /* sidebar, hero card */
--surface-2: #f9f9f9;       /* right panel, with a 1px #f2f2f2 border */
--surface-3: #e4e6ea;       /* tab track */
--line: #e0e2e5;
--line-strong: #ced0d4;     /* select and number box borders */
--fg: #111112;
--muted: #676a71;
--faint: #858585;           /* disabled select text */
--accent: #2962d8;
--nav-active: #cddbf4;
--bubble: #e7eaee;          /* user bubble and table header */
--icon-fill: #e2e5e8;       /* round icon buttons in the panel */
--track: #cdd3da;           /* slider track, switch off */
--ink: #28292c;             /* selected range button */
--chart-1: #7489f7;
--sidebar-w: 260px;
--panel-w: 360px;
--col-w: 720px;
--composer-w: 760px;
--page-w: 1088px;
--radius-card: 16px;
--radius-bubble: 28px;
```

Both themes. Dark mode keeps the same structure: the sidebar on `--bg`, the main area on `--surface`, with the colors above swapped for their dark values.

## Phones

Below 760 px:

- The sidebar becomes a top bar with the brand and a menu button that opens the nav as a sheet.
- The build room's steps panel covers the conversation from the right below 1100 px, and is a full-screen sheet on phones (docs/UI_MUSE_APP.md).
- The composer stays pinned to the bottom with a 16 px side gutter.
- No horizontal page scroll. Tables scroll inside their own rounded container.

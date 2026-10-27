# UI patterns from the Meta Model API dashboard

Ethan shared three screenshots of Meta's developer dashboard on Oct 27, 2026: the Chat playground (twice) and the Usage page. This file describes them so the Muse Muse platform UI can sit next to them like another tab. It follows "Dashboard-native UI" in DESIGN.md: copy the **patterns**, never the identity.

## Hard rules (from DESIGN.md)

- No Meta logo (the infinity mark), no "Meta" wordmark or "Meta Model API" in our header, and no Meta proprietary font. Use the system font stack in `app/globals.css`.
- The brand slot says **Muse Muse** with a **Concept** pill. The footer says "Not an official Meta product."
- Our sign-in page must not look like a Meta sign-in or API-key page. Keep it plain and clearly ours, and never ask for a Meta key.
- Don't put "Ask Meta..." in our composer. Ours says something like "Describe it, or drop in your inspo...".

## Overall frame

- **Three zones** on wide screens: a fixed left sidebar (about 300 px), a centered main column, and on the playground page a right settings panel (about 400 px).
- **Sidebar background** is the soft blue-grey page color (our `--bg`, `#f1f4f7`). The **main area is white** (`--surface`). The sidebar has no visible border, only the color change.
- Lots of whitespace. Borders are thin and low contrast (`#dce2e8`-ish), radii are large (cards about 24 px, inputs about 10 px, chat bubbles about 20 px), and there are almost no shadows except the floating composer.
- Text: near-black `#1c2b33` for body, muted grey for secondary text. The accent is a bright blue (`--accent`).

## Sidebar

- **Top:** brand mark and name, 20 px, semibold. For us: "Muse Muse" plus the Concept pill, with no logo image.
- **Nav rows:** a 20 px outline icon (1.5 px stroke, rounded line caps) followed by a 16 px label with medium weight. Each row is about 48 px tall with 12 px horizontal padding and a 10 px radius.
- **Active row:** light blue fill (about `#d3e3fd`, our `--accent-soft`) with the icon and label in the accent text blue. Inactive rows are dark text with no fill, and hover gets a faint fill.
- **Groups** are separated by 1 px horizontal dividers with about 10 px of margin. Meta's groups are [Home ↗], [Dashboard, Chat, Image, Audio, Segment], [API keys, Usage, Models, Team members, Billing] and [Status, Documentation ↗].
- **External links** show a small "open in new" icon pinned to the right edge of the row.
- **Bottom:** an account chip pinned to the bottom of the sidebar. It has a 40 px solid accent-blue circle with white initials, the name in semibold, a muted second line ("Business account"), and a "⋯" menu button on the right.

**Muse Muse mapping:**

| Group | Rows |
|---|---|
| 1 | Make (`/`, sparkle or plus icon) |
| 2 | Builds (`/builds`, the signed-in user's builds), Rebuilds (`/rebuilds`), Gallery (`/gallery`) |
| 3 | Usage (`/usage`) |
| 4 | How it works ↗ (the repo's DESIGN.md or an about page), Status of the gateway (optional) |
| Bottom | Signed-in chip with initials and email, and a ⋯ menu with Sign out. Signed out: a plain "Sign in" button |

Use inline SVG icons drawn in the same outline style (1.5 px stroke, `currentColor`), not an icon font or a CDN.

## Playground layout (Chat page): the model for the build room

### Top toolbar

Above the main column, aligned to the right of the column: text buttons with a leading icon. Meta has "+ New chat", "⇄ Compare", "</> Get code" and "History". They are 16 px medium weight with no background, and hover gets a faint fill.

For the build room: "+ New muse", "Open preview ↗", "Get connector" (copies the MCP URL), "History" (the product's earlier builds).

### Main column (the conversation)

- Centered, about 820 px wide.
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

- A light grey rounded card (`--surface-2`, about 24 px radius) that fills the right column, with 24 px padding and rows spaced about 32 px apart.
- **Field label** is 16 px medium, and the control sits below or to the right of it.
- **Select:** white, 1 px border, 10 px radius, about 48 px tall, value at 16 px, chevron on the right.
- **Icon action** next to a label, such as "System instructions ✎" or "Model settings ↻": a 36 px round button with a slightly darker grey fill and the icon centered.
- **Slider with number box:** the label sits on the left with a small numeric input (about 90 px wide, 10 px radius, white) on the right of the same row, and the slider underneath runs the full width. The track is grey with the filled part in the accent blue, and the thumb is a 20 px accent-blue circle.
- **Toggle:** a 44×26 px pill. On is accent blue with a white knob, off is light grey.
- **Disclosure row:** "Advanced" with a chevron on the right.

For the build room, the panel becomes a read-only **build panel**:

- Status, as a vertical step rail: Brief, Provision, Build, Preview, Check, Record, Deploy. Each step shows a dot that is pending, active or done.
- Model chips from the brief.
- Build model, Muse Code session id, fix rounds, elapsed time, and running cost.
- Links: Preview, Live, Demo video, Connector URL.
- The live preview, in an iframe card below the panel or in a tab, once it exists.

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

## Tokens to add to `app/globals.css`

```css
--sidebar-w: 300px;
--panel-w: 400px;
--col-w: 820px;
--radius-card: 24px;
--radius-input: 10px;
--radius-bubble: 20px;
--bubble: #eef0f3;          /* dark: #1f2930 */
--table-head: #e9edf1;      /* dark: #1c252d */
--nav-active: #d3e3fd;      /* dark: #10233d */
--chart-1: #7b8cf5;
--chart-2: #f2b97c;
--shadow-float: 0 8px 28px rgba(16, 24, 40, 0.08), 0 1px 3px rgba(16, 24, 40, 0.06);
```

Both themes. Dark mode keeps the same structure: the sidebar on `--bg`, the main area on `--surface`, with the colors above swapped for their dark values.

## Phones

Below 760 px:

- The sidebar becomes a top bar with the brand and a menu button that opens the nav as a sheet.
- The playground's right panel stacks under the conversation as a collapsible "Build details" section.
- The composer stays pinned to the bottom with a 16 px side gutter.
- No horizontal page scroll. Tables scroll inside their own rounded container.

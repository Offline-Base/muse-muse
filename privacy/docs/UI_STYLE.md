# UI style

The approval page, dreaming report and charts should feel at home next to Meta's developer console (dev.meta.ai), since judges will see them beside it. Match the feel, not the brand: never use the Meta logo, the "Meta" wordmark, "Meta Model API" as our title, or any real person's name or avatar. Our name on screen is "Muse Privacy", with "Private workspace on this device" as the subtitle.

These notes come from screenshots of the console's Usage page, Chat playground and home page (Oct 27, 2026). Colors are read off screenshots, so treat them as close, not exact.

## Tokens

Define these as CSS custom properties on `:root`, with a dark variant under `@media (prefers-color-scheme: dark)`.

| Token | Light | Dark | Used for |
|---|---|---|---|
| --bg | #FFFFFF | #0F1115 | Main content |
| --bg-side | #F1F3F6 | #16191F | Sidebar and settings panel |
| --surface | #FFFFFF | #1B1F26 | Cards |
| --border | #E3E6EB | #2A2F38 | Card and input borders, 1px |
| --text | #1C1E21 | #E8EAED | Body text |
| --text-2 | #65676B | #A0A6B0 | Labels, captions, metric rows |
| --accent | #1D63ED | #4C8DFF | Primary buttons, sliders, links, focus rings |
| --accent-soft | #D9E4FA | #1E2B45 | Active nav item background |
| --chart-1 | #7B8CF0 | #8E9DF5 | First series (periwinkle) |
| --chart-2 | #F2B880 | #F5C597 | Second series (peach) |
| --ok | #2E9E5B | #46C07A | Working on the device (green light) |
| --wait | #E8A317 | #F2B640 | Waiting for your OK (amber light) |
| --send | #1D63ED | #4C8DFF | Tagged result going to Muse (blue light) |
| --danger | #D93025 | #F07167 | Kept on device, refused |

Type: `Inter, "Optimistic Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` from Google Fonts (Inter). Page title 32px semibold, card metric 32px bold, body 15px, captions 13px. Tabular numbers (`font-variant-numeric: tabular-nums`) for every metric.

Spacing and shape: 8px grid. Cards radius 16px with 24px padding. Inputs, dropdowns and nav items radius 8px. Buttons are pills (radius 999px). Shadows only on floating things (the composer-style action bar): `0 4px 16px rgb(0 0 0 / 6%)`.

## Layout

- Left sidebar, about 280px, `--bg-side`, product name at the top, nav items with 20px outline icons (1.5px stroke) and labels: Approvals, History, Dreaming, Device, Pairing. The active item gets an `--accent-soft` pill with `--accent` icon and text. A device chip pinned at the bottom (initials circle in `--accent`, device name "Laptop" or "Jetson", and the backend in `--text-2`).
- Main column max width about 1260px, left-aligned with 48px side padding. Page title, a one-line `--text-2` subtitle under it, then a toolbar row of white dropdowns and a segmented control.
- Under 720px wide the sidebar collapses to a top bar, cards stack, and side padding is 16px. No horizontal scroll.

## Components

- **Metric card**: white card, big number, label under it with an (i) info icon that shows a tooltip, an optional caption line ("Cache hit rate: 39.1%" style) and a chart below. Use for approvals per day, decision accuracy, agreement with you, leaks (always shown, even at 0).
- **Segmented control**: gray track (`--bg-side`), selected segment is a white pill with a subtle border. Use for "Pending | All" and "Total | By category".
- **Dropdown**: white, 1px `--border`, radius 8px, chevron on the right.
- **Primary button**: `--accent` pill, white text ("Share it"). **Secondary button**: `--bg-side` pill, `--text` ("Keep it here"). Destructive actions use `--danger` text on a secondary pill.
- **Approval card** (the heart of the page): the request from Muse in `--text-2`, then the exact tagged text that would leave in a monospace block on `--bg-side` with tags like `[Student A]` highlighted as `--accent-soft` chips, then blocked reasons as amber chips, then the router's reason, then the two buttons and the "Don't ask again for things like this" checkbox.
- **Metric row**: under each model step and approval, a small `--text-2` line in the console's format: `4.1 s · Input 10 · Output 26 · Reasoning 124`, plus which model and device ran it ("Glimmer IQ1_S on Jetson").
- **Light indicator**: a 12px dot plus label in the sidebar footer, colored `--ok`, `--wait` (pulsing) or `--send`, fed by the `/events` SSE stream.
- **Charts**: thin gridlines in `--border`, axis labels 12px `--text-2`, bars with 2px top radius, `--chart-1` first, `--chart-2` second, legend as colored dots under the chart. Same palette in matplotlib PNGs for the README and video.

## Copy

Plain words, sentence case, no em dashes. Buttons say what happens: "Share it", "Keep it here", "Dream now", "Delete this decision". Results to Muse never say "error"; they say "Waiting for your OK on the device" or "Kept on your device".

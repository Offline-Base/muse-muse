# Muse App UI tokens

Every token the muse-app look sets in `app/muse-app.css`, with its light and dark value, where the value comes from, and what it is for. Tokens not listed here keep their value from `app/globals.css` (the decorative hues, the spacing steps, the sizes, the easing curves). Every text pair the parts use passes WCAG AA in both modes.

Where each value comes from (`sources.md` has the details):

| Label | Means |
|---|---|
| **M** | Measured from the live page this look follows, in a browser, in light and dark |
| **S** | Sampled from the pixels of a 2x capture of the signed-in app |
| **E** | Estimated from a description of screenshots. Used only where nothing better exists |
| **O** | Ours: chosen for this template, mostly to keep AA contrast, touch sizes or the template's parts working |

## Color

| Token | Light | Dark | Source | Use |
|---|---|---|---|---|
| `--bg` | #FFFFFF | #181819 | M | the page |
| `--surface` | #FFFFFF | #181819 | M | cards, the app bar, dialogs. The same as the page, so a card has a hairline |
| `--surface-2` | #F3F4F5 | #28292B | M | fills: notes, table heads, the dropzone, the chart panel, the person's bubble |
| `--popover` | #FFFFFF | #181819 | M | dialogs, with a hairline and `--shadow-menu` |
| `--toast-bg` | #FFFFFF | #28292B | M, O | toasts. Dark is a step up, so it shows on the page |
| `--input-bg` | #FFFFFF | #181819 | M | text fields, selects, text areas |
| `--line` | black 10% | white 12% | M | every hairline: card edges, dividers, table borders, tags, the app bar's underline |
| `--field-line` | #8A8D91 | #6F7276 | O | text field borders, 3.3:1 light and 3.7:1 dark, so a field's edge shows. The measured hairline is too faint for a field |
| `--fg` | #111112 | #FFFFFF | M | headings, body, labels |
| `--fg-2` | rgba(0,4,9,.59) | rgba(242,247,255,.53) | M | tagline, hints, meta lines, limits, table heads. 5.4:1 on the page in both modes |
| `--placeholder` | same as `--fg-2` | same as `--fg-2` | O | placeholders. The measured placeholder is 2.5:1, under AA, so products use the secondary color |
| `--disabled` | rgba(0,7,17,.37) | rgba(241,246,255,.38) | M | disabled text and icons only |
| `--accent` | #0064D4 | #0064D4 | M light, O dark | primary button, selected marks, progress. White on it is 5.6:1. The measured dark accent is lighter, and white on it is 3.2:1, so dark keeps the light blue for fills |
| `--on-accent` | #FFFFFF | #FFFFFF | M | text and icons on `--accent` |
| `--accent-hover` | black 8% | black 8% | O | overlay on blue fills on hover |
| `--link` | #0064D4 | #1793FF | M | links, text buttons. 5.6:1 on the page in both modes |
| `--tinted-bg` | #E8F1FB | rgba(23,147,255,.16) | M light, O dark | tinted buttons, pressed filter chips, the dropzone while a file is dragged over it |
| `--tinted-hover-bg` | #DFEBF9 | rgba(23,147,255,.24) | O | hovered tinted button |
| `--tinted-fg` | #0064D4 | #5CADFF | M light, O dark | text on `--tinted-bg` |
| `--secondary-bg` | black 5% | white 12% | M | secondary buttons, chips, icon buttons, avatars, the segmented track |
| `--segment` | #FFFFFF | white 12% | M | the chosen option of a segmented control, with `--shadow-card` |
| `--hover` | black 5% | white 8% | M light, O dark | overlay on hover. The measured 12% dark leaves secondary text at 4.5:1 on a hovered row, so dark uses 8% |
| `--press` | black 10% | white 20% | O | overlay while pressed |
| `--focus` | #0064D4 | #1793FF | M | 2 px focus outline |
| `--progress-track` | blue 20% | blue 20% | O | `<progress>` track |
| `--overlay` | black 10% | white 6% | M | the page behind a dialog |
| `--positive` | #008200 | #07B123 | M | success text and icons |
| `--negative` | #C01F37 | #FA4758 | M | error text and icons |
| `--warning` | #C65323 | #F1916E | M | warning icons |
| `--positive-soft` | green 15% | green 15% | M | positive chip fill |
| `--negative-soft` | #FDE8E8 | red 15% | M | error box, negative chip fill |
| `--brand`, `--signature` | #0064D4 | #1793FF (signature) | M | the signature element and one-series charts: the action blue, the only signature color |
| `--signature-soft` | #E8F1FB | rgba(23,147,255,.16) | M light, O dark | fill under the signature element |
| `--signature-ink` | #0064D4 | #5CADFF | M light, O dark | text on `--signature-soft` or `--surface` |
| `--signature-line` | `--signature` | `--signature` | O | strokes and `.bar`s, at least 3:1 on `--surface` and `--surface-2` |
| `--ai-start` | #6547F5 | #6547F5 | S | AI gradient start: the purple of Muse Muse's working mark |
| `--ai-end` | #9B45F0 | #9B45F0 | O | AI gradient end. The mark's own end, #C15AF7, leaves white text at 3.5:1, so it is a deeper violet: white stays at least 4.6:1 along the whole gradient |
| `--ai-gradient` | 90deg, start to end | same | O | model chip and AI badge outlines, the busy AI button, the AI card's cap, the working dots |
| `--ai-soft` | #F0EDFE | rgba(101,71,245,.2) | O | the violet end of a busy `.tinted.ai` button's moving fill |
| `--glass` | rgba(255,255,255,.76) | rgba(56,56,56,.8) | M | the composer, over a 36 px backdrop blur |
| `--send-from`, `--send-to` | #0064D4, #5B70FF | #007FFD, #5B70FF | M | the send button's gradient, drawn in oklab. Only under its icon: white text on the right end is 4.0:1 |
| `--on-media` | #FFFFFF | #FFFFFF | O | lines and labels drawn over a photo |
| `--scrim` | black 60% | black 60% | O | dark glass under a label on a photo. The measured 50% leaves white at 4.0:1 over a white photo |
| `--bubble-in` | #F3F4F5 | #28292B | S | kept for older markup. In this look the answer has no bubble and the person's bubble is `--surface-2` |

## Type

| Token | Value | Source |
|---|---|---|
| `--font` | "Inter Variable", then system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial | O: Inter with its optical size axis, the closest open font to the measured text (about 1% mean width error with the tracking below) |
| `--font-display` | `var(--font)` | M: headings and text share one family |
| `--type-hero` | 400 28px/34px; 30px/34px from 720 px | M: regular weight. The phone size is the measured hero at 390 px, the wide one the measured title size |
| `--type-title` | 600 20px/25px | M: the measured section title |
| `--type-headline` | 600 17px/22px | O |
| `--type-body` | 400 16px/24px | M size, O line: between the measured body (22) and answer (26) lines |
| `--type-label` | 500 14px/20px | M: buttons and labels |
| `--type-meta` | 400 13px/18px | M: footnote |
| `--type-tiny` | 500 11px/16px | M size, O line |
| Tracking | -0.01em on body, `h1` and `h2` | O: corrects Inter's width to the measured text |
| Composer text | 400 18px/27px | M |
| Chat text | 400 16px/26px | M, S |

Inter is self-hosted from npm (`@fontsource-variable/inter` 5.3.0, OFL), imported as `@fontsource-variable/inter/opsz.css` in app/layout.tsx. No stylistic alternates: its default double-story "a" matches. No other font, and nothing from a font CDN.

## Radius

| Token | Value | Source | Use |
|---|---|---|---|
| `--radius-sm` | 8px | S | `.thumb`, tags in tables, inline code, skeleton lines |
| `--radius` | 12px | M | fields, notes, errors, tables, list rows, the options inside the segmented track |
| `--radius-lg` | 16px | M | cards, the segmented track, toasts, page-level notes and errors |
| `--radius-bubble` | 22px | M | the person's chat bubble |
| `--pill` | 9999px | M | buttons, chips, avatars, progress |
| Composer, dialog | 32px, built in | M | |
| `.media` photos | 18px, built in | M, E | |

## Size

Controls stay `--control-height` (44 px) for touch, and icon buttons 40 px (O). The measured page uses 36 px buttons, which is too small for fingers. The composer is 52 px on one line. The column is `--page-width` (720 px).

## Elevation

| Token | Value | Source | Use |
|---|---|---|---|
| `--shadow-base` | an inset 1 px `--line` at the bottom | O | the app bar: a hairline, no shadow |
| `--shadow-card` | inset white highlight, then 2, 6 and 30 px soft black at 2 to 7% | M | the composer, the chosen segment |
| `--shadow-emphasis` | `--shadow-card` | M | a floating button |
| `--shadow-menu` | inset highlight, a 1 px `--line` ring, 12 and 60 px soft black at 4 and 12% | M | menus, dialogs |
| `--shadow-elevated` | a 1 px `--line` ring, the same two soft layers | M | toasts |

In dark mode the inset highlight drops to white 6%. Cards have no shadow: `.card` draws its hairline as an inset ring.

## Motion

| Token | Value | Source |
|---|---|---|
| `--dur-xxs` | 150ms | M: hover and press |

Every other duration and curve is the template's. Only the AI working state (the busy AI button, the AI cap, the working dots) moves on its own.

# Meta UI tokens

Every token in `app/globals.css`, with its light and dark value, where the value comes from, and what it is for. "FB" is Facebook's web CSS variable of the same role; "Meta" is meta.com's stylesheet; "Horizon" is Meta's Horizon OS design guidance. Sources are listed in `sources.md`. Values marked "ours" were chosen for this template. Every text pair the parts use passes WCAG AA in both modes.

## Color

| Token | Light | Dark | Source | Use |
|---|---|---|---|---|
| `--bg` | #F0F2F5 | #1C1C1D | FB `--web-wash` | page background |
| `--surface` | #FFFFFF | #252728 | FB `--surface-background`, `--card-background` | cards, app bar, sheets |
| `--surface-2` | #F0F2F5 | #333334 | FB `--comment-background` | fills inside a card: notes, table heads, dropzone, composer, the chart panel, disabled fields |
| `--popover` | #FFFFFF | #3B3C3E | FB `--popover-background` | menus, popovers, dialogs |
| `--toast-bg` | #FFFFFF | #242526 | FB toast fill | toasts |
| `--input-bg` | #FFFFFF | #242526 | FB `--input-background` | text fields, selects, text areas |
| `--line` | #CED0D4 | #3E4042 | FB `--divider` | dividers, table borders, outlined tags, the dropzone, disabled fields |
| `--field-line` | #8A8D91 | #6F7276 | ours, from FB grays (FB fields use #CED0D4, about 1.5:1) | text field borders, 3.3:1 light and 3.1:1 dark so a field's edge shows; hovered fields use `--fg-2`, as FB does |
| `--fg` | #080809 | #E2E5E9 | FB `--primary-text` | headings, body, labels |
| `--fg-2` | #65686C | #B0B3B8 | FB `--secondary-text` | tagline, hints, meta lines, limits, table heads, note icons, a hovered field's border |
| `--placeholder` | #65686C | #A1A4A9 | FB `--placeholder-text` | placeholders |
| `--disabled` | #B0B3B8 | #6F7276 | FB `--disabled-text` | disabled text and icons only |
| `--accent` | #0866FF | #0866FF | FB `--accent`, `--primary-button-background` | primary button, outgoing bubble, checked boxes, progress |
| `--on-accent` | #FFFFFF | #FFFFFF | FB | text and icons on `--accent` |
| `--accent-hover` | black 8% | black 8% | ours | overlay on blue fills on hover (keeps white text AA) |
| `--link` | #0064D1 | #5AA7FF | FB `--blue-link` | links, text buttons |
| `--tinted-bg` | #EBF5FF | rgba(29,133,252,.2) | FB deemphasized button; dark selected state is ours | tinted buttons, selected chips and segments, drag-over. FB's dark selected chip (#1D85FC with white text, 3.6:1) fails AA, so dark selection stays tinted |
| `--tinted-hover-bg` | #DBEBFF | rgba(29,133,252,.28) | ours | hovered tinted button |
| `--tinted-fg` | #0064D1 | #75B6FF | FB deemphasized button text | text on `--tinted-bg` |
| `--secondary-bg` | #E2E5E9 | white 10% | FB `--secondary-button-background` | secondary buttons, chips, segments, icon buttons, avatars; at 60% the fill of a disabled button |
| `--hover` | black 5% | white 10% | FB `--hover-overlay` | overlay on neutral fills on hover |
| `--press` | black 10% | white 20% | FB `--press-overlay` | overlay while pressed |
| `--focus` | #0866FF | #1D85FC | FB focus ring | 2 px focus outline |
| `--progress-track` | rgba(8,102,255,.2) | same | FB progress ring track | `<progress>` track |
| `--overlay` | rgba(244,244,244,.8) | rgba(11,11,11,.8) | FB `--overlay-alpha-80` | the page behind a dialog |
| `--positive` | #24832C | #3FBB46 | FB `--positive` | success text and icons |
| `--negative` | #DD2334 | #FF7C74 | FB `--negative` | error text and icons |
| `--warning` | #AF8F00 | #AF8F00 | FB `--warning` | warning icons only (3.1:1 on white, too light for text) |
| `--positive-soft` | #E9F3EA | #293F2D | ours (10 to 16% of positive) | positive chip fill, filled dropzone check |
| `--negative-soft` | #FCEDEF | #483534 | ours (8 to 16% of negative) | error box, negative chip fill |
| `--brand` | #0064E0 | #0064E0 | Meta brand blue (meta.com) | default signature hue, gradient start |
| `--ai-start` | #0064E0 | #0064E0 | Meta brand blue | AI gradient start |
| `--ai-end` | #A033FF | #A033FF | violet from meta.com's ring | AI gradient end |
| `--ai-gradient` | 90deg, start to end | same | ours | model chip and AI badge outlines, the busy AI button, the AI card cap, the working dots. White text is at least 4.7:1 along all of it |
| `--ai-soft` | #F6EBFF | violet 20% | ours | the violet end of a busy `.tinted.ai` button's moving fill; `--tinted-fg` stays AA on it |
| `--signature` | var(--brand) | #1D85FC | Meta blue, FB dark accent | signature element, one-series charts |
| `--signature-soft` | #EBF5FF | rgba(29,133,252,.2) | FB tinted | fill under the signature element |
| `--signature-ink` | #0064D1 | #75B6FF | FB tinted text | text on `--signature-soft` or `--surface` |
| `--signature-line` | var(--signature) | var(--signature) | ours | strokes and `.bar`s, at least 3:1 on `--surface` and `--surface-2` in every hue |
| `--cherry` `--grape` `--lemon` `--lime` `--pink` `--teal` | #FB3C44 #7D74FF #F9CF00 #3FBB46 #FA61BA #14B898 | same | FB decorative hues | only chart series a legend names, or overlays, one hue per kind of object. Never text, buttons, or borders, stripes and fills in the UI that tell categories apart |
| `--on-media` | #FFFFFF | #FFFFFF | FB `--always-white` | lines and labels drawn over a photo |
| `--scrim` | black 60% | black 60% | ours | dark glass under a label on a photo (white on it is 5.7:1 even over white) |
| `--bubble-in` | #F0F0F0 | #303030 | FB incoming bubble | incoming chat bubble |
| `--skeleton` | #979A9F at 40% | #979A9F at 30% | FB glimmer gray, softened (ours) | skeleton shapes |

## Accent hues (`data-accent`)

Each sets `--signature`, `--signature-soft`, `--signature-ink` and, where the hue is too pale for a line, `--signature-line`, and tints `.avatar` initials. The hue is Facebook's; the soft, ink and line values are ours, made so ink, `--fg` and `--fg-2` on soft and ink on a card pass AA (4.6:1 or more), and lines are 3:1 or more on a card and on `--surface-2`.

| `data-accent` | `--signature` | Soft, light | Ink, light | Line, light | Soft, dark | Ink, dark |
|---|---|---|---|---|---|---|
| none | #0064E0 (dark #1D85FC) | #EBF5FF | #0064D1 | the hue | blue 20% | #75B6FF |
| `cherry` | #FB3C44 | #FEE4E5 | #BF2E34 | the hue | #542C2E | #FC7C82 |
| `grape` | #7D74FF | #EDECFF | #615AC7 | the hue | #383857 | #A49EFF |
| `lemon` | #F9CF00 | #FEF8DB | #816C00 | #A48900 | #4C441B | #F9CF00 |
| `lime` | #3FBB46 | #E4F5E5 | #297A2D | #359E3B | #2B482F | #5EC664 |
| `pink` | #FA61BA | #FEE9F5 | #AA427E | #E057A7 | #543448 | #FB84C9 |
| `teal` | #14B898 | #DEF5F1 | #0D7863 | #119C81 | #214741 | #3CC4AA |

In dark mode every line is the hue itself.

## Type

| Token | Value | Source |
|---|---|---|
| `--font` | "Inter Variable", then system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial | Inter is Horizon's developer typeface; Facebook UI uses the system stack |
| `--font-display` | "Montserrat Variable", then "Inter Variable", then the system stack | Montserrat is meta.com's first fallback after its own Optimistic VF |
| `--font-mono` | ui-monospace, SF Mono, Menlo, Consolas, Monaco | FB code stack |
| `--type-hero` | 700 28px/34px display; 32px/38px from 720 px | FB headline1 28/34; Horizon H1 32/36 on wide screens |
| `--type-title` | 700 20px/26px display; 24px/30px from 720 px | FB headline2 24/30 |
| `--type-headline` | 700 17px/22px display | FB headline3 17/22 |
| `--type-body` | 400 16px/24px | FB body 15/20, raised to 16 for phones and to stop iOS zoom in fields |
| `--type-label` | 600 15px/20px | FB secondary label 15/20, button labels 600 |
| `--type-meta` | 400 13px/18px | FB meta caption 13/18 |
| `--type-tiny` | 600 11px/16px | FB tertiary 11/16 |

Both fonts are self-hosted from npm (`@fontsource-variable/inter` 5.3.0 and `@fontsource-variable/montserrat` 5.3.0, OFL) and imported in app/layout.tsx. Headings at 24 px and up use -0.01em to -0.02em tracking.

## Space and size

| Token | Value | Source |
|---|---|---|
| `--space-2` to `--space-36` | 2, 4, 8, 12, 16, 20, 28, 36 px | FB spacing steps |
| `--gutter` | 16px | FB margin 16 |
| `--page-width` | 720px | ours: one readable column (Horizon panels run 384 to 1440 wide) |
| `--appbar-height` | 56px | FB top bar 56 (the bar scrolls with the page, so full-page screenshots stay whole) |
| `--control-height` | 44px | FB buttons are 32, 36 or 40 tall; 44 here for touch (Horizon asks 48 or more for hit targets) |

## Radius

| Token | Value | Source | Use |
|---|---|---|---|
| `--radius-sm` | 6px | FB inputs and chips 6 | `.thumb`, tags in tables, inline code, skeleton lines |
| `--radius` | 10px | FB newer medium button 10 | buttons, fields, notes, errors, tables, list rows, toasts, photos |
| `--radius-lg` | 16px | FB bottom sheets 16, Horizon cards 16 | cards, dialogs, sheets, page-level notes and errors |
| `--radius-bubble` | 18px | FB chat bubbles and composer 18 | chat bubbles |
| `--pill` | 999px | Horizon pill role, FB composer pill | chips, segments, avatars, progress. The composer uses half `--control-height`, so it stays a pill on one line and keeps its corners when it grows |

## Elevation

| Token | Value | Use |
|---|---|---|
| `--shadow-base` | 0 1px 2px rgba(0,0,0,.2) | the app bar |
| `--shadow-emphasis` | 0 2px 12px rgba(0,0,0,.2) | a floating button |
| `--shadow-elevated` | 0 8px 20px rgba(0,0,0,.2), 0 2px 4px rgba(0,0,0,.1) | toasts, bottom sheets |
| `--shadow-menu` | 0 12px 28px rgba(0,0,0,.2), 0 2px 4px rgba(0,0,0,.1), inset 1 px white ring (50% light, 5% dark, FB `--shadow-inset`) | menus, dialogs |

All four are Facebook's elevation levels. Surfaces are flat fills; shadows are only for layers that float.

## Motion

| Token | Value | Use |
|---|---|---|
| `--ease-enter` | cubic-bezier(.14,1,.34,1) | something appearing: a toast, a result |
| `--ease-exit` | cubic-bezier(.45,.1,.2,1) | something leaving |
| `--ease-move` | cubic-bezier(.17,.17,0,1) | moving or expanding, like a disclosure chevron |
| `--ease-passive` | cubic-bezier(.5,0,.1,1) | slow loops: the AI working gradient and the moving cap |
| `--ease-quick` | cubic-bezier(.1,.9,.2,1) | press feedback |
| `--ease-soft`, `--ease-strong` | cubic-bezier(.08,.52,.52,1), cubic-bezier(.12,.8,.32,1) | gentle or emphatic emphasis |
| `--dur-xxs` | 100ms | hover, press, color changes |
| `--dur-xs-in` / `--dur-xs-out` | 200 / 150ms | chips, toggles, small fades |
| `--dur-short-in` / `--dur-short-out` | 280 / 200ms | toasts, results appearing |
| `--dur-medium-in` / `--dur-medium-out` | 400 / 350ms | sheets, bigger moves |
| `--dur-long-in` / `--dur-long-out` | 500 / 350ms | page-sized changes |

All are Facebook's FDS curves and durations. The skeleton pulse is Facebook's glimmer: opacity .25 to 1 over 1000 ms, `steps(10, end)`, alternating; the working dots pulse the same way. Dialogs fade and grow from 96% over `--dur-medium-in` with `--ease-enter`. Pressed buttons scale to .975. Everything stops under `prefers-reduced-motion`.

# Muse Muse brand and UI spec

The owner asked (Oct 31, 2026) for Muse Muse's UI to sit closer to meta.ai, and for that look to reach the products it
builds. This file is the reconciled spec: every value the app should use, where each one came from, and what's left to
do. `docs/UI_MUSE_APP.md` stays the detailed record of the conversation surfaces. Where the two differ, this file wins.

Muse Muse isn't Meta's app. It borrows a way of laying out a page, not a brand. See [Rules](#rules).

## How to read the labels

Every value carries one label. When sources disagree, the higher one in this list wins, and the
[differences table](#differences-from-the-spec) records it.

| Label | Source | How far to trust it |
|---|---|---|
| **M** | Measured: computed styles and CSS variables read from live www.meta.ai, Oct 31, 2026, in headless Chromium, signed out, at 1440x900 and 390x844, light and dark | Exact, for what a signed-out visitor sees |
| **M-demo** | Measured, from the small product demos inside the marketing page | Exact for color and radius. Text there is drawn smaller than in the app, so sizes are weak |
| **S** | Sampled from pixels of a 2x capture of the signed-in app (`docs/UI_MUSE_APP.md`) | Close, and the only look at the signed-in conversation |
| **E** | Estimated: the owner's brand spec, a model's reading of screenshots we don't have | A guess. Used only where nothing better exists |
| **O** | Ours: a Muse Muse value kept or chosen because no source covers it | Change freely |

**Three samples checked out exactly.** The live secondary text `rgba(0,4,9,.59)` on white is `#696B6E`, and the faint
text `rgba(0,7,17,.37)` on white is `#A1A3A7`, the very values S sampled. The 768 px column is a live variable. So S can
be trusted where M can't reach.

**What M can't see.** The signed-out page is a marketing page with a working composer. It answered HTTP 403 and still
served its full content, with no login wall, bot check or cookie banner, so the numbers are from the real page. Nothing
was typed or sent. The page has no conversation, chat history, active sidebar row, account menu, search palette, toast,
voice state, mode pill or category chips. Those values are S or E, and they say so.

## Rules

Hard rules. They apply to the platform, to the skills and to anything a build makes from them.

- **Not Meta's app.** No Meta logos and no copy of Meta's seven-petal mark as ours. Meta's terms (section 7) grant no
  trademark license. Keep the Muse Muse name, the purple working icon until the mascot replaces it, and the footer
  "Built with Muse Muse. Not an official Meta product." The platform's sidebar disclaimer and Concept tag stay too.
- **Words we never show:** "Ask Meta AI", "Meta AI" as our name, "Meta (c) 2026", "Download Meta AI". No links to Meta's
  legal pages presented as ours.
- **No dead controls.** A control appears only if it does something real, under an honest name. The "Thinking" pill stays
  out until a real model or effort switch exists. [Left out](#left-out-of-the-spec) lists the rest.
- **Fonts.** Meta's typeface is proprietary: never load it, never name it in a font stack. Self-host an open font.
  Nothing from fonts.googleapis.com, because builder sandboxes block CDNs.
- **The docs mirror** under `/docs` keeps its own look, apart from the chat components it already shares.
- **It's a look change.** With all feature flags off, routes and logic stay the same, and every test keeps passing unless
  it pinned the old look. Keep files where they are: prefer tokens, CSS and existing components over moves or renames.
- **Dark mode and 390 px keep working,** with no sideways scroll. No em dashes in anything a user sees or in docs.

## Tokens

These reuse the names already in `app/globals.css`, so a change there stays small. That file sets each dark value twice,
under `@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`. Change both.

### Color

| Token | Light | Dark | Label | Notes |
|---|---|---|---|---|
| `--bg`, `--chat-bg` | `#ffffff` | `#181819` | M | Page and sidebar. Was `#f2f4f6` and `#0e1013` |
| `--surface` | `#ffffff` | `#181819` | M | Cards and menus on the page. `.main` paints with it, so it has to match the canvas |
| `--surface-2` | `#f3f4f5` | `#28292b` | M | Filled bands and panels |
| `--surface-3` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.12)` | M | Secondary button and pill fill |
| `--line`, `--chat-line` | `rgba(0,0,0,.1)` | `rgba(255,255,255,.12)` | M | Every hairline. S read `#E5E5E5`, the same on white |
| `--line-strong` | `rgba(0,0,0,.16)` | `rgba(255,255,255,.2)` | O | Hover on an outlined control |
| `--panel-line` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.12)` | M | Segmented track. S read `#F2F2F2`, the same on white |
| `--fg` | `#111112` | `#ffffff` | M | Text and icons |
| `--fg-2` | `rgba(0,2,7,.68)` | `rgba(242,247,255,.53)` | M | Emphasized secondary. In dark the live variable is dimmer than plain secondary, so dark uses plain secondary |
| `--muted`, `--chat-muted` | `rgba(0,4,9,.59)` | `rgba(242,247,255,.53)` | M | Secondary. 5.36:1 on white, 5.41:1 on dark |
| `--faint`, `--chat-faint` | `rgba(0,7,17,.37)` | `rgba(241,246,255,.38)` | M | Chevrons, the Done check. Not for text you need to read |
| `--chat-placeholder` | `rgba(0,7,17,.37)` | `rgba(241,246,255,.38)` | M | **Owner call:** 2.52:1 on white and 3.09:1 on the dark card, under AA. S's `#878787` is 3.59:1. One token to change |
| `--accent`, `--accent-text`, `--focus` | `#0064d4` | `#1793ff` | M | Links, focus, progress. 5.57:1 and 5.62:1 |
| `--accent-ink` | `#ffffff` | `#ffffff` | M | On the accent |
| `--accent-soft` | `color-mix(in srgb, #0064d4 9%, white)` | `rgba(23,147,255,.16)` | M, O | Light is the live tint. The live dark mix goes pale, so dark is ours |
| `--send-from` | `#0064d4` | `#007ffd` | M | The gradient, see below. S read about `#2A62CC` |
| `--send-to` | `#5b70ff` | `#5b70ff` | M | S read about `#5D6DF5` |
| `--nav-active` | `#f2f2f2` | `#343435` | M | The live sidebar fill variable. M has no active row to confirm its use. Was blue |
| `--bubble`, `--chat-bubble` | `#f3f4f5` | `#28292b` | S, M | S sampled it in the app. M has the same value as a fill |
| `--hover` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.12)` | M | Rows, icon buttons |
| `--hover-2` (new) | `rgba(0,0,0,.075)` | `rgba(255,255,255,.15)` | M | Hover on an already filled control |
| `--chat-segment` | `#ffffff` | `rgba(255,255,255,.12)` | M | The chosen segment |
| `--chat-label` | `#e7e8eb` | `#2b3037` | S, O | Label on hover over a media card |
| `--work-from`, `--work-to` | `#6547f5`, `#c15af7` | `#8068f8`, `#cd78f9` | S, O | The working icon. Unchanged |
| `--ok`, `--ok-soft` | `#008200`, `#22c55e26` | `#07b123`, `#22c55e26` | M | |
| `--warn`, `--warn-soft` | `#c65323`, `#eab30826` | `#f1916e`, `#fbbf2426` | M | |
| `--bad`, `--bad-soft` | `#c01f37`, `#fde8e8` | `#fa4758`, `#dc262626` | M | |
| `--chart-1` to `--chart-6` | as they are | as they are | O | No source. Unchanged |
| Code block fill | `#f3f4f5` | `#1f1f20` | M | |
| Scrim on media | `rgba(0,0,0,.5)` | same | M | |
| Dialog overlay | `rgba(0,0,0,.1)` | `rgba(255,255,255,.06)` | M | |

**The gradient** is `linear-gradient(to right in oklab, var(--send-from), var(--send-to))` (M), on primary buttons and
Send. White text on its right end is 4.03:1 (3.85:1 in dark), a little under AA for small text. It matches the live
page, so the platform keeps it. Products don't: see [Products](#products).

### Surfaces and elevation

All M. Each shadow sits on the surface fill beside it.

| Token | Value | Fill | Used for |
|---|---|---|---|
| `--shadow-card`, `--shadow-chip` | `inset 0 1px 0 rgba(255,255,255,.64), 0 0 2px rgba(0,0,0,.02), 0 0 6px rgba(0,0,0,.03), 0 6px 30px rgba(0,0,0,.07)` | `rgba(255,255,255,.76)` with `backdrop-filter: blur(36px)`. Dark: `rgba(56,56,56,.8)` | Composer, floating pills and circles |
| `--shadow-pop` | `inset 0 1px 0 rgba(255,255,255,.64), 0 0 12px rgba(0,0,0,.04), 0 12px 60px rgba(0,0,0,.12)` | `rgba(255,255,255,.76)` with `blur(60px)` | Menus |
| Same, on a dialog | as `--shadow-pop` | `#ffffff`, 1px `--line`. Dark: `#181819` | Large popovers |
| `--shadow-segment` | same as `--shadow-card` | `--chat-segment` | Chosen segment |
| `--shadow-showcase` (new) | `inset 0 1px 0 rgba(255,255,255,.64), 0 0 2px rgba(0,0,0,.02), 0 0 10px rgba(0,0,0,.03), 0 10px 50px rgba(0,0,0,.07)` | `#f3f4f5` | A large framed preview (M-demo) |
| `--shadow-side` | as it is | | Panel over the conversation, up to 1100 px (O) |

In dark, every inset highlight is `rgba(255,255,255,.06)`. The outer shadows keep their values (M). Hairline-only cards
have no shadow.

### Radius

| Size | Used for | Label |
|---|---|---|
| 8 px | Thumbnails | S |
| 12 px | Sidebar rows, menu rows, the rail's icon buttons | M |
| 16 px | Menus, segmented track and segment, hairline cards | M |
| 18 px | Small tiles inside a card, example cards | M-demo, E |
| 22 px | The person's bubble, inner cards | M-demo |
| 24 px | Large cards, media card | M-demo, S |
| 32 px | Composer, large popovers | M, S |
| `9999px` | Buttons, pills, circles | M |

`--pill` stays. `--radius-card` stays 16 px. `--radius-input` goes from 10 px to 12 px (O, to match the rows).

### Motion

Hover and press: `150ms cubic-bezier(.4, 0, .2, 1)` (M). Only the working icon moves on its own. New steps fade in over
150 ms, and the panel opens without sliding (S). The live hero's letter-by-letter line isn't copied: it's Meta's own
flourish, and S's rule stands.

## Type

### The font

The live page uses Meta's own variable typeface, weights 400 to 600 (M). We can't. I measured 18 strings of live text
and laid the same strings out locally in each candidate:

| Candidate | Mean width error | Largest error | Hero line |
|---|---|---|---|
| Inter with the optical size axis, `-0.01em` | **1.02%** | 1.9% | -0.7% |
| System stack (SF Pro on the Mac tested) | 1.06% | 1.9% | -1.5% |
| Inter with the optical size axis, no tracking | 2.69% | 3.8% | +1.7% |
| Inter, weight axis only (the template's import today) | 3.21% | **11%** | +11% |

**Use Inter** with the optical size axis, `letter-spacing: -0.01em`, under the SIL Open Font License. It ties the system
stack on a Mac and it looks the same on every OS, while the system stack would become Segoe on Windows and Roboto on
Android, both unmeasured. It costs one 73 KB file.

- **The file:** `inter-latin-opsz-normal.woff2` from `@fontsource-variable/inter` 5.3.0, the template's own dependency.
  Vendor it with its license at `app/fonts/` and load it with `next/font/local`, since `node_modules` here is a shared
  symlink. `native/lab/assets/Inter.LICENSE.txt` is the license text.
- **Stack:** `--font: var(--font-inter), system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
  Text outside Latin falls back to the system font.
- **Smoothing:** `-webkit-font-smoothing: antialiased` on the body (M).
- **No stylistic alternates.** The spec's `cv02 cv03 cv04 cv11` give Inter a single-story "a". The live "a" is
  double-story, in a 2x capture of the hero, and Inter's default already matches.
- **One family.** Headings and text share it (M). No second display font.

### Scale

The live variables give the whole scale (M). `letter-spacing` is normal live. Ours is `-0.01em` everywhere, only to
correct Inter's width.

| Role | Size / line | Weight | Label | Replaces |
|---|---|---|---|---|
| Hero | `clamp(28px, 7.2vw, 48px)` / 1.08 | 400 | M at 1440 (48) and 390 (28.08). The formula fits both | `.play-intro h1` 24, 600 |
| Title 1, page title | 30 / 34 | 400 | M | `.page-head h1` 26, 600 |
| Title 2 | 24 / 29 | 400 | M | |
| Title 3, section | 20 / 25 | 600 | M | `.section-head h2` 19, 600 |
| Composer text | 18 / 27 | 400 | M | 18 / 26 |
| Response, the answer and the bubble | 16 / 26 | 400 | M, S agree | |
| Body | 16 / 22 | 400 (500, 600 to stress) | M | `body` 15 / 1.5 |
| Subheadline, buttons | 14 / 20 | 500 | M | `.btn` 15, 500 |
| Subheadline, rows and menus | 14 / 20 | 400 | M | `.nav-link` 15, 500 |
| Footnote | 13 / 18 | 400 (500 to stress) | M | |
| Caption 1, legal line | 12 / 16 | 400 | M | `.disclaimer` 11.5 |
| Caption 2 | 11 / 13 | 400 | M | |

The change that moves the look most here is **regular-weight headlines**. Bold is rare on the live page.

## Layout

| Thing | Value | Label |
|---|---|---|
| Conversation and composer column | 768 px, centered | M, S |
| Sidebar open | 256 px, canvas fill, no divider | M |
| Sidebar collapsed | 56 px rail | M |
| Steps panel | 400 px, 1 px left hairline | S |
| Page gutter on phones | 16 px | O |
| Composer margin on phones | 24 px, 342 px wide at 390 | M |
| Phone menu sheet | The full width of the window | M |
| Make page block | Hero, then 32 px, then composer, centered in the window as one block | M |
| Gap between turns | About 48 px | S |

The live hero is **centered**. The spec's left-aligned axis describes the signed-in greeting, which M can't see, so M's
centered hero stands. It also suits Muse Muse's Make page, which every signed-out visitor sees first.

## Components and states

Class names are today's. Keep them.

### Buttons (`.btn`, `.icon-btn`), all M

| Kind | Size | Fill and text | Hover |
|---|---|---|---|
| Primary `.btn-primary` | 36 px, `0 14px`, gap 2 px, full radius | The gradient, white, 14 / 500 | No change |
| Secondary `.btn`, `.btn-outline` | Same | `--surface-3`, `--fg`, 14 / 500, no border | `--hover-2` |
| Small `.btn-sm` | 32 px, `0 12px` | Either, 14 / 400 | Same |
| Floating | 40 px, `0 12px 0 14px` | Glass, `--shadow-chip`, 14 / 500 | |
| Icon, outlined `.composer-tool` | 32 px circle, 24 px icon | Transparent, `inset 0 0 0 1px var(--line)` | `--hover` |
| Icon, plain `.icon-btn-plain` | 32 px circle | `--muted` icon | `--hover` |
| Disabled | | `opacity: .5` | |
| Focus | | `outline: 2px solid var(--focus)` on buttons | |

Keep `.btn-block` at 46 px on the sign-in form (O).

### Composer (`.composer`, `Composer.tsx`, `SteerBox.tsx`)

- **Card:** up to 768 px, radius 32 px, glass fill, `--shadow-card`, no border (M). 107 px tall with one line of text on
  the Make page (M), and about 130 px in the build room (S).
- **Text:** 18 / 27, starting 20 px from the left and 16 px from the top (M, S).
- **Bottom row:** 32 px controls, 14 px from the edges (M, S).

| State | What shows | Label |
|---|---|---|
| Empty | Placeholder in its token. Send at half strength | M at 390 and S. Live at 1440 read full strength, so two of three sources say half |
| Typing | Send at full strength. No visible change on focus: the live card keeps its shadow, and the caret marks it | M |
| Attachments | The chips above the text, as now, with `--line` | O |
| Dragging | `0 0 0 2px var(--accent)` ring, "Drop to attach" | O |
| Submitting | Spinner in Send | O |
| Voice, recording | Real, in `VoiceInputButton`. The placeholder reads "Listening...". "+" becomes a 32 px outlined X that throws the take away (Escape's action today). The mic becomes a 32 px pill: three dots at 3.5 px, a 13 px stop square, the clock | E for shape. Our actions |
| Voice, transcribing | Spinner in the mic. The X cancels | O |
| Build running | Send becomes a stop square while the box is empty. With a note, Stop sits beside Send | S |
| Error | `.form-error` under the card | O |

Send stays the same color while recording. The spec's cobalt `#3563F6` isn't confirmed anywhere, and Send doesn't do
anything new in that state.

### Examples under the composer (`.ex-grid`, `.ex-card`)

Three cards of real examples, starting 16 to 20 px under the composer: radius 18 px, aspect ratio 0.86, full-bleed
photo, a scrim `linear-gradient(180deg, transparent 45%, rgba(0,0,0,.68))`, caption 14 / 500 white at the bottom left
(E, with M's button type). Three across from 560 px, one per row under it at 16:9. "Use my camera" and the tag stay,
since they work. There's no separate text line in the card: the example's description becomes its `title`.

### Sidebar (`.sidebar`, `.nav-link`, `Brand.tsx`, `AccountMenu.tsx`)

All M unless it says otherwise.

- **Container:** 256 px, `--bg`, no border, 12 px side padding.
- **Row:** 232 x 32 px, radius 12 px, padding `6px 12px 6px 4px`, gap 6 px, a 24 px icon box, 14 / 400. 1 px apart.
- **Hover:** `--hover`. **Active:** `--nav-active`, text stays `--fg` (the fill M, the use inferred), weight 500 (O: E's
  600 is heavier than anything else on the page).
- **Group gaps:** 16 px of space, no rule between groups (O). Today's groups stay.
- **Brand:** our two-sparkle mark in `--fg`, the name 14 / 500, the Concept tag in a neutral fill. Same 12 px inset as
  the live logo slot. It never becomes the working icon or anything petal-shaped.
- **Foot:** disclaimer 12 / 16 in `--muted`, then the account row: 32 px avatar in `--surface-3` with `--fg` initials,
  name 14 / 400, role 12 / 16 (E, with M's scale). Sign in is a small primary button.

### Menus (`.menu`, `.menu-item`), all M

- **Card:** radius 16 px, padding 6 px, glass with `blur(60px)`, `--shadow-pop`, no border. About 231 px wide.
- **Row:** 36 px, radius 12 px, padding `6px 8px`, 14 / 400. Icon 20 px, 8 px of space after it.
- **Hover:** `--hover`. **Keyboard focus:** `inset 0 0 0 2px var(--fg)`.
- **Divider:** 0.5 px `--line`, 8 px side inset, 6 px above and below.
- **End marks** (chevron, external link): 16 px in `--faint`.
- **Destructive:** text and icon `--bad`, hover `--bad-soft` (E, with M's colors).

### Segmented tabs (`.chat-tabs`, `.tabs`, `.range`, `.segmented`), M

Track 36 px, `--panel-line`, radius 16 px, 4 px inset. Chosen segment 28 px, radius 16 px, `--chat-segment`,
`--shadow-segment`. Labels 14 / 500 in `--fg` whether chosen or not. S read 15 px and a fully round track on the steps
panel. M is the same control measured directly, so it wins.

### Conversation kit (`components/chat`), mostly S

- **Title chip:** 36 px tall, 12 px side padding, 15 px text (S), with `--shadow-chip` and glass (M).
- **Share and More:** 36 px circles 8 px apart, 16 px icons (S), same surface (M).
- **Bubble:** right-aligned, up to 75% of the column, `--chat-bubble`, 16 / 26, 44 px tall on one line, 16 px side
  padding (S). Radius 22 px whatever its height (M-demo). Today's is 25 px. Attachments are 40 px squares at 8 px (S).
- **Working step:** icon 18 px, title 16 / 26 in `--chat-muted`, description 13 / 18, on a 1 px `--line` thread (S). The
  spec's purple gradient rail is left out. S saw a plain hairline.
- **Show thinking:** icon 18 px still, 14 px gap, 15 px `--chat-muted`, small chevron (S). M-demo showed 13 / 500 at
  demo scale: not adopted.
- **Answer:** no bubble, 16 / 26, 12 px between paragraphs (S, and M's response variable).
- **Media card:** the column's width, radius 24 px (S, M-demo).
- **Steps panel:** as `docs/UI_MUSE_APP.md` has it, with the segmented tabs above. Sources uses the same list (S).
- **Scroll button:** 32 px circle, glass, 16 px above the composer (S).

### Cards, data and pages

No source covers these, since the live page has no dashboards. Apply the tokens and scale, and keep them quiet.

- **Page head:** Title 1 in `--fg`, subtitle body in `--muted`. Never accent-colored headings.
- **`.card`:** `--surface`, 1 px `--line`, radius 16 px (M for a hairline card).
- **`.hero-card`:** `--surface-2`, no border, radius 24 px (M-demo). Heading in Title 3 in `--fg`.
- **Big numbers (`.dash-num`):** Title 1, 400 (O).
- **Status pills:** keep their tones, with the new soft fills. **`.chip`, for models:** `--surface-3` and `--fg` (O), so
  blue is left for links and actions.
- **Icon circles:** `--surface-2` and `--fg` (O).
- **Tables:** 14 / 20, hairlines only, `--muted` headers at 13 / 18 (O).
- **Inputs:** 40 px, radius 12 px, 1 px `--line`, 2 px `--focus` outline (O).

## Left out of the spec

| From the spec | Why it's out | Real alternative |
|---|---|---|
| Seven-petal logo and its SVG | Meta's mark. No trademark license | Our two-sparkle mark, then the mascot |
| "Ask Meta AI..." placeholder | Meta's name | "Describe it, or drop in your inspo..." |
| Instant / Thinking pill | No model or effort switch exists | Nothing, until one does |
| Media | No such feature | Nothing |
| Artifacts | No such feature, and its 2x2 shapes icon is Meta's | Gallery stays, under its own name |
| Scheduled | No recurring agent tasks | Nothing |
| Vibes, Vibes.ai | No such feed. Our vibe tuning is something else and keeps its name | Nothing |
| Search, Command-K palette | No platform search. The docs' palette only searches docs | Nothing yet |
| History list, unread dot | Needs a new query in the root layout, which is a logic change | Builds row, and the History button on Make |
| Sidebar collapse | Would be real, but it's new state in the shell | Later, see the gap list |
| Notification bell | No notifications | Nothing |
| Profile menu: View profile, Apps, Settings, Keyboard shortcuts | None exist | The account menu keeps My builds and Sign in or out |
| Download app, Download Meta AI | Muse Muse has no app to download, and the second is Meta's name | Nothing |
| AI Demos, AI identification, Report an issue | Meta's links | Nothing |
| "Meta (c) 2026" and Privacy, Terms, AI Terms, Cookies | Meta's legal pages aren't ours | The disclaimer and the footer |
| Discover and Ask anything chips, with starter grid | No matching feature. Their prompts are Meta's | Our three examples |
| Take action, Create images chips | Same | Same |
| Time-of-day greeting | Copy nobody asked for, and M's headline doesn't change | One fixed headline |
| Thumbs up, thumbs down | Nothing stores feedback | Nothing |
| Copy on a response | Could be real, but no answer in a build needs it yet | The Share button copies the link |
| Pin, Rename, Delete chat | No such actions on a build | The More menu's real actions |
| Toast "Link copied" | Share already says it on its own button | That button |
| Mascot character | The owner's mascot lands later, in `WorkingIcon` | The working icon |
| Designer names, font history, design philosophy | Unverified. Not used | Nothing |

## Differences from the spec

| Thing | Spec (E) | Use | Source | Why |
|---|---|---|---|---|
| Sidebar width | 248 | 256 | M | Live |
| Sidebar row | 36 tall, radius 10, 13.5 px | 32 tall, radius 12, 14 / 400 | M | Live |
| Hero | 28, left-aligned | 48 at 1440, 28 at 390, centered | M | Live. The spec's is the signed-in greeting, unseen |
| Single-story "a" with `cv` features | On | Off | M | The live "a" is double-story |
| Display font | Plus Jakarta Sans | Inter only | M | One family live |
| Text color | `#09090B` | `#111112` | M, S | Live |
| Secondary | `#71717A`, `#52525B` | `rgba(0,4,9,.59)` | M, S | Live, and it matches the sample |
| Placeholder | `#A1A1AA` | `rgba(0,7,17,.37)` | M | Live. See the owner call |
| Send, idle | `#8B9CFE` flat | Gradient at half strength | M, S | Live is a gradient and `opacity: .5` |
| Send, voice | `#3563F6` | Same gradient | M | No live cobalt |
| Primary blue | Not stated | `#0064d4` to `#5b70ff` | M | Live |
| Unread dot | `#2563EB` | Left out | | No such feature |
| Composer radius, width | 26, 680 | 32, 768 | M, S | Live |
| Composer height | 116 | 107 on Make, 130 in the room | M, S | Live |
| Composer text | 15.5 | 18 / 27 | M, S | Live |
| Composer shadow | 3 layers, with a ring | M's 4 layers, no ring | M | Live |
| Controls gap, edge | 18 and 20 px padding | 14 px from the edges | M, S | Live |
| Button | 32 tall, 13 px | 36 tall, 14 / 500 | M | Live |
| Menu radius | 16 to 20 | 16 | M | Live |
| Menu row radius | 10 | 12 | M | Live |
| Segmented track | Fully round, 13 px | Radius 16, 14 / 500 | M | Live |
| Dividers | `#F1F1F4` | `rgba(0,0,0,.1)` | M | Live |
| Dark mode | Not covered | The live values | M | Live |
| Chat column | 680 to 700 | 768 | M, S | Live variable |
| Message text | 15 / 24 | 16 / 26 | M, S | Live variable, and the sample |
| Thinking rail while working | Purple gradient | 1 px hairline | S | The capture |
| Step dot | 5 px | 8 px | S | The capture |
| Panel width | 340 | 400 | S | The capture |

## The docs mirror

`/docs` shares `app/globals.css` and the sidebar with the platform: `docs.css` reads the shared tokens in 129 places. So
retinting `--bg` would retint the docs. To keep their look:

- **Freeze the tokens.** In `docs.css`, put today's values of the shared tokens under
  `:root:has(.docs-frame), :root:has(.docs-nav)`, in light and both dark forms. Don't freeze `--chat-*`, `--send-*`,
  `--work-*`, or the composer's shadow, since the docs chat shares that kit and it should follow.
- **Keep the sizes.** Tokens don't cover `.btn`, `.menu`, `.nav-link` or `.page` geometry. Check them with before and
  after shots of `/docs`, and pin what moves under `.docs-frame` or `.sidebar:has(.docs-nav)`.
- **Its font doesn't move.** It stays what `app/docs/font.ts` loads. That file's comment names Meta's typeface; reword
  the comment next time the file changes.

## Products

### What's there

- `template/.agents/skills/meta-ui` and `product-ui`, `template/app/globals.css` and `template/AGENTS.md` set today's
  house look: gray wash, flat white cards, Meta blue, Inter with Montserrat headings, a blue-to-violet AI gradient.
- `lib/brief/render.ts` names meta-ui in the build prompt ("read `.agents/skills/meta-ui` for the look", "The look always
  comes from the meta-ui skill, in Meta blue") and in the fix and change prompts ("Keep the product's current look").
- `lib/prompts/judge.ts` describes that same look as the expected house style. Copying "a real product's look" otherwise
  blocks a build.
- `lib/brief/__tests__/flags-off.test.ts` pins all of those prompts byte for byte. It **doesn't read `template/`**: every
  build reads `template/AGENTS.md` and the skills, flags or not.
- Template changes reach builds only through a new snapshot (`npm run snapshot`, then `BUILDER_SNAPSHOT_ID`).
- A refine keeps the sandbox a product was built in, and its copy of the template, so shipped products never change on
  their own.
- `setupBuilder` carries `template/targets/` but says it only counts toward the hash: I found nothing yet that copies an
  overlay into a workspace.
- `template/tests/judge-shot.ts` and `template/scripts/smoke-report.mjs` rely on `.card.ai`, `data-result` and `aria-busy`.
- The look has already been tuned through canaries and undone once (`e21beb5`), so a change here can cost verify and
  judge passes.

### Recommendation: a second look, behind a flag

Don't rewrite meta-ui. Add beside it, and gate what tells a build to use it.

1. **Add files only, in the template:** `.agents/skills/muse-look/` (`SKILL.md`, `reference/tokens.md`,
   `reference/components.md`) and `app/look.css`. The skill's description is narrow: "Use only when the build prompt
   names it." `look.css` isn't imported by default, so nothing changes on a flags-off build. `globals.css`, `meta-ui`,
   `product-ui` and `AGENTS.md` stay exactly as they are.
2. **Add a flag,** `MUSE_LOOK_ENABLED`, read through `lib/env.ts`, and add it to `FLAGS` in `flags-off.test.ts`.
3. **Branch the prompts on it,** only where they name the look: the five lines in `render.ts` that name meta-ui and the
   house-style sentence in `judge.ts`. With the flag on, the prompt says to read `muse-look` and import `./look.css` after
   `globals.css`, and the judge is told the new house style is expected. With it off, the goldens don't move, and the
   test proves it. Add flag-on assertions to `brief.test.ts`.
4. **Roll out in order:** snapshot first, flag second, because a prompt that names a missing skill would break a build.
   Run canaries with the flag on, against the same checks.
5. **Make it the default later,** on purpose, with `UPDATE_GOLDEN=1`, so the diff shows what changed.

An overlay under `template/targets/` is the cleaner home, since flags-off sandboxes wouldn't even hold the files, but it
would need a new copy step. It can come later if a stray skill matters.

### What `look.css` does

It changes **values, not names**: same tokens, same classes, same components, so verify, the judge's screenshots and the
demo studio keep working.

| Template token or rule | Value | Note |
|---|---|---|
| `--bg`, `--surface`, `--popover`, `--input-bg` | `#ffffff`, dark `#181819` | White page |
| `--surface-2` | `#f3f4f5`, dark `#28292b` | |
| `--line` | `rgba(0,0,0,.1)`, dark `rgba(255,255,255,.12)` | |
| `--fg`, `--fg-2` | `#111112`, `rgba(0,4,9,.59)`, and the dark values above | |
| `--placeholder` | Same as `--fg-2` | **Keeps AA.** The skill promises it |
| `--accent`, `--focus`, `--link`, `--signature` | `#0064d4`, dark `#1793ff` | **Flat on text buttons,** for AA |
| Send (`.composer .send`) | The gradient | Icon only, so 3:1 is enough |
| `--ai-start`, `--ai-end` | `#6547f5`, `#c15af7` | The AI mark becomes the purple of the working icon |
| `--font-display` | `var(--font)` | One family. Add `@fontsource-variable/inter/opsz.css`, already in the dependency. Hero 11% too wide without it |
| `--type-hero`, `--type-title`, `--type-headline` | 400 28/34, 600 20/25, 600 17/22 | Regular hero |
| `body` | `letter-spacing: -0.01em` | |
| `--radius`, `--radius-lg` | 12 px, 16 px | |
| `.card` | `box-shadow: inset 0 0 0 1px var(--line)` | White on white needs an edge |
| `.bubble.out`, `.bubble.in` | `--surface-2` and `--fg`; no fill | The person's bubble turns gray |
| `.composer` | Radius 32 px, `--shadow-card` | |
| `.appbar` | No shadow, 1 px `--line` under it | |
| Montserrat | Stops being used. The import stays | Same `package.json`, same snapshot |

The skill keeps everything in `meta-ui` about flows, states and copy, and repeats the rules: no Meta logos or marks,
never "Meta" as the brand, keep the footer, no dead controls. Products keep their own name, and they get no platform
sidebar or composer unless the brief asks for one.

## Gap list

Walked on Oct 31 against the running app with fixtures at 1440 and 390, in light. No page scrolled sideways at either
width. Ordered by how much each moves the look closer. **Now** means worth doing in this pass.

| # | Gap | Today | Files | When |
|---|---|---|---|---|
| 1 | **Canvas and color tokens**, light and dark | Gray sidebar and page tokens, `#2962d8`, off-brand dark | `app/globals.css` (three token blocks), `app/layout.tsx` (`themeColor`), docs freeze in `app/docs/docs.css` | Now |
| 2 | **Sidebar** | 260 px, gray, right border, 40 px rows at 15 / 500, blue active pill, rules between groups | `globals.css` (Shell, nav rows), `components/shell/Brand.tsx` (mark color only) | Now |
| 3 | **Make page** | Small bold heading, cards first, composer pinned to the window's bottom, 360 px panel of disabled-looking controls | `app/page.tsx`, `components/composer/Composer.tsx` (examples after the form), `globals.css` (Playground), `SetupPanel.tsx` | Now |
| 4 | **Font and type scale** | System font, 15 / 1.5 body, 600 headings | `app/layout.tsx`, new `app/fonts/`, `globals.css` (`--font`, base, `.page-head`, `.section-head`, `.card` headings) | Now |
| 5 | **Buttons** | 40 px, 15 px, flat primary at 600, outlined secondary, 8 px radius in `.toolbar` | `globals.css` (Controls, `.toolbar .btn`) | Now |
| 6 | **Composer surface** | Solid white, one-layer shadow, focus ring, 130 px on Make | `globals.css` (Composer, `--shadow-card`), `.composer-input` min height on Make | Now |
| 7 | **Blue headings and blue chips** | Gray panels with accent titles ("Use your products in Muse" on the dashboard, "Lab results" on fine-tuning), model chips and icon circles in blue tint | `globals.css` (Dashboard, Lab results, chips, icon circles) | Now |
| 8 | **Segmented controls** | `.range` is a dark filled pill, three separate styles | `globals.css` (`.chat-tabs` in `chat.css`, `.tabs`, `.range`, `.segmented`) | Now |
| 9 | **Menus** | 1 px border, 14 px radius, heavy shadow, 500 text | `globals.css` (`.menu`, `.menu-item`) | Now |
| 10 | **Sign-in width (a bug)** | `.page-narrow`'s 520 px loses to `.page`'s later media rule, so the form runs 1046 px wide | `globals.css` (Page scaffolding) | Now |
| 11 | **Conversation fine-tuning** | Bubble radius 25, chip shadow from the capture, tabs at 15 px, S's send colors, Show thinking fine | `components/chat/chat.css`, tokens | Now |
| 12 | **Gallery and product page chrome** | Cards fine once tokens land. Gray panel on the product page, 8 px toolbar | Tokens, `.panel` fill only. Wave 2 is on these files, so stay in CSS | Now, tokens only |
| 13 | **Dashboard, usage, how it works, fine-tuning** | Bold numbers, tinted icons | Tokens, `.dash-num`. Charts unchanged | Now, tokens only |
| 14 | **Voice state** | A pill with a stop square and clock. The "+" stays and the placeholder doesn't change | `components/voice/VoiceInputButton.tsx`, `Composer.tsx`, `SteerBox.tsx`, Composer CSS | Now if time allows. Seen briefly, and it touches logic wiring |
| 15 | **Phone sheet** | 88% wide with a backdrop | `globals.css` (`.sheet`) | Now, small |
| 16 | Phone Make page | 16 px composer margin | `globals.css` | Now, small |
| 17 | Favicon | `#2962d8` tile | `app/icon.svg` | With the mascot |
| 18 | Sidebar collapse to the 56 px rail | No control | `Sidebar.tsx`, a small client part, `.shell` grid | Later. Real, helps beside the steps panel, but it's new state |
| 19 | History in the sidebar | Builds row only | Root layout query | Later, it's a logic change |
| 20 | Search palette | Docs only | New | Later, if there's something to search |
| 21 | Thinking pill | None, on purpose | `Composer.tsx` holds the comment | Not until a real switch exists |

### Pitfalls for whoever does these

- **`.main` paints with `--surface`,** so a dark `--surface` lighter than `--bg` would lighten every page. The table
  above keeps them equal.
- **Glass over a pinned composer:** the card is now 76% opaque. The floor hack (`--composer-floor`) paints only outside
  the card, so content blurs through it, as it does live. `components/build/__tests__/steps.test.tsx` pins the floor rule
  in `globals.css`: keep that line as it is.
- **Bare text may grow:** moving `body` from 15 px to 16 px changes everything that inherits it. Check tables and panels.
- **Moving the form above the examples in `Composer.tsx`:** do it in the markup, not with `order`, so tab order follows
  the screen. `composer.test.tsx` pins class names and the row's markup.
- **Dead-looking controls on Make:** `SetupPanel` shows disabled selects and switches. They report facts, so restyle them
  as plain label and value rows inside a folded section, or link them from How it works. Keep the facts visible somewhere.
- **Check after each:** `/docs` before and after, dark mode, 390 px, and `npx tsx --test lib/brief/__tests__/flags-off.test.ts`.

### Status after the build pass (Oct 31)

Checked on the dev server with fixtures at 1280 and 390, light and dark, with no sideways scroll on any screen. A
computed-style fingerprint of `/docs` (eight pages: five at 1280 in light and dark and at 390 in light, five at 1440 in
light and dark with the live demo panel open) matched the one taken before the change, property for property.

| # | Gap | Status |
|---|---|---|
| 1 | Canvas and color tokens | Done, light and both dark blocks. `themeColor` is `#ffffff` and `#181819`. New tokens: `--hover-2`, `--glass`, `--gradient`, `--shadow-glass`, `--overlay`, `--code-bg`, `--scrim`, `--ease` and the body type tokens. The docs freeze is in `app/docs/docs.css`, "The look before docs/BRAND.md" |
| 2 | Sidebar | Done. Rows stay 40 px in the phone sheet, for fingers |
| 3 | Make page | Done. Centered headline "What should Muse make?", composer, then the examples. `SetupPanel` is a folded list of facts |
| 4 | Font and type scale | Done. Inter is vendored at `app/fonts/` and set on `<html>` |
| 5 | Buttons | Done. `.toolbar .btn` uses the shared button |
| 6 | Composer surface | Done. 107 px on Make, about 130 px in the room. The "+" menu inside the card is solid, since a blur inside a blur shows nothing behind the card |
| 7 | Blue headings and chips | Done |
| 8 | Segmented controls | Done: `.chat-tabs`, `.tabs`, `.range`, `.segmented` |
| 9 | Menus | Done. The build room's More menu stays solid: it holds a long panel of facts |
| 10 | Sign-in width | Fixed: 520 px |
| 11 | Conversation fine-tuning | Done: bubble 22 px, tabs 14 / 500, glass chip and buttons |
| 12 | Gallery and product page | Tokens, and `.panel` is a hairline card |
| 13 | Dashboard, usage, how it works, fine-tuning | Tokens, regular-weight big numbers. No weight above 600 is left |
| 14 | Voice state | Not done. It changes the recording controls' wiring |
| 15 | Phone sheet | Done: full width, the live overlay |
| 16 | Phone Make page | Done: 24 px margins, a 342 px composer at 390 |
| 17 to 21 | | Not in this pass, as planned |

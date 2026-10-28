# Meta design language: research notes (Oct 28, 2026)

Collected from public sources to build the `meta-ui` skill for Muse Muse products. Values are facts read from the
sources listed at the end; roles marked "inferred" were deduced from how a page uses a color. facebook.com and meta.ai
block scripted fetches, so Facebook values come from dated public copies of its CSS variables, and Meta values from
the live meta.com and developers.facebook.com stylesheets.

## Color

Facebook switches themes with a class on `<html>` (`__fb-light-mode` / `__fb-dark-mode`). Current values (2024 to
2026), with the 2021 value where it changed.

| Facebook token | Light | Dark |
|---|---|---|
| `--accent`, `--primary-button-background` | #0866FF (2021: #1877F2) | #0866FF |
| `--blue-link` | #0064D1 | #5AA7FF |
| deemphasized (tinted) button bg / text | #EBF5FF / #0064D1 | rgba(29,133,252,.2) / #75B6FF |
| selected chip, tab or toggle | #EBF5FF with #0064D1 text | #1D85FC with white |
| `--web-wash` (page) | #F0F2F5 (one copy #F2F4F7) | #1C1C1D (2021: #18191A) |
| `--surface-background`, `--card-background` | #FFFFFF | #252728 |
| `--comment-background` / flat card | #F0F2F5 / #F8F9FB | #333334 |
| `--popover-background` | #FFFFFF | #3B3C3E |
| `--input-background`, toast | #FFFFFF | #242526 |
| `--secondary-button-background` | #E2E5E9 | rgba(255,255,255,.1) |
| `--primary-text` | #080809 | #E2E5E9 |
| `--secondary-text` | #65686C | #B0B3B8 |
| `--placeholder-text` | #65686C | #A1A4A9 |
| `--disabled-text` | #B0B3B8 | #6F7276 |
| `--divider` | #CED0D4 | #3E4042 |
| `--hover-overlay` | rgba(0,0,0,.05) | rgba(255,255,255,.1) |
| `--press-overlay` | rgba(0,0,0,.10) | rgba(255,255,255,.2) |
| `--positive` | #24832C | #3FBB46 |
| `--negative` | #DD2334 | #FF7C74 |
| `--warning` | #AF8F00 (fails AA as text on white; icons only) | #AF8F00 |

Facebook decorative hues: cherry #FB3C44, grape #7D74FF, lemon #F9CF00, lime #3FBB46, pink #FA61BA, teal #14B898.

Meta corporate pages (meta.com, developers.facebook.com): blue #0064E0, text #1C2B33, secondary #465A69, muted
#67788A, border #CBD2D9, divider #DADDE1, wash #F1F4F7.

Gradients:
- Meta symbol: #0064E1 (0 to 40%) to #0073EE (83%) to #0082FB.
- meta.com: `linear-gradient(45deg, #0065E0, #0F8BFF)` and `linear-gradient(to left, #4553E4, #0064D4)`, plus a conic
  ring (#0082FB, #A033FF, #FF5280, #FFD251, #25D366) of unlabeled purpose.
- Meta AI's ring (2024 to April 2026, sampled from a render, approximate): blues #0058EB to #0092FF, indigo #4F4BFE,
  violet #C04DF2, cyan #00E1F4. In April 2026 Meta AI moved to a purple identity, and in September 2026 the Muse
  agent got a looping "M" mark. Never imitate these marks.

## Type

- Meta's brand typeface, Optimistic (Display and Text, variable 200 to 800), is proprietary. meta.com's fallback stack
  is `Optimistic VF, Montserrat, Helvetica, Arial, Noto Sans, sans-serif`.
- Facebook UI uses system stacks: `Segoe UI Historic, Segoe UI, Helvetica, Arial, sans-serif` and
  `system-ui, -apple-system, BlinkMacSystemFont, sans-serif`. Code: `ui-monospace, Menlo, Consolas, Monaco, monospace`.
- Facebook web type scale (size/line height px, weight): headline1 28/34 700, headline2 24/30 700, headline3 17/22
  700, primary label 17/22 500, body 15/20 400 (600 emphasized), secondary label 15/20 500, meta caption 13/18 400,
  tertiary 11/16 500, input 16/500. Button labels 600.
- Meta Horizon OS: H1 32/36 (-0.2 tracking), H2 24/28, H3 20/24, Body1 14/20, Body2 11/16. Developers' typeface is
  Inter. At least 14 px, ideally 18 px or more for reading. No italics.
- Free substitutes (OFL): Montserrat for headings (Meta's own first fallback; 700 with -0.01em tracking at 24 px and
  up), Inter for body and UI (Horizon's developer typeface), Figtree as a one-family alternative.

## Shape, spacing and elevation

- Facebook radii: buttons 6 (newer medium 10, large 12); cards, dialogs, toasts and list cells 8; inputs and chips 6;
  images and badges 4; skeletons 8; chat bubbles and composer pill 18; bottom sheets 16. People avatars are circles,
  Pages and groups 8 px rounded squares.
- Horizon UI Set radii: dialogs 24, panels, large buttons and text fields 20, cards 16, list items 12, small buttons 8,
  checkboxes 4, plus a pill role.
- Spacing steps 2, 4, 8, 12, 16, 20, 28, 36; gutter 8, margin 16; list rows 12 px vertical and 16 px horizontal
  padding; feed cards 12 px apart.
- Sizes: top bar 56; buttons 32, 36 or 40 tall; chips 24, 32 or 44; list cells at least 44 to 52; dialogs up to 548
  or 700; toasts at least 288 wide. Horizon hit targets at least 48, 60 for primary controls.
- Elevation: base `0 1px 2px rgba(0,0,0,.2)`; emphasis `0 2px 12px rgba(0,0,0,.2)`; elevated
  `0 8px 20px rgba(0,0,0,.2), 0 2px 4px rgba(0,0,0,.1)`; menus `0 12px 28px rgba(0,0,0,.2), 0 2px 4px rgba(0,0,0,.1)`
  with a 1 px inset ring. Surfaces are flat fills; shadows are for floating layers.
- Inputs: 1 px #CED0D4 border (#3E4042 dark). Focus: `0 0 0 2px #fff, 0 0 0 4px #0866FF` (#1D85FC dark).
- Icons: outlined on web and mobile, 24 grid with a 20 live area, sizes 12, 16, 24, 48.

## Components

- Primary button: #0866FF fill, white 15/600 text, 36 tall, 12 to 16 side padding, radius 6 (10 newer). Pressed
  buttons scale to .975.
- Secondary: #E2E5E9 fill with primary text. Tinted: #EBF5FF with #0064D1. Tertiary: transparent. Hover and press use
  the overlays.
- Composer: gray pill, at least 36 tall, radius 18, 8 by 12 padding, 15/20 text. Outgoing bubbles use the accent,
  incoming #F0F0F0 (#303030 dark).
- Toast: surface fill, radius 8, 16 by 10 padding.
- Loading: Facebook's skeleton is an opacity pulse, not a sweep: 1000 ms, `steps(10, end)`, alternate, opacity .25 to
  1, color #979A9F, radius 8. Progress ring #0866FF on rgba(8,102,255,.2).
- AI attribution: Meta labels AI-made or AI-edited media with an "AI info" label (since July 2024).

## Motion

Facebook FDS curves (unchanged 2021 to 2026): enter `cubic-bezier(.14,1,.34,1)`, exit `cubic-bezier(.45,.1,.2,1)`,
move and expand `cubic-bezier(.17,.17,0,1)`, passive move `cubic-bezier(.5,0,.1,1)`, quick move
`cubic-bezier(.1,.9,.2,1)`, fade linear, soft `cubic-bezier(.08,.52,.52,1)`, strong `cubic-bezier(.12,.8,.32,1)`.
Durations in/out (ms): 100/100, 200/150, 280/200 short, 400/350 medium, 500/350 long. meta.com mostly uses
`cubic-bezier(.4,0,.2,1)` and `cubic-bezier(.165,.84,.44,1)` at 200 to 500 ms.

## Horizon OS guidance that applies to 2D web

- Responsive panels from 384 x 500 to 1440 x 1000.
- Contrast at least WCAG AA. Support light and dark via `prefers-color-scheme`; desaturate in dark rather than invert.
- Semantic color roles (background, surface, accent, selected, positive, negative, warning). Never rely on color alone.

## Sources

- Facebook CSS variable copies on GitHub: GatoJustiniano/gatojustiniano.github.io (2021), ahmedelmansory1911/Cloned-Facebook
  (2024), imgnxtion/freeonlinemarketplace (2024), SysAdminDoc/HushFacebookWeb (values read live Oct 2026),
  amitrv26/FB-LOX-UXR (2026 UXR prototype citing Facebook's internal tokens).
- ishadeed.com/article/new-facebook-css (2020 analysis).
- www.meta.com and developers.facebook.com/docs live stylesheets (fonts, palette, gradients, easing).
- Wikimedia Commons renders of the Meta symbol and the 2024 Meta AI logo.
- developers.meta.com/horizon/design: styles_typography, fonts-icons, styles_color, pwa; Spatial SDK UI Set reference.
- TechCrunch, July 1 2024, on the "AI info" label. Coverage of the April 2026 Meta AI identity and the September 2026 Muse
  logomark (design trade press).

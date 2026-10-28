# Demo Studio

Every product Muse Muse ships gets a recorded demo video. Until Oct 28 that video was the smoke test replayed at
1280x720 with Playwright's built-in recorder, a 2.5 s title card and step captions burned over the app. Real
recordings showed the problems: half of each video was a static "Working…" screen while a model answered, captions
covered the app's own buttons, there was no cursor, the VP8 recorder blurred text, and the result was on screen
for about a second.

Demo Studio replaces that with a launch-clip quality video, made the same way for every product, with no extra
work from Muse Code.

## What a viewer sees

- A 1920x1080, 30 fps H.264 MP4, usually 25 to 60 seconds, plus a poster JPEG.
- An intro card sized to its text: "Made with Muse Muse", the product's name, its tagline and the Meta models it uses
  as chips, with the poster beside it in a small browser window, so the first second shows what the product makes.
- The app inside a browser window on a Meta-blue backdrop, with its real URL in the address bar.
- A cursor that glides to each control with easing, a ripple on every click, text appearing key by key, and a file
  chip that drops onto the picker when a file is chosen. An action that changes nothing (a fill with the value the
  field has, an option already chosen) gets no glide or ripple. The cursor moves off a result while it is held and
  fades out while the mouse rests, so waits and results are clean.
- Up to two new results a step brought on screen and held about 3 seconds before the next action, under the caption
  of the step that made it. The video ends on the strongest result after the last model wait.
- A camera that zooms in on the field being typed into and frames each result when it appears, then eases back out.
  A result is framed on the content column with what led to it above it, and crop edges keep clear of headings.
- Model waits sped up, with an honest badge in the window's toolbar such as "Waited 14 s, sped up". Actions and
  results always play at real speed.
- Step captions in a lower-third below the window. They never cover the app, and at a step change the old text fades
  out and the new one in on a pill that stays up, so two captions never show at once.
- An outro card with "Try it" and the live URL (or the product's name and tagline when there is no URL) and "Built
  with Muse Muse. Not an official Meta product."
- The cards and the app meet through the plain backdrop, so two screens are never on top of each other.
- A poster that is the best result as the camera shows it (the one that ended the longest model wait), 1920x1080
  with no window, caption or badge, so it fills a 16:9 card.

## How it works

```
smoke.spec.ts (Muse Code writes it, as before)
   │  the platform copies it to tests/smoke.demo.spec.ts with `@playwright/test` imports pointed at ./demo-fixtures
   ▼
playwright test --project=studio (1280x720 CSS px at deviceScaleFactor 2)
   │  tests/demo-fixtures.ts (platform file): the page fixture, studio project only
   │    - CDP screencast recorder: JPEG frames at 2560x1440, at most 30 fps, with timestamps
   │    - cursor overlay, eased glides, drawn typing, file chip (patched Locator actions, restored after the test)
   │    - activity tracker: DOM mutations, aria-busy on/off, scrolls, test.step start/end
   │    - results: up to two a step scrolled into view when they landed off screen, and held; the strongest at the end
   ▼
test-results/demo/timeline.json + test-results/demo/frames/*.jpg
   ▼
node scripts/demo-studio.mjs --spec <spec.json>   (platform file)
   │  scripts/demo-plan.mjs (pure): speed ramps, camera keyframes, caption and badge timings, poster
   │  ffmpeg cuts the poster from one frame; Chromium renders the window (backdrop and chrome), captions and badges as
   │  PNGs, the intro (with the poster) and outro as JPEGs
   │  ffmpeg: frames -> 30 fps screen layer -> zoompan camera -> window composite -> captions -> dips to the cards
   ▼
demo.mp4 + poster.jpg + studio.json (summary)  ->  the platform uploads both to Blob, then deletes the frames
```

If the studio render fails, `demo-studio.mjs --basic` makes a plain 1920x1080 cut from the same frames with the
waits sped up, captions and badges, and no camera or cards. If the demo run itself fails, there is no video, as
before. A run that passes without a timeline ran without the recorder (the smoke test took its `test` from a module
of its own, which the import rewrite doesn't reach), so the task records it again in the `demo` project with
Playwright's own video and the platform makes the old MP4 from that.

The recorder never changes what an action does: the typing is only drawn (the field's value is set without events,
and the fill then sets the exact value with its own), its page calls run on timers saved before a test can pause
them (`page.clock`), and the time its choreography and holds add is given back to the test's timeout.

## Files

| File | Owner | What it does |
|---|---|---|
| `template/tests/demo-fixtures.ts` | platform (restored before every run) | Re-exports `@playwright/test` with a page fixture that records the studio project |
| `template/scripts/demo-plan.mjs` | platform | Pure planning: edit decision list, camera, captions, badges, poster. Unit-tested |
| `template/scripts/demo-studio.mjs` | platform | Renders the poster and cards and composites with ffmpeg |
| `template/scripts/demo-inter.woff2` | platform | Inter (Latin, every weight, OFL, from @fontsource-variable/inter) for the cards and the file chip, so they look the same in sandboxes from snapshots without Inter |
| `template/playwright.config.ts` | platform | `studio` project at deviceScaleFactor 2 with no built-in video; `demo` is Playwright's own video, the old demo, under the name older platform code runs; `smoke` ignores `*.demo.spec.ts` |
| `lib/sandbox/tasks.ts` | platform | The demo command: copy the smoke spec, run the studio project, then the studio, or the `demo` project when nothing was recorded |
| `lib/sandbox/builder.ts` | platform | `finishDemo`: writes the studio spec, uploads `demo.mp4` and `poster.jpg`, falls back to `--basic`, deletes the frames |
| `lib/sandbox/setup.ts` | platform | Snapshot fonts: Inter (also the default sans-serif, so products on the system font stack don't render in DejaVu Sans), color emoji |
| `scripts/rerecord-demos.ts` | platform | Re-records live products; `--dry-run` works in a throwaway copy of each sandbox that calls Meta directly, and saves the timeline and studio summary with the video |

## Timeline format (version 1)

All times are seconds since the recording started. Rects are CSS pixels in the viewport the recording started with,
and run past it when part of the element is off screen.

```json
{
  "version": 1,
  "viewport": { "width": 1280, "height": 720 },
  "dpr": 2,
  "status": "passed",
  "duration": 41.2,
  "frames": [{ "file": "frames/000001.jpg", "t": 0.0 }],
  "steps": [{ "title": "Upload a photo of the receipt", "t0": 0.4, "t1": 3.1, "depth": 0 }],
  "actions": [{ "kind": "type", "t0": 3.4, "ready": 4.8, "t1": 4.9, "rect": { "x": 200, "y": 300, "w": 600, "h": 44 }, "label": "Store name", "typed": 13, "heads": [] }],
  "activity": [{ "t": 9.8, "added": 14, "changed": 3, "text": 212, "rect": { "x": 180, "y": 120, "w": 920, "h": 540 } }],
  "busy": [{ "t": 5.0, "on": true, "rect": { "x": 180, "y": 400, "w": 920, "h": 200 } }],
  "scrolls": [{ "t": 10.1, "y": 640 }],
  "results": [{ "t": 10.0, "at": 9.8, "rect": { "x": 180, "y": 90, "w": 920, "h": 540 }, "scrollY": 640, "waited": 4.8, "busy": true, "media": 0, "heads": [], "blanks": [] }],
  "column": { "x": 180, "w": 920 },
  "viewports": []
}
```

`kind` is one of `goto`, `click`, `type`, `upload`, `select`, `check`, `press`, `hover`. An action's `t0` is when the
cursor starts moving to it, after any wait for the element to appear, and `ready` is when the cursor is there and
Playwright's own action starts (it may still wait, say for a button to be enabled). Uploads also carry `fileName`, and
fills `typed`, the characters drawn into the field (0 when the field already said it). `noop: true` marks an action
that changed nothing, so the cursor stayed put. An activity record's `text` is the characters of text it added. A
result is one the recorder brought on screen and held: `at` is when it appeared, `t` when it came on screen (when the
scroll to it started, or when it appeared), and its rect is measured in view, at `scrollY`. `waited` is how long the
viewer waited for it in seconds (its aria-busy span, or the time since they last pressed or typed), `busy` whether it
came from an aria-busy section, and `media` how many pictures it holds. `heads` (on actions and results) are the boxes
of headings, labels and the app bar on screen, `blanks` those of empty text fields, and `pressed` that of the control
pressed last. `column` is the content column, from `main`. `viewports` lists `page.setViewportSize` calls (`t`,
`width`, `height`). Frames come only when the screen changes, so a frame lasts until the next one. Timelines from
before any of these fields existed still work: an action without `ready` was ready when it ended, and a result's wait
comes from the aria-busy spans and sped-up waits before it.

## Recording rules

- **Results:** a result is a section that stopped being aria-busy (when the busy element, like a Skeleton, is removed,
  the section or card it was in, unless that holds the field the viewer typed into: that is the form, and the burst
  that replaced the busy part stands), or the biggest element of a burst that added at least 3 elements or 20
  characters of text. A busy button only marks the end of a wait, and a burst inside a section that is still busy is
  its loading state. The same result reported both ways within half a second is one, and pictures in it decode (at
  most 1.5 s) before it is measured.
- **Holds:** before each action (and again when the element it waited over half a second for has appeared), when a
  step passes and before a `goto`, the results that appeared since the top-level step began, are at least 2% of the
  screen and aren't the form the viewer just used (one holding the control pressed last, unless an aria-busy section
  made it) are held oldest first, at most two a step. A test without steps is one step from its first action. A burst
  still coming in is waited for, up to 0.6 s, so an action's result is held right after it rather than one action
  late. Each is scrolled into view when most of it is off screen, and the cursor glides off it to its resting place
  and fades out; a cursor that already faded during a wait stays hidden while the mouse moves there. It holds 2.8 s
  from when it is in view; a step's second result that lands within 48 px of the first holds 0.8 s, and past an
  estimated 30 s of main part a result the viewer waited under 1.5 s for holds 1 s. A result noticed after its hold
  would have ended adds no time.
- **The end:** a passing test goes back to its strongest result from the last wait of 1.5 s or more on (one waited at
  least 3/4 as long for as the longest, then one from an aria-busy section, then one with pictures, then the biggest)
  and holds it 2.8 s, unless it is still in view from its own hold. The test then holds its last frame 0.8 s more.
- **Waiting:** the choreography waits for an element as the action would (visible, or attached for uploads, presses
  and forced actions), never longer than the action's own timeout or the test's `actionTimeout`.
- **Actions that change nothing:** a fill with the value the field has, a check of a box already checked (or an
  uncheck of one that isn't), a click on an option already chosen (a radio, its label, a selected tab) and a select of
  the option already selected run with no scroll, glide or ripple. A click of that kind still moves the real mouse, so
  the cursor ignores it.
- **Cursor:** it fades out 2.4 s after the mouse last moved and comes back with the next move.
- **Scrolling:** the page scrolls smoothly unless the product sets its own `scroll-behavior`, so a product that jumps
  to its result glides there.
- **Screenshots and viewports:** frames are left out while `page.screenshot` or `page.setViewportSize` runs. Demo
  Studio drops any other run of frames of another shape shorter than a second, and fits a longer one into the
  recording's shape.

## Editing rules

- **Protected time plays at 1x:** every action from 0.4 s before it to 0.8 s after, the first 0.2 s of each step
  through 1.0 s after it starts, every reveal from 0.2 s before to 2.4 s after, the first second and the last 2.5
  seconds. A reveal is an activity burst with at least 3 added or 5 changed nodes or 20 characters of new text,
  aria-busy turning off, or a held result. A loading state (a reveal that comes with aria-busy turning on) and an
  echo (a reveal under 3% of the viewport, within 80 px of an action's element, that starts while the action runs or
  up to 1 s after it, like a file name by its picker or a button saying it is working) only play to 1.0 s after they
  start. An action that waited more than 1.6 s inside Playwright plays at 1x from 0.4 s before `t0` to 0.3 s after
  `ready` and from 0.3 s before `t1` to 0.8 s after it; the wait between is idle.
- **Idle time** longer than 1.6 s becomes `min(1.4, 0.5 + 0.1 * idle)` seconds, at most 16x. Idle stretches of 3 s
  or more get the badge with the real, rounded-up seconds: the aria-busy span around the stretch (the model call), or
  without one the time from the end of the action before the stretch to the reveal or action that ends it (the click
  to the answer), when no more than 3 s of that span played at 1x and no other badged stretch shares it, else the
  stretch itself.
- **Length cap:** if the main part would still run past 70 s, idle stretches over 1 s are compressed too.
- **Captions:** one per top-level step with a title, cut to 60 characters, each up until the next starts, the last
  until 0.6 s before the main part ends. Captions shorter than 1 s are dropped. The step count shows when there are
  two or more. Each caption is a pill and its text, drawn separately, every pill under every text, and of two pills
  that meet the wider on top. At a step change the old text fades out over 0.15 s while the new pill fades in, then
  the old pill fades out while the new text fades in, so the pill changes width without blinking or showing inside
  the other, and two texts are never on screen together.

## Camera rules

- Zoom `z` from 1 to 1.8, centered on a point, keyframed in output time, eased with smoothstep over 0.7 s, and
  clamped so the crop never leaves the frame. Every move takes 0.7 s: between two shots the camera holds the first
  until it has to move, unless the first was cut short by an action outside it or a scroll.
- **Typing:** frame the field with 120 px of padding, `z` between 1.25 and 1.8, from when the cursor heads there until
  0.6 s after the fill. A fill that drew no text gets no shot.
- **Reveal:** frame the union of what appeared, with 64 px of padding (28 px above, where the button that asked for it
  usually sits), if it covers less than 60% of the viewport and at least half of it is on screen, `z` between 1.15 and
  1.6, held for 2.5 s, then back to 1. Never framed: the field echoing keys while typing, a loading state, an echo,
  anything mostly off screen, and where a result appeared that the recorder brought on screen later (its held result
  frames it once it is in view). A held result taller than the screen counts against as much of it as the screen can
  show, so its top gets a shot. The crop sits on the middle of the content column (the recorder's, or the span of the
  held results and the actions), with `z` no higher than shows the whole column and 64 px either side, and a result
  shorter than the crop gets the spare room above it.
- **Tall targets** taller than the crop show their top.
- **Edges stay clear:** a crop's top and bottom edges move to cut through as few as they can of the controls the test
  used nearby, the headings, labels and app bar the recorder saw closest in time, each edge just past one or out to
  take it in, the nearest such place winning, while the target stays in view.
- **A shot holds through actions inside its view** that start before it would end (the file chip landing on a picker
  next to the field).
- **The cursor stays in view:** a shot starts to leave 0.4 s before an action outside its view. If that action starts
  before the shot could hold 1.2 s, the shot takes the action's target in (64 px of padding) when both still fit at
  the lowest zoom, and otherwise there is no shot. An action that changed nothing doesn't count.
- Zoom targets less than 1.5 s apart merge into one shot of their union. Every zoom holds at least 1.2 s. The last
  0.7 s of the main part is at `z = 1`, and the last frame is held up to 2 s when the last result needs it for its
  shot. Nothing is framed after a `page.setViewportSize`.
- **Poster:** the best held result as the camera shows it: its shot 1.5 s into the hold (halfway when shorter) and at
  least a second after it is in view, that second when it got no shot, or the last frame for the last one. A result is
  passed over, while another is left, when its frame holds an empty text field, or when it holds the control pressed
  last and the viewer waited under 1.5 s for it. Of the rest the poster takes one waited at least 3/4 as long for as
  the longest, then one from an aria-busy section, then one with pictures, then the biggest, then the latest. An older
  timeline's waits come from its aria-busy spans and sped-up waits. A recording without held results uses the biggest
  reveal's shot, 1.2 s after the biggest reveal, or 60% of the way through.

## Layout (1920x1080)

| Part | Box |
|---|---|
| Window chrome bar (dots, URL pill, wait badge) | x 224, y 64, 1472 x 40; the badge is a 32 px pill at its right end |
| Screen (the app) | x 224, y 104, 1472 x 828, 18 px bottom corner radius |
| Caption zone | y 932 to 1080, pill centered at y 1006 |
| Intro | 2.6 s, a slow 4% push-in |
| Outro | 2.2 s, a slow 4% push-in |
| Transitions | card or app to the plain backdrop in 0.3 s, then the backdrop to the next in 0.3 s |

The backdrop, the window chrome, the shadow and the rounded corners are one PNG with a transparent hole over the
screen, laid over the screen layer. A recording that isn't 16:9 (a test that sets a phone-sized viewport) is shown
whole in a 16:9 canvas with the wash (#F0F2F5) around it, and the camera works in that canvas.

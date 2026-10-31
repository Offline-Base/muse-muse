# The Muse app look

The owner prefers the Meta Muse app's chat look to Muse Muse's current one (Oct 30) and asked to copy it, including
its steps sidebar. This is that look, written down from two screenshots of the app for the conversation surfaces: the
Make page composer, the build room, and the docs sidebar chat. Muse Muse still isn't Meta's app: no Meta logos, and the
footer keeps "Built with Muse Muse. Not an official Meta product."

The first capture showed a turn while it was working, at about 1.6x, so sizes read from it directly come out about 20% small. The second (2968 by 1982, a 2x capture of a 1484 by 991 window)
showed a finished turn with the steps panel open; every color below was sampled from its pixels, and every size is in
CSS px (half its pixels).

## Colors and type

| Token | Value | Used for |
|---|---|---|
| Text | `#111112` | Body text, labels, icons, the person's message |
| Secondary | `#696B6E` | Step titles and descriptions, "Show thinking", panel dots |
| Faint | `#A1A3A7` | The "Done" check |
| Placeholder | `#878787` | The composer's placeholder |
| Hairline | `#E5E5E5` | The panel's border, the thread line, outlined buttons and the model pill |
| Bubble | `#F3F4F5` | The person's message |
| Track | `#F2F2F2` | The steps panel's tab track |
| Hover label | `#E7E8EB` | Labels like "Add to favorites" |
| Working icon | `#6547F5` to `#C15AF7` | The working icon, blue-violet to purple |
| Send | about `#2A62CC` to `#5D6DF5` | A left-to-right gradient; at half strength (`#94B0E5` to `#AEB6FA`, as sampled) while the box is empty |

Type is the system UI sans everywhere: body 16 px on a 26 px line; "Show thinking" 15 px; panel step titles 14 px
semibold; panel descriptions 13 px on a 21 px line; the composer's placeholder 18 px. Regular weight everywhere else;
nothing bold in the stream.

## The page

- **Background:** plain white. No cards around the conversation, no gray canvas, lots of empty space.
- **Column:** one centered column for messages and the composer, up to 768 px wide in both captures, shrinking with
  the window, with generous gaps (about 48 px between turns).

## The title chip

Top left, floating over the page, about 32 px from the left: the conversation's title ("Muse mascot in the datacenter")
in a white pill.
- **Shape:** about 36 px tall and fully rounded, with 12 px side padding.
- **Edge:** no border, only a soft shadow (about `0 2px 16px rgba(0,0,0,0.08)`).
- **Text:** 15 px, text color.

In Muse Muse it holds the product or build name.

## The top-right buttons

Two 36 px white circles, 8 px apart, about 24 px from the right edge of the conversation area, each with the same soft
shadow and no border: share (a paper plane) and more (three dots), with 16 px icons in the text color.

## The person's message

- **Bubble:** right-aligned to the column's edge, `#F3F4F5`, no border, fully rounded (44 px tall for one line), 16 px
  side padding. Its width fits the text, up to about 75% of the column.
- **Text:** 16 px, text color.
- **Attachments:** they sit inside the bubble, at its right end. Each is a 40 px square thumbnail with 8 px rounded
  corners and a hairline border, in a bubble with 12 px top and bottom padding (64 px tall). Several attachments line up
  in a row.

## The agent's working step

- **Icon:** to the left of the step's title, the working icon, about 18 px. In the app it's a small "flower" of dots
  in a ring, shading from blue-violet to purple, spinning slowly while the step runs. Here it becomes the Muse mascot's
  working animation, from the owner's mascot folder, when that exists.
- **Title:** a short present-tense step title ("Generating mascot data center video"), 16 px, secondary color,
  regular weight.
- **Thread line:** under the title, a 1 px hairline drops from under the icon. It runs beside the step's description:
  one or two sentences in the secondary color saying in plain words what's happening and why, 13 px on an 18 px line
  (measured in the first capture, which is 1.614 device px per CSS px).
- **Nesting:** sub-steps (subagents, workflow children, observers, tool calls) nest on the same thread line, each with
  its own small icon and one-line title, so a step reads as a quiet tree.

## The finished turn

- **Show thinking:** when the turn is done, its steps fold into one row: the working icon (still, 18 px), 14 px of
  space, "Show thinking" in 15 px secondary color, and a small right chevron (about 6 by 11 px) 4 px after it.
  Clicking the row opens the steps panel.
- **Output:** what the turn made sits about 32 px below, at the column's full width and its own aspect ratio, with
  about 24 px rounded corners. Hovering shows a small label at its top-right corner (a `#E7E8EB` rounded rectangle, 13
  px text).
- **Answer:** plain text in the text color, 16 px on a 26 px line, 12 px between paragraphs, about 32 px under the
  output. No bubble.

## The steps panel

Opened from "Show thinking", it sits at the right edge of the window, full height:
- **Panel:** 400 px wide, white, a 1 px hairline on its left edge, no shadow. It takes its width from the conversation
  (which re-centers in the space left) instead of covering it.
- **Close:** a thin 10 px X in the text color, in a 32 px hit area, centered about 24 px from the top and 31 px from
  the right edge.
- **Tabs:** a segmented control 52 px from the top and 16 px from each side, 36 px tall: a fully rounded `#F2F2F2`
  track, with the chosen tab as a white fully rounded segment inset 4 px (28 px tall) and a soft shadow under it
  (about `0 1px 6px rgba(0,0,0,0.12)`). Labels are 15 px in the text color, centered in each half, the same color
  whether chosen or not. The app's tabs are "Steps" and "Sources".
- **The list:** starts about 28 px under the tabs. Each step has:
  - an 8 px `#696B6E` dot, centered 27 px from the panel's left edge, on a 1 px hairline thread that runs from the
    first dot to the end of the list;
  - a title 18 px right of the thread (14 px semibold, secondary color);
  - a description about 6 px under the title (13 px regular on a 21 px line, secondary color);
  - when the step made an image or a video, a 72 px square thumbnail with 8 px corners about 12 px under the
    description (videos get a dark round play badge in the middle);
  - about 14 px of space before the next step.
- **The end:** the thread ends at a 14 px outlined check circle in the faint color, centered on the thread, with
  "Done" in the step title style.
- **Sources:** not shown in the capture. Use the same list style: each source a row with a 16 px favicon or
  thumbnail, a 14 px title in the text color and a 13 px secondary line (its domain or path).

## The composer

A big white card at the bottom of the column, about 24 px above the window's bottom edge:
- **Card:** about 130 px tall, 32 px corner radius, no border, a soft
  shadow (about `0 4px 24px rgba(0,0,0,0.07)`).
- **Text field:** 18 px text; the caret starts 20 px from the left and about 16 px from the top. No visible label: the
  placeholder (in the placeholder color) says what to type.
- **Bottom row:** 14 px from the card's edges, with 32 px controls:
  - **Left:** a circular "+" button with a 1 px hairline outline and a 13 px plus. It opens attachments: photo, file,
    camera and voice memo, as the composer has today.
  - **Right**, from left to right:
    - A pill toggle 32 px tall with a 1 px hairline outline, 16 px side padding and 15 px text ("Thinking" in the
      app). For Muse Muse it's the model or effort switch.
    - 8 px of space, then a circular mic button with a hairline outline (voice input already exists).
    - 12 px of space, then the send button: a filled circle with the send gradient and a white up arrow, at half
      strength while the box is empty, and a white rounded square (stop) while the agent works.

## The scroll button

When the conversation is scrolled up, a 32 px white circle with a soft shadow and a down chevron sits centered on the
column, 16 px above the composer. It jumps to the newest message.

## Motion

Only the working icon moves. New steps fade in (150 ms). The panel opens and closes without sliding. Nothing else
animates.

## Where it applies

- **Make page:** the composer, and the first message as the person's bubble.
- **Build room:** see below.
- **Docs sidebar chat:** the same bubbles, steps and composer. It's already a narrow sidebar, so "Show thinking"
  unfolds the steps list inline under its row instead of opening a second panel.

## The build room

Built on Oct 31 in `components/build`. `steps.tsx` maps a build onto the kit (`roomSteps`, `roomSources`,
`conversationItems`, `currentStep`) and `BuildRoom.tsx` lays it out.

- **The title chip** holds the product name. **Share** copies the product's link: the live URL once it ships, the build
  room's link before. **More** opens the build details (`BuildDetails.tsx`).
- **The main column** has the person's turn as a bubble. A running round shows its current step inline with the working
  icon, and folds into "Show thinking" when it ends. "Show thinking" opens the steps panel, at the fix round if it's one.
  The round's output is the media card: the live preview while the build runs (an iframe with the same sandbox attributes
  as before), then the demo video, its poster, or the checks' last screenshot. The final message is plain text under it.
- **The steps panel** replaces the "Build details" panel. It starts open beside a running build from 1100 px, and closed
  on a finished build or a narrower window. Below 1100 px it covers the conversation from the right, and on phones it's
  a full-screen sheet with the same close X. While the build runs the list follows its newest line, unless the reader
  scrolls up, and a closed fold doesn't render what it holds until it's opened. Until the room has read the window's width, an open panel that would cover
  the conversation stays hidden (`.room[data-settled="false"]`), so a phone never sees it flash.
- **The steer box is the composer** while a build runs. Send turns into stop while the box is empty. With a note written,
  Stop moves beside Send, so it's always one press away, and still asks to confirm.
- **The working icon** is `WorkingIcon` everywhere, so the mascot's animation replaces it in one file.
- **Native targets:** `roomSteps` takes `targets`, rows with `media`, which show under the deploy and above the end row.
  `nativeRows` in `apps.tsx` fills it with the "Apps" step: one row per native run, with each package and check under it. With
  no native events there's no row and nothing on the page. While a run goes on after the build has ended, the conversation
  has a line for it under the answer, the list has no end row yet, and the stream stays open (docs/NATIVE.md).

To look at it with no sandbox and no keys, `scripts/dev/room-fixtures.ts` stores a running, a failed and a finished build
and a plain `muse exec` build in a local PGlite. Its header has the commands. `scripts/dev/native-fixtures.ts` does the same
for the Apps step and the product page's "Get it" panel.

### Where each thing went

Nothing the old room showed is gone. This is where each piece is now.

| The old room | Now |
|---|---|
| Toolbar: New muse, Open preview, Get connector, History | More menu. Open preview is also under the preview |
| Mobile status line (status, time, cost) | The running step's line, and the More menu |
| "Build details" panel | Steps panel and More menu |
| Model, Muse Code session, fix rounds, elapsed, cost, tokens | More menu |
| Status rail, with the stages still to come | More menu. Stages that have happened are also steps |
| Models in the product | More menu, and the Sources tab |
| Links: preview, live product, product page, demo video | More menu. The live link and product page are also in the answer |
| Connector URL and how to add it | More menu |
| The person's muse, references, rebuild tag, "From the docs page" | Bubble with 40 px thumbnails, tag above, fold below. File names are in the Sources tab |
| Notes from before any turn | A "Getting ready" step |
| Brief turn | A step, with the whole brief in a "Read the brief" fold. A declined brief also shows in the conversation |
| Muse Code turn title and its time, usage and cost | The round's step and its description |
| Time and cost of the brief, checks, demo and deploy | Each one's step, in its description |
| Goal card, with status and progress | On the round's step, in the panel |
| Todo list | On the round's step, in the panel |
| Agents section | An "Agents" row nested under the newest round, with paths, phases and status words |
| Live log: tool calls, edits, status and error lines | Nested rows, running ones turning. Long runs fold behind their summary, and a running round keeps its newest 8 unfolded |
| Muse Code's messages | Nested rows. A round's last words also show in the conversation |
| Thinking | A nested fold |
| Subagent rows | Nested rows with the subagent avatar and their status |
| Hook runs and compaction | Nested rows. A blocked hook is a failed row |
| Workflow cards | In the Agents row on the newest round, as nested rows in the log on older ones, with phase and children |
| Observer runs | Nested rows, folded past 3 |
| Question card | The conversation, where it's answered, last while it's open, with a row in the round's step saying it was asked |
| Owner notes | Bubbles in the conversation with how they went, and a row in the round's step |
| Stop, Send now, After this step | The composer |
| Log lines, such as the per-round engine line and `build_note` | Rows under their turn. A line logged just before a round heads that round, not the turn before it |
| Error notes | Failed rows, and a line in the conversation |
| Checks: verify steps, failing output, the judge's verdict | A step with a "What ran" fold, open when it failed, and one line in the conversation |
| The judge's screenshots | The check step's thumbnails. Captions are their alt text and tooltip |
| Recorded demo | The media card once done, and the record step's thumbnail |
| Deployed | A step with the live link |
| Ship turn, its time, tokens and cost | The answer and its last line |
| "This build didn't ship" | The answer, plain text, with Try another muse |
| Jump to latest | The kit's scroll button, now also on a finished build |

**Sources** lists the muse's references, the models in the brief, then what Muse Code looked at: Meta docs pages and
searches, the model catalog, skills and web searches. On the session bridge these come from the tool's arguments
(`detail.source`, set in `lib/sandbox/msp-log.ts`). On `muse exec` the log has no arguments, so a docs read shows by the
first line of its reply, the catalog by its tool name, and searches and skills don't show.

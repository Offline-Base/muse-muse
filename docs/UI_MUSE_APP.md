# The Muse app look

The owner prefers the Meta Muse app's chat look to Muse Muse's current one (Oct 30) and asked to copy it, including
its steps sidebar. This is that look, written down from two screenshots of the app for the conversation surfaces: the
Make page composer, the build room, and the docs sidebar chat. Muse Muse still isn't Meta's app: no Meta logos, and the
footer keeps "Built with Muse Muse. Not an official Meta product."

The first capture showed a turn while it was working. The second (2968 by 1982, a 2x capture of a 1484 by 991 window)
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
- **Column:** one centered column for messages and the composer, up to 768 px wide (it was about 620 px in the first,
  narrower capture, so it shrinks with the window), with generous gaps (about 48 px between turns).

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
- **Attachments:** they sit inside the bubble, at its right end. Each is a 32 px square thumbnail with 8 px rounded
  corners and a hairline border. Several attachments line up in a row.

## The agent's working step

- **Icon:** to the left of the step's title, the working icon, about 18 px. In the app it's a small "flower" of dots
  in a ring, shading from blue-violet to purple, spinning slowly while the step runs. Here it becomes the Muse mascot's
  working animation, from the owner's mascot folder, when that exists.
- **Title:** a short present-tense step title ("Generating mascot data center video"), 16 px, secondary color,
  regular weight.
- **Thread line:** under the title, a 1 px hairline drops from under the icon. It runs beside the step's description:
  one or two sentences in the secondary color saying in plain words what's happening and why.
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
- **Card:** about 130 px tall in the second capture (105 px in the first), 32 px corner radius, no border, a soft
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
- **Build room:**
  - The title chip holds the product name. Share copies the product's link (the live URL once it ships, the build
    room's link before). More opens the build details that today sit in the "Build details" panel: model, Muse Code
    session, fix rounds, elapsed time, cost, tokens, connector URL and demo video.
  - The main column has the person's turn as a bubble. Each Muse Code round shows its current step inline with the
    mascot while it runs, and folds into "Show thinking" when it ends. The round's output is the media card: the live
    preview while the build runs (an iframe with today's sandbox attributes), then the poster or the demo video once
    it's done. The final message is plain text.
  - The steps panel replaces the "Build details" panel. Steps lists the whole build in order: the brief, each Muse Code
    round with its subagents, workflows, observers and tool calls nested under it, checks and fix rounds, the demo and
    the deploy. Screenshots and demo frames are its thumbnails, and it ends in "Done", "Stopped" or "Didn't finish".
    Subagent and workflow child rows use the mascot's subagent avatar (16 px) in place of the dot. Sources lists what
    the build used: the brief's inspirations and reference files, the Meta docs pages and models the agent looked up
    through the build MCP, the skills it read, and web pages.
  - Below about 1100 px wide, the panel covers the conversation from the right instead (same look, plus a soft shadow
    on its left edge); on phones it's a full-screen sheet with the same close X.
  - While a build runs, the steer box is this composer, and send turns into stop.
- **Docs sidebar chat:** the same bubbles, steps and composer. It's already a narrow sidebar, so "Show thinking"
  unfolds the steps list inline under its row instead of opening a second panel.

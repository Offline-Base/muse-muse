# The Muse app look

The owner prefers the Meta Muse app's chat look to Muse Muse's current one (Oct 30) and asked to copy it. This is
that look, written down from a screenshot of the app (a 2x capture, so the CSS sizes below are half its pixels), for
the conversation surfaces: the Make page composer, the build room, and the docs sidebar chat. Muse Muse still isn't
Meta's app: no Meta logos, and the footer keeps "Built with Muse Muse. Not an official Meta product."

## The page

- **Background:** plain white (`#FFFFFF`). No cards around the conversation, no gray canvas, lots of empty space.
- **Column:** one centered column about 620 px wide for messages and the composer, with generous vertical gaps
  (about 48 px between turns).
- **Type:** the system UI sans at 16 px, line height about 1.6. Body text near-black (`#1C1E21`); secondary text
  Meta gray (`#65676B`). Regular weight almost everywhere; nothing bold in the stream.

## The title chip

Top left, floating over the page: the conversation's title ("Muse mascot in the datacenter") in a white pill.
- **Shape:** about 28 px tall and fully rounded, with 12 px side padding.
- **Shadow:** soft, `0 2px 10px rgba(0,0,0,0.08)`, with no border.
- **Text:** 15 px, near-black.

In Muse Muse it holds the product or build name.

## The person's message

- **Bubble:** right-aligned, light gray (`#F1F2F4`), no border, fully rounded ends (about 24 px radius), 12 px by
  16 px padding. Its width fits the text, up to about 75% of the column.
- **Text:** 16 px, near-black.
- **Attachments:** they sit inside the bubble, at its right end. Each is a 32 px square thumbnail with 8 px rounded
  corners and a hairline border. Several attachments line up in a row.

## The agent's working step

- **Icon:** to the left of the step's title, the working icon, about 16 px. In the app it's a small purple "flower" of
  eight dots in a ring, shading from violet (`#7C3AED`) to lilac (`#C084FC`), spinning slowly while the step runs.
  Here it becomes the Muse mascot's working animation, from the owner's mascot folder, when that exists.
- **Title:** a short present-tense step title ("Generating mascot data center video"), 16 px, gray (`#65676B`),
  regular weight.
- **Thread line:** under the title, a thin vertical line (1 px, `#D7DADF`) drops from under the icon. It runs beside
  the step's description: one or two sentences in the same gray at 16 px, line height about 1.7, saying in plain
  words what's happening and why.
- **Nesting:** sub-steps (subagents, workflow children, observers, tool calls) nest on the same thread line, each
  with its own small icon and one-line title, so a step reads as a quiet tree.
- **Finished steps:** they keep their title with a check in place of the spinner. The final answer is plain
  near-black text with no bubble.

## The composer

A big white card pinned to the bottom of the column:
- **Card:** about 105 px tall, 32 px corner radius, a hairline border (`#E4E6EB`) and a soft shadow
  (`0 2px 12px rgba(0,0,0,0.08)`).
- **Text field:** the caret starts top-left with 18 px padding. No visible label: the placeholder reads like the
  app's.
- **Left of the bottom row:** a 34 px circular "+" button with a 1 px gray outline (`#CED0D4`). It opens
  attachments: photo, file, camera and voice memo, as the composer has today.
- **Right of the bottom row**, from left to right:
  - A pill toggle with a 1 px gray outline, 34 px tall, 16 px text ("Thinking" in the app). For Muse Muse it's the
    model or effort switch.
  - A 34 px circular mic button with a gray outline (voice input already exists).
  - The send button: a 34 px filled circle in Meta blue (`#4267F5`-ish), showing an up arrow when idle and a white
    rounded square (stop) while the agent works.

## Motion

Only the working icon moves. New steps fade in (150 ms). Nothing else animates.

## Where it applies

- **Make page:** the composer, and the first message as the person's bubble.
- **Build room:** the person's turn as a bubble, each Muse Code round as working steps on a thread (the brief,
  writing code, subagents and workflows as nested steps, checks, the demo, deploy), the final message as plain text,
  and the steer box as this composer while a build runs.
- **Docs sidebar chat:** the same bubbles, steps and composer.

---
name: recipe-image
description: Use for Muse Image work beyond one call, such as editing a person's photo in a conversation, composing several reference images, search-grounded generation, a consistent series from anchor images, or tagging and updating a listing photo.
---

# Muse Image recipes

Read `meta-image` first. It covers `images.generate`, `images.edit`, sizes, errors and cost. This skill adds the conversation patterns. Text steps name `muse-wonder-1.0`, which a test build runs on a cheaper model by itself. Image calls are real calls, so keep tests to one or two, and use fixtures elsewhere.

The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

Every recipe here uses `meta.responses.create({ model: "muse-image-1.0", tools: [{ type: "image_generation" }], ... })`. Pull images from `output` items where `type === "image_generation_call"`, with base64 in `result`. Find that item by type, never by position: a reply can also hold a reasoning item and a message. Keep each response's `id` on the page.

A photo goes in a turn as an `input_image`, inside a message:

```ts
input: [{ role: "user", content: [
  { type: "input_text", text: instruction },
  imagePart(photoDataUrlOrUploadUrl), // from @/lib/meta/parts
] }]
```

A bare list of content parts, with no `{ role: "user", content: [...] }` around it, is refused with a 400.

## Shared rules

- **Real pictures only.** Every image on the page came back from Muse Image or the person. Never an SVG, a drawn shape, a gradient or a stock placeholder standing in for a result. When a call fails or is blocked, show the reason in an `.error` with `role="alert"` and a Retry button, and keep the last good image.
- **The sample.** Try the sample runs the real flow on the brief's image fixtures in `fixtures/` (pictures the platform made with Muse Image). Copy the ones the flow needs to `public/samples/` and send them as data URLs. When the brief has no fixture a step needs, the product makes its own first turn from a written prompt, and says so.
- **Storage.** Results are large. Keep them in IndexedDB with `@/lib/client/media-store`. If that file isn't in the project (an older builder), write a small IndexedDB store yourself. Never put an image or a data URL in localStorage, and never let a failed save lose a paid result.
- **Progress and cost.** Each image takes about 10 to 30 seconds. Show a working state per turn, allow 90 seconds per call in tests, and show the turn's `usage` (input, cached and output tokens) under each result. Images cost about $0.01 each; put that in `costItems`.
- **End state.** Each flow ends with a final image, a Download button and the list of turns that made it. A redo always chains from the turn before the one being redone.

## 05/01 Fundamentals: generate, refine, compose

1. **Generate:** turn 1 is a text prompt in, one image out.
2. **Refine:** each later turn passes `previous_response_id` and only the change ("add a small red wool hat, keep the snowy forest"). Never resend the image.
3. **Compose:** a turn attaches one or more `input_image` parts beside its instruction and names each one in the text ("place the fox from the previous image on a table beside this mug, with this vase next to the mug"). Attach only images the server doesn't have yet; earlier results carry forward.
4. **No server state:** with `store: false`, carry the prior `image_generation_call` item as the first entry of the next turn's `input` instead of `previous_response_id`. Use it when an id is refused or expired.

Check: an image comes back for each step, a compose turn with two references returns one image, and a blocked prompt shows a friendly message. Limit: size sets only the aspect ratio.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image/01_image_api_fundamentals

## 05/02 Generation grounded in search

Ask for the search in the prompt: "Search the web for a coordinated outdoor lounge set that matches this brief, then render a clean product grid, one piece per cell on a plain white background." This is prompt wording, with no search tool passed. The API doesn't return what it found.

1. **Research and render:** turn 1 is the grid, so each piece stays faithful later.
2. **Compose:** turn 2 chains from turn 1 and attaches only the person's photo of the space (or the sample), with a guard: "Keep the space exactly as in the photo. Only add the furniture, matching the daylight and shadows."
3. **Refine:** turn 3 can search again ("Search the web for a matching coffee table, then add it in the open center. Keep everything else unchanged.").

If the reply has a message item, show its text as "What the model says it found (not checked)". Label every result "An illustration, not a photo of real products", and never show prices, stock or store names as fact. Limit: whether these searches are billed apart is unconfirmed, so note it in BUILD_NOTES.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image/02_backyard_restyle

## 05/03 Anchored series

Consistency comes from making references first.

1. Generate one anchor turn for each recurring thing: a character sheet on a plain background, each location plate with no characters. Chain each anchor from the one before, so all of them sit in one conversation. Show them, and let the person redo one before going on.
2. Each panel chains from the latest response with `previous_response_id`, names its anchors ("the hero shown earlier, in the park shown earlier"), and repeats the same style words. Ask for no text and no speech bubbles in panels.
3. Keep every id on the page. To redo a panel, chain from the id before it, not from the bad one.
4. If an id is refused, attach the anchors again as `input_image`.
5. Compose the page in one more chained turn ("Arrange the panels into one portrait page. Place each panel as-is"), or lay the panel images out in a CSS grid, which can't redraw them.
6. Letter in code: draw each short uppercase line in a bubble on a canvas over the page, in empty space, with a tail toward the speaker the person picks. Download the lettered page as PNG.

Size it to finish: two or three anchors and four panels by default. Render one panel at a time with visible progress. Count about $0.10 per series, and put that in `costItems`. The smoke test runs one anchor and one panel; the full series is for the person. Limit: small details can still drift, so compare each panel with its anchors.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image/03_anchored_generation

## 05/04 Editing with reasoning: a listing photo across turns

Build: a photo of several items for sale gets a price tag next to each, then updates as items sell.

1. **Tag:** turn 1 attaches the photo and binds each price to its item by name: "Add a small handwritten price tag next to each item, like masking tape with a marker price: $25 on the brass lamp, $80 on the guitar, $15 on the stack of books. Keep the items and the floor otherwise unchanged." The person edits the item and price list in a form; code writes the sentence.
2. **Update:** later turns chain with `previous_response_id` and name what changes and what stays: "The guitar sold: remove it and its tag, leaving bare floor. Mark the books down: $15 struck through with $8 beside it. Keep the lamp and its $25 tag unchanged."
3. **Compare:** a before and after slider over the original and each turn.
4. **Exact pixels (optional):** only when pixels outside one region must stay identical, find the region with SAM (`meta-sam`), crop, edit the crop, and paste it back with the mask as alpha.

Prices and strikethroughs are drawn labels, not a pricing feature: keep the real list in the page's own data and show it beside the image. Tell the model to keep each item's true condition. Check: the tag sentence is built from the form in a unit test, and one real tag turn returns an image. Limit: drawn text can come out wrong, and a whole-image edit can shift small things outside the region. Say so.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image/04_image_editing_with_reasoning

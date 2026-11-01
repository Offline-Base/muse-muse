---
name: recipe-image
description: Use for Muse Image work beyond one call, such as editing a person's photo in a conversation, search-grounded generation, a consistent series from anchor images, or careful region edits.
---

# Muse Image recipes

Read `meta-image` first. It covers `images.generate`, `images.edit`, sizes, errors and cost. This skill adds the conversation patterns. Tests use `muse-spark-1.3-contributor` for text steps. Image calls are real calls, so keep tests to one or two, and use fixtures elsewhere.

The links are for people and BUILD_NOTES. The build firewall may block GitHub, so never fetch or clone them.

Every recipe here uses `meta.responses.create({ model: "muse-image-1.0", tools: [{ type: "image_generation" }], ... })`. Pull images from `output` items where `type === "image_generation_call"`, with base64 in `result`. Keep each response's `id` on the page.

A photo goes in a turn as an `input_image`, inside a message:

```ts
input: [{ role: "user", content: [
  { type: "input_text", text: instruction },
  imagePart(photoDataUrlOrUploadUrl), // from @/lib/meta/parts
] }]
```

## 05/01 Fundamentals

One generation, one edit of a person's photo, and one follow-up with `previous_response_id`. Check: an image comes back, and a blocked prompt shows a friendly message. Limit: size sets only the aspect ratio.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image/01_image_api_fundamentals

## 05/02 Generation grounded in search

Ask for the search in the prompt: "Search the web for currently available outdoor chairs that match this brief, then draw them as a grid." This is prompt wording, with no search tool passed. Then a second turn attaches the person's photo and places the pieces, and a third turn can search again.

Label the result "An illustration, not a photo of real products", and never show prices or stock as fact. Limit: whether these searches are billed apart is unconfirmed, so note it in BUILD_NOTES.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image/02_backyard_restyle

## 05/03 Anchored series

Consistency comes from making references first.

1. Generate one anchor turn for each recurring thing: a character sheet, each location plate. Show them, and let the person redo one before going on.
2. Each panel chains from the latest response with `previous_response_id`, so it holds the anchors, and names them in its prompt.
3. Keep every id on the page. To redo a panel, chain from the id before it, not from the bad one.
4. If an id is refused, attach the anchors again as `input_image`.

Render one panel at a time with visible progress, since each takes about 15 seconds. Count about $0.10 or more per series, and put that in `costNotes`. Limit: small details can still drift, and lettering is best done in code over the image.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image/03_anchored_generation

## 05/04 Editing with reasoning

Try words first: describe the region and what must stay the same, such as "On the second shelf from the top, replace the blue vase with a green one. Leave everything else exactly as it is." The model works out what to change.

Use SAM (`meta-sam`), crop, edit and paste back with the mask **only when exact pixels outside the region must stay identical**, such as product photos or legal images. The person can compare before and after with a slider. Limit: a whole-image edit can shift small things outside the region. Say so.
Link: https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image/04_image_editing_with_reasoning

---
name: meta-image
description: Use to generate images from text, edit a photo, or combine several images into one with Muse Image (muse-image-1.0).
---

# Muse Image

All calls run on the server.

```ts
import { metaClient } from "@/lib/meta/client";

const meta = metaClient();
```

## Generate

```ts
const out = await meta.images.generate({
  model: "muse-image-1.0",
  prompt: "A walnut bookshelf with five shelves against a white wall, soft daylight",
  n: 1,
  size: "1024x1536",
  output_format: "jpeg",
});
const b64 = out.data?.[0]?.b64_json; // base64, always there unless you ask for a url
```

Show it with `data:image/jpeg;base64,${b64}` (`image/webp` when you leave `output_format` at its default).

| Option | Values |
|---|---|
| `n` | 1 to 10. Each image is billed |
| `size` | `"WxH"` sets **only the aspect ratio**, not pixels. `1024x768` came back as 1792×1344. Up to 16:1. Resize yourself if you need exact pixels |
| `response_format` | `b64_json` (default) or `url`, a temporary signed URL. Don't store that URL |
| `output_format` | `webp` (default), `png` or `jpeg` |

The reply is `{ created, output_format, background, usage, data: [{ b64_json }] }`. Ignore `usage` token counts: billing is per image.

## Edit or combine photos

The SDK sends multipart form data. Pass one file to edit it, or an array of up to 10 files to combine them.

```ts
import { toFile } from "openai";

const out = await meta.images.edit({
  model: "muse-image-1.0",
  image: await toFile(photoBytes, "room.jpg", { type: "image/jpeg" }),
  prompt: "Add a walnut bookshelf against the left wall. Keep everything else the same.",
});
```

For combining, describe how the inputs relate, for example: "Put the chair from the second image into the room in the first image."

`mask`, `input_fidelity`, `partial_images` and `moderation` are not supported, and sending them returns 400. Unknown fields also return 400.

## Changing only one region

There is no mask support. To change one area:

1. Find it with SAM 3.1 (meta-sam skill).
2. Crop to its box with some padding.
3. Edit the crop.
4. Paste it back over the original, using the SAM mask as the alpha channel.

## Follow-up edits ("make it darker")

The Responses API keeps context between turns. Chain turns with `previous_response_id`. Tool controls go in an `image_generation` tool, and it's the only tool accepted. Each image comes back as an `image_generation_call` output item with base64 bytes in `result`.

```ts
const first = await meta.responses.create({
  model: "muse-image-1.0",
  input: "A cozy reading nook by a window",
  tools: [{ type: "image_generation" }],
});
const next = await meta.responses.create({
  model: "muse-image-1.0",
  previous_response_id: first.id,
  input: "Same scene at night with a warm lamp",
  tools: [{ type: "image_generation" }],
});
```

## Errors

| Status | Meaning | What to do |
|---|---|---|
| 400 `content_policy_violation` | Blocked for safety | Show a friendly message and suggest rewording. Blocked images aren't billed |
| 400 | Bad option or unknown field | Fix the request |
| 415 | Wrong Content-Type | Use the SDK helpers |
| 503 | Temporary | Retry |

## Cost

$0.01 per image returned, so `n: 4` costs $0.04. A generation takes about 10 to 15 seconds, so show progress and allow 90 seconds in tests.

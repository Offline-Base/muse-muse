---
name: meta-reasoning
description: Use for text reasoning, reading photos, understanding video, reading PDFs, or getting JSON back from Muse Spark 1.3 or Muse Wonder through the Meta Model API Responses endpoint.
---

# Muse Spark 1.3 and Muse Wonder

All calls run on the server, in a route handler or server action.

```ts
import { metaClient } from "@/lib/meta/client";

const meta = metaClient(); // OpenAI SDK pointed at the Muse Muse gateway
```

## Pick the model

| Model | Use when |
|---|---|
| `muse-spark-1.3` | Default. Text, image, PDF and video input, 1M-token context |
| `muse-wonder-1.0` | Only if the brief lists it, for audio input, long multi-step work or web search. It's in preview and costs about three times as much |

## Text

```ts
const res = await meta.responses.create({
  model: "muse-spark-1.3",
  instructions: "You write cut lists for simple furniture. Use inches.",
  input: "A 30 inch wide, 72 inch tall bookshelf with 5 shelves in 3/4 inch plywood.",
});
const answer = res.output_text;
```

## Photos

Send a photo as a content part built with `imagePart`. It takes an https URL or a base64 data URL.

```ts
import { toDataUrl } from "@/lib/meta/media";
import { imagePart } from "@/lib/meta/parts";

const res = await meta.responses.create({
  model: "muse-spark-1.3",
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: "List every ingredient on this recipe card." },
        imagePart(toDataUrl(photoBytes, "image/jpeg")),
      ],
    },
  ],
});
```

Resize photos in the browser to about 1600 px on the long side before upload (see the product-ui skill). It keeps requests under the 4.5 MB function body limit and cuts cost.

## Video and PDFs

These two input types are the least documented, so check them on first use and record what worked in BUILD_NOTES.md.

- **Video.** Upload the clip with `uploadMedia` in the browser (product-ui skill), then pass the URL with `videoPart({ url })` from `@/lib/meta/parts`. This is the same `input_video` part SAM 3.1 uses.
- **PDF.** Upload with `meta.files.create({ file, purpose: "user_data" })` and pass `{ type: "input_file", file_id }`. If that returns 400, extract the text on the server and send it as text.

## JSON output

Use `respondJson` from `@/lib/meta/json` with a zod schema. It asks for JSON, validates the reply and retries once with the validation error. Don't parse model text by hand.

```ts
import { z } from "zod";
import { respondJson } from "@/lib/meta/json";

const CutList = z.object({
  pieces: z.array(z.object({ name: z.string(), qty: z.number().int(), lengthIn: z.number(), widthIn: z.number() })),
  notes: z.array(z.string()),
});

const cutList = await respondJson({
  model: "muse-spark-1.3",
  schema: CutList,
  schemaName: "cut_list",
  input: `Bookshelf: ${JSON.stringify(spec)}`,
});
```

## Reasoning effort and streaming

- Pass `reasoning: { effort: "low" }` for quick interactive replies. The default is high. Meta doesn't accept `none`.
- For long answers, pass `stream: true` and forward `response.output_text.delta` events to the browser through a `ReadableStream`.

## Errors

| Status | Meaning | What to do |
|---|---|---|
| 400 | The request is wrong | Fix it. Retrying unchanged fails again |
| 401 | Gateway token problem | Show "This product is temporarily unavailable" |
| 404 `model_not_found` | Wrong model, or one this product isn't allowed to use | Use a model the brief lists |
| 429, 503 | Busy | The SDK retries twice by default. Then show a retry button |

## Cost

Spark 1.3 runs about $1.25 per million input tokens and $4.25 per million output. One photo plus a short answer costs well under a cent. Keep instructions short and don't resend history you don't need.

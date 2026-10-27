---
name: meta-reasoning
description: Use for text reasoning, reading photos, understanding video, reading PDFs, or getting JSON back from Muse Spark 1.3 or Muse Wonder through the Meta Model API Responses endpoint.
---

# Muse Spark 1.3 and Muse Wonder

All calls run on the server, in a route handler or server action. The API matches OpenAI's Responses API.

```ts
import { metaClient } from "@/lib/meta/client";

const meta = metaClient(); // OpenAI SDK pointed at the Muse Muse gateway
```

## Pick the model

| Model | Use when |
|---|---|
| `muse-spark-1.3` | Default. Text, image, PDF and video input, 1M-token context |
| `muse-wonder-1.0` | Only if the brief lists it, for audio input, long multi-step work or web search. It's in preview and costs about three times as much |

## JSON output: use respondJson

Anything the UI renders as fields should come from `respondJson` with a zod schema. It uses Meta's native strict structured output (`text.format` json_schema, `strict: true`), validates with zod, retries once with the error, and falls back on its own if Meta rejects the schema (recursive schemas and `z.record` go non-strict). Never parse model text by hand.

```ts
import { z } from "zod";
import { respondJson } from "@/lib/meta/json";

const CutList = z.object({
  pieces: z.array(z.object({ name: z.string(), qty: z.number().int(), lengthIn: z.number(), widthIn: z.number() })),
  notes: z.array(z.string()),
  warning: z.string().optional(), // optional fields come back missing, never null
});

const cutList = await respondJson({
  schema: CutList,
  schemaName: "cut_list",
  instructions: "You write cut lists for simple furniture. Use inches.",
  input: `Bookshelf: ${JSON.stringify(spec)}`,
  // model: "muse-spark-1.3" (default), reasoningEffort: "low" (default)
});
```

- `.describe("...")` on fields becomes the schema description. Use it to steer the model.
- Zod checks that JSON Schema can't express (`.refine`) still run, and a failure triggers the one retry.
- It throws `RespondJsonError` (with `.issues`) if the second reply still doesn't match, and rethrows API errors.

## Plain text

```ts
const res = await meta.responses.create({
  model: "muse-spark-1.3",
  instructions: "You write friendly plant care tips.",
  input: "My basil is wilting.",
  reasoning: { effort: "low" },
});
const answer = res.output_text;
```

For long answers, pass `stream: true` and forward `response.output_text.delta` events to the browser through a `ReadableStream`.

## Photos

`imagePart` takes an https URL or a base64 data URL. Resize in the browser first (`resizeImage`, product-ui skill).

```ts
import { imagePart } from "@/lib/meta/parts";

const result = await respondJson({
  schema: Tally,
  schemaName: "tally",
  input: [{ role: "user", content: [{ type: "input_text", text: "Count the birds." }, imagePart(dataUrl)] }],
});
```

## PDFs

Two ways, both confirmed:

```ts
import { toFile } from "openai";
import { filePart } from "@/lib/meta/parts";
import { toDataUrl } from "@/lib/meta/media";

filePart({ dataUrl: toDataUrl(pdfBytes, "application/pdf"), filename: "menu.pdf" }); // inline, small PDFs
const file = await meta.files.create({ file: await toFile(pdfBytes, "menu.pdf", { type: "application/pdf" }), purpose: "user_data" });
filePart({ fileId: file.id }); // big PDFs, or one PDF used in several calls
```

## Video

`videoPart({ url })` with a **public https URL** from `uploadMedia` (Meta downloads it), a data URL for tiny clips, or `videoPart({ fileId })` after `meta.files.create`. MP4 or MOV. A 3-second clip is about 800 input tokens.

## Media URL fallback

If Meta can't download a URL, the call fails with HTTP 400 `media_url_origin_error`. Retry once with the bytes:

```ts
import { fetchAsDataUrl, isMediaUrlOriginError } from "@/lib/meta/media";

try {
  return await ask(imagePart(url));
} catch (err) {
  if (!isMediaUrlOriginError(err)) throw err;
  return await ask(imagePart(await fetchAsDataUrl(url)));
}
```

Vercel Blob URLs from `uploadMedia` work. Some sites (Wikimedia, for one) refuse Meta's fetcher.

## Reasoning effort

`reasoning: { effort }` accepts `minimal`, `low`, `medium` and `high`, not `none`. Use `low` for interactive replies. Even trivial answers use 150 to 400 reasoning tokens at `low`.

## Errors

| Status | Meaning | What to do |
|---|---|---|
| 400 | The request is wrong (the message names the field) | Fix it. Retrying unchanged fails again |
| 400 `media_url_origin_error` | Meta couldn't download your media URL | Retry with a data URL or a file id |
| 401 | Gateway token problem | Show "This product is temporarily unavailable" |
| 404 `model_not_found` | Wrong model, or one this product isn't allowed to use | Use a model the brief lists |
| 429, 503 | Busy | The SDK retries twice by default. Then show a retry button |

## Cost

Spark 1.3 runs about $1.25 per million input tokens and $4.25 per million output. One photo plus a short JSON answer costs well under a cent. Keep instructions short and don't resend history you don't need.

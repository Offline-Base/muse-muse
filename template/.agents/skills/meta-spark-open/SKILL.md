---
name: meta-spark-open
description: Use only when the brief lists muse-spark-open. Muse Spark Open, Meta's open-weight model, run by a hosted provider and reached through the gateway, for text and images in and text out.
---

# Muse Spark Open

## What it is

Meta's open-weight model, the open release of Muse Spark. Muse Muse runs it on a hosted provider (Baseten for now) and reaches it through the same gateway as every other model, with this product's token. It reads text and images and writes text. It reasons before it answers.

## The helpers

Server code only, in a route handler or a server action. Always pass the incoming `request` (or `await headers()`), so the gateway limits each visitor.

```ts
// app/api/sort/route.ts
import { askSparkOpen } from "@/lib/meta/spark-open";

const INSTRUCTIONS = "Sort the task into one of: errand, call, chore. Answer with the word only.";

export async function POST(request: Request) {
  const { task } = await request.json();
  try {
    const { text, label } = await askSparkOpen(request, {
      instructions: INSTRUCTIONS,
      messages: [{ role: "user", content: String(task).slice(0, 4000) }],
    });
    return Response.json({ text, label });
  } catch {
    return Response.json({ error: "The answer didn't come through. Try again in a moment." }, { status: 502 });
  }
}
```

- `askSparkOpen(request, options)` returns `{ text, label }` for one whole answer. It throws when the call fails or no answer came back, so catch it and show a plain error with a retry.
- `sparkOpenStream(request, options)` returns `{ stream, label }`: the answer as plain text while it's written, never the reasoning. Return the stream from the route and send `label` in a header or a first message.
- `messages` run oldest first and end with the visitor's message. Keep `INSTRUCTIONS` on the server, and never take it from the browser.
- Images: put `{ type: "image_url", image_url: { url } }` parts beside `{ type: "text", text }` in a user message. Use a data URL from `toDataUrl`, or an `uploadMedia` URL for big files.
- JSON: pass `json: true`, then parse the text with a zod schema and handle a reply that doesn't parse. Don't use `respondJson` for it: that helper is for the Responses endpoint.
- `maxTokens` (default 2000) counts its reasoning too. With too few, the reasoning uses them all and the helper throws. Keep `reasoning: "low"` unless a step really needs more: more reasoning is slower and costs more.
- An answer can take half a minute or more to start. Show that it's working, and set `export const maxDuration = 120` on the route.
- Don't call `metaClient().responses` with this model, and never call a provider or any other host yourself. The gateway answers only `/v1/chat/completions` for it.

## The label and the credit

Show `label` with every answer it writes, word for word. It names where it ran, for example:

> Muse Spark Open, on Baseten

To credit it with a chip, use `<ModelChip model="muse-spark-open" verb="Written" />` beside the label.

Its license, the Muse Model License, asks for this line. Put it in the footer, word for word, on every screen:

> Built with Muse Spark Open. For people 18 and over only.

Never say a person wrote an answer, and never imply Meta made the product.

## Limits

- Text and images in, text out. It has no web search, and takes no audio, video or PDFs: use the brief's other models for those.
- One reply per call. Function tools work; built-in tools don't.
- The gateway meters every call against the product's daily budget, like the other models, so write no limits of your own and hold no key.
- For people 18 and over only. Don't build it into a product for children or for students under 18, and say so in BUILD_NOTES.md if the brief asks for one.

## Tests

During the build its calls are real, on the build's own token and budget. Keep test calls few and short. Assert that an answer and its label show, never what the answer says.

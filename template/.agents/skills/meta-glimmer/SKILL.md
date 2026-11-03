---
name: meta-glimmer
description: Use only when the brief picks muse-glimmer, an open-weights model someone hosts. Muse Glimmer is Meta's open-weights 30B model. The Meta Model API doesn't serve it, and it needs a GPU server, not a phone, a laptop or a small board.
---

# Muse Glimmer

## What it is

Glimmer is a 30B dense model distilled from Muse Spark and released under Apache 2.0. Meta's docs list it as multimodal. Meta's quantized build is under 20 GB, and it runs on vLLM, SGLang, llama.cpp or ExecuTorch.

## When a product can use it

A product deployed on Vercel can't run Glimmer itself. It can call Glimmer only when `GLIMMER_URL` points at an OpenAI-compatible endpoint someone hosts on a GPU server, such as vLLM on Modal or Baseten. Meta's smallest Glimmer file is 16.8 GB, and a one-bit cut on an 8 GB board gave poor answers, so never promise in the UI or BUILD_NOTES.md that it runs on a phone, a laptop or a small board.

```ts
import { glimmer } from "@/lib/meta/glimmer";

const local = glimmer(); // null when GLIMMER_URL isn't set
if (local) {
  const res = await local.client.chat.completions.create({
    model: local.model, // GLIMMER_MODEL, or "muse-glimmer"
    messages: [{ role: "user", content: "..." }],
  });
}
```

If `GLIMMER_URL` isn't set, use Muse Wonder and say in the UI and in BUILD_NOTES.md that the Glimmer mode needs a Glimmer endpoint.

## Calling a `GLIMMER_URL` endpoint yourself

These come from Meta's Muse Glimmer docs (prompting and deploy guides).

- Send `temperature: 1.0`, `top_p: 0.95` and `top_k: 64` together on every request. Never send `temperature: 0`: Meta says greedy decoding gives flat, repeating or looping answers.
- Glimmer always reasons before it answers, and that can't be turned off. Set how much with `chat_template_kwargs: { reasoning_strength: "low" }` (low, medium, high or xhigh; the default is high). Don't use `reasoning_effort`, which llama.cpp ignores. Use low for interactive replies.
- Reasoning counts against `max_tokens`. If it uses them all, `content` comes back empty with `finish_reason: "length"`. Treat an empty answer as a reason to raise `max_tokens` or lower the strength, never as an answer, and stream long calls so they don't time out.
- The reasoning comes back in `message.reasoning` or `message.reasoning_content`, not in `content`. Never show it as the answer.
- Never put `<|eom|>` in `stop`. It ends a message, not the turn, so stopping there cuts off tool calls and answers.
- Pass tools as OpenAI-style `tools`; the server returns `tool_calls`. Glimmer makes one tool call per turn, so send each result back before it can make the next.
- Images go in `image_url` parts placed before the question, and work only when the server loaded Glimmer's vision projector.
- Put the system prompt first. Name the task exactly and say the format, length and tone up front. Don't explain to it how it works.

<!-- Wave 3, unit 11: the hosted Glimmer -->
## When the build prompt says "Hosted Muse Glimmer"

Muse Muse hosts Glimmer only during demo windows, and every other answer comes from Muse Wonder. Use the one helper. It handles the fallback, so don't write a second one. Never call `glimmer()` for this: it's only for an endpoint someone hosts through `GLIMMER_URL`, and it returns null here.

```ts
import { askGlimmer } from "@/lib/meta/glimmer";

const { text, by, note } = await askGlimmer({
  messages: [{ role: "user", content: question }],
  own: true, // this product's own tuned model; leave it out for base Muse Glimmer
  request, // the incoming request, or `await headers()`
});
```

- `by` is `"own"`, `"glimmer"` or `"wonder"`. Show `note` next to the answer whenever it isn't null. Models wrote these answers, so never say a person did.
- It throws only when the request itself is wrong (a 400). Fix those.
- A Glimmer answer can take over a minute, so show progress and set `export const maxDuration = 300` on the route.
- In a build the gateway sends sample replies with `simulated: true`. Assert that a reply shows, never what it says.
- The hosted endpoint takes text only: no images, no tools and no streaming. Keep a request under about 4,096 tokens.
- A product's own tuned model (`own: true`) was trained for one task. Use it only for that task, and use base Glimmer or Muse Wonder for anything else.
- Muse Glimmer's license and usage policy pass down to this product, so no use the policy bars.
- To test a closed window, have the smoke test call `page.setExtraHTTPHeaders({ "x-musemuse-glimmer-test": "closed" })`. The product must still answer and show the note.
<!-- End wave 3, unit 11 -->

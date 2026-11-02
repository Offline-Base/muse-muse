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
- Muse Glimmer's license and usage policy pass down to this product, so no use the policy bars.
- To test a closed window, have the smoke test call `page.setExtraHTTPHeaders({ "x-musemuse-glimmer-test": "closed" })`. The product must still answer and show the note.
<!-- End wave 3, unit 11 -->

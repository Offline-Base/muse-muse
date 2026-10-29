---
name: meta-glimmer
description: Use only when the brief asks for a local, private or offline model. Muse Glimmer is Meta's open-weights model for local agents and is not served by the Meta Model API.
---

# Muse Glimmer

## What it is

Glimmer is a 30B dense model distilled from Muse Spark and released under Apache 2.0. Meta's docs list it as multimodal. Meta's quantized build is under 20 GB, and it runs on vLLM, SGLang, llama.cpp or ExecuTorch.

## When a product can use it

A product deployed on Vercel can't run Glimmer itself. It can call Glimmer only when `GLIMMER_URL` points at an OpenAI-compatible endpoint someone hosts, such as vLLM on Modal or Baseten, or a home device exposed through a relay.

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

If `GLIMMER_URL` isn't set, use Muse Wonder and say in the UI and in BUILD_NOTES.md that the local mode needs a Glimmer endpoint.

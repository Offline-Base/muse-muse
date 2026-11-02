---
name: jetson-fleet
description: Use only when the brief lists jetson-fleet. A Meta model on boards Muse Muse runs, reached through the gateway, for text only.
---

# Jetson fleet

## What it is

A Meta model on a small set of boards Muse Muse runs. The platform chooses which, and the product never names one. It takes text only and sends one whole reply at a time, at about 13 to 15 tokens a second.

## The one helper

Server code only, in a route handler or a server action. Don't write a fallback, and don't call any other model in its place.

```ts
import { askFleetOrMessage } from "@/lib/meta/fleet";

const { text, answered, label } = await askFleetOrMessage({
  messages: [{ role: "user", content: question }],
  request, // the incoming request, or `await headers()`
});
```

- It never throws. When the boards can't answer, `text` holds fixed words saying the fleet is offline, `answered` is false and `label` is null. Show `text` either way.
- A reply can take over a minute, so show progress and set `export const maxDuration = 120` on the route.
- The gateway takes at most about 8000 characters of messages and answers with at most 1024 tokens. A product gets 100 answers a day, a visitor 10 a minute, and only one question runs at a time. Past any of these the helper gives the same fixed words.
- The messages have a shape the gateway checks: at most 64, a `system` message only first, and the last one the user's, with text. The helper sends only each message's `role` and `content`. A wrong shape also gives the fixed words, on every try, and the server log shows `[fleet] 400` with the reason's code.
- In a build the gateway sends a simulated reply with `simulated: true`, and no board is called. Assert that a reply and the label show, never what the reply says.

## The label

Always show this next to every answer, word for word. `label` holds it.

> Answered on boards we run, with no cloud model. Your text passes through this product's server, Muse Muse, ngrok and our lead board, so don't send private things.

Add nothing to it that makes it sound safer than it says, and never say a person wrote an answer. To credit the model with a chip, use `<ModelChip model="jetson-fleet" verb="Answered" />`, never another model's name.

## What not to use it for

Never use it for health, student, legal, money or other personal data. If the brief needs those, say so in BUILD_NOTES.md.

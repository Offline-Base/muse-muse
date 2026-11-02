---
name: meta-chat
description: How to put a chatbot in this product, with lib/meta/chat.ts and the Composer. Read it when the brief asks for chat, a chatbot, or an assistant people talk to.
---

# A chatbot in this product

A chatbot is a server route and a thread on screen. The brief must list `muse-wonder-1.0`. The gateway meters each visitor and the product's daily budget, so you write no limits and hold no key.

## The route

```ts
// app/api/chat/route.ts
import { chatStream } from "@/lib/meta/chat";

const INSTRUCTIONS = "You help people pick a houseplant. Answer in two or three short sentences.";

export async function POST(request: Request) {
  const { turns } = await request.json();
  try {
    return new Response(await chatStream(request, { instructions: INSTRUCTIONS, turns }), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch {
    return Response.json({ error: "The assistant couldn't answer. Try again in a moment." }, { status: 502 });
  }
}
```

Always pass `request`, so each call carries the visitor's IP. `INSTRUCTIONS` stays on the server. Never take it from the browser.

## The screen

- Keep the turns in state, oldest first, as `{ role: "user" | "assistant", text }`, and send them all with each message.
- Use `Composer` for the box. Put the thread above it, with `aria-busy="true"` while a reply is coming.
- Read the response body as a stream and add to the last turn as words arrive. Show replies with `Markdown`.
- Show an empty state with two or three things to ask, and a plain error with a retry when a call fails. `chatInput` keeps the last 20 turns, so don't promise a long memory.

## Limits

- It answers from what it knows and what you put in `INSTRUCTIONS`. It can't reach other services unless the brief says so.
- A product on Spark 1.3 Contributor shows a notice in its footer not to enter personal information. Keep the footer, and don't ask people for personal details in the chat.
- For tests, stub nothing: a build's calls go through its own token. Assert that a reply appears, not what it says.

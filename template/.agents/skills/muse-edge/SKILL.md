---
name: muse-edge
description: Use only when the brief's "Where it runs" lists Edge, or the brief asks the product to keep answering when the cloud is cut. lib/meta/edge.ts asks the cloud first and a backup model on an edge board second, and labels who answered.
---

# Muse Edge

## What it is

A product that must keep answering when Meta's cloud can't be reached asks for its structured answers through `respondJsonOrEdge` in `lib/meta/edge.ts`. It tries the cloud first (`respondJson` through the gateway, held to 10 s), then a backup model on an edge board through any OpenAI-compatible server at `EDGE_URL`. With `EDGE_FIRST=1` it asks the board first. It never returns a reply that doesn't match your zod schema, from either side.

Use it for the product's main answer only. Everything else (chat streams, images, voice) stays as the other skills say, and the page must say plainly when one of those is unavailable.

## How to call it

Server only, in a route handler or a server action. Same options as `respondJson`.

```ts
import { respondJsonOrEdge } from "@/lib/meta/edge";

const answer = await respondJsonOrEdge({
  schema: Status,
  schemaName: "status",
  instructions: "...",
  input: rowsAsText,
  request,
});
if (!answer.ok) return Response.json({ message: answer.message }, { status: 503 });
return Response.json({ ...answer.data, by: answer.by, label: answer.label });
```

- It never throws for a model failure. Read `ok`. When it is false, show `answer.message` as it is, in the page, not only in the console, and keep the person's input on screen. That happens when both sides are down, and also when the cloud was reached and turned the request down (a limit or a refusal): the backup model answers only when the cloud can't be reached, never to get around the cloud's answer.
- `answer.by` is `"cloud"` or `"edge"`. `answer.fellBack` says why the first side didn't answer, for your logs only.
- Keep the schema small and flat: an enum for status, a few short strings, a short list. A small board model handles that far better than deep nesting or free text.
- Don't log raw answers or inputs from the edge path to the console. Never write `console.error` for an expected fallback: the smoke test fails on console errors.

## Labels

Show `answer.label` next to every answer, in small text, word for word. It is fixed by the platform, never written by a model:

- the cloud: "Answered in the cloud, Muse Wonder"
- the board: "Answered on <board>, <model>", for example "Answered on jetson-04, Llama 3.2 3B"

The board and model names come from `EDGE_BOARD` and `EDGE_MODEL_NAME`. Never invent your own wording for who answered.

## What to say, and what never to say

Anything a person reads in the product or BUILD_NOTES.md:

- Data in a demo is invented. Label it "Simulated" on the page, for example "Simulated cold room".
- Say the product "is built so" it keeps answering from a backup model when the cloud is cut. Don't say it works offline: the page itself, saved data and the other models still need their network.
- Never call a board answer private or on-device. Never say anything is attack-proof or stops hacks.
- No food-safety advice and nothing about real freezers or real stores. Status lines say what the simulated readings show and what to check next, never whether food is safe.
- Say what to check, not what happened: "The probe and the controller disagree" rather than "the controller was hacked".

## Env

| Name | What |
|---|---|
| `EDGE_URL` | The edge server's `/v1` base URL. Unset means no edge side. |
| `EDGE_MODEL` | The served model's name. |
| `EDGE_API_KEY` | Only when the server asks for one. |
| `EDGE_BOARD`, `EDGE_MODEL_NAME` | The names in the label. |
| `EDGE_FIRST` | `1` asks the board first. |
| `EDGE_TIMEOUT_MS`, `EDGE_CLOUD_TIMEOUT_MS` | How long each side gets. Defaults 60000 and 10000. |

These are set by whoever runs the product. Never put a value in code.

## Testing

- Unit tests can fake `fetch` the way `scripts/__tests__/edge.test.mjs` does.
- Write `edge-drill.json` at the product's root, naming the route that calls `respondJsonOrEdge` and a simulated body for it: `{ "path": "/api/actions/status", "method": "POST", "body": { ... } }`. The route's JSON reply must carry `label` on success and `message` when both sides fail.
- `scripts/edge-drill.mjs` runs four simulated outage drills against a running product (cloud refused, cloud hung, both down, a tampered edge reply), with `scripts/edge-fake.mjs` as the edge server and `scripts/edge-blackhole.mjs` as the gateway. Read the top of each file. None of them calls a real model.

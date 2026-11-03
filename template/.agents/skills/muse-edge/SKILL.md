---
name: muse-edge
description: Use only when the brief's "Where it runs" lists Edge, or the brief asks the product to keep answering when the cloud is cut. lib/meta/edge.ts asks the cloud first and a backup on an edge board second (a small model for the answer, Meta SAM 3.1 for a look at a photo), and labels who answered.
---

# Muse Edge

## What it is

A product that must keep answering when Meta's cloud can't be reached asks for its structured answers through `respondJsonOrEdge` in `lib/meta/edge.ts`. It tries the cloud first (`respondJson` through the gateway, held to 10 s), then a backup model on an edge board through any OpenAI-compatible server at `EDGE_URL`. With `EDGE_FIRST=1` it asks the board first. It never returns a reply that doesn't match your zod schema, from either side.

Use it for the product's main answer only. When the product must see what is in a photo, use `segmentOrEdge` from the same file (below). Everything else (chat streams, images you make, voice) stays as the other skills say, and the page must say plainly when one of those is unavailable.

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

## When the product must see: `segmentOrEdge`

When the brief lists `sam-3.1` (find, count or outline things in a photo, like a door left open), every SAM call goes through `segmentOrEdge` in `lib/meta/edge.ts`, never the meta-sam skill's `meta.responses.create`. It asks the cloud's `sam-3.1` first (held to 10 s when a board waits behind it), then Meta SAM 3.1 on the board at `EDGE_SAM_URL` (the board's `sam3` service). The meta-sam skill's prompt rules still apply.

```ts
// app/api/actions/look/route.ts
import { segmentOrEdge } from "@/lib/meta/edge";

export async function POST(request: Request) {
  const { photo, prompt } = await request.json();
  const seen = await segmentOrEdge({ image: photo, prompt, request });
  if (!seen.ok) return Response.json({ message: seen.message }, { status: 503 });
  return Response.json({ count: seen.count, objects: seen.objects, by: seen.by, label: seen.label });
}
```

- `image` is a JPEG or PNG data URL. In the browser: `resizeImage(file, { maxSide: 1024 })`, then `blobToDataUrl`, both from `@/lib/client/resize`. Send it to a route handler, not a server action (their 1 MB body limit).
- `prompt` is one short noun phrase, like "open door" or "pallet". For two things, make two calls.
- `seen.objects` is a list of `{ box: { left, top, right, bottom }, score }`. The box is fractions of the photo, 0 to 1, the same from either side, so draw it over the photo with CSS percentages. Say the count in words ("1 open door found"). Zero found is an answer, not an error.
- `threshold` (default 0.5) is the lowest score that counts, on both sides.
- `overlay: true` asks the board for its picture with the matches tinted (`seen.overlay`, a JPEG data URL). The cloud has none, so draw your own boxes either way.
- When `ok` is false, show `seen.message` as it is, on the page: "Can't see right now..." when both sides are down, the cloud's refusal, or a photo it couldn't read. Never guess a count, and never `console.error` it.
- Every photo the product offers as a sample (a door photo, say) lives in `public/samples/`: copy it there from `fixtures/`. Put a "Try the sample" button next to the photo picker that loads it with `fetch("/samples/door-open.jpg")`, then `resizeImage` and `blobToDataUrl` as for a picked photo, and sends it through the same route. Never fetch `/fixtures/` from the page: that folder isn't served. The smoke test clicks "Try the sample" and waits for the labeled result.
- When the look is the main answer (is the door open?), turn the count into the status in code ("Door open" when the count is above 0), not with a model. Such a product needs no `respondJsonOrEdge` at all.
- A camera button: `navigator.mediaDevices.getUserMedia({ video: true })` into a `<video>`, draw one frame on a canvas, `canvas.toBlob(cb, "image/jpeg", 0.85)`, then `resizeImage` and `blobToDataUrl`. Stop the camera's tracks after. Browsers open the camera only on https or `http://localhost`, so keep a photo picker (`FilePicker`, product-ui skill) beside it.

## The board status line

Every edge product shows whether it reaches a board, on its main screen, near the main answer. Render the template's `BoardStatus` from `components/BoardStatus.tsx`, and keep `app/api/board-status/route.ts` and `lib/meta/board-status.ts` as they are:

```tsx
import { BoardStatus } from "@/components/BoardStatus";

<BoardStatus looks /> {/* `looks` only when the product looks at photos with segmentOrEdge */}
```

- It says "Connected to <board>" only when every board side this copy has set up answered its health check just now, and "Not connected to a board" otherwise, with a plain second line. It asks no model.
- A hosted copy usually has no board: then it says "Not connected to a board", and that is the truth. Never hide it, restyle it into something that looks connected, or write your own wording for it.
- Never say a board answered unless a reply's `by` says so. Never show a board name, a board model or "on the board" anywhere else on the page.

## Board screens

A screen, tab or mode that says it shows the board's answer ("Board", "Board mode", "Offline preview", "On the Jetson") must never call the cloud. Call the helpers with `boardOnly: true` there:

```ts
const answer = await respondJsonOrEdge({ schema: Status, schemaName: "status", instructions, input, request, boardOnly: true });
const seen = await segmentOrEdge({ image: photo, prompt, request, boardOnly: true });
```

- With no board set up they return `ok: false` with "Not connected to a board. This screen asks only the board, so the cloud model wasn't asked." Show that message as it is, with the BoardStatus line beside it. That is the right result on a hosted copy.
- An answer labeled "Answered in the cloud" or "Seen in the cloud" never goes on a board screen.
- You don't need a board screen. The main screen with its label and the BoardStatus line is enough.

## Labels

Show `answer.label` next to every answer, in small text, word for word. It is fixed by the platform, never written by a model:

- the cloud: "Answered in the cloud, Muse Wonder"
- the board: "Answered on <board>, <model>", for example "Answered on jetson-02, Muse Glimmer one-bit"

For a look at a photo (`segmentOrEdge`), `seen.label` is:

- the cloud: "Seen in the cloud by Meta SAM 3.1"
- the board: "Seen on <board> by Meta SAM 3.1"

The board and model names come from `EDGE_BOARD` and `EDGE_MODEL_NAME` (for SAM, `EDGE_SAM_BOARD` and `EDGE_SAM_MODEL_NAME`). Never invent your own wording for who answered or who looked.

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
| `EDGE_SAM_URL` | The board's SAM service, like `http://127.0.0.1:8790`. Unset on a hosted product (with `GATEWAY_URL` set), the board look goes through Muse Muse's `{GATEWAY_URL}/fleet/v1/segment` to an office Jetson, slower (10 to 25 s), and only when the cloud fails or `EDGE_FIRST=1`; Muse Muse answers 404 while that route is off, which reads as the board being down. Write nothing for it: `segmentOrEdge` already does it. |
| `EDGE_SAM_BOARD`, `EDGE_SAM_MODEL_NAME` | The names in the SAM label. Default `EDGE_BOARD` (else "the board") and "Meta SAM 3.1". |
| `EDGE_SAM_TIMEOUT_MS` | How long the board's look gets. Default 30000. |
| `EDGE_SAM_API_KEY` | Only when something in front of the service asks for a token. |

These are set by whoever runs the product. Never put a value in code.

## Testing

- Unit tests can fake `fetch` the way `scripts/__tests__/edge.test.mjs` does.
- Write `edge-drill.json` at the product's root, naming the route that calls `respondJsonOrEdge` and a simulated body for it: `{ "path": "/api/actions/status", "method": "POST", "body": { ... } }`. The route's JSON reply must carry `label` on success and `message` when both sides fail. Add `"page": "/board"` only when the BoardStatus line is on a page other than `/`.
- A product that looks at photos also names its `segmentOrEdge` route under `sam`, with the string `SIMULATED_PHOTO` where the photo goes (the drill puts a small simulated photo there), and its sample photo under `sample`: `"sam": { "path": "/api/actions/look", "body": { "photo": "SIMULATED_PHOTO", "prompt": "open door" }, "sample": "/samples/door-open.jpg" }`. A product whose only answer is the look writes only `sam`.
- `scripts/edge-drill.mjs` runs four simulated outage drills against a running product (cloud refused, cloud hung, both down, a tampered edge reply), two board status drills (the route says connected with the simulated board up and "Not connected to a board" with it down, and the page shows the BoardStatus line), and on the `sam` route four more (the same, with a tampered board reply) and one that loads the sample photo, with `scripts/edge-fake.mjs` as the edge server and the board's SAM service and `scripts/edge-blackhole.mjs` as the gateway. Read the top of each file. None of them calls a real model.

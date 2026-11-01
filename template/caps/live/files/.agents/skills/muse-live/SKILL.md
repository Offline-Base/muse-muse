---
name: muse-live
description: How a Muse Muse product shows near-live captions from the microphone, and how a saved collection's changes reach every open browser with no reload. Read it when brief.md has a "Live" section.
---

# Live captions and updates

brief.md's "Live" section says which of the two this product has. Two-way voice isn't available: nothing talks back.

## Captions

The browser sends a piece of 2 to 3 seconds at a time, so text appears a few seconds behind the speaker.

```tsx
"use client";
import { CAPTIONS_NOTICE, useCaptions } from "@/lib/platform/captions";

export function Lecture() {
  const { captions, status, error, start, stop } = useCaptions();
  const on = status === "starting" || status === "listening";
  return (
    <section>
      <p>{CAPTIONS_NOTICE}</p>
      <button onClick={on ? stop : start}>{on ? "Stop" : "Start captions"}</button>
      {error ? <p role="alert">{error}</p> : null}
      <p aria-live="polite">{captions.map((c) => c.text).join(" ")}</p>
    </section>
  );
}
```

- `start()` must come from a click. The browser asks for the microphone then. Never start on page load.
- Show `CAPTIONS_NOTICE` near the button, before the click. It says where the audio goes. Say no more about what happens
  to the audio than it does.
- Offer Stop from `starting` on, as above: someone can change their mind while the browser's question is showing.
- Each caption is `{ text, startMs, endMs }`, times from when recording started. Don't promise speaker names: the model
  doesn't give any. Pieces overlap a little and the repeated words are taken out for you, so don't dedupe them again.
- `status` is `idle`, `starting`, `listening`, `stopped`, `limit` or `error`. `limit` means this person, or everyone on
  their network together, used today's minutes; show `error`, which says which. Silence costs nothing: quiet pieces aren't sent.
- This app doesn't keep the audio. Save the captions only if the brief says to.

## Live updates

```tsx
"use client";
import { useLive } from "@/lib/platform/live";

type Score = { team: string; points: number };

export function Board() {
  const { items, status, error } = useLive<Score>("scores", "shared");
  return (
    <section>
      {status === "reconnecting" ? <p>Reconnecting. Scores may be a little behind.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <ul>{items.map((i) => <li key={i.id}>{i.data.team}: {i.data.points}</li>)}</ul>
    </section>
  );
}
```

- `useLive(collection, scope)` reads only. The collection and scope are the ones brief.md's "Saving data" section lists,
  and a browser gets only what its holder could read with `data()`. Save through your own action routes as the `muse-data`
  skill says. Don't refresh or poll after a save: the change arrives by itself, in under 5 seconds.
- `items` starts empty and fills from the stream, oldest change first, the newest 500 at most. Sort for display yourself.
- `status` is `connecting`, `live`, `reconnecting` or `error`. At most 20 people can watch one product at once, and at most
  10 from one network, and past that `status` stays `reconnecting`, so keep the page usable without it.

## The smoke test

```ts
import { checkCaptions, checkLiveUpdate } from "./caps/live";

await checkCaptions(page, { start: "Start captions", stop: "Stop" });

await checkLiveUpdate(page, {
  change: async (first, mark) => {
    await first.getByLabel("Team").fill(`Team ${mark}`);
    await first.getByRole("button", { name: "Add" }).click();
  },
  shows: (mark) => `Team ${mark}`,
});
```

- `checkCaptions` clicks start, waits for 2 pieces from the fake microphone, clicks stop, and checks their times and that
  their words show. It clicks stop itself, so call it once: the smoke test may use at most 6 pieces. Its pieces are real
  calls.
- The test browser's microphone plays `fixtures/talk.wav`, a made-up lecture about rivers, whatever the product is about.
  Never assert those words, and don't put them in the product.
- `checkLiveUpdate` opens a second browser, waits until it has caught up, and needs `shows` there within 5 seconds with no
  reload. `mark` is a made-up word that's new each run. Save it in the change and make `shows` from it: never a fixed text,
  because this test runs again in the same build (fix rounds, the demo), and earlier runs' rows are still there. If the
  change can't carry words, like a vote button, read the second browser and work out what comes next:
  `shows: async (_mark, other) => new RegExp(\`^Votes: ${Number(await other.getByTestId("votes").innerText()) + 1}$\`)`.
- They take the judge screenshots `10-captions` and `11-second-browser-live`, so number your own around them. If they
  come last, take your final screenshot after them.

These helpers, the routes and the fixture are platform files. Leave them as they are.

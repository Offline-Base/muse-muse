import type { Brief } from "@/lib/brief/schema";
import { liveBlock, liveCollectionScope } from "@/lib/caps/live/brief";
import { LIVE_LIMITS } from "@/lib/caps/live/limits";
import type { CapRenderEntry } from "@/lib/caps/render";

/**
 * The live cap's part of the prompts (docs/CAPABILITIES.md, 2.6 and section 13). Its text names the platform files in
 * template/caps/live: the skill, the helpers in lib/platform/, the routes, tests/caps/live.ts and fixtures/talk.wav.
 */
export const LIVE_RENDER: CapRenderEntry = {
  title: "Live",
  build(brief: Brief) {
    const live = liveBlock(brief);
    if (!live) return [];
    const collection = live.updates?.collection;
    const scope = collection ? liveCollectionScope(brief, collection) : "";
    return [
      `The brief asks for ${[live.captions ? "near-live captions" : "", collection ? `live updates of the ${collection} collection` : ""].filter(Boolean).join(" and ")}.`,
      "",
      "- Read `.agents/skills/muse-live/SKILL.md` first.",
      ...(live.captions
        ? [
            "- Captions: `useCaptions()` from `lib/platform/captions.ts` (a client component) records the microphone, sends 2 to 3 second pieces to the platform's own `/api/musemuse/live-caption` route, and gives `{ captions, text, status, error, start, stop, clear }`, each caption `{ text, startMs, endMs }`. Pieces overlap a little, so words aren't cut, and the repeats are removed for you.",
            "- `start()` must come from the person's click: the browser asks for the microphone then, never on page load. Show `CAPTIONS_NOTICE` from the same file next to the button, before they click. It says the audio goes to Muse Voice Transcribe. Show a Stop button while `status` is listening, and show `error` as it is, in plain words.",
            "- List `muse-voice-transcribe-1.0` in `musemuse.json`'s models, used for the captions. The product's own code doesn't call it: the route does.",
            "- Privacy: audio isn't kept. Don't save the captions unless the brief says to, and never send them to a model without saying so.",
          ]
        : []),
      ...(collection
        ? [
            `- Live updates: \`useLive("${collection}", "${scope}")\` from \`lib/platform/live.ts\` (a client component) gives \`{ items, status, error }\`, each item \`{ id, data, seq }\`, oldest change first, and keeps them current with no reload. Render from \`items\`. Writes still go through your action routes with \`data()\` from \`lib/platform/data.ts\`, and the change reaches every open browser by itself, so don't refresh or poll.`,
            `- Scope: a browser gets only what its holder could read with \`data()\`. ${collection} is ${scope}.`,
          ]
        : []),
      `- Limits the user sees, once each: ${[
        live.captions ? "captions run a few seconds behind and each person has a limited number of minutes a day (`status` becomes \"limit\" and `error` says so)" : "",
        collection ? `at most ${LIVE_LIMITS.streamsPerProduct} people can watch at once, and past that \`status\` stays "reconnecting", so keep the page usable without it` : "",
      ]
        .filter(Boolean)
        .join("; ")}.`,
      ...(live.captions ? [`- No stand-in: a build's chunks are real calls. Its test browser has a fake microphone playing \`fixtures/talk.wav\`, a made-up lecture about rivers, so captions show those words whatever the product is about. Never assert those words.`] : []),
      ...(collection ? ["- No stand-in: a build's stream is real, on the build's own test rows."] : []),
      `- Smoke test, from \`tests/caps/live.ts\`: ${[
        live.captions ? `\`checkCaptions(page, { start, stop })\` clicks your start button, waits for 2 caption pieces and clicks stop. At most ${LIVE_LIMITS.smokeChunks} pieces per verify, so call it once` : "",
        collection ? "`checkLiveUpdate(page, { change, shows })` opens a second browser, runs `change` in the first, and needs `shows` in the second within 5 seconds with no reload" : "",
      ]
        .filter(Boolean)
        .join("; ")}. Each takes its own judge screenshot, so leave numbers 10 and 11 to them.`,
      "- `lib/platform/captions.ts`, `captions-chunks.ts`, `live.ts`, `live-state.ts`, `app/api/musemuse/live-caption/route.ts`, `app/api/musemuse/live-ticket/route.ts`, `fixtures/talk.wav`, `tests/caps/live.ts` and `scripts/caps/live.mjs` are platform files. Leave them as they are.",
    ];
  },
  refine(brief: Brief) {
    const live = liveBlock(brief);
    if (!live) return [];
    return [`- The product has ${[live.captions ? "near-live captions" : "", live.updates ? `live updates of ${live.updates.collection}` : ""].filter(Boolean).join(" and ")} (\`.agents/skills/muse-live/SKILL.md\`). Keep their checks in the smoke test passing.`];
  },
  markdown(brief: Brief) {
    const live = liveBlock(brief);
    if (!live) return [];
    return [...(live.captions ? ["- Near-live captions, a few seconds behind"] : []), ...(live.updates ? [`- Live updates of ${live.updates.collection}, with no reload`] : [])];
  },
};

# Look first

`LOOK_FIRST`, off by default. Owner request, Nov 2: "build the UI first, then wire everything in, and still be able to modify the UI".

## How a build runs with it on

1. **Brief, product and sandbox** as today.
2. **Round 0, the screens** (`look.md`, at most 12 minutes):
   - every screen in brief.md, the navigation, and the empty and error states;
   - sample data from `lib/sample.ts`;
   - no model calls, routes, saving or platform services;
   - the only check is `npx tsc --noEmit`, with no `npm run verify`.
   - On the serve engine the round gets no session goal, since the goal is the whole build.
3. **The preview starts.** The build room shows "Your screens are ready" to everyone. The person who started the build (owner powers, as for a change) gets:
   - **Change the look:** a note. It passes the same policy check as a change, then runs one short round (`look-change.md`, at most 6 minutes), with the note fenced as the person's words. The screens are shown again. At most 2 changes.
   - **Looks good, wire it up.**
   - **Nothing:** after `LOOK_WAIT_SECONDS` (default 120, between 15 and 600), it wires in by itself, so an unattended build never stalls.
4. **The wiring run** (`wire.md`): everything else in brief.md on the same screens, with brief.md's Done means. It keeps the look, and says in BUILD_NOTES.md where wiring changed a screen.
5. **The checks and fix rounds** as today, numbered from the wiring round.

Milestone and chain builds skip the look stage.

## The pieces

| Piece | Where |
|---|---|
| Flag and wait | `lib/env.ts` (`lookFirst`, `lookWaitMs`) |
| Prompts | `lib/engine/look.ts` |
| Steps | `writeLookPromptStep`, `lookReplyStep`, `lastEventIdStep` in `lib/pipeline/build-steps.ts` |
| The stage | `runLook` in `lib/pipeline/workflow.ts` |
| Events | `look` and `look_reply` in `lib/types.ts` |
| The owner's answer | `POST /api/builds/{id}/look` |
| The card | `components/build/LookCard.tsx`, with its state from `components/build/look.ts` |

## Turning it on

- `LOOK_FIRST=1` on a preview first, with one test build on `TEST_MODEL` and made-up data.
- The prompts are written into the sandbox at run time, so this needs no new builder snapshot.

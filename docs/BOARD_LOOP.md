# The board loop

One button on a judged model: make the file, send it to a board, serve it, run a fixed test set, record a clip, open a try page. Behind `BOARD_LOOP`, off by default. Started Nov 1, 2026. It has only ever run against the simulated board. What a real board still needs is in [JETSON_TODO.md](JETSON_TODO.md).

## Stages

| Stage | What it does | Cost shown |
|---|---|---|
| Tune | Reads the judged adapter (`judgedProblem`: finished, with eval items) | The job's cost plus judging |
| Make the file | Real board: waits for the local files job, which the start route starts through the quantize route, so every GPU cap applies. Jetson gets IQ1_S, a Llama adapter gets Q4_K_M (`loopFile`, `fileForDevice`). Simulated: skipped, no GPU, a stand-in name | The quantize job's cost |
| Send to the board | `install`: a file already there gets checked, then a download under a `.part` name, checksum twice. A real file with no checksum is refused. Over MCP the board reports the download's hash, and a mismatch ends the loop | $0 |
| Serve on the board | `serve`, then polls until the board lists the name | $0 |
| Fixed test set | `TEST_SET` (the emulator's prompts), one prompt a tick, tokens a second from the stream, memory and temperature from the node. A real board must stay under its own memory | $0 |
| Record a demo | Demo Studio's own recorder and terminal scene. A clip that can't be made skips the stage and doesn't stop the loop | $0 |
| Open the try page | `/try-board/<id>` | $0 |

`lib/board-loop/tick.ts` makes one small saved move each call and `workflow.ts` calls it and sleeps. Each stage has a time limit. A board that can't be reached waits until that limit; any other error ends the loop, stops the board and closes the page. Stop runs from the route itself, so it works after the workflow's 12-hour hard stop. The board is only touched once this loop's serve began: before that it still has its old job, and a stop would end that. A real board leaves maintenance only once it says the model left; if it doesn't say so within 40 seconds, it stays in maintenance and the serve stage says to check it. Stop does not stop a local files job the loop started: that runs on under its own caps, the stage says so, and it stops from its own page. Costs are what jobs recorded, and a stage with none says "not recorded".

## Boards

Everything goes through `BoardDriver` (`lib/board-loop/driver.ts`). `BOARD_LOOP_TARGET` picks one. A loop's stored rows never hold an address or token.

| Target | Code | Seen working? |
|---|---|---|
| `simulated` (default) | `sim.ts`, `scripts/sim-board.mjs` through the fleet driver | Yes, as labeled: canned text only |
| `fleet` | `fleet.ts`, `BOARD_FLEET_URL`, `BOARD_FLEET_TOKEN` (`jpt_`, needs admin for `exec`), `BOARD_FLEET_NODE` | Only against the simulated process and fakes |
| `device` | `device-mcp.ts`, `DEVICE_MCP_URL`, `DEVICE_MCP_TOKEN`. `install_model` waits about 5 minutes, so it suits the small Llama and not 6.5 GB | Never run on a board; a fake caller only |

**The simulated board** is a real small node process on 127.0.0.1, behind a random token, that answers the part of the control plane's API the loop uses. It holds no model, runs no llama.cpp and never executes the commands it's sent. It exits after 30 idle minutes. Its answers say they are canned, and its memory number is its own, about 50 MB. Its tokens a second is a setting (`SIM_BOARD_TPS`). None of its numbers say anything about a Jetson. Every page, caption and stage line says "Simulated board".

It needs a host that keeps a process running. On Vercel, set `BOARD_SIM_URL` and `BOARD_SIM_TOKEN` to one running elsewhere, or the loop waits and then fails at the send stage's limit. The clip needs `BOARD_CLIP_TOOLS_DIR` (a folder with `@playwright/test` 1.64.1 and its browser) and ffmpeg on the same machine, and is skipped in a Vercel function: **a loop run on a Preview gets no clip** until this is moved into a sandbox.

## The try page

`/try-board/<id>`, with `lib/board-loop/try.ts`. The board answers one person at a time: a visitor's own poll runs their turn at the front of the line, so there's no worker.

- One open turn per visitor, 5 turns an hour per visitor, 20 per network, a queue of 12, 500 characters in, 128 tokens out (`TRY_LIMITS`). Refusals say when to come back.
- A visitor is the SHA-256 of a random cookie, and prompts are cleared when the turn ends. Finished turns go after a day.
- A queued turn with no poll for 30 seconds leaves the line, and a failure that's the board's fault gives the turn back.
- Offline: the page reads the board and never starts it. If the board is gone it says so and checks again.
- **A real board's page is admins only until `BOARD_TRY_PUBLIC`.** Prompts then reach a tuned model on owned hardware with no content check of their own, so decide that deliberately.

## Tables

`0031_board_loop`: `board_loops` (one going per kind of board) and `board_try_turns` (one running per loop, one open per visitor), both held by partial unique indexes. Merged with another migration, keep `0031`'s `when` newer (`lib/db/migration-order.ts`).

## Tests

    npx tsx --test lib/board-loop/__tests__/loop-sim.test.ts lib/board-loop/__tests__/fleet.test.ts
    npx tsx --test --experimental-test-module-mocks lib/board-loop/__tests__/store.test.ts

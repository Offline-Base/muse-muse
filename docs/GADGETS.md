# Gadgets as a build option

A first pass, Oct 30, 2026, on branch `gadget-option`: `docs` plus Hussam's `device-tools`, merged. Hussam owns the board side (`muse-device/server.py`, `lib/device/client.ts`). This file says what the platform side does now and what's left. See also [PLATFORM_PLAN.md](PLATFORM_PLAN.md), section 5.

Not the same thing as a Muse gadget built with Meta's Muse Gadget SDK: the commands a shipped product offers for a person's own gadget of that kind are a product output, in [PRODUCT_OUTPUTS.md](PRODUCT_OUTPUTS.md).

## How it works

A gadget is an option the brief writer picks the way it picks a model. It's off until `GADGETS_ENABLED=1`: with it off, the brief writer isn't told about gadgets and its schema can't pick one, so nothing changes for production builds.

| Piece | Where | What it does |
|---|---|---|
| The option | `PRODUCT_MODELS` in `lib/brief/schema.ts` | `muse-gadget` sits beside the models. The brief writer's catalog (`lib/prompts/catalog.ts`) says when to pick it: only when the muse asks for hardware, paired with the model that reads the capture, and the product must still work without a board. |
| Build prompt | `lib/brief/render.ts` | Points Muse Code at `.agents/skills/muse-gadget`. |
| Permission | `allowedModelsFor` in `lib/pipeline/logic.ts` | Keeps `muse-gadget` in the product's token `allowedModels`, the way a model's id is there. No new column or migration. |
| Gateway | `app/api/gateway/gadget/route.ts`, `lib/gateway/gadget.ts` | `GET {GATEWAY_URL}/gadget` lists tools; `POST {tool, arguments}` calls one. Product token required. 403 `gadget_not_allowed` without the option. |
| Tools | `PRODUCT_GADGET_TOOLS` | `describe_device`, `capture_image`, `record_audio`, the same names and arguments as `muse-device`. Never `run_command`. |
| Drive tools | `PRODUCT_DRIVE_TOOLS` | `drive_status`, `export_to_drive`: a separate list, for a brief that asks, the owner only, and only with `DRIVE_EXPORT_PRODUCTS` and the owner check. `docs/DRIVE_EXPORT.md`, "From a product". |
| Limits | `GADGET_LIMITS` | 30 calls a minute per product, 10 per visitor. |
| Builds | `SIMULATED_BOARD` | Build tokens always get a simulated board: the same receipt photo and three seconds of speech every time (`lib/gateway/gadget-sim-media.ts`), so tests are steady and sandboxes never reach hardware. |
| Live | `deviceConfig()` from `lib/device/client.ts` | Live tokens reach the board in `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN`, or get 503 `gadget_offline`. A board error is a 502 that never shows the board's address. |
| Template | `template/lib/meta/gadget.ts` | `takePhoto`, `recordSound` (returns WAV for `transcribeFile`), `gadgetInfo`, `isGadgetOffline`. |
| Skill | `template/.agents/skills/muse-gadget/SKILL.md` | When to use it, the simulated board, what to do when no board is connected, product copy. |
| Manifest | `template/musemuse.schema.json` | Accepts `muse-gadget` in `models`. |
| Page | `app/gadgets/page.tsx`, `components/gadgets/info.ts` | `/gadgets`, public: what a gadget is, whether the option is on and a live board is set up (plain words from the environment, never the board's address or token, and no call to the board), shipped products with the option, and a link to `/device` for admins. |

Tests: `lib/gateway/__tests__/gadget.test.ts`, `lib/brief/__tests__/gadget-option.test.ts` and `components/gadgets/__tests__/gadgets-page.test.tsx`.

## Left to do

1. **A new builder snapshot, then the switch.** Template changes reach builds only after `npm run snapshot` and a new `BUILDER_SNAPSHOT_ID` on Vercel. Then set `GADGETS_ENABLED=1`. Neither is done yet.
2. **A board per owner.** Done behind flags: the wave 3 registry and owner check, and gadget connect below.
3. **More tools on `muse-device`.** Show something on a screen or the e-ink tablet, set a pin on the UNO Q, read a sensor. Add each one to `PRODUCT_GADGET_TOOLS`, the simulator and the skill.
4. **Where it shows.** "Uses your gadget" on product pages, and a Make-page example that asks for hardware.
5. **A real board end to end.** The live path is covered by unit tests with a fake board only.

**Wave 3 (behind flags, `docs/CAPABILITIES.md` section 19).** `HARDWARE_GADGET_OWNER_CHECK` closes the one-board-for-everyone finding: a live token reaches only the board its product's owner linked, and only with an owner pass unless the link opens it to visitors. `HARDWARE_BOARD_REGISTRY` lets admins add their own `muse-device` boards on `/device`. `HARDWARE_BOARD_TOOLS`, with the owner check on, lets a brief ask for `read_sensor` and `show_text`, which bring no camera or microphone.

## Gadget connect (`GADGET_CONNECT`, off by default, Nov 1)

Lets a person pair their own board, lets its products run the model on it, and adds a simulated robot. It needs `HARDWARE_BOARD_KEY` to save a board, and `HARDWARE_GADGET_OWNER_CHECK`, `HARDWARE_BOARD_TOOLS` and a served hardware cap for a product to reach one. Real boards: [JETSON_TODO.md](JETSON_TODO.md). Nothing here has run on real hardware.

**Pairing.** Brought forward from section 19 of CAPABILITIES.md, following the design in `docs/OFFLINE.md` on `tg-offline`, which holds no code.

1. On the board, `python3 server.py --tls`, then `python3 server.py pair`: a one-time code of 8 characters (no 0, O, 1 or I; 10 minutes; 5 wrong tries burn it) and a 6-digit check number from the certificate's public key.
2. On `/gadgets`, the address. Muse Muse reads the public key from a TLS handshake and shows its own check number. The person compares them, which is what stops someone in the middle. The key's hash comes back in a sealed ticket that names their account, so nobody else can finish it.
3. The code goes over TLS pinned to that key. The board mints a token, returns it once, and keeps only its hash. Muse Muse seals the token in `devices` with `trust = pinned_tls`.
4. Every later call checks the pin on the finished handshake, before any of the request is written (`lib/caps/hardware/pinned.ts`). Removing the board tells it to forget the token, if it's on.

**Owner scope and the shared guest.** A guest can't pair, list or link a board: `requireBoardOwner` refuses any open-access visitor and `guest@musemuse.invalid`, and the page says why. This matters because every guest has one user id, so "the board's owner is the product's owner" would pass for all of them. `linkedBoardRow` also refuses a guest-owned row, in case one gets there another way. A signed-in person holds their own boards, and with the flag on no admin rights are needed. On production's guest mode, then, a visitor has to sign in to pair.

**Inference.** `ask_board` on `{GATEWAY_URL}/gadget`, and `askBoard` and `askBoardOrMessage` in the hardware overlay's `lib/platform/board.ts`. The model comes from the board's kind (`lib/caps/hardware/targets.ts`): Jetson Orin Nano gets one-bit Muse Glimmer, others a small Llama. Only the owner, unless they open it to visitors. No board: 503 `gadget_offline`, with the words to show. Nothing falls back to a cloud model by itself.

**Robotics, simulated only.** `robot_status` (read only), `robot_action` and `hard_stop`. `ROBOT_ACTIONS` in `lib/gateway/gadget-sim.ts` is everything: fan 1 to 30 s, pump 1 to 5 s, light 0 to 100%. Limits are checked on the platform and on the board. Every action is confirmed by the owner:

- Live, a product's call never moves anything. It gets a `confirmUrl` to `/gadgets/confirm`, where the owner says yes under their own session, and a signed request is good once for 10 minutes for that exact action. A product holds no session, so it can't confirm for itself, whatever it sends. Only the owner may ask, even with visitors open.
- In a build, with no owner there, a signed card stands in, and the reply says `simulated`.
- `hard_stop` needs no confirmation and no budget, and is open to anyone the link lets in. It's saved on the platform first and stays until the owner clears it. If the board didn't answer, the reply says so.
- A board that didn't report `simulated: true` at pairing refuses every robot tool. `server.py` has no actuator tools at all: only `muse-device/sim_board.py` does.

**The simulated board.** `python3 muse-device/sim_board.py --state DIR` runs the real `server.py` (TLS, pairing, tokens, routes) with made-up sensors and a fixed rule in place of a model. It loads nothing and says it's simulated in every answer. A build's in-process simulator is `lib/gateway/gadget-sim.ts`, and a local build gets the same one (`localBoardFiles`).

Tests: `lib/caps/hardware/__tests__/pairing.test.ts` (real TLS and a real self-signed certificate), `lib/gateway/__tests__/gadget-connect.test.ts`, the GADGET_CONNECT block in `routes.test.ts`, and `muse-device/test_pairing.py`.

Left: a new builder snapshot for the overlay changes, and `CAP_READY.hardware`, which needs true for any of this to reach a build.

Meta's Muse Gadget SDK is a separate track: a Pi 5 paired to our own Muse account, gadget skills and gadget builds (PLATFORM_PLAN.md, section 5). Muse Muse never holds anyone's Gadget SDK token.

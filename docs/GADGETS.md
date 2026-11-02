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

## Who can read the text

Muse Privacy on your own laptop is the only private path. A board or the fleet can keep text from a cloud model, unless a fleet combo model sends it to one, but not from the servers and networks it passes through, so their answers aren't private. The rows cover the photos and recordings a board's tools send back as well as text. The table is `lib/inference/reach.ts`, and `lib/__tests__/reach-claims.test.ts` fails if this section's rows differ from it, or its other words or the gadget and fleet copy claim more. It reads for phrases, so a paraphrase gets past it. Tiers are the trust words in [OFFLINE.md](OFFLINE.md), section 3, with one stretch: `home` here means the owner's own board, even when a hosted site reaches it at a public https address over the internet, not only on the owner's network.

| Path | Code | Tier | Who can read the text | What a product may say | Today (Nov 2) |
|---|---|---|---|---|---|
| Muse Privacy on your own laptop | `privacy/docs/THREAT_MODEL.md`, `privacy/base/egress.py`, `privacy/relay/src` | this-machine | Nobody off the laptop reads the original documents or the tag map. Muse and the relay see tagged text, summaries and Muse's own requests, including any name typed into Muse, and a tagged result can be a document's own text with only the names swapped. Cloudflare ends TLS at the relay, so the relay isn't end-to-end encrypted. Tagging can miss a name, and what you type into Muse reaches Meta first. | Your original documents and tag map stay on your laptop, but Muse and its relay on Cloudflare see their text with names tagged, summaries and Muse's requests, including any name you type into Muse, and tagging can miss a name. | Runs on a laptop. The Jetson version is designed and simulated only, and has never run on a board. |
| A product using a paired board | `lib/caps/hardware/board.ts`, `lib/gateway/gadget-connect.ts`, `lib/gateway/gadget.ts`, `template/caps/hardware/files/lib/platform/board.ts` | home | The product's server, Muse Muse and the board, over a public https address on a hosted site, for what goes to the board and what comes back, photos and recordings included. A board added by address has no pin, so it can sit behind a tunnel that ends TLS, which can read it too: ask_board refuses such a board, but show_text and the media tools still reach it. | This product's server and Muse Muse can read what goes to the owner's board and what comes back, photos and recordings included, and so can a tunnel in front of it if the owner added the board by address. | Not live: GADGET_CONNECT was unset in production on Nov 2 (docs/BUILD_LOG.md), and this path has not run on real hardware. |
| The fleet gateway | `lib/board-loop/fleet.ts`, `jetson-infra:docs/serving-over-ngrok.md`, `jetson-infra:scripts/fleet-up.sh`, `jetson-infra:control-plane/jetson_cp/hub.py`, `jetson-infra:control-plane/jetson_cp/llm.py` | shared | The product's server, ngrok, which ends TLS, the lead board and the board that answers, plus Muse Muse when the call goes through it. Called at offlinebase.com/admin rather than the ngrok address, a Vercel rewrite in another project ends TLS first. From the lead board to another board the chat may cross the office network unencrypted: fleet-up.sh enrolls boards over http on the LAN, and whether a given board uses the tunnel instead isn't known. A combo model can send the whole chat to its cloud provider, OpenRouter or Vercel AI Gateway, and by default does for any chat its router doesn't find plainly simple. The gateway's request log holds metadata. ngrok's inspector runs on port 4040 of the lead board (fleet-up.sh reads it), and a Nov 2 report, not reproduced, said it held the last 50 requests with raw bodies in memory. | This product's server, ngrok and the fleet's boards can read your text, and so may anyone on the office network between boards, a combo model's cloud provider, and Muse Muse or Vercel when the call goes through them. | The fleet serves through ngrok. In this repo only the board loop calls its chat route (BOARD_LOOP_TARGET=fleet), and no product route forwards a chat to it. |
| Board tools through the fleet's /device route | `lib/device/client.ts`, `lib/gateway/gadget.ts`, `lib/device/agent.ts`, `app/api/device/ask/route.ts`, `muse-device/autostart.sh`, `jetson-infra:control-plane/jetson_cp/routes/device.py` | shared | Muse Muse, ngrok, which ends TLS, the lead board and the board, plus the product's server when a product made the call, for what goes to the tools and what comes back, photos and recordings included. From the lead board to another board it's plain http on the office network, token included, so anyone on that network can read it. ngrok's inspector on port 4040 of the lead board sits in front of this route too, so it may hold the board's bearer token, which opens every tool on it, and the photos and recordings in memory. Meta's model reads tool results when an admin asks on Muse Muse's admin page /device (/api/device/ask). | This product's server, Muse Muse, ngrok and the fleet's lead board can read what goes to and comes back from a board's tools, including photos and recordings, and it crosses the office network as plain http. | A real board answered through Muse Muse's client on Nov 2 (docs/BUILD_LOG.md), but not from a live product: DEVICE_MCP_URL isn't set in production. The route merged into jetson-infra on Nov 2. |

## Left to do

1. **A new builder snapshot, then the switch.** Template changes reach builds only after `npm run snapshot` and a new `BUILDER_SNAPSHOT_ID` on Vercel. Then set `GADGETS_ENABLED=1`. Neither is done yet.
2. **A board per owner.** Done behind flags: the wave 3 registry and owner check, and gadget connect below.
3. **More tools on `muse-device`.** Show something on a screen or the e-ink tablet, set a pin on the UNO Q, read a sensor. Add each one to `PRODUCT_GADGET_TOOLS`, the simulator and the skill.
4. **Where it shows.** "Uses your gadget" on product pages, and a Make-page example that asks for hardware.
5. **A real board end to end.** The live path is covered by unit tests with a fake board only. A real board answers through Muse Muse's client (Nov 2, BUILD_LOG), but not yet through the gateway from a live product. `muse-device/autostart.sh` keeps a board's server up.

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

**Limits on what a board says.** A reply stops at 32 MB and an answer at 16,000 characters. `target` is the model the board's `/v1/models` names when that differs from the one picked for its kind. A simulated answer's `target` says no model ran. `simulated` is the board's own word at pairing, so a custom server could claim it: the label is only as good as the board you paired.

**The simulated board.** `python3 muse-device/sim_board.py --state DIR` runs the real `server.py` (TLS, pairing, tokens, routes) with made-up sensors and a fixed rule in place of a model. It loads nothing and says it's simulated in every answer. A build's in-process simulator is `lib/gateway/gadget-sim.ts`, and a local build gets the same one (`localBoardFiles`).

Tests: `lib/caps/hardware/__tests__/pairing.test.ts` (real TLS and a real self-signed certificate), `lib/gateway/__tests__/gadget-connect.test.ts`, the GADGET_CONNECT block in `routes.test.ts`, and `muse-device/test_pairing.py`.

Left: a new builder snapshot for the overlay changes, and `CAP_READY.hardware`, which needs true for any of this to reach a build.

Meta's Muse Gadget SDK is a separate track: a Pi 5 paired to our own Muse account, gadget skills and gadget builds (PLATFORM_PLAN.md, section 5). Muse Muse never holds anyone's Gadget SDK token.

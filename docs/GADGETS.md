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
2. **A board per owner.** Today every live product with the option shares the one board the platform has connected. Next: a registry of boards per owner (URL and token, stored encrypted), a "connect a gadget" screen, and the gateway picking the owner's board.
3. **More tools on `muse-device`.** Show something on a screen or the e-ink tablet, set a pin on the UNO Q, read a sensor. Add each one to `PRODUCT_GADGET_TOOLS`, the simulator and the skill.
4. **Where it shows.** "Uses your gadget" on product pages, and a Make-page example that asks for hardware.
5. **A real board end to end.** The live path is covered by unit tests with a fake board only.

**Wave 3 (behind flags, `docs/CAPABILITIES.md` section 19).** `HARDWARE_GADGET_OWNER_CHECK` closes the one-board-for-everyone finding: a live token reaches only the board its product's owner linked, and only with an owner pass unless the link opens it to visitors. `HARDWARE_BOARD_REGISTRY` lets admins add their own `muse-device` boards on `/device`. `HARDWARE_BOARD_TOOLS` adds `read_sensor` and `show_text`.

Meta's Muse Gadget SDK is a separate track: a Pi 5 paired to our own Muse account, gadget skills and gadget builds (PLATFORM_PLAN.md, section 5). Muse Muse never holds anyone's Gadget SDK token.

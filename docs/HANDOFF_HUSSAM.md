# Handoff for Hussam (Oct 30, 2026)

Everything Ethan and Claude worked out this week about gadgets, devices, flash drives and where tuned models run. Read this first, then the files it links.

## Where main stands

- **Merged:** your `device-tools` branch (`muse-device/server.py`, the admin-only `app/api/device`, `lib/device/client.ts`), the `knowledge` branch (13d385f), the docs mirror and the assistant, and the two items below.
- **The gadget option** is in, and it stays off until `GADGETS_ENABLED=1`. See [GADGETS.md](GADGETS.md).
- **Flash drive card checkout** is in, and it stays off until the Stripe settings are set. See [VIBE_TUNING.md](VIBE_TUNING.md), Feature 6, "Paying by card".
- **The plan:** [PLATFORM_PLAN.md](PLATFORM_PLAN.md) covers the shared backend (inspired by XFaaS), ship checks (inspired by TestGen-LLM and ACH), the platform MCP and the "My projects" connector, Muse Gadgets, model day and AWS Device Farm. The same plan as an artifact: https://claude.ai/artifact/Qfs5LzUUB1HosmhkUXz6vG

## Gadgets: how they work today

- `muse-gadget` sits in `PRODUCT_MODELS` (`lib/brief/schema.ts`). The brief writer picks it like a model, but only when the muse asks for hardware.
- **Permission** comes through the product token's `allowedModels`. No migration is needed.
- **The gateway** is `GET` and `POST {GATEWAY_URL}/gadget` (`app/api/gateway/gadget/route.ts`, `lib/gateway/gadget.ts`).
  - The tools are `describe_device`, `capture_image` and `record_audio`. `run_command` is never exposed.
  - Limits: 30 calls a minute per product and 10 per visitor.
- **Build tokens always get a simulated board:** a fixed receipt photo and 3 seconds of speech (`lib/gateway/gadget-sim-media.ts`).
- **Live tokens** reach your board through `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN` (`deviceConfig()` in your `lib/device/client.ts`). If the board can't be reached, the answer is 503 `gadget_offline`. A board error is a 502 that never shows the board's address.
- **The template:** `template/lib/meta/gadget.ts` (`takePhoto`, `recordSound`, `gadgetInfo`), the skill `template/.agents/skills/muse-gadget/SKILL.md`, and the manifest schema, which accepts `muse-gadget`.

### Turning gadgets on

The order matters:

1. `npm run snapshot`, then set the new `BUILDER_SNAPSHOT_ID` on Vercel. Until then, builds don't have the gadget helper or skill.
2. Set `GADGETS_ENABLED=1`. If it's set before step 1, any build that picks a gadget breaks.
3. Set `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN` to your board. Live products then reach real hardware.

### Left for you

1. Boards per owner: a registry with the URL and an encrypted token, a "connect a gadget" screen, and the gateway picking the owner's board.
2. More tools on `muse-device`: show something on a screen or the e-ink tablet, set UNO Q pins, read sensors. Each new tool also goes into `PRODUCT_GADGET_TOOLS`, the simulator and the skill.
3. Show it in the UI: "Uses your gadget" on product pages, and a Make example that asks for hardware.
4. Test one real board end to end. So far only a fake board has been tested.

### Rules

- Never hold anyone's Meta Gadget SDK token. The SDK terms say tokens are personal and non-commercial.
- Never SSH to the Jetsons from Ethan's laptop. Go through the fleet control plane.
- Keep `jetson-05` out of experiments.

## Hardware on hand

| Hardware | Count |
|---|---|
| Jetson Orin Nano 8 GB | 6 |
| Raspberry Pi 5 | 2 (RAM unknown) |
| Arduino UNO Q 4 GB | 1 |
| Coral board | 2 (online only over Mac USB sharing) |
| E-ink tablet | 1 (make and OS unknown) |

Ethan is quantizing Muse Glimmer to 1 bit and below, so a model API can live on any of these boards.

## Where a tuned model should run (requested, not built yet)

Ethan wants every vibe fine-tune to offer "Run it on" with five choices: your computer, a connected gadget, Fireworks, Baseten or Modal. The plan is a menu in place of `RunLocallyLink` on `app/fine-tuning/[jobId]/page.tsx`, and tabs on `/fine-tuning/[jobId]/run`.

Each model has two public Hugging Face repos:
- `-lora-<job8>`: a rank 16 adapter of 224 to 393 MB.
- `-gguf-<job8>`: Q3_K_M (13.7 GB), Q4_K_M (16.9 GB) and Q6_K (22.9 GB).

The research found:

| Option | Fit | How the platform deploys it | Rough cost |
|---|---|---|---|
| Your computer | Already built (Feature 5) | Nothing to deploy | $0 |
| Gadget (Jetson) | Only Q1_0 (4.85 GB) fits, and it's probably unusable. IQ1_S (6.53 GB) is at the limit. NanoQuant's sub-1-bit output isn't a GGUF, so llama-server can't run it. | llama-server (b11970 or later) through the fleet control plane. The real gadget model is the 3B to 4B distilled student in KNOWLEDGE_UPDATE.md. | n/a |
| Fireworks | Hosts the Muse Glimmer 30B base. An uploaded LoRA runs only on an on-demand deployment, at rank 4 to 64. | REST: create the model (`HF_PEFT_ADDON`), `getUploadEndpoint`, upload the files, `validateUpload`, then create a deployment with `minReplicaCount: 0` | H100 at $8 an hour |
| Baseten | Deploys over REST with no CLI | A config-only Truss with a llama.cpp image and `weights: hf://...@commit`. Then `POST /v1/prepare_model_upload`, upload to S3, and `POST /v1/models` | L4 at $0.85 an hour; scales to zero |
| Modal | No REST deploy, only the Python SDK | v1: a script to copy and paste. Later: run `modal deploy` in a throwaway Vercel Sandbox with the person's token. | A10 at $1.10 an hour; scales to zero |

Never save a person's key in a workflow step argument, because step arguments are stored. Any deploy that uses a key once has to finish inside one route handler.

### Open decisions

- Who pays for hosted GPUs: the person's own key (recommended) or the platform.
- Whether a Fireworks multi-LoRA pool should replace the Lambda pool.
- Whether to offer Glimmer on gadgets before an IQ1_S file has been scored.
- Whether Meta's output terms allow hosting models trained on Muse Wonder's text.

### Not yet confirmed

- Whether Fireworks accepts Glimmer's `gate_proj` adapter.
- How each host handles `tuned.jinja`.

## Flash drives

- **Ordering a drive:** card checkout is live in code. To turn it on, set `DRIVE_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `DRIVE_PRICE_CENTS`. A live Stripe key also needs `DRIVE_LIVE_SALES=1`.
- **"Put it on my own flash drive":** designed but not built.
  - The page, in Chrome or Edge, writes the model and runtime onto the person's stick.
  - The llama.cpp runtime is mirrored to public Blob, because GitHub release downloads can't be fetched from a browser and Vercel function responses are capped at 4.5 MB.
  - It's blocked on whether the launchers may clear the browser's quarantine flag and Mark of the Web from the runtime. Ethan hasn't decided yet.

## Other open questions

- How users sign in to the Muse app connector.
- The e-ink tablet's make.
- The peripherals on the Pis and the UNO Q.
- Which Jetsons are spare.
- Who sends the platform's email.
- The monthly budget for AWS Device Farm. It's about $0.17 per device minute, and nothing paid runs without Ethan's OK.

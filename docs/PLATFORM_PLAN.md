# Platform plan: no-setup products, an MCP for agents, hardware, and a model test bed

Proposed Oct 30, 2026. Nothing here is built yet, except the `device-tools` branch noted under Hardware. Read this with [DESIGN.md](DESIGN.md) and [DOCS_MIRROR.md](DOCS_MIRROR.md).

The goal: Muse Muse should be a more usable Muse Code whose output is a working, deployed product that someone can use right away, with no API keys to paste and no backend to set up. On top of that it becomes a tool other agents can call, a way to reach hardware, and the place to measure a new Meta model the day it ships.

## Where it stands

Already true for every product:

- **No API keys.** Products call Meta through the platform gateway with a product token (`GATEWAY_URL`, `PRODUCT_TOKEN`), with a daily budget per product and a platform-wide cap.
- **Deployed.** Each product is its own Vercel project with a public link, a demo video and a Muse app connector (`/api/mcp/<slug>`).
- **Uploads.** `uploadMedia` stores a file in Blob for about a day so a model can read it.

What a product can't do without its builder adding infrastructure, and what users notice:

- **Nothing is saved** beyond the browser (`localStorage`). No shared lists, no history across devices, no data two people can see.
- **No sign-in**, so no "my" anything.
- **No background work**: no schedules, reminders, digests or long jobs.
- **No outbound messages**: no email or notifications.
- **No third-party APIs** that need a key, and nowhere for an end user to put their own.
- **Quality is uneven.** Blind-judged products scored 5.5 to 7.2 out of 10 across rounds. Tests can pass while the product is broken, and nothing re-checks a product after it ships.

## 1. Backends the platform runs (inspired by XFaaS)

Meta's serverless platform, XFaaS ([SOSP 2023](https://ceres.cs.umd.edu/818/papers/xfaas.pdf)), runs functions for thousands of internal teams on one shared pool, so no team runs servers. Four of its ideas fit here:

| XFaaS idea | What it means for Muse Muse |
|---|---|
| One shared pool where any worker can run any function | One shared backend for every product, instead of a database and server per product. A new product has a backend the moment it deploys. |
| Per-tenant quotas and admission control | Per-product limits on storage, rows, jobs and email, checked in the gateway like today's model budget. One busy product can't starve the rest. |
| Delay-tolerant work is queued and run when capacity is cheap | Background jobs and schedules run off the request path, spread out, with retries. |
| Back-pressure protects downstream services | Concurrency limits per model protect Meta's rate limits for everyone. |

XFaaS is used only for work that isn't user-facing, because its latency varies. So the request path stays in each product's own Vercel functions, and the shared backend handles data, jobs and messages.

### What products get, as helpers in `template/lib/platform/`

| Service | Helper the builder uses | How the platform runs it |
|---|---|---|
| **Data** | `data(request).collection("orders").put/get/list/delete`, with `scope: "user" \| "shared"` | One Postgres (Neon, already connected), rows keyed by product id, collection and owner. Size and row quotas per product. Declared in `musemuse.json` under a new `data` key, so the judge and tests know what's stored. |
| **Sign-in** | `currentUser(request)` returns `{ id, email? }` or an anonymous device id | Platform-run magic-link sign-in on a shared domain. Products never see a password or a session secret, only a signed user id. An anonymous user can claim their data when they sign in. |
| **Files** | `files(request).put/get/list`, building on `uploadMedia` | Blob, kept until deleted, owner-scoped, with a per-product quota. Today's one-day uploads stay for model input. |
| **Jobs and schedules** | `jobs.enqueue("digest", input)`; `schedules` in `musemuse.json` (`"daily 07:00"`) | The platform's cron calls the product's `/api/jobs/<name>` with a signed token, with retries and quotas. One platform cron fans out to every product, so products need no cron config. |
| **Email** | `notify(request).email({ to: "me", subject, text })` | Sent by the platform to signed-in users only, with a daily cap per product. No arbitrary recipients, so it can't be used for spam. |
| **Outside APIs** | `fetchPublic(url)` for keyless public APIs on an allowlist (weather, public datasets); `secrets(request).get("their_service")` for keys the end user owns | The gateway proxies and caches public calls. A key the end user owns is pasted into the product's own settings screen, stored encrypted by the platform and used server-side. It never appears in code or the browser. |

**Both kinds of database.** Every product starts on the shared database, so saving works the moment it deploys: products hold no secrets, quotas and abuse checks live in one place, and the gateway already has the token, budget and metering. When a product needs more, such as its own queries, more room, or a hand-off to someone else, its owner moves it to its own Postgres with one button. The platform creates that database through the Vercel Marketplace (Neon), copies the data across, and keeps the connection string in the product's Vercel settings, on the server only. The `data()` helper works the same on both, so the product's code doesn't change.

**The owner can see their data.** Each product's page in Muse Muse gets a data view for browsing and exporting shared collections. What a product's users save privately shows there as counts only.

Builder side: the template's `AGENTS.md` and a new `platform` skill teach the helpers. The brief writer decides what's persisted, and the screen judge checks that a saved item survives a reload in a second browser. Fixtures seed a per-build sandbox namespace that is deleted at the end of the build.

## 2. Products that actually work (Meta's assured-LLM testing work)

Two Meta papers set the rule: an LLM's code is only accepted when it clears filters that prove it works and improves something. TestGen-LLM ([FSE 2024](https://arxiv.org/abs/2402.09171)) kept only tests that built, passed reliably and raised coverage: 75% built, 57% passed reliably, 25% raised coverage. ACH ([FSE 2025](https://arxiv.org/abs/2501.12862)) generated realistic faults first and kept tests that caught them. Engineers accepted 73% of its tests, and about half would have been thrown out by a coverage-only filter.

For Muse Muse, a product goes live only when it passes these filters:

1. **Builds and passes**, as today.
2. **Not flaky.** The smoke test passes three runs in a row.
3. **The tests can catch a broken product.** The platform injects faults the user would notice: the model call returns an error, the main action returns wrong data, the primary button does nothing, saved data doesn't save. The smoke test must fail on each fault. If one survives, the next fix round strengthens the tests, not the product. The share of faults caught goes on the build page.
4. **Works where people use it.** After deploy, the same smoke test runs against the live URL before the product is marked live. Today the checks run only in the sandbox.
5. **Stays working.** A nightly job reruns each live product's smoke test. A failure opens a fix round or marks the product broken, so the gallery never shows a dead product as working.
6. **Refinements don't regress.** Every earlier test stays in the suite.

## 3. A more usable Muse Code

- **Starter shapes.** A few proven skeletons (tracker, generator, converter, assistant chat, dashboard, game) that the brief picks from, so the floor rises before Muse Code writes a line.
- **A plan to approve, in about 30 seconds.** Show the brief's screens and what will be saved, and let the user adjust before the 5-minute build. "Just build it" stays the default.
- **Preview as soon as it renders**, not only at the end.
- **Parallel work.** Muse Code's child agents in separate worktrees split screens and tests.
- **Ready to use.** Install to the home screen (PWA), a share link with a preview card, a short address, export to the user's GitHub or as a zip, and "Use in Muse".
- **Builds that can't get stuck.** A reconcile job finds runs the workflow engine lost and marks them failed with a retry button. A build from the docs on Oct 30 stranded this way, after the local workflow state was wiped mid-run.

## 4. Muse Muse as an MCP server, for coding agents and for your Muse

### For coding agents

A platform-level MCP endpoint, `/api/mcp`, beside the per-product ones, so Claude Code, Muse Code or any agent can build with it:

| Tool | Does |
|---|---|
| `start_build` | Note plus inspo as https URLs (the platform fetches and checks them into Blob) or small inline files. Returns the build id and room URL right away. |
| `get_build` | Status, step, cost, preview and live URLs, the latest notes and failures. |
| `wait_for_build` | Waits up to about 5 minutes per call, so an agent can loop without polling. |
| `refine_product` | Sends a change to a shipped product. |
| `list_products`, `get_product` | Links, connector URL, actions and their schemas, repo export. |
| `run_benchmark` (admin) | Starts a model-day run (section 6). |

**Auth:** a personal token created on the Dashboard, stored hashed, revocable, with the same build quota as the person. It's never `MODEL_API_KEY`. Claude Code adds it with:

```bash
claude mcp add --transport http muse-muse https://muse-muse.vercel.app/api/mcp --header "Authorization: Bearer $MUSE_MUSE_TOKEN"
```

### Ask your Muse how your project is going

A private "My projects" connector the owner adds to the Muse app, which takes remote MCP servers over HTTP. The owner can then ask their Muse things like "How's my bakery app doing this week?", "Did anyone use the receipt scanner today?" or "Is anything broken?"

| Tool | Answers with |
|---|---|
| `list_projects` | Each of the owner's products, its link, and whether it's live. |
| `project_status` | Build state, the last nightly check, the latest change, and anything still building. |
| `project_usage` | Visits, people, actions run, model calls and spend for today and the week, and the budget left. |
| `project_errors` | Recent failures in the live product, in plain words. |
| `project_data` | Row counts for every collection, and lookups in shared collections. Rows a product's users save privately show as counts only. |

- **Private.** It signs in with the owner's Muse Muse account if the Muse app's connectors support sign-in, or else uses a private connector URL with a secret the owner can revoke. It only ever shows the owner's own products.
- **Read-only to start.** Asking for a change still happens in Muse Muse.
- **Where the answers come from.** The gateway already meters each product's model calls. The template adds a small visit counter and error reporter that collect no personal data, and the nightly checks from section 2 supply the health.

## 5. Hardware with Muse Gadgets

What Muse Gadgets is ([gadgets.muse.ai](https://gadgets.muse.ai/), [SDK](https://github.com/facebookincubator/muse-gadget-sdk)): Meta's open-source SDKs (Apache 2.0) for ESP32 boards and Linux machines such as a Raspberry Pi, plus Meta's Home Link. A gadget pairs with the owner's Muse app with an SDK token. After that, the owner's Muse can show things on its screen, listen and speak, run commands on a Linux gadget, and drive smart-home devices through community skills (a `SKILL.md` pasted into the muse's chat).

**The terms limit what a platform can do** ([SDK Terms](https://gadgets.muse.ai/sdk-terms)):

- **Personal tokens:** SDK tokens are "for personal, non-commercial use with your own Muse account", and "personal to you".
- **Other people's data:** a token may not be used "to access any Muse account other than your own" or "to process another person's Muse data".
- **Not a platform:** the SDK "is not a supported product or developer platform" and may stop working at any time.
- **Distribution:** at most 50 devices given to others, none sold or listed in a store. Anything more needs Meta's written permission.

So Muse Muse must never hold users' gadget tokens, or reach into their Muse. These three routes stay within the terms:

1. **Products as gadget skills.** Every product already has a Muse connector. Add a generated "Use with your gadget" `SKILL.md` on each product page. It tells the owner's own Muse how to use the product's connector with their gadget, for example: "every morning, call `daily_plan` and show it on the e-ink screen". The owner pastes it into their muse's chat, the same way as the SDK's community skills. We never touch a token.
2. **Gadget builds for the owner's own board.** A muse can target a gadget. Muse Code writes a Linux-gadget command or ESP32 firmware change from the open-source SDK (each folder has an `AGENTS.md` for coding agents), plus flashing steps. The owner flashes and pairs it with their own token. Sandboxes can compile the ESP32 firmware but can't test it on hardware, so these ship as "built, untested on device".
3. **Our own boards, through `device-tools`.** The `origin/device-tools` branch (Oct 30) adds `muse-device/server.py`, an MCP server for a board's camera, microphone and, optionally, shell, called from the admin-only `/api/device` route. It doesn't use Meta's SDK, so the gadget terms don't apply. Use it as the hardware part of the model test bed, and later as "bring your own board", where a user's board runs this server and its URL and token go in the encrypted per-user vault.

If you want more than this, such as gadgets built for many users, ask Meta first: the terms require their written permission.

### The boards we have

| Board | Count | Role | Notes |
|---|---|---|---|
| Raspberry Pi 5 | 2 | One becomes a real Muse gadget on the Linux Device SDK, paired with our own Muse account and token. That's personal use, within the terms, and it's the demo for routes 1 and 2. The other runs `muse-device` for the test bed. | Meta lists the Pi 5 as a supported gadget. Voice and vision need a mic, speaker and camera attached. |
| Arduino UNO Q, 4 GB | 1 | The actuator board. Its microcontroller drives LEDs, relays, servos and sensors, and its Linux side runs `muse-device` with a new pin tool, so a product's action can move something real. | Not on Meta's gadget list, so it's untested as a gadget. As our own MCP board it needs no SDK. |
| E-ink tablet | 1 | A display. Products get an e-ink view (high contrast, no motion, large type) that a scheduled job refreshes, such as a morning plan. | Not a gadget in the SDK's sense, because the SDK's e-ink support is for ESP32 boards. It works through the tablet's browser, if it has one. |
| Jetson Orin Nano | 6 | Run Muse Glimmer quantized to 1 bit and below behind an OpenAI-compatible API, so products and model day can call it, and host `muse-device` with cameras. At 1 bit the 30B weights are about 3.75 GB, and below 1 bit about 3 GB, which leaves room in the board's 8 GB for the runtime and context. | Most already serve the offline fleet (Bolt, the LFM models, the router). Use spare boards first, and only through the fleet control plane. |
| Coral boards (Google, Synaptics) | 2 | On-device vision for the edge stage: compare the boards' NPU detectors with SAM 3.1 on the same images. | Enrolled as coral-01 and coral-02. Online only while tethered to the Mac. |

**Every board serves an API.** Each board runs `muse-device` for its own hardware and, where the model fits, a local model API. The platform registers each board's endpoints in the gateway, so a product reaches a board's tools or the quantized Glimmer with the same product token it uses for Meta. Board addresses and tokens never leave the server. When a board is offline, the product gets a clear error and falls back to a hosted model where its brief allows.

The demo for the video: a Pi 5 paired as our own Muse gadget, a product's gadget skill pasted into our muse, and the UNO Q moving something when the product's action runs.

## 6. Model day: a test bed for each new Meta model

A daily job diffs `GET /v1/models`. A new id, or an admin button, starts a run with three stages, under a dollar cap and a sandbox concurrency limit:

1. **What the API can do.** Run all 154 docs pages' demos and their `DemoSpec`s with the model swapped in. This is already a browser sweep (`sweep.mjs`) that presses every demo's main action. The result is a feature matrix next to the current model's: tool calling, strict schemas, search grounding, reasoning efforts, vision, video, long context, each protocol, plus latency and cost.
2. **How well it builds.** A fixed suite (the 10 catalog rebuilds, the 11 canary muses and a held-out set) built with the new model in each role: brief, build, judge. Score it with the blind pairwise review already used for the UI rounds, against the current model. Measure live rate, fix rounds, time, cost, judge score and the share of injected faults the tests catch.
3. **What's new.** A generator writes stretch muses along axes the suite doesn't cover: chains across several models, long multi-step products, video, hardware through `device-tools`, adversarial inputs. Many run in parallel. A judge flags surprises: products the new model finished that the current one failed. Each surprise is rerun three times before anyone calls it a new capability. Confirmed ones join the fixed suite, and the hunt repeats until a round finds nothing new.

An edge pass runs the quantized Glimmer on the Jetsons and compares its speed and answers with full precision and the hosted models, so each new quantization gets a report card too.

The output is a public report card per model, with the diff against the previous one.

This only measures models. Meta's Model API terms forbid using outputs to train competing models, so these results must never become training data for one.

## Order

The hackathon closes Nov 4 at 9 PM ET, and the demo video is still unrecorded. Demo is 25% of judging, so nothing here should eat that time. In this order:

| # | Work | Rough size | Why first |
|---|---|---|---|
| 1 | MCP server for agents, and "My projects" for your Muse (section 4) | 1 to 2 days | Shows well in the demo ("Claude Code built this through Muse Muse", then "Muse, how's my app doing?"), and needed by the test bed |
| 2 | Live-URL check and fault injection (section 2, filters 3 and 4) | 1 to 2 days | Directly raises the share of products that work |
| 3 | Data and sign-in on the shared database, then the move to a product's own database (section 1) | 2 to 3 days, then 1 day | The biggest jump in what products can be |
| 4 | Gadget skills on product pages (section 5, route 1) | Half a day | Cheap, within the terms, and a hardware story for the demo |
| 5 | Model day, stage 1 | 1 day | Reuses the docs sweep |
| 6 | Boards as gateway backends: device tools and the quantized Glimmer | 1 to 2 days | When the quantized Glimmer is ready. A product calling Glimmer on a Jetson is a strong demo |
| 7 | Jobs, email, outside APIs, nightly re-checks | 2 to 3 days | After the hackathon |
| 8 | Model day stages 2 and 3, gadget builds, starter shapes | Ongoing | After the hackathon |

## Open questions

- **Muse app sign-in:** whether the Muse app's custom connectors can sign in to a service, which decides how "My projects" stays private.
- **The e-ink tablet:** its make and operating system decide whether it can show a web page.
- **Peripherals:** which Pis and the UNO Q have a camera, microphone or speaker attached.
- **Spare Jetsons:** which boards are free. The fleet control plane was offline on Oct 30, so this wasn't checked.
- **Email sender:** which domain products send from, and the provider.

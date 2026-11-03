# Feature flags: what to turn on, and how

The owner asked how to turn on all features. The short answer: not every switch should go on. Some spend the owner's money for public visitors, some break the Meta-only rule, and some do nothing yet. This page sorts every switch into three groups, and `scripts/flags-on.sh` turns on the first group in one go.

Written Nov 3, 2026, on branch tg-f-flags. Checked against `lib/env.ts`, `lib/caps/ids.ts`, docs/CAPABILITIES.md, docs/HANDOFF.md, docs/OWNER_RUNBOOK.md, docs/NATIVE_READY.md, docs/DRIVE_EXPORT.md and docs/TRAINING.md. Production's env names were read with `vercel env ls production` (names only, no values). Nothing was changed, deployed or spent.

The rules this page follows:

- Meta models only at runtime. Llama does not count.
- Public visitors never spend the owner's money beyond the existing guest limits (the 25 guest builds a day, each product's daily budget, `DAILY_SPEND_CAP_USD`).
- $200 of Meta API budget for builds. Judging moves to Muse Wonder on Nov 4, so every build costs more after that.

Every switch reads "1", "true", "yes" or "on" as on (`flag()` in lib/env.ts). The script writes "1". An env change reaches only a new deployment, so every change ends with a redeploy.

## How to turn them on

From the linked worktree, not this one:

```
cd ~/mm-wt/overnight
```

```
~/mm-wt/f-flags/scripts/flags-on.sh --dry
```

```
~/mm-wt/f-flags/scripts/flags-on.sh
```

Then push to main, or press Redeploy on the latest Production deployment. After the Nov 4 8 AM code freeze, use Redeploy only.

The script reads the names Production has. It adds each "turn on now" switch that is missing, with the value 1. It leaves switches that are already present alone, since their values can't be read safely. Add `--rewrite` to reset those to 1 as well (it removes each one, then adds it again). It changes nothing else. It never touches a "turn on after setup" or "leave off" switch.

Counts: 48 to turn on now (36 already present, 12 new), 33 rows to turn on after their setup, 28 rows (31 names) to leave off.

## 1. Turn on now

### New: the script adds these 12

| Flag | What it does | Needs | Risk |
|---|---|---|---|
| `STEER_CHAT` | Muse Code answers each steering note in the build feed, and a guest can steer the builds their own browser started. | Steering is already on through `BUILD_RANGE` and `MUSE_FULL`. Guests use the `GUEST_EDITS` pass, which is set. | Small. Each note gets one policy check, charged to that build. 6 notes a minute, 40 a build. Paused at the daily cap. |
| `BUILD_ROOM_STEPS` | The build room shows two columns, with a plain step feed that Contributor rewords in small batches. | Nothing. | Up to 40 Contributor calls a build, a fraction of a cent each, inside the build's costs and the daily cap. The build never waits on it. |
| `ENGINE_EXACT_LOGIC` | The brief writer says when a product's main claim needs real code, like a parser or a solver. | Nothing. | None found. Prompt text only. |
| `ENGINE_FIT_OUTPUT` | A call that asks for more output than its token's budget covers runs with a smaller limit instead of being refused. | Nothing. | Low. It never goes over a budget. A long reply can come back shorter. |
| `ENGINE_LIVE_SMOKE` | After deploy, the smoke test runs against the live link before a product is marked live. | Nothing. | A few more sandbox seconds a build. A product that only works on the build machine now shows as partial, which is the honest result. |
| `RUNTIME_OUTPUTS` | Each live product's Get it panel adds a VS Code extension and a GitHub Action, and the owner can download a self-host kit. | `VERCEL_TOKEN` and `VERCEL_TEAM_ID`, both set. | Low. The kit strips tokens and .env files. All guests share one account, so one guest can download another guest product's source kit (rate limited). No Meta spend. |
| `STORY_PAGES` | Shows /offline, the clearer /private and the frontier section on /how-it-works. | Nothing. Read at build time, so it needs the redeploy. Runbook step 3 sets it too. | None. Static pages. |
| `TRUST_REPORTS` | Adds a Report link on products, /admin/reports, and admin takedown and ban. | Migration 0018_trust. `npm run build` runs migrations on every deploy, so it is already applied. | Low. 3 reports a minute and 5 a day per IP, kept only as an HMAC. Takedown and ban are admin only. |
| `TUNE_GENERAL_CHECKS` | A glimmer-lora chat tune also answers 20 general and 20 safety prompts, judged blind, shown apart from the task score. | Nothing. | Up to 40 more judged items a tune on a Meta judge, plus a little GPU time, including visitor runs under the start code and the `TRAIN_*` caps. |
| `CODE_BROWSE` | `/browse` opens one page a product's owner typed, in a sandbox that reaches only that host, and returns text and a screenshot. | `CODE_ENABLED` and `BUILDER_SNAPSHOT_ID`, both set. Reaches only new builds with the code block. | Vercel Sandbox time, $2 a day for the whole platform (`CODE_BROWSE_DAILY_USD`). Owners and build tests only, never visitors. Guests don't get the code cap while `TRUST_SIGNED_IN_CAPS` is on. |
| `HARDWARE_GADGET_OWNER_CHECK` | A live product token reaches only the board its owner linked. | Tell Hussam, since gadgets are his. | It only narrows access. `DEVICE_MCP_URL` isn't set, so gadget products already answer offline. Required before `DEVICE_MCP_URL` ever reaches Production. |
| `META_UI_ONLY` | Every new product uses our meta-ui skill (gray page, flat white cards, Meta blue, Inter and Montserrat), whatever `MUSE_APP_LOOK`, `BUILDS_ON_CONTRIBUTOR` or `BUILD_RANGE` say. No muse-app overlay, no design direction, and the judge expects the meta-ui house style. `BUILD_RANGE` keeps its depth, limits, subagents and workflows. A fix or change keeps an older product's look from its own files. Owner, Nov 3. | Nothing. meta-ui is the template's own look, so no new snapshot. | Builds already running keep the look they started with. With `BUILD_RANGE` on, builds skip the build-range overlay, so the smoke report keeps the template's limits on the last screenshot (result within 1,000 px of the top, page at most 4,000 px tall) instead of 2,400 and 12,000. |

### Already present: keep these 36

The script leaves these alone. Each one's value can't be read from here, so check any you are unsure of in the dashboard, or run the script with `--rewrite`.

| Flag | What it does | Needs | Risk |
|---|---|---|---|
| `AGENTS_ENABLED` | The brief writer may pick the agent target, with the agent kit. | Builder snapshot with the agent kit. | Low. Personal accounts stay off. |
| `AGENT_LONG_RUNS` | The two long recipes may be picked, and their products get $25 a day (`AGENT_LONG_DAILY_USD`) instead of $10. | `RECIPES_ENABLED`. | Visitors of one long-run product can spend up to $25 a day of Meta money on it, inside the daily cap. Set `AGENT_LONG_DAILY_USD` to 10 before the Wonder flip. |
| `BUILD_RANGE` | Each brief picks its own design direction, products go deeper, and complex builds use subagents. It also forces `MUSE_APP_LOOK` and `MUSE_FULL` on. With `META_UI_ONLY` on, the direction and the muse-app look are dropped and the rest stays. | Builder snapshot with the build-range overlay. | Builds run longer and cost a bit more, inside the build budget. |
| `CODE_ENABLED` | Pyodide and QuickJS in the browser for products with the code block. `/exec` and `/browse` need it. | Nothing. | The code cap is for signed-in builders only. |
| `DATA_ENABLED` | Products with a data block save rows through `/data`. | Nothing. Passed a real Preview build. | Signed-in builders only. |
| `EDGE_BUILDS` | Edge builds get lib/meta/edge.ts, the muse-edge skill and the outage drill kit. | `EDGE_ENABLED`. Owner decision D3, Nov 2. | A product's `EDGE_URL` must name a Meta model (one-bit Glimmer or SAM 3.1). docs/EDGE_DEMO.md still shows a Llama 3.2 3B example: keep demos on Glimmer or SAM. |
| `EDGE_ENABLED` | The brief writer may pick the edge target, and edge builds run the simulated outage drill. | `EDGE_BUILDS`. | Same Meta-only note. The cloud call is Muse Wonder. |
| `ENGINE_CHECK_ON_TIMEOUT` | A first round that hits its time cap goes on to checks and fix rounds instead of failing. | Nothing. | Low. |
| `ENGINE_MILESTONES` | A big brief may split into 2 or 3 milestones in chained rounds of one session. | Nothing. | Big builds take longer, inside the budget. |
| `ENGINE_ROUND_SCALING` | The first round grows with the brief, up to 45 minutes. | Nothing. | More sandbox time per big build. Vercel's sandbox bill is not in `DAILY_SPEND_CAP_USD`. |
| `FULL_BUILDS` | Every requirement is listed, tested and judged. Builds may run 150 minutes. | Nothing. | More per build after the Wonder flip. |
| `GADGETS_ENABLED` | The brief writer may pick the muse-gadget target. | Builder snapshot with the gadget helper. | No board is connected, so gadget products answer offline. |
| `GLASSES_ENABLED` | The brief writer may pick the glasses target. | Builder snapshot with the glasses overlay. | Proven only in a simulated session. Copy must say so. |
| `GUEST_EDITS` | The browser that made a guest build can refine it. | Nothing. | Refinements count against the shared guest quota. |
| `HOST_TUNED` | An admin can host a tuned model on Baseten, Modal, Fireworks or Lambda from its page. | Provider keys, `HOST_HF_TOKEN`, `HOST_TUNED_DAILY_USD`. | Admin-only GPU spend, capped per day, stopped after 15 idle minutes. The runbook removes it after the partner evals. |
| `MAKE_CHAT_ALL` | The Make page's box starts a product, a tuned model or both. | `TUNE_COMPOSER`. | None beyond existing limits. |
| `MUSE_APP_LOOK` | New builds get the muse-app look and its UI skill. `META_UI_ONLY` overrides it. | Builder snapshot with the muse-app overlay. | None. |
| `MUSE_CODE_ENABLED` | Products may run Muse Code sessions for their owner, $1 and 15 minutes at most each. | `CODE_ENABLED` and the musecode overlay. | Owners only. Builder-only cap, so guests don't get it. |
| `MUSE_FULL` | Every Muse Code run gets the platform's settings, hooks and build MCP server, and steering. | Nothing. | None. |
| `OPEN_TRAIN` | Anyone can start a tune through the describe and folder flows, under the start code and visitor limits. | `TUNE_START_CODE` and the `TRAIN_*` caps, all set. | Visitor GPU spend, held by the start code. Keep the code out of public copy. |
| `PLAN_ART` | One Muse Image edit of the mascot per plan card. | Nothing. | About $0.01 a build. |
| `PRODUCT_OUTPUTS` | Every product gets a CLI, skill file, Claude plugin and gadget commands. | Nothing. | None. |
| `PROVE_IT` | After a product goes live, each output runs for real against it and is recorded. | `PRODUCT_OUTPUTS`. | Up to $1.50 a build of Meta spend, more on Wonder. |
| `RECIPES_ENABLED` | The brief writer may pick recipes, and builds get their skills. | Nothing. | Low. |
| `TRAIN_CONTRIBUTOR_WRITER` | Admins may have Contributor write made-up tune datasets. Reads only the exact value 1. | Nothing. | Meta may train on that tier, so made-up tasks only. |
| `TRUST_SIGNED_IN_CAPS` | Data, files, connect, jobs, code, runtime and hardware go only to signed-in builders, never guests. | Nothing. | None. This is the guard that keeps guests off stateful caps. Keep it on. |
| `TUNE_ANY_BASE` | Admins may pick another Muse Glimmer base. The code refuses Llama and every other family. | Nothing. | HANDOFF and TRAINING.md still say keep it off, but that predates the Glimmer-only code. Judges never see it. |
| `TUNE_AUTO_PUBLISH` | An admin's judged run uploads to Hugging Face by itself. | `HF_TOKEN`, `HF_NAMESPACE`. | Leave `HF_PUBLIC` unset or 0 so uploads stay private. |
| `TUNE_COMPOSER` | /fine-tuning/new and the run room. Other tune flags need it. | Nothing. | Admins only on its own. |
| `TUNE_FOLDER` | /fine-tuning/new takes a folder or zip. | `TUNE_COMPOSER`. | Files go to Meta on a tier where Meta may train. The page says so. |
| `TUNE_FROM_BUILDS` | A muse-glimmer build gets an "Its own model" row that opens a prefilled tune plan. | `TUNE_COMPOSER`. | Nothing trains until Start. |
| `TUNE_LOOP` | Admins may run a repeat-until-good loop on a judged run. | Nothing. | Admin GPU spend only when started. |
| `TUNE_RESEARCH` | Admins may run deep research for tune data with Meta's search. | Nothing. | $2 a run at most. |
| `TUNE_RL` | Admins may run GRPO on a Glimmer LoRA with a code-checked reward. | Nothing. | Up to $8 and 90 minutes a job, when an admin starts it. |
| `VERIFY_AGENTS` | Products show "What was checked", and the judge gets agent rules. | `PROVE_IT`, `RECIPES_ENABLED`, `AGENTS_ENABLED`. | None. No extra calls. |
| `VR_ENABLED` | The brief writer may pick the vr target, and /q/{slug} is served. | Builder snapshot with the VR overlay. | Long builds. Simulated only, no real headset. |

## 2. Turn on after its setup

Each of these works only after someone does something first. The script never touches them.

| Flag | What it does | Needs | Risk |
|---|---|---|---|
| `TRUST_LEGAL_PAGES` | /privacy and /terms on the platform, and privacy and terms pages in new products. | Ethan reads the draft in lib/trust/terms.ts (about 40 minutes, HANDOFF to-do 3). | Low. The text is an unreviewed draft until then. Don't turn on the age gate or geo block with it. |
| `EXPORT_TUNED` | One-click installers (Mac, Windows, Linux, Jetson, Ollama) on a tuned model's public page. | Ethan settles docs/DATA_RIGHTS.md Q1 first: the moss and lab repos are public now and on hold. | No spend. It refuses Llama files. It makes held public files easier to run. |
| `LOOK_FIRST` | A build shows its screens with sample data, waits up to 2 minutes for changes, then wires everything. | One Preview test build on `TEST_MODEL` with made-up data. | Every guest build gets an extra round and a wait of up to 2 minutes. |
| `CHAINED_BUILDS` | A signed-in builder's big build runs across many sessions for up to 24 hours. | `FULL_BUILDS` (set). One Preview test chain. Set `CHAINED_TOTAL_USD` to about 20 first. | One chain may spend $60 of the $200 Meta budget at the default. Guests can't chain. |
| `CODE_EXEC` | `/exec` runs a product's Python or Node program in a no-network sandbox for 15 seconds. | Set `CODE_EXEC_DAILY_USD` (3 or lower). New builds only. | Vercel Sandbox spend, $3 a day in total. Owners and signed-in end users only. Keep `CODE_EXEC_VISITORS` off. |
| `FILES_ENABLED` (with `FILES_SEARCH`, `FILES_DATASETS`) | Products store files, search their text, and read vetted public datasets. | One Preview test build. None has run for real. | Signed-in builders only. Blob storage, capped per product. |
| `CONNECT_ENABLED` (with `CONNECT_VAULT` and `CONNECT_VAULT_KEY`) | Products call allowlisted public APIs, and the vault keeps a builder's own keys. | One Preview test build. The vault also needs a 32-byte base64 key Ethan makes. | Signed-in builders only. Keep sends off (see Leave off). |
| `JOBS_ENABLED` (with `JOBS_WEBHOOKS`) | Products run scheduled jobs, and other services can start them. | One Preview test build. Pick `JOBS_DAILY_USD` (default $5). | Meta spend by cron, $1 a product and $5 a day by default. Never for the guest account. |
| `LIVE_ENABLED` (with `LIVE_UPDATES`) | Near-live captions, and saved changes that reach every open browser. | One Preview test build. Updates also need the data cap. | Open to guests. Captions are 10 minutes per visitor a day, inside each product's budget. |
| `MEDIA_ENABLED` (with `MEDIA_VIDEO`, `MEDIA_MUSIC`, `MEDIA_SAM_TILING`) | Video from pictures, MIDI music, and SAM past 16 objects. | At least one part flag, or it does nothing. One Preview test build. | Open to guests. SAM runs cost about $0.04 to $0.18, inside each product's budget. |
| `RUNTIME_ENABLED` | Products get Python functions. | One Preview test build. | Signed-in builders only. |
| `NATIVE_EXTENSION` | Products can ship as a browser extension. | One Preview check of the zip and its Get it download, which haven't run. | Low. One test build went live for $0.03. |
| `NATIVE_GAME_ENGINES` | Game builds may use Phaser or Babylon. | One Preview test build. | Low. |
| `DATA_SIGN_IN` | Products with a data block may sign people in with a passkey. | One Preview test with a public `PLATFORM_URL`. | Low. Signed-in builders only. |
| `SPARK_OPEN_PRODUCTS` | The gateway serves muse-spark-open on Baseten, metered like Meta's models. | `BASETEN_API_KEY` in Production, and Ethan confirms Baseten bills per token. Snapshot snap_9heVjeRgxcye4EkOwb8DgxVjkj7H has the overlay. | A new provider bill, outside the Meta budget, capped by token budgets and the daily cap. |
| `TRUST_SPARK_TO_WONDER` | Live products' calls to the retired Spark 1.3 run on Muse Wonder. | Ethan approves the cost. Turn it on with the Nov 4 Wonder flip. | Wonder costs about 40 times Contributor, so product budgets cover fewer calls. |
| `PROVE_NIGHTLY` | A nightly cron re-checks a few live products on Contributor. | Ethan OKs the spend. Set `PROVE_NIGHTLY_PRODUCTS` to 2. | Up to $1.50 a product a night of Meta money. A product's proof status may change during judging. |
| `PARTNER_EVALS` | After a tune is judged, host it on Baseten or Modal, answer held-out prompts, judge, tear down. | Runbook step 8: provider keys, data rights Q2 for run ebad9aad. Turn it off after. | About $5 to $13 of GPU, admin only. |
| `GPU_TRAIN_ON_DATA` | A signed-in builder can train a model on their product's own rows. | Ethan OKs builder GPU spend, keeps `TRAIN_DAILY_USD` low, runs one test. | Lambda GPU spend by anyone with the builder code, 1 run a day per product. Guests are refused. |
| `QUANT_ENABLED` | Admins can start glimmer-quantize jobs that make GGUF files. | Ethan OKs about $3.70 and 2 hours of Lambda per job. | Admin GPU spend, outside the Meta budget. |
| `QUANT_TARGETS` | Quantize jobs add one-bit Glimmer files and device targets. | `QUANT_ENABLED`. Update HANDOFF O7, which still says off. Ethan OKs any one-bit file leaving S3 (it derives from Spark Open). | Admin GPU spend. Jetson copy must say about 5 tokens a second with weak answers. |
| `DRIVE_EXPORT_ENABLED` | The admin Flash drive card on /device copies a tuned model from a Jetson to a USB stick. | Ethan uploads the kit (`scripts/drive-kit.ts --upload`), commits kit-files.json, deploys. Hussam installs drive.py and runs setup-drive.sh. Fleet env vars. A Glimmer GGUF from one quantize job. | Admin only. The old board path exports Llama 3.2 1B: export only Glimmer files. |
| `HARDWARE_BOARD_REGISTRY` | /api/boards, linking a board to a product, and board lists on /device and /gadgets. | `HARDWARE_BOARD_KEY` (32 bytes base64, Ethan makes it, never in chat) and a real board from Hussam. | Low. Admin routes. |
| `HARDWARE_ENABLED` | The hardware cap: briefs may ask for hardware and builds get the overlay. | `HARDWARE_GADGET_OWNER_CHECK` first. Hussam. One Preview test build. | Signed-in builders only. |
| `HARDWARE_BOARD_TOOLS` | `read_sensor` and `show_text` for products, and on /api/device for admins. | `HARDWARE_ENABLED`, the owner check, `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN`, a linked board. Hussam. | Never without the owner check. |
| `GADGET_CONNECT` | A signed-in person pairs their own board and uses a simulated robot. | The board key, owner check, board tools, `HARDWARE_ENABLED`. Hussam. | Never run on real hardware. Guests can't pair. |
| `DRIVE_EXPORT_PRODUCTS` | Products get `drive_status` and `export_to_drive`, writing a model kit to a stick on the owner's linked board. | Everything for `DRIVE_EXPORT_ENABLED` and `HARDWARE_BOARD_REGISTRY`, plus the owner check. Hussam's sign-off. | Tools answer offline without a board. Owner only. Glimmer files only. |
| `FLEET_PRODUCTS` | jetson-fleet products answer from the office boards with one-bit Glimmer. | `FLEET_PRODUCTS_URL`, a `jik_` key from Hussam with cloud_daily_limit 0, `FLEET_PRODUCTS_MODEL=muse-glimmer-2026-iq1s-io-lowest`, jetson-llama on jetson-02. | Answers measured weak (Nov 3). Uses ngrok's 20,000 monthly requests. Admin-owned products only. Runbook section 10: filming window only. |
| `GPU_GLIMMER_SHARED` | muse-glimmer products reach a hosted Glimmer during an admin's demo window. | Ethan's yes on decision 11, `GLIMMER_ENDPOINT_URL` and `GLIMMER_ENDPOINT_KEY`. | GPU spend up to $15 a day. Visitors of admin products use the window while open. |
| `BOARD_LOOP` | Admin one-button loop: make the GGUF, send it to a board, serve, test, record, open a try page. | A board target: a sim host outside Vercel, or the fleet with Hussam. A real board also starts a quantize job (about $3.40). | The fleet target puts a `jpt_` root token in Production env. Prefer the sim target. |
| `GITHUB_EXPORT` | Connect GitHub and Export to GitHub on a product's Code page. | A GitHub OAuth App with the production callback, its id and secret, `CONNECTED_ACCOUNTS_KEY`, and Ethan's repo scope decision. | Low. It uses the visitor's own GitHub. No Meta spend. |
| `NATIVE_TARGETS` (present) with `PACKAGER_SNAPSHOT_ID` | Phone and desktop apps get made. | `PACKAGER_SNAPSHOT_ID` from docs/NATIVE_READY.md step 6 (runbook step 2), then one test phone build. | A few cents of Sandbox time. |
| `BUILDS_ON_CONTRIBUTOR` (present) | Keeps builds on Contributor. Removing it is the Nov 4 switch to Muse Wonder. | Runbook section 14 on Nov 4: check `BRIEF_MODEL`, `JUDGE_MODEL`, `BUILD_MODEL`, `COMPLEX_BUILD_MODEL`, set the day's cap, remove it, redeploy. | About $4 a build on Wonder, against $0.17 to $0.40 now. |

## 3. Leave off

| Flag | What it does | Needs | Risk (why off) |
|---|---|---|---|
| `NATIVE_LAB` (present) | Checks products on the AWS Mac and Windows lab boxes. | A running lab and its instance ids, which Production doesn't have. | It is set now. Without the lab, Windows jobs refuse and Mac jobs queue and expire, with up to $150 of AWS spend if it runs. Remove it unless the lab is up: `vercel env rm NATIVE_LAB --environment production --yes`. |
| `TRY_TUNED` | Anyone can chat with a tuned model and wake it on a paid GPU. | `HOST_TUNED` and caps. | Public GPU spend, up to $10 a day and 4 wakes. For a filmed shot only, with `TRY_TUNED_WAKES_PER_DAY=0`. |
| `HOST_TUNED_OPEN` | Any signed-in person deploys a paid endpoint. | `HOST_TUNED`. | Public spend up to $25 a day. |
| `CODE_EXEC_VISITORS` | Visitors run code through `/exec`. | `CODE_EXEC`, decision 10. | Public sandbox spend. Meta terms decision still open. |
| `MUSE_CODE_VISITORS` | Visitors start Muse Code sessions. | `MUSE_CODE_ENABLED`, decision 10. | Public spend, $1 a session. Terms decision still open. |
| `FLEET_ALL_PRODUCTS` | Any builder's product uses the office fleet. | `FLEET_PRODUCTS`. | Opens the office boards to anyone who signs in. |
| `GPU_GLIMMER_ALL_PRODUCTS` | Any builder's product uses a paid Glimmer window. | `GPU_GLIMMER_SHARED`. | Other people spend GPU money. Decision 11 open. |
| `BOARD_TRY_PUBLIC` | Visitors use a real board's try page. | `BOARD_LOOP`. | Public prompts reach an office Jetson with no content check. |
| `FLEET_SAM` | Hosted products reach SAM 3.1 on jetson-04. | Fleet URL, `jpt_` token, node. | The admin token runs root commands on every board. HANDOFF says off for judging. |
| `COMPOSIO_PERSONAL_ENABLED` | Gmail, Calendar and Slack on the owner's accounts. | `COMPOSIO_API_KEY`. | Every guest shares the owner account, so any guest could act as the owner. |
| `PLATFORM_POWERS` | A product acts as a small Muse Muse for its owner. | The platform overlay. | Up to $50 a day across products, and no real power has run. |
| `CONNECT_SENDS`, `CONNECT_SENDS_PRODUCTION` | Products send messages with the builder's key. | The vault. | Owner decision 8 keeps sends off production. |
| `DEVICE_LLAMA_TRAINING` | Trains on the house board. | `DEVICE_MCP_URL`. | The board trains only Llama. Breaks the Meta-only rule. |
| `SIM_TUNE` | Runs a tuned GGUF on the lab's Android emulator. | `NATIVE_LAB`. | Every Glimmer file is too big. Anything small enough is Llama. |
| `FIREWORKS_TUNE` | Train on Fireworks beside Lambda. | A working Fireworks key. | The account answered 412 (suspended) on Nov 2. Runs would fail in front of judges. |
| `TRUST_AGE_GATE` | 18 and over at sign-in, before building, and in new products. | Nothing. | Slows or blocks judges. |
| `TRUST_GEO_BLOCK` | Blocks listed territories. | `TRUST_GEO_COUNTRIES`. | Could refuse judges by location. |
| `FAST_BUILDS` | One-round parallel builds. | Nothing. | Changes the build shape in judging week. The owner left it off Nov 2. |
| `HF_PUBLIC` | Makes auto-published tunes public. | Nothing. | Publishes before data rights are checked. Keep unset or 0. |
| `DRIVE_ENABLED`, `DRIVE_LIVE_SALES` | Public flash drive order requests, and live card sales. | Stripe keys, prices. | Takes buyers' names and addresses and real money. Sales need counsel, tax and insurance review first. |
| `PUBLIC_TRAINING` | Visitor tune runs. | Nothing. | Adds nothing: `OPEN_TRAIN` already turns it on. |
| `PROVE_PUT_FILES` | Local test knob for Prove it. | Nothing. | Would skip the real download check on Production. |
| `GLASSES_NATIVE_CHECKS` | Meant for simulator glasses checks. | The lab. | No code reads it. |
| `NATIVE_DEVICE_FARM` | Meant for real phones in Device Farm. | The lab. | No code reads it, only its cap number. |
| `PUBLIC_DATASETS` | Placeholder for visitor-written datasets. | A terms decision. | Nothing reads it as yes. |
| `CONNECT_MORE_TOOLS` | More read-only tools. | A Composio sync. | Nothing reads it yet. |
| `TRUST_DEPLOY_BIG_FILES` | Files over 10 MB deploy. | Nothing. | No code reads it. |
| `NATIVE_BRIDGE_NOTIFY`, `NATIVE_BRIDGE_BLE` | Shell bridge parts. | Nothing. | No code reads them. |

## The order to do the setups

Times are ET. Costs are list-price estimates.

1. **Now, Ethan, $0.** Run `scripts/flags-on.sh --dry`, then without `--dry`. Push to main or Redeploy. Then `node scripts/judge-check.mjs` and check `/offline` answers 200. If the AWS lab isn't running, remove `NATIVE_LAB`.
2. **Now, Ethan, $0.** Set the spend lines before the Wonder flip: `AGENT_LONG_DAILY_USD` to 10, `CHAINED_TOTAL_USD` to 20, `PROVE_NIGHTLY_PRODUCTS` to 2, `CODE_EXEC_DAILY_USD` to 3.
3. **Ethan, about 40 minutes, $0.** Read the legal draft, then `TRUST_LEGAL_PAGES`.
4. **Ethan, $0.** Settle DATA_RIGHTS Q1 (the public moss and lab repos), then `EXPORT_TUNED`.
5. **Ethan, runbook step 2, a few cents.** `PACKAGER_SNAPSHOT_ID`, then one test phone build.
6. **Ethan, about an hour of Preview test builds on `TEST_MODEL`, about $0.03 to $0.40 each.** One build each for `LOOK_FIRST`, `FILES_ENABLED`, `CONNECT_ENABLED`, `JOBS_ENABLED`, `LIVE_ENABLED`, `MEDIA_ENABLED` with one part, `RUNTIME_ENABLED`, `NATIVE_EXTENSION`, `NATIVE_GAME_ENGINES`, `DATA_SIGN_IN`, then one test chain for `CHAINED_BUILDS` (capped by `CHAINED_TOTAL_USD`). Turn on in Production only what passed. Then `CODE_EXEC`.
7. **Ethan, 15 minutes, $0.** GitHub OAuth App, its id and secret, `CONNECTED_ACCOUNTS_KEY`, then `GITHUB_EXPORT`.
8. **Ethan, runbook step 8, $5 to $13 of GPU.** `PARTNER_EVALS`, then off with `HOST_TUNED`.
9. **Ethan, $3.70 and 2 hours of Lambda per job.** `QUANT_ENABLED` and `QUANT_TARGETS`. Quantize the cold-room tune to a Glimmer GGUF.
10. **Ethan and Hussam, about 30 minutes of Hussam's time.** Ethan uploads the drive kit and commits kit-files.json. Hussam installs drive.py and runs setup-drive.sh. Then `DRIVE_EXPORT_ENABLED`.
11. **Hussam, with Ethan making `HARDWARE_BOARD_KEY`, $0.** `HARDWARE_BOARD_REGISTRY`, `HARDWARE_ENABLED`, `HARDWARE_BOARD_TOOLS` with `DEVICE_MCP_URL` and `DEVICE_MCP_TOKEN`, `GADGET_CONNECT`, then `DRIVE_EXPORT_PRODUCTS`.
12. **Hussam and Ethan, filming window only (runbook section 10), $0 plus ngrok requests.** `FLEET_PRODUCTS` with the `jik_` key. `BOARD_LOOP` on the sim target, or the fleet with about $3.40 of quantize.
13. **Ethan's decisions, spend outside the Meta budget.** `SPARK_OPEN_PRODUCTS` after `BASETEN_API_KEY` and a per-token bill check. `GPU_GLIMMER_SHARED` after decision 11 (up to $15 a day). `GPU_TRAIN_ON_DATA` after one test and a low `TRAIN_DAILY_USD`. `PROVE_NIGHTLY` after OKing about $3 a night.
14. **Nov 4, 8:05 AM, Ethan, runbook section 14.** Set the day's cap, remove `BUILDS_ON_CONTRIBUTOR`, turn on `TRUST_SPARK_TO_WONDER` with it, Redeploy. About $4 a build from here.

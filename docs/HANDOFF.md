# Handoff, Oct 27

Where Muse Privacy stands after the build, integration, tuning, review fixes and final measurements. Numbers are from [eval/reports/final.md](../eval/reports/final.md).

## Done and verified

Verified here means run on this Mac, with Glimmer on OpenRouter and invented data, or with every model and API mocked.

| What | How it was checked |
|---|---|
| All device modules (guard, model client, workspace and agent, router, approvals, egress, connector, relay client, approval page, heavy-step queue and worker, dreaming, light driver) | `uv run pytest -q`: 1587 passed, 6 skipped (the integration tests, which need RUN_INTEGRATION=1), 0 failed on the final tree. `uv run ruff check .` clean. |
| The relay Worker | `cd relay && npm test`: 52 passed. `npx tsc --noEmit` clean. |
| The relay with the real Python device | `RUN_INTEGRATION=1 uv run pytest tests/test_relay_e2e.py`: `wrangler dev --local`, OAuth discovery, client registration, the pairing page with PKCE, the token, then MCP initialize, tools/list and a tool call through the relay, plus single-use codes and the one-copy-per-device rule. Passed on Oct 27 (relay build). |
| The real server | `python -m base` in cloud mode on a temp home: /health, /api/status, 401 on /mcp without the token, MCP over streamable HTTP listing 24 essays with 24 distinct tags and no roster names (integration smoke test). |
| Router accuracy, approvals and leaks on 100 items and the holdout | `final_cloud`: 75% on 100 items (share tagged 3 of 25, summary 24 of 25, ask 25 of 25, refuse 23 of 25), 49 approval requests, 0 leaks, 0 errors, 0 fallbacks; nothing shared that should have been asked about or kept. Holdout 75%, 0 leaks. |
| Five simulated nights of dreaming | `final/nights.md`: approval requests 11, 12, 9, 8, 10 a day; holdout agreement 75, 70, 75, 75, 75, 75%; the gate kept no night's rules; 0 holdout leaks every night; **one day-5 text flagged by the eval's checker, a false positive** (the verb "rose" matched the invented student Rose; the device's `guard.leaks` finds nothing). See the top of final.md. |
| The 24-essay grading job end to end with real Glimmer | `e2e_cloud_no_rules.md` and `e2e_cloud.md`: 24 essays graded, 24 feedback files with real names only under BASE_HOME, the router asked on day one, approved on the page API, 32.4 s and 31.3 s from request to the result Muse read, 0 leaks in every tool output. |
| Secrets and personal data | `uv run python -m scripts.secrets_scan --history` and a whole-repo scan for key values and prefixes, addresses, host and user names, home paths and real-looking identifiers: nothing found in the tree or git history. The only hits were invented test fixtures that test the detectors themselves (a fake key built in a test, a fake home path, `123-45-6789` and `a@gmail.com` as examples the guard must reject, the Visa test card), lock-file hashes, and the Jetson's `/var/lib/muse-privacy/home` state folder. The author's first name appears in docs where it names who decides. One user-name leak was caught and fixed during this stage: the simulation report had recorded a temporary `--home` path, now `<empty folder>` |

## Built but not tested on real hardware or real services

| What | State | What would test it |
|---|---|---|
| Glimmer on the laptop (`GLIMMER_BACKEND=llama_server`, `scripts/start.sh`) | Code and unit tests only. No model on this Mac. Two llama-servers on one 17 GB GGUF have not been tried for memory. | Free disk, download the Q4_K_M, `scripts/start.sh`, then `bench_speed --label laptop` and `run_eval --device-label laptop` |
| The Jetson: `deploy/jetson/install.sh`, three systemd units, TLS for the approval page, llama-server memory flags, adapter sync | Unit files parse and pass hardening checks in `tests/test_deploy_files.py`; the Jetson code path runs in simulation. Memory use (estimated 6.5 to 7.3 GiB) is not measured. | A board: install, then record `free -m`, `tegrastats` and llama-server's buffer lines in `eval/reports/jetson_memory.md`, and `bench_speed --label jetson` |
| Heavy steps from the Jetson to the laptop over the home network | Tested with both ends on one machine | A board and the laptop on the same network |
| The relay on Cloudflare | Not deployed | `cd relay && npx wrangler login && ./deploy.sh` |
| The Muse app: custom connector, Muse's real OAuth client (DCR or CIMD), the pairing page in Muse's browser, scheduled jobs | Not tried. Muse's client was played by httpx in the relay e2e test. | docs/MUSE_SETUP.md, steps 3 to 7 |
| Status light | Firmware logic is unit-tested; not flashed | The parts below, then `python -m base.light --test` |
| Enclosure | Model and tests in `hardware/enclosure/`; the hole pattern, fan position and stack height are placeholders | Caliper measurements, then print and the one-hour thermal test in `hardware/enclosure/THERMAL_TEST.md` |
| Quantization eval (Q4_K_M against i1-IQ1_S and IQ1_M) and router LoRA training | Modal scripts; `--check` passes, never `--run` | Ethan's go-ahead per run |
| Hugging Face repo and file names | Not checked (no downloads allowed here) | The first download or the Modal quant eval |
| A LoRA adapter going through the dreaming gate | No gate for adapters yet; documented as a manual holdout run | A trained adapter |

## Ethan's open decisions and actions

| # | Action | Why it matters | How |
|---|---|---|---|
| 1 | Fix the eval's leak checker and rerun the five nights | The final simulation recorded one day-5 leak. It is a false positive: `eval/run_eval.py` matches names case-insensitively, so the verb "rose" in a model-written class summary matched the invented student Rose. Until it is fixed and rerun, "0 leaks on every run" cannot be quoted for the simulation | In `_contains`, match roster names that are also common words (Rose, Wren, Grace) only when capitalized, as the guard does, add a test, then rerun `simulate_nights --nights 5 --per-day 20 --out eval/reports/final` (about $0.27 and 32 minutes) |
| 2 | Read the Official Rules, then fill in docs/PRIOR_WORK.md | Prior-code disclosure, IP, repo visibility, use of AI coding tools and published weights | Edit the "Still to do" paragraph at the top of docs/PRIOR_WORK.md |
| 3 | Test the custom connector in the Muse app | The connector is the product; nothing has been tried in Muse yet | Deploy the relay, then docs/MUSE_SETUP.md. If the app will not take it, use Muse Code (step 5) |
| 4 | Pick a Jetson | Blocks every Jetson number, the Jetson scene and the enclosure fit | Take one board out of the serving pool; then the Jetson commands in the README |
| 5 | Approve the Modal quantization eval and the LoRA run | Quantization quality is unmeasured, and dreaming has no trained adapter | `scripts/cloud/README.md`: about $2 to $5 and $6 to $12 at list prices. Sending real decision rows to the cloud for LoRA is a separate yes |
| 6 | Free disk for local models | The laptop's on-device speed is the number the pitch rests on. The Q4_K_M is about 17 GB plus a llama.cpp build; the Mac has about 15 GB free | Then the "Laptop with llama-server" steps in the README |
| 7 | Install Muse Code and use it for one piece | The plan and the hackathon page both highlight it | Say which piece in docs/PRIOR_WORK.md and the README |
| 8 | Buy the light parts and take the caliper measurements | The light is in the demo; the enclosure cannot print until the board is measured | Parts: an RP2040 USB board (QT Py RP2040), a 16-pixel NeoPixel ring, a 330 ohm resistor, a 470 to 1000 uF capacitor, a USB-C data cable (`hardware/light/README.md`). Measurements 1 to 9 in `hardware/enclosure/MEASUREMENTS.md` |
| 9 | Rotate the API keys pasted in chat, after the event | The OpenRouter and Meta API keys were pasted into a chat session | Make new keys on each site, put them in `.env`, revoke the old ones |
| 10 | Do the grading spot-check | The plan's grading-quality number is manual | Fill in the blank columns of `eval/reports/grading_spotcheck.md`, then add the agreement to final.md |
| 11 | Decide t002's label | It expects a shared document list, but the list names an IEP file and a lunch-status file, which the connector holds back. The eval scores the refusal as a miss | Relabel it, or leave it and keep the explanation in post_fix.md |
| 12 | Decide whether dreaming should learn from the request text | On what the connector really sends, nightly rules cannot tell this teacher's cases apart, so the gate keeps none (see final.md) | A code change in `base/dreaming/train.py`, then rerun the simulation |
| 13 | Record the video | Due with the submission | docs/DEMO_SCRIPT.md |

## Cost so far

| Service | Spend | Source |
|---|---|---|
| OpenRouter (Glimmer, all development and every measured number) | $2.31 in total on the key: about $0.04 through integration, $1.40 for tuning, $0.45 for the review fixes, $0.42 for the final runs | `GET /api/v1/key` read before and after each stage, never printing the key |
| Meta Model API (Muse Spark 1.3, the 2,000-item practice set) | About $2.07, an estimate: 90 calls, 144,059 prompt and 443,431 completion tokens, at a third-party price list's $1.25 and $4.25 per million (not confirmed on Meta's page); against $150 of credits | `eval/reports/synthetic.md`, `eval/reports/raw/synthetic_usage.jsonl` |
| Modal | $0, never run | |
| Cloudflare | $0, nothing deployed | |
| **Total** | **about $4.40** | |

## Where things are

| Need | File |
|---|---|
| Every number and its command | eval/reports/final.md |
| Interfaces between modules | docs/CONTRACTS.md |
| Decisions and why | docs/DECISIONS.md |
| What existed before the event | docs/PRIOR_WORK.md |
| Muse setup and test prompts | docs/MUSE_SETUP.md |
| The video | docs/DEMO_SCRIPT.md |
| How the router was tuned | eval/reports/tuning_log.md |
| The review fixes and their effect | eval/reports/post_fix.md |
| Relay deploy and troubleshooting | relay/README.md |
| Jetson install | deploy/jetson/README.md |
| Paid cloud scripts | scripts/cloud/README.md |

# Handoff, Oct 27

Where Muse Privacy stands after the build, integration, tuning, request topics, two rounds of review fixes and the final measurements. Numbers are from [eval/reports/final.md](../eval/reports/final.md), measured after the last fixes on one code state. The first final runs are kept in `eval/reports/before_fixes/` as history.

## Done and verified

Verified here means run on this Mac, with Glimmer on OpenRouter and invented data, or with every model and API mocked.

| What | How it was checked |
|---|---|
| All device modules (guard, model client, workspace and agent, router, approvals, egress, connector, relay client, approval page, heavy-step queue and worker, dreaming, light driver) | `uv run pytest -q`: 1681 passed, 6 skipped (the integration tests, which need RUN_INTEGRATION=1), 0 failed on the final tree. `uv run ruff check .` clean. |
| The relay Worker | `cd relay && npm test`: 52 passed. `npx tsc --noEmit` clean. |
| The relay with the real Python device | `RUN_INTEGRATION=1 uv run pytest tests/test_relay_e2e.py`: `wrangler dev --local`, OAuth discovery, client registration, the pairing page with PKCE, the token, then MCP initialize, tools/list and a tool call through the relay, plus single-use codes and the one-copy-per-device rule. Passed on Oct 27 (relay build). |
| The real server | `python -m base` in cloud mode on a temp home: /health, /api/status, 401 on /mcp without the token, MCP over streamable HTTP listing 24 essays with 24 distinct tags and no roster names (integration smoke test). |
| Router accuracy, approvals and leaks on 100 items and the holdout | `final_cloud`: 76% on 100 items (share tagged 3 of 25, summary 25 of 25, ask 25 of 25, refuse 23 of 25), 48 approval requests, 0 leaks (34 approved releases checked too), 0 errors, 0 fallbacks; nothing shared that should have been asked about or kept. Holdout 75%, 10 approval requests, 0 leaks. |
| Five simulated nights of dreaming | `final/nights.md`: approval requests 10, 8, 7, 7, 6 a day (unneeded 5, 3, 2, 2, 1); holdout agreement 75, 85, 85, 80, 90, 90%; the paired gate kept all five nights; 0 holdout leaks every night and 0 day leaks every day. The holdout is selected on, so its gain is an upper bound. |
| The unseen test (100 practice items the days, nights and gate never see) | In the same run: 70% with no rules, 79% after the last night, approval requests 53 to 30. **One leak with the night-0 router** (syn-0765: an approved snippet kept an invented name that is not on the roster and that the name pass missed); 0 after the last night. Ask first fell from 100% to 68%: a "snippets with no topics: share tagged" rule learned from 2 approvals now shares 8 snippets the teacher wanted asked about. See final.md, sections 3 and Leaks. |
| The 24-essay grading job end to end with real Glimmer | `e2e_cloud_no_rules.md` and `e2e_cloud.md`: 24 essays graded, 24 feedback files with real names only under BASE_HOME, the router asked on day one, approved on the page API, 33.4 s and 30.1 s from request to the result Muse read (28 Glimmer calls each, the request-topic call included), 0 leaks in every tool output. |
| Request topics and the review fixes | Unit tests with fakes: the learned floor over broader rules, the raw-request keyword scan, a held result when the request cannot be tagged, a request-only never-share topic asking instead of refusing, search_documents' bounded wait and `purpose`, the paired gate and the approval card's request-topic chips. Glimmer's request labels against hand labels: `eval/reports/request_topics.md` (held-out draw: parents 0.86 / 0.86, third_party 0.75 / 0.84, class_level 0.94 / 0.94, full_text precision 0.50). |
| Grading cross-check | `eval/reports/grading_crosscheck.md`: Muse Spark 1.3 graded the same 24 tagged essays; same total as Glimmer on 15 of 24, within one point on 23 of 24. A second opinion, not ground truth. |
| Secrets and personal data | `uv run python -m scripts.secrets_scan --history` and a whole-repo scan for key values and prefixes, addresses, host and user names, home paths and real-looking identifiers: nothing found in the tree or git history. The only hits were invented test fixtures that test the detectors themselves (a fake key built in a test, a fake home path, `123-45-6789` and `a@gmail.com` as examples the guard must reject, the Visa test card), lock-file hashes, and the Jetson's `/var/lib/muse-privacy/home` state folder. The author's first name appears in docs where it names who decides. One user-name leak was caught and fixed during this stage: the simulation report had recorded a temporary `--home` path, now `<empty folder>`. Rerun after the final measurements: `eval/reports/secrets_scan.md`, 0 findings, and the new reports, raw rows and charts are clean |

## Built but not tested on real hardware or real services

| What | State | What would test it |
|---|---|---|
| Glimmer on the laptop (`GLIMMER_BACKEND=llama_server`, `scripts/start.sh`) | Code and unit tests only. No model on this Mac. Two llama-servers on one 17 GB GGUF have not been tried for memory. | Free disk, download the Q4_K_M, `scripts/start.sh`, then `bench_speed --label laptop` and `run_eval --device-label laptop` |
| The Jetson: `deploy/jetson/install.sh`, three systemd units, TLS for the approval page, llama-server memory flags, adapter sync | Unit files parse and pass hardening checks in `tests/test_deploy_files.py`; the Jetson code path runs in simulation. Memory use (estimated 6.5 to 7.3 GiB) is not measured. | A board: install, then record `free -m`, `tegrastats` and llama-server's buffer lines in `eval/reports/jetson_memory.md`, and `bench_speed --label jetson` |
| Heavy steps from the Jetson to the laptop over the home network | Tested with both ends on one machine | A board and the laptop on the same network |
| The relay on Cloudflare | Not deployed. Claude's attempt was stopped by the session's auto-mode safety check, so Ethan runs it | `cd relay && npx wrangler login && ./deploy.sh` |
| The Muse app: custom connector, Muse's real OAuth client (DCR or CIMD), the pairing page in Muse's browser, scheduled jobs, and whether Muse says who a result is for (search_documents' `purpose`, the instructions of run_private_task) and follows a search's job id with get_result | Not tried. Muse's client was played by httpx in the relay e2e test, and the eval's search items assume Muse fills in `purpose`. | docs/MUSE_SETUP.md, steps 3 to 7 (test step 4 checks the purpose) |
| Status light | Firmware logic is unit-tested; not flashed | The parts below, then `python -m base.light --test` |
| Enclosure | Model and tests in `hardware/enclosure/`; the hole pattern, fan position and stack height are placeholders | Caliper measurements, then print and the one-hour thermal test in `hardware/enclosure/THERMAL_TEST.md` |
| Quantization eval (Q4_K_M against i1-IQ1_S and IQ1_M, now four jobs with the device's own prompts, the request-topic pass included) and router LoRA training | Modal scripts; `--check` passes, never `--run` | Ethan's go-ahead per run |
| Hugging Face repo and file names | Not checked (no downloads allowed here) | The first download or the Modal quant eval |
| A LoRA adapter going through the dreaming gate | No gate for adapters yet; documented as a manual holdout run | A trained adapter |

## Ethan's open decisions and actions

| # | Action | Why it matters | How |
|---|---|---|---|
| 1 | Read the Official Rules, then fill in docs/PRIOR_WORK.md | Prior-code disclosure, IP, repo visibility, use of AI coding tools and published weights | Edit the "Still to do" paragraph at the top of docs/PRIOR_WORK.md |
| 2 | Deploy the relay | Muse can reach the device only through it, and nothing in the Muse app can be tried before it is up. Claude's attempt was stopped by the session's auto-mode safety check, so Ethan runs it | `cd relay && npx wrangler login && ./deploy.sh`. It prints `https://muse-privacy-relay.<your-subdomain>.workers.dev`; relay/README.md has a troubleshooting table |
| 3 | Test the custom connector in the Muse app | The connector is the product; nothing has been tried in Muse yet | docs/MUSE_SETUP.md steps 2 to 7: connect the device, add the connector, pair, set the two scheduled jobs, then the test script. Test step 4 checks that Muse fills in a search's `purpose`. If the app will not take the connector, use Muse Code (step 5) |
| 4 | Pick a Jetson | Blocks every Jetson number, the Jetson scene and the enclosure fit | Take one board out of the serving pool; then the Jetson commands in the README |
| 5 | Approve the Modal quantization eval and the LoRA run | Quantization quality is unmeasured, and dreaming has no trained adapter | `scripts/cloud/README.md`: about $2 to $5 and $6 to $12 at list prices. Sending real decision rows to the cloud for LoRA is a separate yes |
| 6 | Free disk for local models | The laptop's on-device speed is the number the pitch rests on. The Q4_K_M is about 17 GB plus a llama.cpp build; the Mac has about 15 GB free | Then the "Laptop with llama-server" steps in the README |
| 7 | Install Muse Code and use it for one piece | The plan and the hackathon page both highlight it | Say which piece in docs/PRIOR_WORK.md and the README |
| 8 | Buy the light parts and take the caliper measurements | The light is in the demo; the enclosure cannot print until the board is measured | Parts: an RP2040 USB board (QT Py RP2040), a 16-pixel NeoPixel ring, a 330 ohm resistor, a 470 to 1000 uF capacitor, a USB-C data cable (`hardware/light/README.md`). Measurements 1 to 9 in `hardware/enclosure/MEASUREMENTS.md` |
| 9 | Rotate the API keys pasted in chat, after the event | The OpenRouter and Meta API keys were pasted into a chat session | Make new keys on each site, put them in `.env`, revoke the old ones |
| 10 | Do the grading spot-check | The plan's grading-quality number is manual; Spark's cross-check is only a second opinion | Fill in the blank columns of `eval/reports/grading_spotcheck.md`, then add the agreement to final.md |
| 11 | Decide t002's label | It expects a shared document list, but the list names an IEP file and a lunch-status file, which the connector holds back. The eval scores the refusal as a miss | Relabel it, or leave it and keep the explanation in post_fix.md |
| 12 | Decide how much evidence a broad share rule needs | Two approvals taught "share tagged" for every snippet with no topics, so on the unseen test the router stopped asking about 8 snippets the teacher wanted to see | A code change in `base/dreaming/train.py` (for example more answers before a rule covers a whole kind), then rerun the simulation (about $0.39 and 34 minutes) |
| 13 | Optional: score the night-5 router on the 100 tasks | The gate kept all five nights, so final_cloud is the starting router, not the night-5 one | About $0.10: `uv run python -m eval.run_eval --set eval/tasks.jsonl --name final_cloud_night5_rules --rules eval/reports/final/learned_rules_night5.md --device-label "laptop (OpenRouter Glimmer)"` |
| 14 | Record the video | Due with the submission | docs/DEMO_SCRIPT.md |

## Cost so far

| Service | Spend | Source |
|---|---|---|
| OpenRouter (Glimmer, all development and every measured number) | $3.789 in total on the key: $2.305 up to the first final runs (about $0.04 through integration, $1.40 for tuning, $0.45 for the first review fixes, $0.42 for the first final runs), $0.919 for the request-topic work and its checks, and $0.565 for the final runs after the second review fixes | `GET /api/v1/key` read before and after each stage, never printing the key; the last stage per run in eval/reports/final.md, "Cost of these runs" |
| Meta Model API (Muse Spark 1.3) | About $2.21, an estimate: $2.07 for the 2,000-item practice set (90 calls, 144,059 prompt and 443,431 completion tokens) and $0.14 for the grading cross-check (24 calls, 32,637 prompt and 22,437 completion tokens), at a third-party price list's $1.25 and $4.25 per million (not confirmed on Meta's page); against $150 of credits | `eval/reports/synthetic.md`, `eval/reports/raw/synthetic_usage.jsonl`, `eval/reports/grading_crosscheck.md` |
| Modal | $0, never run | |
| Cloudflare | $0, nothing deployed | |
| **Total** | **about $6.00** | |

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
| The review fixes and their effect | eval/reports/post_fix.md (first round); eval/reports/final.md, "What changed since the first final runs" (second round) |
| The first final runs, before request topics | eval/reports/before_fixes/ |
| Relay deploy and troubleshooting | relay/README.md |
| Jetson install | deploy/jetson/README.md |
| Paid cloud scripts | scripts/cloud/README.md |

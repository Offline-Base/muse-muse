# Muse Privacy, Meta Global AI Developer Hackathon build

Muse Privacy is a Muse connector that gives Muse a private workspace on the user's own device, a laptop or a Jetson Orin Nano. Muse plans work from its cloud VM using tags like "Student A." The device holds the documents, runs Muse Glimmer for every step that touches them, writes finished files with real names locally, and returns only tagged or summarized results. A privacy router decides for each result whether to share it tagged, share a summary, ask the user, or refuse, and a nightly "dreaming" job teaches it the user's approve and deny decisions. It is written new in this repo.

Read docs/CONTRACTS.md before writing or changing any module. It is the shared interface every module codes against. Shared types live in base/types.py and settings in base/config.py; change them only when CONTRACTS.md changes with them.

## The hackathon
- Meta Global AI Developer Hackathon, entered on the startup track, solo. The Official Rules (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver, checked Oct 28) say the startup Representative must be an active employee of the startup; Ethan confirms the track and entity before submitting.
- One rubric for every project: Impact 30% (who benefits, whether people could use it, fit with one of the problem statements, which no public page lists; the two themes are the nearest public match), Use of Meta AI Tooling 25% (creative use beyond a basic integration, unexpected capabilities), Demo 25% (a working demo that holds up live, and the quality of the demo video), Technical Depth & Execution 20%. The startup track's blurb ("technical execution and whether it holds up in production") is emphasis, not the rubric. A measured number still beats a claim, but who it helps, what Meta's models do here and the demo, live and on video, are 80% of the score. docs/RUBRIC.md has the sources and maps the project to each criterion.
- The Rules require building with Meta AI products ("Muse Spark, Glimmer, SAM 3, and any other Meta AI products identified on the Event page"). We use Muse Glimmer for every private step (our own rule: no other model family), Muse Spark 1.3 through the Meta Model API for the eval harness and synthetic data, and the Muse app through the connector. The Rules never name the Muse app or connectors, so the tooling story leads with Glimmer and Spark.
- Submissions are due Nov 4 at 9 PM ET (EST that day, 02:00 UTC Nov 5) in the Cerebral Valley portal. We submit by noon ET. Judging runs Nov 4 to 8 and the live finals are Nov 9, so the device and relay client must stay up through Nov 9.
- Our own rule, stricter than the Official Rules (which ask for original work the entrant solely owns, and allow third-party technical help, and open source if its licenses are followed and the submission builds on it): everything is built in this repo during the event. The author's earlier repos (decision-guard, base-router-subagent, decision-tree) are inspiration only: read them, then write new code here. Never import from them, vendor them, or symlink them. Record what each piece was inspired by in docs/PRIOR_WORK.md.

## Where models run (as of Oct 27)
- Development is cloud only for now. Do not download, serve, quantize or train any model on this Mac. The disk has about 15 GB free and Ethan asked for cloud. No `hf download`, no llama-server, no mlx-lm runs locally.
- GLIMMER_BACKEND=openrouter (the default today) sends Glimmer calls to OpenRouter model `meta/muse-glimmer-30b`. This is a development mode for synthetic data only: base/config.py and the workspace refuse to read any folder without a `.synthetic` marker while the backend is a cloud endpoint. Never weaken that check.
- GLIMMER_BACKEND=llama_server is the shipping mode: Glimmer on the device through llama-server's OpenAI-compatible API. Laptop: Meta's `Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf`. Jetson Orin Nano 8GB: `mradermacher/Muse-Glimmer-30B-i1-GGUF` i1-IQ1_S (6.5 GB) for lookups and tagging, with heavy steps handed to the laptop through the dial-out worker. Needs llama.cpp b10353 or newer.
- Oct 29, Ethan's call: `PRIMARY_MODEL=lfm` (set in .env) runs grading, summaries and the name and topic checks on Liquid's LFM3-VL-2B on this laptop (`scripts/start_checker.sh`, 127.0.0.1:8083), with LFM3-1.7B on Ethan's Jetson (the Jetson gateway, `JETSON_LFM_BASE` and `JETSON_LFM_API_KEY` in .env) as the fallback when a local call fails, else Glimmer. The gateway is on the internet, so it gets the same synthetic-only refusal as OpenRouter. The privacy router stays on Glimmer. llama.cpp b11972 breaks json_schema replies if a request also sends `enable_thinking: false`; thinking is off on the server instead.
- Glimmer's "assistant" model is a DFlash speculative-decoding drafter, not a chat model, so Glimmer itself is the router (decided Oct 27 from the model card).
- Glimmer prompting: put `Reasoning strength: low` (or medium/high/xhigh) in the system prompt; on llama-server use `chat_template_kwargs.reasoning_strength`. Reasoning counts against max_tokens, so give at least 1500. OpenRouter accepts `reasoning: {"effort": "low"}`, `response_format` json_schema (strict) and tools.
- Muse Spark 1.3: POST https://api.meta.ai/v1/chat/completions, `Authorization: Bearer $META_API_KEY`, model `muse-spark-1.3`, `reasoning_effort` in minimal|low|medium|high|xhigh|max (no "none"), strict json_schema works, usage has `completion_tokens_details.reasoning_tokens`. Limits seen: 3000 requests and 4M tokens per minute.

- Oct 30, Ethan's call: "use Liquid for now, ignore Glimmer." `DEVICE_ONLY=1` is set in .env, so LFM3-VL-2B on this laptop answers every step, the router included, and no model off the device can be reached. This overrides the Oct 27 "cloud only" and the Oct 29 Jetson fallback. Eval numbers measured with Glimmer on OpenRouter do not describe this setup; use eval/reports/device_only_lfm.md and eval/reports/compliance*.md. No Glimmer download without asking. docs/COMPLIANCE_PLAN.md has the plan and its status.

## Devices
- BASE_DEVICE selects laptop or jetson. Never hardcode a device, URL, hostname or path to one machine.
- The Mac is a managed work laptop: never bind anything on it to 0.0.0.0, scan the network, or start Tailscale. Servers on the laptop bind 127.0.0.1. The laptop reaches the Jetson by dialing out (base/heavy/worker.py); the Jetson never connects in to the laptop.
- Do not touch any real Jetson board (no SSH, no fleet jobs). The Jetson path is built and tested in simulation until Ethan picks a board.
- Anything that works on one device needs a test or smoke check for the other.

## Hard rules
- Nothing leaves the device except connector tool results, and every result passes guard.tag and the privacy router first. Raw documents, names, identifiers and the tag map never leave. Enforce this in code and test it.
- Finished files with real names are written only on the device, under BASE_HOME (default ~/.base).
- base/spark.py is only for the eval harness and synthetic data, never for user data, and refuses any input containing a roster name or a guard hit.
- All test and demo data is synthetic. Never put real names, real student data or real personal data in fixtures, logs or commits. Phone numbers use 555-01xx, emails use example.com/example.org, SSNs start with 9 or 000, card numbers are well-known test numbers.
- Secrets live in .env, which is gitignored. Never print, log or commit API keys, IP addresses, hostnames, usernames or Wi-Fi names.
- Deleting a document, fact or decision row removes it from the next dreaming rebuild.
- Every module gets pytest tests. Mock OpenRouter, the Meta API and llama-server in unit tests (respx), with integration tests marked `@pytest.mark.integration` and skipped unless RUN_INTEGRATION=1.
- Keep code small and boring. Python 3.12, FastAPI, SQLite, uv. Ask before adding a framework. Use only dependencies already in pyproject.toml; if a new one is unavoidable, say so in your final report instead of editing pyproject.toml.
- Any number we might quote goes into eval/reports with the command that produced it.
- No em dashes in user-facing text (README, docs, UI copy, messages to Muse).

## Commands
This folder sits inside the Muse Muse repo as `privacy/`, so run these from here. Keep it apart: no imports either way
(`lib/__tests__/privacy-boundary.test.ts`). CI is `.github/workflows/privacy.yml` at the repo's root.
- `uv run pytest -q` runs the unit tests. `uv run ruff check .` lints.
- `uv run python -m base.server` starts the approval page and connector for BASE_DEVICE.

Ports: answer model 8081, router 8082, checker (LFM3-VL-2B) 8083, embedder (EmbeddingGemma 2, SEARCH_EMBEDDINGS=1) 8084, approval page 8787, Muse connector 8790.

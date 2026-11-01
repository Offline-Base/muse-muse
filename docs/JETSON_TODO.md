# Jetson to-do

What to run when the owner gives Jetson access, in order. **Nothing here has been run.** The board loop has only seen the simulated board (`docs/BOARD_LOOP.md`). Stop at the first step that fails and record it in `docs/BUILD_LOG.md`, with the numbers, even when the answer is no.

Use a board with no other job (jetson-03 or jetson-04 hold Bolt today, so say which is being taken off it). Never SSH from the laptop. Everything goes through the fleet control plane or the board's own MCP server, and no Glimmer file runs on the laptop.

## 1. Fleet connection

The `offline-fleet` MCP connection fails today (endpoint not found at www.offlinebase.com).

- Owner: make a personal token (`jpt_`) with the **admin** role on the console's Connect page, since `exec` needs admin. Set `BOARD_FLEET_URL` (https, with `/admin`), `BOARD_FLEET_TOKEN` and `BOARD_FLEET_NODE` on the machine or Preview running the loop. Fix or re-add the MCP entry too.
- Run: `GET /api/nodes` with the token, then a harmless `exec` such as `uname -a` from `POST /api/nodes/{id}/actions`.
- **Pass:** the board is `online`, not in maintenance, has `metrics.mem` and `metrics.temps_c`, and `exec` returns exit code 0. Also confirm the agent's `exec` runs as root, since `installCommand` writes under `/opt` and `/proc/sys/vm/drop_caches`, and `gguf-serve.sh` needs root. If not, change those commands first.

## 2. A real one-bit file

Needs a tuned adapter's real IQ1_S from `QUANT_TARGETS` (`docs/TRAINING.md`, "Device targets"), public on the OfflineBase Hub namespace.

- Run: the local files job on a rented GPU, not here.
- **Pass:** `fileForDevice("jetson_orin_nano", files)` returns a file, `files.public` is true, and `LOW_BIT_KL_MAX` has been set from a measured run.

## 3. One-bit file loads under 8 GB

`BOARD_LOOP_TARGET=fleet`, `BOARD_LOOP=1`, press **Send to the board** on the judged model, and watch Send and Serve. It serves with `gguf-serve.sh`, release `FLEET_LLAMA_RELEASE` (b11970), one chat, 2048 context, desktop off (`systemctl set-default multi-user.target`).

- **Check the release first:** the file was quantized on b11669 and must load on the board's build.
- If it runs out of memory, try in order: smaller context (1024), mmap, partial GPU layers. An 8 GB board rebooted once from a GPU out of memory (`gguf-serve.sh` header), so have someone able to power cycle it.
- **Pass:** the board lists the name in `loaded_models`, and `metrics.mem.used_mb` stays under 7,200 MB of 7,620 MB with the model loaded and one chat running, with no OOM in `logs_query` `dmesg` and swap at or near 0. **Fail is a real result:** the file measured 6.53 GB on the knowledge model, the 7.7 GB to run is only an estimate, and the earlier 70% device rule would allow only 5.6 GB. Then record it, and the board gets the small Llama instead.

## 4. Thermal watch

Ten minutes of the fixed test set repeated, reading `/api/nodes/{id}/metrics?range=15m`.

- **Pass:** `temp_tj` stays under 85 C with no throttling in `logs_query`, and tokens a second in the last prompt is within 20% of the first. Record peak `temp_tj` and `power_w`. The 85 C and 20% lines are my starting numbers, not a spec: check them against NVIDIA's limit for the module.

## 5. Tokens a second

The loop's Fixed test set stage, with the real model.

- **Pass:** all five prompts answer with real, non-canned text, the loop's memory check passes, and first token is under 30 seconds. Record tokens a second and first token per prompt. For a usable try page, aim for at least 2 tokens a second. Below that, record it and leave the try page off.
- Also run the job's held-out prompts here and compare with the GPU's answers: 90% final answers was the job's own bar.

## 6. Serve

- Run: a chat through the gateway at `/v1/chat/completions` with `X-JCP-Node`, and a second at the same time.
- **Pass:** both answer, one waiting or getting 429 `fleet_busy`, and no other model loads beside it. Then press Stop.
- **Pass:** `--undo` runs, the model leaves `loaded_models`, maintenance is off, and the board can go back to its old model. Write down how that model comes back: `--undo` hands chats to Ollama and doesn't restore Bolt.

## 7. Demo recording

- Run: the loop on a machine with `BOARD_CLIP_TOOLS_DIR` and ffmpeg (a Vercel function gets no clip).
- **Pass:** an H.264 1920x1080 clip, whose captions say "Real board, through the fleet", with the real answers and numbers. Watch it through. Nothing about it says simulated, and the numbers match the loop's page.

## 8. Try page

- Run: `/try-board/<id>` as an admin first. Before setting `BOARD_TRY_PUBLIC`, the owner decides about content checks, since prompts reach a tuned model directly.
- **Pass:** two browsers queue in order; the sixth turn in an hour is refused; unplugging the board's network shows the offline state within about 10 seconds and uses no turn; the page recovers by itself.

## 9. Flash drive path

Uses the existing drive export, not the loop (`docs/DRIVE_EXPORT.md`). `LocalFiles.lowBit` is deliberately left out of drive orders today.

- Run: `/device` Flash drive card on the Jetson, with the board reached over its MCP server, using a real USB stick and the file allowed by the owner. If the one-bit file should go on drives, add it to the orders first and record that decision.
- **Pass:** the export ends `PASS`, every file reads back, and the drive runs on a second machine that isn't the laptop.

## 10. Then replace the copy

- `fit` in `deviceModelTarget` and `LOW_BIT_FACTS` in `lib/train/quant-targets.ts`, with what was measured.
- `provenOnDevice` to true only if steps 3 to 5 passed.
- `WhereItRuns`' "not run on a real board" line.
- Note in `docs/BOARD_LOOP.md` which targets have now been seen working.

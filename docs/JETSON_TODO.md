# Jetson to-do

What to run when the owner gives Jetson access. **Nothing here has been run on a real board.** The board loop and gadget connect have only seen simulated boards (`docs/BOARD_LOOP.md`, `docs/GADGETS.md`). The numbers quoted from `docs/log/quant-run-2026-11-01` and `docs/log/quant-run-tuned-2026-11-01` are from an x86 stand-in, not a Jetson. Start with Part A, stop at the first step that fails, and record it in `docs/BUILD_LOG.md`, with the numbers, even when the answer is no.

Use a board with no other job (jetson-03 or jetson-04 hold Bolt today, so say which is being taken off it). Never SSH from the laptop. Everything goes through the fleet control plane or the board's own MCP server, and no Glimmer file runs on the laptop.

# Part A: the board loop (`BOARD_LOOP`)

## 1. Fleet connection

The `offline-fleet` MCP connection fails today (endpoint not found at www.offlinebase.com).

- Owner: make a personal token (`jpt_`) with the **admin** role on the console's Connect page, since `exec` needs admin. Set `BOARD_FLEET_URL` (https, with `/admin`), `BOARD_FLEET_TOKEN` and `BOARD_FLEET_NODE` on the machine or Preview running the loop. Fix or re-add the MCP entry too.
- Run: `GET /api/nodes` with the token, then a harmless `exec` such as `uname -a` from `POST /api/nodes/{id}/actions`.
- **Pass:** the board is `online`, not in maintenance, has `metrics.mem` and `metrics.temps_c`, and `exec` returns exit code 0. Also confirm the agent's `exec` runs as root, since `installCommand` writes under `/opt` and `/proc/sys/vm/drop_caches`, the serve and stop commands write to `/run`, and `gguf-serve.sh` needs root. If not, change those commands first.

## 2. A real one-bit file

Needs a tuned adapter's real IQ1_S from `QUANT_TARGETS` (`docs/TRAINING.md`, "Device targets"), public on the OfflineBase Hub namespace.

- Run: the local files job on a rented GPU, not here. Done once through the harness with publish 0 (Nov 1, adapter 1898e46c, made-up data): IQ1_S passed, 30 of 30 final answers, KL 0.943, and `LOW_BIT_KL_MAX` is now 1.1. That file was not kept or published, so this step still needs a public one.
- **Pass:** `fileForDevice("jetson_orin_nano", files)` returns a file, `files.public` is true, and `LOW_BIT_KL_MAX` has been set from a measured run.

## 2b. Send

- Run: press **Send to the board** with `BOARD_LOOP_TARGET=fleet` and watch the Send stage. No board command in `lib/board-loop/fleet.ts` has ever run.
- **Pass:** the file arrives under `.part`, its checksum passes twice, and a corrupted file planted at that name is removed and downloaded again. A failed send, or Stop before serving, leaves the board's old model running.

## 3. One-bit file loads under 8 GB

`BOARD_LOOP_TARGET=fleet`, `BOARD_LOOP=1`, press **Send to the board** on the judged model, and watch Send and Serve. It serves with `gguf-serve.sh`, release `FLEET_LLAMA_RELEASE` (b11970), one chat, 2048 context, desktop off (`systemctl set-default multi-user.target`).

- **Check the release first:** the file was quantized on b11669 and must load on the board's build.
- If it runs out of memory, try in order: smaller context (1024), mmap, partial GPU layers. An 8 GB board rebooted once from a GPU out of memory (`gguf-serve.sh` header), so have someone able to power cycle it.
- **Pass:** the board lists the name in `loaded_models`, and `metrics.mem.used_mb` stays under 7,200 MB of 7,620 MB with the model loaded and one chat running, with no OOM in `logs_query` `dmesg` and swap at or near 0. **Fail is a real result:** the 6.53 GB file on the knowledge model loaded under 8 GiB and 7 GiB limits on an x86 CPU with 6 threads and no swap (Nov 1, `docs/log/quant-run-2026-11-01`): 7.3 GB resident with mmap at a 4K context, 7.0 GB with `-lm none`, about 2.4 tokens a second and about 5 seconds to the first token. x86 under a limit isn't a Jetson, and the earlier 70% device rule would allow only 5.6 GB. Then record it, and the board gets the small Llama instead. The tuned file (same size, adapter 1898e46c, made-up data, Nov 1, `docs/log/quant-run-tuned-2026-11-01`) also loaded under both limits with no out-of-memory event: 7.31 to 7.39 GB peak resident with mmap, 7.00 to 7.05 GB with `-lm none`, 2.5 tokens a second, 3.9 to 6.1 seconds to the first token.
- On b11669 `--no-mmap` is gone: it's `-lm none`. It needs `tuned.jinja` for a trainChannel 0 adapter: on the tuned file under Meta's stock template, 1 of 5 answers was usable, and 2 looped to the token limit.

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
- **Pass:** `--undo` runs, the model leaves `loaded_models`, maintenance is off, and the board can go back to its old model. Write down how that model comes back: `--undo` hands chats to Ollama and doesn't restore Bolt. The undo runs under `systemd-run`, so confirm the agent comes back and that the 40 second wait is long enough.

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

## 9b. Board MCP path

- Run: the same loop with `BOARD_LOOP_TARGET=device`, on a board with the updated `muse-device/server.py`.
- **Pass:** `install_model` returns a sha256 matching the file, and a wrong one stops the loop before serving.

# Part B: small Llama and the installer

## Small Llama on other boards and devices

Tuned Llama 3.2 3B Q4_K_M: 2.02 GB, about 2.8 GB resident, about 23 tokens a second on 6 x86 threads, and 162 on an A10. None of this was on a phone or a board. Measure it on the real device, then replace `fit` in `deviceModelTarget`.

## The Jetson installer

From `EXPORT_TUNED` (`docs/TRAINING.md`, "Export a tuned model"). Tested only on a simulated board, with a fake `uname`, board file, `cmake` and `llama-cli`.

1. **Does the source build work?** Run the installer on a real board: `cmake` with `GGML_CUDA=ON` at b11669, on JetPack's own CUDA. Record how long it takes, and whether `-j 4` runs out of memory.
2. **Which flags let it load?** The script uses `-c 4096 -ngl 99`, neither measured on a board. Change `LLAMA_RUN_CONTEXT` and the default layers in `lib/train/export` to what works.
3. **Does `--cpu` run?** The arm64 prebuilt may need a newer glibc than the board has.
4. **Does Ollama run an IQ1_S file?** Not tried anywhere.
5. **After a real run,** update the Jetson `proof` line in `EXPORT_KINDS`.

# Part C: gadget connect

## Gadget connect (`GADGET_CONNECT`, docs/GADGETS.md)

G1. **Copy the files and start it.** `muse-device/server.py`, `drive.py`, `train.py` to a board, then `python3 server.py --tls`. Proves: it makes a certificate, and `python3 server.py pair` prints a code and a check number. `server.py` needs `openssl` on the board, which nobody has checked on JetPack 7.
G2. **Reach it from a hosted site.** A hosted site can't call a private address, on purpose. A board needs a public address that keeps its own TLS: a TCP passthrough tunnel, not one that ends TLS itself, or the pin would be the tunnel's certificate. Open: which tunnel. On a local site, a board on the same network works.
G3. **Pair it from `/gadgets`.** Proves: both screens show the same check number, and the board's kind comes out `jetson_orin_nano`. `boardKindOf` matches the text of `describe_device`'s `model`. A real board's text has never been read by this code.
G4. **Put one-bit Muse Glimmer on it and start it.** From a tuned model's IQ1_S file (Part A, step 2), with `install_model` and `start_model`. Proves: it fits and answers. The file is about 6.5 GB and the estimate to run it is 7.7 GB against 8 GB of memory, with no measurement. A failed GPU allocation has frozen and rebooted these boards (`train.py`), so watch it, and be ready for it not to fit. Its answers may also be poor: the knowledge run's one-bit recall was 9.0% against 29.5% at four bits, and the tuned test file was clearly right on 2 of 5 general questions.
G5. **Ask from a product.** `askBoard` from a linked product. Proves: the answer comes from the board, in under `BOARD_ANSWER_MS` (100 seconds), and it's what `/v1/chat/completions` returned. If one-bit is slower than that, the limit needs to change. `server.py`'s `ask_model` adds `enable_thinking`, and `/v1` doesn't: check Glimmer's template behaves. Also confirm what the real `llama-server` reports at `/v1/models`, since the answer's `target` uses that name when it differs from the picked model.
G6. **Turn the owner check on first.** `HARDWARE_GADGET_OWNER_CHECK` before `DEVICE_MCP_URL` or any real board reaches production.

## Small Llama on other devices

G7. **A Raspberry Pi or other device.** Same as 3 to 5 with Llama 3.2 3B Q4_K_M. Proves: its kind comes out right and it answers.

## Training on the board

G8. **Run `setup-train.sh` and one run on Llama 3.2 1B.** `train_model`, then `training_status`. Proves: it trains and converts. Nothing about this base has been measured on a board. The file is 2.47 GB, so `TRAIN_OVERHEAD_GIB` puts a run at about 3.5 GiB, against a real 2.3 GiB taken by the smaller model it replaced. Record peak memory, seconds per step, and whether `convert_lora_to_gguf.py` b11970 takes the adapter. Until then the product says it hasn't been measured. If it doesn't fit, show board training as not available: don't swap in a smaller non-Meta model.
G9. **A board fine-tune on a drive.** `export_model` with the Llama license on it. The kit's new license files need `scripts/drive-kit.ts --upload` first. Earlier non-Meta runs on `jetson-02` can't go on a drive any more, by design.

## Robotics

G10. **Real actuators don't exist in this code.** `server.py` has no robot tools. `robot_action` runs only in `sim_board.py`, and the gateway refuses every robot tool on a board that didn't report `simulated: true` at pairing. Before a real one: a physical cut-off the software can't override, a watchdog on the board that stops everything if the platform goes quiet, limits enforced on the board with each actuator's own numbers, and someone watching. Don't do this by flipping the simulated check.
G11. **Check the hard stop on hardware.** Press it with the actuator running and time it. On a real board a stop that reaches only the platform isn't a stop, and the page tells the owner to cut power in that case.

## Fleet

G12. **`jetson-infra`'s control plane has no TLS on the LAN**, so the fleet gateway can't be paired this way. docs/OFFLINE.md on tg-offline has the options. Not part of this.

# Last: replace the copy

- `fit` in `deviceModelTarget` and `LOW_BIT_FACTS` in `lib/train/quant-targets.ts`, with what was measured.
- `provenOnDevice` to true only if steps 3 to 5 passed.
- `WhereItRuns`' "not run on a real board" line.
- Note in `docs/BOARD_LOOP.md` which targets have now been seen working.
- `On your own hardware` mark in `lib/story/flow.ts` and the limits on `/offline`.

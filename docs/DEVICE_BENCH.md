# Device bench

How to measure Muse Privacy's models on each device: the Mac, a Jetson Orin Nano 8GB and a Raspberry Pi 5 (8 GB or 16 GB). One script, `scripts/bench_device.py`, runs unchanged on all three and writes `eval/reports/device_<label>.md` with the command at the top, plus `eval/reports/raw/device_<label>.jsonl` (numbers, lengths and hashes only, never text).

**Claude never connects to a board.** No SSH from the laptop, no fleet jobs. Ethan copies a bundle and the model files on a USB stick, runs every command below on the board's own console, and brings back the two report files on the stick.

## What the bench does

1. Records the device: OS, board, CPU, cores, memory, free disk, llama.cpp build, how many other llama-servers run, the power source (pmset on macOS, /sys on Linux), `nvpmodel -q` on a Jetson and `vcgencmd get_throttled` and `measure_temp` before and after on a Pi. Never the host name, an address or the user name; it refuses to write a report that holds one.
2. Checks the model, its vision projector and the KV cache at `--ctx` fit in memory with `--margin` GB (default 1) to spare, and skips with the reason instead of running out of memory. A drafter that does not fit is skipped the same way.
3. Runs `llama-bench` (pp512 and tg128, 3 repetitions) when it sits next to llama-server, before any server starts, so the model is never loaded twice.
4. Starts its own llama-server on a free 127.0.0.1 port (never 8081 to 8085, so a running app is left alone) with a throwaway key file, and always stops it, errors included. Load time is the start to the first answer from `/health`. It reads the model, KV, recurrent state and compute buffer sizes and the offloaded layers from the server's log, and samples the server's peak memory every half second.
5. Times the real steps on a copy of the invented class in a throwaway home, with the request bodies the device sends and the prompt cache off: one router decision, the name pass, request topics and grading one essay (`--runs` each), the name pass over the essay folder (`--essays`), one ask_device answer (LFM only), and with `--full-grade` the whole 24-essay grading job.
6. With `--kind glimmer --reasoning low,medium,high`, repeats the steps at each reasoning level. With `--draft FILE`, repeats them greedily with the drafter at each `--draft-n` and compares with a greedy run without it: speedup, acceptance and whether the outputs match (by hash). The rule, written before any number: the drafter stays off below 1.1x.
7. Marks the report invalid when the power source changes during the run or is not `--expect-power`.

## Labels

| Label | Device | Model |
|---|---|---|
| `mac-lfm` | Mac, plugged in | LFM3-VL-2B Q4_K_M with its projector |
| `mac-lfm-battery` | Mac, on battery | the same |
| `mac-glimmer1b` | Mac | the fine-tuned Glimmer, about 1.6-bit (IQ1_S) |
| `mac-glimmer1b-dflash` | Mac | the same with the DFlash drafter |
| `jetson-lfm` | Jetson Orin Nano 8GB | LFM3-VL-2B |
| `jetson-glimmer1b` | Jetson Orin Nano 8GB | Glimmer about 1.6-bit (IQ1_S), text only, no drafter |
| `pi5-8-lfm` | Raspberry Pi 5 8 GB | LFM3-VL-2B |
| `pi5-16-lfm` | Raspberry Pi 5 16 GB | LFM3-VL-2B |
| `pi5-16-glimmer1b` | Raspberry Pi 5 16 GB | Glimmer about 1.6-bit (IQ1_S) |

## Devices

Ethan fills this in (no host names or addresses).

| Device | Model and RAM | OS | Storage | Cooling or power mode | Internet for uv and llama.cpp |
|---|---|---|---|---|---|
| Mac | this laptop | macOS | internal | plugged in for every run but the battery one | yes |
| Jetson | Orin Nano 8GB, a board that serves no other demo | JetPack: to fill in | NVMe: to fill in | `nvpmodel -q`: to fill in, never changed by the bench | to fill in |
| Pi | Pi 5, 8 GB or 16 GB: to fill in | Pi OS Lite 64-bit: to fill in | SD or NVMe: to fill in | active cooler: to fill in | to fill in |

## Before any device: the bundle

On the Mac, in the repo:

```
uv run python -m scripts.make_bundle
```

It writes `dist/muse-bench-<date>.tar.gz` and its `.sha256`, from the files git tracks (uncommitted edits included) with no `.env`, no `.gguf`, no reports and nothing `.git/info/exclude` names, and it refuses to build if the secrets scan finds anything. Copy to the USB stick: the tarball, its `.sha256`, and the model files the device needs (`LFM3-VL-2B-Q4_K_M.gguf`, `mmproj-LFM3-VL-2B-Q8_0.gguf`, the Glimmer file).

Check a Glimmer file before anything loads it (header only, no model call):

```
uv run python -m scripts.plug_in_model /path/to/glimmer.gguf --check --label glimmer1b
```

## Mac

The context defaults to the app's: 16384 for LFM3-VL-2B and 4096 for Glimmer (the Jetson unit's), so Glimmer on the Mac gets `--ctx 16384` like `ANSWER_CTX`. Run while no Muse session is active, through the model-slot lock when another job may be using the model. The bench takes its own port, so the live app keeps running; the report counts the other llama-servers.

```
pmset -g batt | head -1
uv run python -m scripts.bench_device --label mac-lfm --gguf models/LFM3-VL-2B-Q4_K_M.gguf --mmproj models/mmproj-LFM3-VL-2B-Q8_0.gguf --kind lfm --expect-power plugged --full-grade
```

On battery (Ethan unplugs first):

```
uv run python -m scripts.bench_device --label mac-lfm-battery --gguf models/LFM3-VL-2B-Q4_K_M.gguf --mmproj models/mmproj-LFM3-VL-2B-Q8_0.gguf --kind lfm --expect-power battery --runs 1 --essays 6
```

The fine-tuned Glimmer, then with the drafter if Ethan downloads it:

```
uv run python -m scripts.bench_device --label mac-glimmer1b --gguf /path/to/glimmer.gguf --kind glimmer --ctx 16384 --reasoning low,medium,high --full-grade --hash --expect-power plugged
uv run python -m scripts.bench_device --label mac-glimmer1b-dflash --gguf /path/to/glimmer.gguf --kind glimmer --ctx 16384 --draft /path/to/drafter.gguf --draft-n 3,5,7,15,16 --expect-power plugged
```

## Jetson Orin Nano 8GB

1. Pick a board that serves no other demo and take it out of the serving pool. On its console, stop the services that hold GPU memory, for example `sudo systemctl stop ollama docker` and the board's own llama.cpp service. Record `nvpmodel -q`; do not change the power mode unless Ethan says so. Boot without the desktop only if Ethan chooses to (`sudo systemctl isolate multi-user.target`).
2. Copy the tarball, its `.sha256` and the models from the stick to the board's disk, then check and unpack:

   ```
   sha256sum -c muse-bench-<date>.tar.gz.sha256
   tar xzf muse-bench-<date>.tar.gz && cd muse-bench-<date> && sha256sum -c SHA256SUMS
   ```

3. Install uv if the board lacks it (see docs.astral.sh/uv), then build llama.cpp. The laptop runs b11972; Glimmer needs b10353 or newer and LFM3-VL-2B b11960 or newer, so build b11972:

   ```
   export PATH=/usr/local/cuda/bin:$PATH
   git clone --depth 1 --branch b11972 https://github.com/ggml-org/llama.cpp ~/llama.cpp && cd ~/llama.cpp
   cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=87 -DCMAKE_BUILD_TYPE=Release && cmake --build build -j 2 --target llama-server llama-bench
   ```

4. In the unpacked bundle, build the app's Python and run the benches. The memory flags match the Jetson unit (`-ub 128 -b 512 --swa-full`). Glimmer runs text only, without a drafter, at a 4096 context; the drafter (about 1.6 GB) does not fit next to it in 8 GB.

   ```
   uv sync --frozen --no-dev
   uv run python -m scripts.bench_device --label jetson-lfm --gguf ~/models/LFM3-VL-2B-Q4_K_M.gguf --mmproj ~/models/mmproj-LFM3-VL-2B-Q8_0.gguf --server-bin ~/llama.cpp/build/bin/llama-server --ub 128 --batch 512 --swa-full --full-grade --expect-power plugged
   uv run python -m scripts.plug_in_model ~/models/glimmer.gguf --check --device jetson --label jetson-glimmer1b
   uv run python -m scripts.bench_device --label jetson-glimmer1b --gguf ~/models/glimmer.gguf --kind glimmer --server-bin ~/llama.cpp/build/bin/llama-server --ctx 4096 --ub 128 --batch 512 --swa-full --runs 1 --essays 6 --hash --expect-power plugged
   ```

5. Put the board back in the pool and restart what you stopped.

## Raspberry Pi 5 (8 GB or 16 GB)

1. Pi OS Lite 64-bit, the active cooler on. The bench records `vcgencmd get_throttled` and the temperature before and after; an under-voltage flag means the supply is too weak and the numbers are low.
2. Copy and check the bundle as on the Jetson, install uv, then build llama.cpp for the CPU (no GPU, so `--ngl 0` below):

   ```
   git clone --depth 1 --branch b11972 https://github.com/ggml-org/llama.cpp ~/llama.cpp && cd ~/llama.cpp
   cmake -B build -DGGML_NATIVE=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build -j 4 --target llama-server llama-bench
   ```

3. In the unpacked bundle:

   ```
   uv sync --frozen --no-dev
   uv run python -m scripts.bench_device --label pi5-8-lfm --gguf ~/models/LFM3-VL-2B-Q4_K_M.gguf --mmproj ~/models/mmproj-LFM3-VL-2B-Q8_0.gguf --server-bin ~/llama.cpp/build/bin/llama-server --ngl 0 --runs 1 --essays 6 --max-minutes 60
   uv run python -m scripts.bench_device --label pi5-16-lfm --gguf ~/models/LFM3-VL-2B-Q4_K_M.gguf --mmproj ~/models/mmproj-LFM3-VL-2B-Q8_0.gguf --server-bin ~/llama.cpp/build/bin/llama-server --ngl 0 --runs 1 --essays 6 --full-grade --max-minutes 90
   uv run python -m scripts.bench_device --label pi5-16-glimmer1b --gguf ~/models/glimmer.gguf --kind glimmer --server-bin ~/llama.cpp/build/bin/llama-server --ngl 0 --ctx 2048 --runs 1 --essays 2 --max-minutes 90
   ```

   On an 8 GB Pi, Glimmer gets the same command as the 16 GB one with `--label pi5-8-glimmer1b`; expect the memory check to stop it or the run to be too slow to use.

## Copy back

Only these files go back on the stick, never the server log or anything else from the board:

- `eval/reports/device_<label>.md`
- `eval/reports/raw/device_<label>.jsonl`
- `eval/reports/model_file_<label>.md`, when you ran the check on the board

On the Mac, copy them into `eval/reports/` and `eval/reports/raw/` and read them before quoting anything.

## Fits, too slow or does not fit

**Unverified until measured.** Every row is a projection from file sizes and memory bandwidth; a row changes to measured only with a `device_<label>.md` report behind it.

| Device | LFM3-VL-2B (about 1.6 GB with its projector) | Glimmer about 1.6-bit (IQ1_S), about 6.1 GiB | DFlash drafter (about 1.6 GB) | Why |
|---|---|---|---|---|
| Mac (Apple silicon, the app's laptop) | fits | fits | fits | Unified memory well above the model, drafter and KV cache with the live app running. |
| Jetson Orin Nano 8GB (about 7.4 GiB seen by Linux) | fits | fits only at the edge: headless, other GPU services stopped, 4096 context | does not fit | 6.1 GiB model plus about 0.2 GiB of KV cache at 4096 tokens plus about 1 GiB for the system is about 7.3 of 7.4 GiB; the drafter adds 1.6 GB more. |
| Raspberry Pi 5 8 GB | fits, slow | too slow, and at the edge of memory | does not fit | CPU only. Each generated token reads the whole model from memory (about 17 GB/s at best), so a 6 GB model gives about one token a second or less. |
| Raspberry Pi 5 16 GB | fits, slow | fits in memory, too slow | fits in memory, unlikely to help | The same memory bandwidth as the 8 GB board; more memory does not make it faster. |
| A 16 GB laptop | fits | projected to fit | projected to fit | The full stack (Glimmer, LFM, the embedder and a KV cache) may pass what macOS lets the GPU use on 16 GB. Projected, not tested. |

# Jetson deploy files

Everything needed to run Muse Privacy on a Jetson Orin Nano 8GB as three systemd services.

**Status: no board has been chosen yet, and nothing in this folder has been run on a real Jetson.** The unit files and scripts are checked by `tests/test_deploy_files.py` (the units parse and carry the hardening settings, the scripts pass `bash -n`, nothing binds beyond loopback except the approval page when you set `APPROVAL_HOST`), and the Jetson code path is tested in simulation on the laptop. Expect to fix small things on first contact with a board.

## What runs

| Service | What it does | Listens on |
|---|---|---|
| `muse-privacy-glimmer` | llama-server with Muse Glimmer i1-IQ1_S (6.5 GB), 4096 context, one slot, all layers on the GPU | 127.0.0.1:8081 only, and the unit denies every non-loopback address |
| `muse-privacy` | `python -m base` with `BASE_DEVICE=jetson` and `GLIMMER_BACKEND=llama_server`: approval page, connector, heavy-step queue, status light | approval page on `APPROVAL_HOST` (default 127.0.0.1), connector on 127.0.0.1:8790 |
| `muse-privacy-relay` | `python -m base.connector.relay_client run`: dials out to the connector relay so Muse can reach the connector | nothing, outgoing only |

On the Jetson, answer and router calls share the one llama-server on 8081. Heavy steps (grading) go to the laptop when its worker is connected: the laptop runs `python -m base.heavy.worker` and dials out to this board's approval page. This board never connects to the laptop. With no worker in the last 30 seconds, the step runs here on the 1-bit model.

All three run as the `muse-privacy` system user with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, no capabilities, `RestrictAddressFamilies` limited to Unix and IP sockets, and only `/var/lib/muse-privacy` writable. The two Python services have `MemoryMax` (1G and 256M) and a system call filter. The model service has no memory cap and no `PrivateDevices`, because it needs the GPU and shares the board's 8 GB with it.

## Files

| File | What it is |
|---|---|
| `install.sh` | Run once as root from a checkout of this repo. Creates the `muse-privacy` user (in the `video` and `dialout` groups when they exist), `/opt/muse-privacy`, `/var/lib/muse-privacy` (0700) and `/etc/muse-privacy/env` (site settings, 0640). Copies the app without `.env`, builds its virtualenv with `uv sync --frozen --no-dev` when uv is installed, optionally builds llama.cpp with CUDA (`--build-llama`), downloads the GGUF and installs and enables the units. It never restarts the board and never changes its power settings. |
| `muse-privacy-glimmer.service` | The model server. Its `ExecStartPre` runs `glimmer-env.sh`. |
| `glimmer-env.sh` | Writes `/var/lib/muse-privacy/glimmer.env`. When `/var/lib/muse-privacy/adapters/router.gguf` exists, `LORA_ARGS` becomes `--lora <that file> --lora-init-without-apply`, so the router adapter is loaded but off, ready to be turned on per request or with `adapter_sync.sh`. Otherwise `LORA_ARGS` is empty and llama-server starts without a LoRA. |
| `muse-privacy.service` | The Muse Privacy server. Reads site settings from `/etc/muse-privacy/env`. |
| `muse-privacy-relay.service` | The relay client. Installed but not enabled until you set `RELAY_URL` and pair. |
| `adapter_sync.sh` | Installs a router LoRA adapter you brought over from the laptop (USB stick, or a copy the laptop starts), restarts the model service if the file changed (llama-server only loads LoRA files at start), and leaves its global scale at 0 (the router names it per request). `--scale S` applies it to every request, for testing. |

## Model download

`install.sh` downloads

```
https://huggingface.co/mradermacher/Muse-Glimmer-30B-i1-GGUF/resolve/main/Muse-Glimmer-30B.i1-IQ1_S.gguf
```

to `/opt/muse-privacy/models/` through a `.part` file that `curl --continue-at -` resumes after an interruption. It reads the file's SHA-256 and size from the Hugging Face API (`/api/models/mradermacher/Muse-Glimmer-30B-i1-GGUF/tree/main`), checks free disk first, and only moves the file into place when the SHA-256 matches. Set `MODEL_SHA256` to supply the hash yourself.

## Install

```
sudo deploy/jetson/install.sh --build-llama
sudoedit /etc/muse-privacy/env      # APPROVAL_HOST, RELAY_URL, LIGHT_SERIAL, WORKSPACE_ROOT
sudo systemctl start muse-privacy-glimmer muse-privacy
journalctl -u muse-privacy-glimmer -u muse-privacy -f
```

llama.cpp must be b10353 or newer. Loading the model takes about a minute; the model unit allows five.

## Pair the laptop worker

On the Jetson, print the worker token:

```
sudo -u muse-privacy env BASE_HOME=/var/lib/muse-privacy/home /opt/muse-privacy/app/.venv/bin/python -m base.heavy.routes
```

On the laptop, with `JETSON_URL` set to the Jetson's approval page (the address you put in `APPROVAL_HOST`, port 8787):

```
uv run python -m base.heavy.worker --token <token>
```

## Router adapter

```
sudo /opt/muse-privacy/bin/adapter_sync.sh /path/to/router.gguf              # load, global scale 0
sudo systemctl restart muse-privacy                                          # the server finds its id
sudo /opt/muse-privacy/bin/adapter_sync.sh /path/to/router.gguf --scale 1.0  # testing only: every request
```

On the Jetson the router and the answer model share one llama-server, and a scale set through `/lora-adapters` applies to every request that does not name its own adapters. With `DREAMING_BACKEND=lora`, the server asks llama-server for the id of `router.gguf` at start (`GET /lora-adapters`) and the router names it on each of its own requests, so the default global scale of 0 keeps the answer model, the name pass and grading on the plain model. `--scale 1.0` applies the adapter to all of them and is only for trying it out. No adapter has been through the dreaming gate yet: score one with `eval.run_eval --holdout` against llama-server before using it.

## Memory on the 8 GB board

The IQ1_S file is 6.08 GiB. The unit starts llama-server with a small ubatch (`-ub 128`) and with the prompt cache and context checkpoints turned off (`--cache-ram 0 --ctx-checkpoints 0`), which otherwise grow in host memory with every new prompt. That puts llama-server at an estimated 6.5 to 7.3 GiB, against about 7.3 GiB the board's Linux sees, so the board must boot headless (`sudo systemctl set-default multi-user.target`). These are estimates: on first contact, record `free -m`, `tegrastats` and llama-server's model, KV and compute buffer lines in `eval/reports/jetson_memory.md`. If it still does not fit, every model step except lookups has to go to the laptop worker.

## Not covered here

- Choosing or flashing a board, power modes and clocks. Use the board's defaults until one is picked.
- The relay Worker itself (`relay/`) and device registration (`python -m base.connector.relay_client pair`).

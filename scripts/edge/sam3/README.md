# SAM 3.1 on a Jetson

Meta's Segment Anything 3.1 (`facebook/sam3.1`, gated on Hugging Face) running on jetson-04, a Jetson Orin Nano 8 GB, with a small page on a laptop that calls it through the fleet control plane. This is the edge direction the owner chose on Nov 2, 2026 (docs/EDGE_PLAN.md, "Direction: SAM 3.1 on the boards").

## Files

| File | Runs on | What it does |
|---|---|---|
| `convert_fp16.py` | the laptop | Downloads `sam3.1_multiplex.pt` (3.5 GB) into memory with the signed-in Hugging Face account, halves every fp32 tensor and saves `sam3.1_multiplex_fp16.pt` (1.76 GB). Only the small file touches disk |
| `server.py` | jetson-04, `/opt/sam3/server.py` | The `sam3` service. Loads the detector half of the 3.1 checkpoint once, then `POST /segment` takes an image and a text prompt and returns boxes, scores and mask areas, plus a picture with the matches tinted when `overlay` is true. `GET /health`. One request at a time. `--selftest image.jpg` runs one prompt and exits |
| `ask.py` | jetson-04, `/opt/sam3/ask.py` | Joins an image's base64 pieces left by earlier fleet jobs in `/tmp/sam-ui/<id>/`, asks the service, prints one `SAMRESULT {json}` line and removes the pieces |
| `ui.py`, `index.html` | the laptop | A page at `http://127.0.0.1:8792`. It shrinks the photo to 640 px, sends it to jetson-04 as fleet exec jobs of 15 KB each, then runs `ask.py` and shows the tinted picture and the scores |
| `tune/` | jetson-03 (and jetson-04's `share.py`) | The on-board tune of SAM 3.1 for one new word, and its before and after scores (below) |

## On jetson-04

- `/opt/sam3/venv`: PyTorch 2.14.1+cu130 and torchvision from download.pytorch.org, Meta's `sam3` code at `f1647e8d0c1d280991f4d1b7d974c2704537fe66`, plus `einops`, `pycocotools` and `psutil`, which its `pyproject.toml` leaves out. About 5.2 GB.
- `/opt/sam3/model/`: the fp16 checkpoint (sha256 `959c68010f37f856f1ffdf9d4b76f0644c312bb53299768f4281f788606fbdf8`), `config.json`, the tokenizer files and the LICENSE.
- `sam3.service`: on at boot, `192.168.12.144:8790` (office network only), `MemoryMax=6G`, `OOMScoreAdjust=500` so it is killed before anything else on the board.
- PyTorch warns that its cu130 build has no published kernels for the Orin (compute 8.7). It works by compiling at first use, so the first request after a restart is slow (about 7 to 14 s). Every result so far was right. If something misbehaves, suspect this first.

Measured Nov 2 on Meta's `truck.jpg`: load 45 to 54 s, 3.4 GB of GPU memory at rest and 3.9 GB at peak; "truck" 1 found at 0.87 in 1.4 to 2.6 s, "wheel" 4 found at 0.78 to 0.95, "person" 0 (right) in 1.3 s. At 640 px through the page, about 10 to 20 s a round trip, most of it the upload.

## Tuned detectors (Nov 3)

`server.py --tuned muse=/opt/sam3/model/muse31_delta_fp16.pt` loads a tuned detector beside Meta's. A request with `"tuned": "muse"` looks with it and the answer says `"weights": "muse"`; without that field it is Meta's SAM 3.1 as before. Swapping copies 30.4M numbers on the GPU inside the service's lock. On jetson-04 it is a drop-in, `/etc/systemd/system/sam3.service.d/tuned.conf`.

`tune/` holds how that file was made on jetson-03, an 8 GB Orin Nano: Meta's own SAM 3 trainer (`sam3/train/train.py`, Roboflow 100-shot recipe) with the vision and language encoders frozen and kept in bf16, so only the detector's transformer, geometry encoder and scoring heads train (30.4M of 838M parameters). The base is SAM 3.1, read tensor by tensor from jetson-04 over the office network (`share.py`, `sam31load.py`) because jetson-03's disk had 569 MB free. Five epochs of 160 made-up images, about 2 s a step. `evalmuse.py` scores Meta's weights and the tuned ones on 50 held-out images and on a harder "small" set built from them, plus Meta's truck photo to check nothing was forgotten. Results: docs/BUILD_LOG.md, Nov 3.

## From a hosted product (Nov 3, `FLEET_SAM`, off)

A product on Vercel can't reach the office network. Muse Muse's `POST {GATEWAY_URL}/fleet/v1/segment` (`lib/caps/fleet/sam.ts`) does what `ui.py` does, on the server: the product's token in, the photo to jetson-04 in 15,000-character pieces through the control plane's jobs API, `ask.py`, and the service's own answer back. `segmentOrEdge` uses it when `EDGE_SAM_URL` is unset. It needs `FLEET_SAM=1`, `FLEET_SAM_NODE`, `BOARD_FLEET_URL` and `BOARD_FLEET_TOKEN` on the deployment.

## The page

```
cd scripts/edge/sam3
read -s "FLEET_TOKEN?Fleet token: " && export FLEET_TOKEN && python3 ui.py
```

The token is a personal fleet token (`jpt_...`) of an admin, because `exec` is admin only. Type it at the prompt; never paste it in a chat or a file. The server keeps it in memory and sends it only to the control plane. The control plane's API lives under `/admin` (`FLEET_URL` defaults to `https://creative-linoleum-retake.ngrok-free.dev/admin`). Limits it works within: an exec command is at most 16,384 characters, and a job's streamed output keeps 256 KB.

## What may be said

Meta's SAM 3.1 runs on a Jetson Orin Nano in the office and answers text prompts on photos in about 1.5 to 3 seconds. Not yet: anything about a camera feed, video tracking (the multiplex tracker half isn't loaded), offline use, or accuracy beyond the photos tried.

# SAM 3.1 on a Jetson

Meta's Segment Anything 3.1 (`facebook/sam3.1`, gated on Hugging Face) running on jetson-04, a Jetson Orin Nano 8 GB, with a small page on a laptop that calls it through the fleet control plane. This is the edge direction the owner chose on Nov 2, 2026 (docs/EDGE_PLAN.md, "Direction: SAM 3.1 on the boards").

## Files

| File | Runs on | What it does |
|---|---|---|
| `convert_fp16.py` | the laptop | Downloads `sam3.1_multiplex.pt` (3.5 GB) into memory with the signed-in Hugging Face account, halves every fp32 tensor and saves `sam3.1_multiplex_fp16.pt` (1.76 GB). Only the small file touches disk |
| `server.py` | jetson-04, `/opt/sam3/server.py` | The `sam3` service. Loads the detector half of the 3.1 checkpoint once, then `POST /segment` takes an image and a text prompt and returns boxes, scores and mask areas, plus a picture with the matches tinted when `overlay` is true. `GET /health`. One request at a time. `--selftest image.jpg` runs one prompt and exits |
| `ask.py` | jetson-04, `/opt/sam3/ask.py` | Joins an image's base64 pieces left by earlier fleet jobs in `/tmp/sam-ui/<id>/`, asks the service, prints one `SAMRESULT {json}` line and removes the pieces. An optional fourth argument names a tuned detector (`muse`); `SAM_URL` says where the service listens |
| `ui.py`, `index.html` | the laptop | A page at `http://127.0.0.1:8792` with a switch between Meta's weights and the tuned ones, and a "Before and after" button that shows both side by side. It reaches the board straight (`SAM_URL`) or through the fleet (`FLEET_URL`) |
| `compare.py` | the laptop | One command for the before-and-after shot: a photo, Meta's weights and the tune, "muse" and "plush toy", written to one page and printed as a table |
| `test_sam_page.py` | the laptop | Tests for the three above against a fake service and a fake control plane: `python3 -m unittest scripts/edge/sam3/test_sam_page.py` |
| `LOCAL.md` | | What "running locally" can mean for the video, Hussam's rebind and cable-out steps, the go or no-go check, and why not the Mac |
| `tune/` | jetson-03 (and jetson-04's `share.py`) | The on-board tune of SAM 3.1 for one new word, and its before and after scores (below). `tune/README.md` has the steps to repeat it |

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

**The risk (Nov 3 review), and why it stays off for judging.** `BOARD_FLEET_TOKEN` has to be an admin's `jpt_` token, because the route runs exec jobs and `exec` is admin only. An admin token runs any command as root on every board (`bash -lc`), and can change users and settings. Putting it on the public app's deployment means anyone who gets the app's production env, or finds a hole in the route, owns the fleet. The route does what it can: every command is built from checked parts, the token never reaches a product or a browser, only admin-made live products may call it, and looks are capped (40 a product and 200 in all a day, 4 a minute a visitor, one at a time). Two costs remain: the control plane's job history keeps every photo piece, and each look spends 10 to 25 of the tunnel's monthly requests. There is no smaller `jpt_` token today: the roles are admin, operator (no exec) and viewer, and a token can't be held to one board.

**A safer way, proposed, not built:** a `POST /v1/segment` in the control plane, made like its `/v1/systemone`:
- The board advertises a `sam3` capability, and its agent forwards `/v1/segment` to SAM on the board, as it forwards `/v1/systemone` to `systemone_url` (`agent/jetson_agent/llm_proxy.py` and `ollama.py` in jetson-infra add the path and a `sam_url`).
- The control plane routes it to a board with that capability and checks a `jik_` API key, like the other `/v1` routes. A `jik_` key reaches only `/v1/*`, has its own `rpm_limit`, and can be revoked alone. It can't run commands or change anything on the fleet.
- `lib/caps/fleet/sam.ts` then sends one request with the photo instead of 10 to 25 exec jobs, so the photo pieces leave the job history and the tunnel budget goes about 15 times further. `BOARD_FLEET_TOKEN` can then drop to a viewer token for the read-only uses (the /device fleet card and Wonder's fleet tools).
- Work: a change to jetson-infra's control plane and agent with tests, then Hussam updates the agent on jetson-04 and makes the key. About half a day, $0. The agent's tunnel buffers up to 4 MB, enough for a 400 KB photo and the tinted picture back; that wasn't tried.

Until then, if `FLEET_SAM` must be on: a dedicated admin user that Hussam makes for this one token, so it can be revoked alone and its jobs stand out in the audit log, revoked the day judging ends. That's Hussam's and the owner's call together.

## The page

Straight to the service, from a laptop on the office network or cabled to the board (no token, no control plane, a look in about 2 s):

```
cd scripts/edge/sam3
SAM_URL=http://<board address>:8790 python3 ui.py
SAM_URL=http://<board address>:8790 python3 compare.py ../../../public/muse/muse-jetson.jpg
```

Through the fleet control plane, from anywhere it is reachable:

```
FLEET_URL=http://<control plane>/admin python3 ui.py
```

`FLEET_URL` has no default: on the office network give the control plane's office address, so nothing goes through the public tunnel. The page asks for the token at the prompt (not shown as you type): a personal fleet token (`jpt_...`) of an admin, because `exec` is admin only. Never paste it in a chat or a file. The page keeps it in memory and sends it only to the control plane. Limits it works within: an exec command is at most 16,384 characters, and a job's streamed output keeps 256 KB. In this mode the last job carries this folder's `ask.py` inline, so the tuned switch works without updating the board's copy. `SAM_BOARD_URL` (default the office address) is where the board reaches its own service; after the rebind in LOCAL.md it can be `http://127.0.0.1:8790`.

Either way the answer must name the weights asked for: if the page asks for the tune and the board answers with Meta's weights (an older `server.py`), it says so instead of showing Meta's picture as the tune's.

## What may be said

Meta's SAM 3.1 runs on a Jetson Orin Nano in the office and answers text prompts on photos in about 1.5 to 3 seconds. Not yet: anything about a camera feed, video tracking (the multiplex tracker half isn't loaded), offline use, or accuracy beyond the photos tried.

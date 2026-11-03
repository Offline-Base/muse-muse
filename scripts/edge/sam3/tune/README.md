# Tuning Meta SAM 3.1 on an 8 GB Jetson

How the `muse` detector was made on Nov 3, 2026, step by step, so someone else can make it again. It ran on jetson-03, a Jetson Orin Nano 8 GB, with Meta's own SAM 3 trainer. Cost: $0 (our board, no cloud). Results and caveats: docs/BUILD_LOG.md, "Nov 3, 2026, 2:15 to 4 AM ET", and the raw scores in docs/log/bench/2026-11-03/.

What it is: SAM 3.1 learns a new word, "muse", for the Muse mascot (a small cream plush figure). Only the detector trains: the transformer encoder and decoder, the geometry encoder and the scoring heads, 30.4M of 838M parameters. The vision and language encoders stay frozen in bf16. The result is a 61 MB fp16 file of the trained tensors (a "delta"), which `../server.py --tuned muse=<file>` loads beside Meta's weights.

What it is not: proof that SAM sees better. Meta's SAM 3.1 already finds the mascot on every held-out image when asked for "plush toy" or "toy". The tune adds a name. "Next step" below is the test that could show more.

## What you need

| Thing | Size or time | Where it was on Nov 3 |
|---|---|---|
| A Jetson Orin Nano 8 GB (L4T 39.2.1, Ubuntu 24.04), power mode MAXN_SUPER | | jetson-03 |
| Free memory | The trainer held about 5.2 GB of the 7.5 GB (unified memory). Stop other model services first; `muse-device` and the fleet agent can stay | |
| Free disk | About 7.8 GB for `/opt/sam3train` in all (venv, the `sam3` clone, data, logs). The run itself writes about 70 MB | jetson-03 had 569 MB free, which is why the base weights were streamed (step 3) |
| PyTorch for the Orin | PyTorch 2.14.1+cu130 and torchvision from download.pytorch.org, in a venv, about 5.2 GB | `/opt/sam3train/venv` |
| Meta's code | `facebookresearch/sam3` at `f1647e8d0c1d280991f4d1b7d974c2704537fe66`, plus `einops`, `pycocotools`, `psutil` (its `pyproject.toml` leaves them out) | `/opt/sam3train/sam3` |
| SAM 3.1's weights | `facebook/sam3.1` is gated on Hugging Face: accept Meta's license with the account first. Halved to fp16 with `../convert_fp16.py`: 1.76 GB | on jetson-04, `/opt/sam3/model/` |
| The data | 160 training images and 50 held-out images in COCO format (`_annotations.coco.json` per split), one class, made-up images of the mascot. The held-out 50 come from a video the training set never used; 38 show Muse and 12 don't | jetson-03, `/opt/sam3train/data/muse-coco/` |
| Time | About 11 minutes to load SAM 3.1 over the office Wi-Fi, 30 minutes to train, and about 10 minutes of looks for the scoring (counted, not timed: about 400 looks at a median 1.35 s) | |

## Steps

1. **The venv and Meta's code** on the training board. Same recipe as jetson-04 (`../README.md`, "On jetson-04"). Check `python -c "import torch; print(torch.cuda.is_available())"` says True. PyTorch warns that its cu130 build has no kernels for the Orin (compute 8.7); it compiles them at first use, so the first step is slow.
2. **The data** in `/opt/sam3train/data/muse-coco/<split>/`, each split with its `_annotations.coco.json`, in the layout Meta's Roboflow 100 recipe reads. On Nov 3 `test/` held the 50 held-out images, which `evalmuse.py` reads. Put this folder's `.py` files in `/opt/sam3train/lib31/`.
3. **The base weights.** With room on disk, copy `sam3.1_multiplex_fp16.pt` and change `load_sam31` to read it. Without room (Nov 3), stream it from the SAM board over the office network, one tensor per request, with `share.py` on that board (its docstring has the two commands; it is token-guarded, office-network only, read-only, and ends itself after 4 hours). Write `http://<SAM board office address>:8797/<token>` to `/run/sam31share.url` on the training board. At about 3.4 MB/s that took 11 minutes.
4. **The trainer config.** Copy Meta's Roboflow 100-shot config to `configs/muse/muse1.yaml` in the `sam3` clone, pointed at the data above, with 5 epochs, batch size 1, lr scale 0.1 and resolution 1008. Then `muse31.yaml` is the same with `experiment_log_dir: /opt/sam3train/runs/muse31` and `model._target_: musefreeze31.build`. `musefreeze31.build` loads SAM 3.1 (step 3), freezes the encoders in bf16, and swaps the trainer's checkpoint saving for the 61 MB delta, since the trainer's own 349 MB checkpoint with optimizer state wouldn't fit.
5. **Run it** as a transient unit with a memory cap, so it is killed before anything else on the board: the `systemd-run` line at the top of `run_nov3.sh`. That script scores Meta's weights and the tune before and after (`evalmuse.py`) around the training. Skip its first block (the SAM 3 `muse1` scoring) when making only the SAM 3.1 tune.
6. **Check the log:** `musefreeze31: trainable 30.4M params, frozen ...`, `sam31load: ... tensors from SAM 3.1`, about 2.1 s a step for 800 steps, loss from about 498 at the first step to an epoch average of about 4.4, and the trainer's own held-out AP at the end.
7. **Serve it.** Copy `runs/muse31/muse31_delta_fp16.pt` (61 MB, sha256 `737e8506...` on Nov 3) to the SAM board and add `--tuned muse=<path>` to `server.py`'s command (on jetson-04 that is the drop-in `/etc/systemd/system/sam3.service.d/tuned.conf`). A restart takes 45 to 57 s to load and about 15 s for the first look. GPU memory at rest went from 3,425 to 3,525 MB.
8. **See it.** `../compare.py` shows Meta's weights and the tune side by side on one photo; `../ui.py` has the same switch on a page.

## Not in the repo yet (to copy in, read-only, by whoever has the board)

These live only on jetson-03. Without them, steps 2 and 4 can't be repeated exactly:
- `configs/muse/muse1.yaml` and `muse31.yaml` from the `sam3` clone (find them with `find /opt/sam3train/sam3 -name 'muse*.yaml'`). They go in `tune/configs/`.
- The script that made the 210 images, if one exists, or a note on how they were made. The images are made-up renders of our own mascot; if they go in the repo or on Hugging Face, add them to docs/DATA_RIGHTS.md first.
- `run_nov3.sh` in the repo is the Nov 3 script as it ran; the `/opt/sam3train/run_nov3.sh` copy is the same.

## Next step, not run: a look-alike test that could show a real gain

On the Nov 3 set, the tune can't beat Meta's weights: "plush toy" already finds Muse every time, and there is nothing else on those images it could confuse Muse with. The question a tune can answer is whether SAM can tell **our** plush figure from other plush toys. The test, built so and not run:

- **Data:** about 40 held-out images that show Muse **and** one to three other soft toys (cream, white or round ones on purpose: a teddy bear, a bunny, a ghost plush), plus about 20 with look-alikes and no Muse. Made-up images, made the same way as the training set but never trained on, with every toy boxed and labeled `muse` or `other`.
- **Score for each of:** Meta's weights asked "plush toy", Meta's weights asked "cream plush toy", and the tune asked "muse". Count only boxes on Muse as right. Report precision and recall at 0.5, box AP, and how many look-alikes were boxed as Muse.
- **What would count as a gain:** the tune's "muse" keeps recall near Meta's "plush toy" while boxing far fewer look-alikes. Meta's "plush toy" should box every toy, so its precision on Muse falls with each look-alike; that drop is the gap a tune could close.
- **Cost:** $0 on jetson-03 (about 60 looks per setting, 3 settings, about 5 minutes) plus the time to make the images. If the tune boxes look-alikes as Muse too, the honest result is that it learned "plush toy" under a new name. Then retrain with the look-alikes as negatives in the training set.
- Also rescore the tune with "plush toy" and "toy" (the Nov 3 scoring asked those only of Meta's weights), so we know the new word didn't cost the old ones.

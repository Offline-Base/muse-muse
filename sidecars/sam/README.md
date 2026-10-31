# SAM region finder (sidecar)

A small HTTP server on 127.0.0.1:8085 that runs Meta's SAM 3.1 on this device. Given one page image
and concept names (face, signature, id card, barcode), it returns each region's kind, score and box,
and a copy of the page with every box (plus a small pad) filled solid. docs/CONTRACTS.md, "Regions
sidecar", has the HTTP contract.

## Status (Oct 31)

- Built and tested with a fake predictor that answers from `eval/sam_pages/truth.json`. The tests run
  in the root environment and never import mlx (`tests/test_sam_server.py`).
- The real predictor (`MlxSamPredictor`, mlx-vlm on Apple silicon) is **unverified**. It was written
  from the mlx-community/sam3.1-bf16 model card and the mlx-vlm SAM 3 README and has never run here.
  Nothing is installed: no mlx-vlm, no weights, no lock.
- Off by default. `scripts/start_sam.sh` starts it only when `SAM_ENABLED=1`, and `scripts/start.sh`
  then starts it too, as an optional helper (`keep_running`) that cannot stop the app.
- The device side is built (`base/regions.py`, docs/CONTRACTS.md "Regions on the device"): with
  `SAM_ENABLED=1` the scan reader sends each page here first and LFM3-VL-2B reads only the covered
  copy; when this server is down, the page is not read at all. `tests/test_regions.py` runs that path
  against this server with the fake predictor.

## Setting it up (needs Ethan's yes first)

These steps download about 3.5 GB of weights and a large Python environment (mlx-vlm brings mlx,
transformers, datasets and opencv). Check `df -h` first.

1. Weights: `hf download mlx-community/sam3.1-bf16 --local-dir models/sam3.1-mlx` from the repo
   folder. The smaller fallback is `mlx-community/sam3-8bit` (SAM 3, not 3.1): then set
   `SAM_MODEL_ID=mlx-community/sam3-8bit` so every report names SAM 3.
2. Environment: `cd sidecars/sam && uv lock && uv sync --frozen`. `exclude-newer` in
   `pyproject.toml` keeps the lock to releases at least two weeks old.
3. Start: `SAM_ENABLED=1 scripts/start_sam.sh`, then `curl -s 127.0.0.1:8085/health` shows the model.

If the first real run fails inside `MlxSamPredictor`, that class is the only place to fix: it is the
one part written against an API nobody could run here.

## Rules it keeps

- Binds 127.0.0.1 (or ::1, localhost) only; any other `--host` is refused before anything starts.
- Every `/regions` call needs `Authorization: Bearer <key>`, the key in `BASE_HOME/llama_api_key`
  (the same file the other model servers read).
- Bodies over 8 MB get 413. One image is checked at a time.
- The image is never logged or written to disk; the log line is counts and milliseconds only.
- `HF_HUB_OFFLINE=1`: it never downloads at run time.
- SAM's license excludes ITAR and military end uses, so the device must never call it while the
  cui, cjis or export toggle is on. The reader side that calls this server
  (`base/workspace/scans.py`) enforces that.

The weights are Meta's, under the SAM License, and are not in this repo. mlx-vlm is MIT.

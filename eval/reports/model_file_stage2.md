# Model file check: stage2

Command: `uv run python -m scripts.plug_in_model glimmer-stage2-IQ1_S.gguf --check --label stage2`

Date: 2026-10-31. Read from the file's header; no model was loaded or called.

| What | Value |
|---|---|
| File | glimmer-stage2-IQ1_S.gguf |
| Size | 6.08 GB |
| Architecture | muse-glimmer |
| Quant type (general.file_type) | IQ1_S |
| Tensor types | F32 x313, IQ1_S x306, IQ2_XXS x52, Q2_K x7, Q4_K x52, Q5_K x1 |
| Tensor type ids | 0, 10, 12, 13, 16, 19 |
| Parameters | 27,854,794,240 (27.85 B) |
| Effective bits per weight | 1.874 (file bytes x 8 / parameters) |
| Vision | no vision tensors in the file; no mmproj file next to it |
| Vocabulary | 202,048 tokens |
| Chat template | present, sha256 cfc67e5f349f3769, mentions reasoning_strength: yes |
| sha256 | 23fef56a3bb9c7f3f2e513044cf11c88bf2d3cb3adfbc727c49288cea4fbafb4 |
| KV cache at 16,384 tokens | 0.81 GB (at most: the model has a 2048-token sliding window) |
| llama-server build | not found (set LLAMA_SERVER_BIN); types checked against the table only |
| Free disk on its volume | 56.1 GB (needs 2 GB) |
| Memory needed | 10.9 GB (model, drafter and KV cache at 16,384 tokens, plus 4 GB for the rest) |
| Memory on this device | 216.3 GB |
| Device | laptop, 4 GB kept for everything but the model |

Result: can be plugged in.

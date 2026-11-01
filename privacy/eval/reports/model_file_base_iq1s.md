# Model file check: base_iq1s

Command: `uv run python -m scripts.plug_in_model Muse-Glimmer-30B.i1-IQ1_S.gguf --check --label base_iq1s`

Date: 2026-10-31. Read from the file's header; no model was loaded or called.

| What | Value |
|---|---|
| File | Muse-Glimmer-30B.i1-IQ1_S.gguf |
| Size | 6.08 GB |
| Architecture | muse-glimmer |
| Quant type (general.file_type) | IQ1_S |
| Tensor types | F32 x313, IQ1_S x306, IQ2_XXS x52, Q2_K x7, Q4_K x52, Q5_K x1 |
| Tensor type ids | 0, 10, 12, 13, 16, 19 |
| Parameters | 27,854,794,240 (27.85 B) |
| Effective bits per weight | 1.874 (file bytes x 8 / parameters) |
| Vision | no vision tensors in the file; a vision projector sits next to it (1 mmproj file(s)) |
| Vocabulary | 202,048 tokens |
| Chat template | present, sha256 cfc67e5f349f3769, mentions reasoning_strength: yes |
| sha256 | 87ec555ca9a80d0ad68a603188518c94422ac954cccfd7be5161d84192148d32 |
| KV cache at 16,384 tokens | 0.81 GB (at most: the model has a 2048-token sliding window) |
| llama-server build | 11972 |
| Free disk on its volume | 9.5 GB (needs 2 GB) |
| Memory needed | 10.9 GB (model, drafter and KV cache at 16,384 tokens, plus 4 GB for the rest) |
| Memory on this device | 36.0 GB |
| Device | laptop, 4 GB kept for everything but the model |

Result: can be plugged in.

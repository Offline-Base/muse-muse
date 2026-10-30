# Quantization {#quantization}

Muse Glimmer ships pre-quantized GGUF checkpoints, so you can run it on a single GPU without converting anything. At roughly 4-bit precision the language model fits under 20 GB, which leaves room for the KV cache, the vision projector, and a speculative decoding drafter.

## Choose a checkpoint {#checkpoints}

Both checkpoints live in [`meta-models/Muse-Glimmer-30B-GGUF`](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF), alongside the vision projector and the DFlash drafter.

| File                                           | Download size | What it's for                                             |
| ---------------------------------------------- | ------------- | --------------------------------------------------------- |
| `Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf`     | 16.8 GB       | Text model, fixed K-quant. Start here.                    |
| `Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf` | 19.7 GB       | Text model, dynamic K-quant. Higher quality, more memory. |
| `mmproj-Muse-Glimmer-30B-Q4_K_M.gguf`          | 1.4 GB        | Vision projector, required for image input.               |
| `dflash-Muse-Glimmer-30B-Q4_K_M.gguf`          | 1.6 GB        | DFlash draft model, optional.                             |

The two text checkpoints use different recipes. K-Quant-17GB is a fixed scheme: a `Q4_K` body at group size 32, `Q6_K` at group size 128 on the `attn_v` and `ffn_down` projections, and `Q5_K` at group size 128 on the output head. K-Quant-Dynamic searches per-unit precision across `Q4_K`, `Q5_K`, and `Q6_K`, all at group size 32.

Full-precision weights are not published as GGUF. For bf16, use the safetensors checkpoint at [`meta-models/Muse-Glimmer-30B`](https://huggingface.co/meta-models/Muse-Glimmer-30B).

## Download the checkpoints {#download}

The `llama serve` command below fetches the checkpoint for you, so this step is optional. Download the files directly when you want them on disk, such as for an [ExecuTorch export](https://dev.meta.ai/docs/muse-glimmer/deploy#executorch) or an offline machine:

**bash**

```bash
pip install -U huggingface_hub

hf download meta-models/Muse-Glimmer-30B-GGUF --local-dir ./muse-glimmer \
  --include "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf" \
  --include "mmproj-Muse-Glimmer-30B-Q4_K_M.gguf"
```

## Run the checkpoint {#run}

Muse Glimmer support shipped in llama.cpp release `b10353`. Use `b10353` or newer: older builds don't register the `muse-glimmer` architecture and refuse to load these files with `unknown model architecture: 'muse-glimmer'`.

Install llama.cpp from [llama.app](https://llama.app/), then start the server:

**bash**

```bash
llama serve -hf meta-models/Muse-Glimmer-30B-GGUF \
  --hf-file Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf \
  --port 8080
```

Name the checkpoint with `--hf-file`. Given a repository on its own, `-hf` looks for a `Q4_K_M` quant. Three of the four GGUFs here carry that tag — the text model, the vision projector, and the drafter — so a bare `-hf` won't reliably resolve to the text model.

The vision projector downloads alongside the checkpoint, so image input works without extra flags. Pass `--no-mmproj` to skip it.

The server allocates the model's full trained context by default. Use `-c` to request a smaller one and reduce KV-cache memory. `-np` divides the context across slots, so `-np 4` with `-c 131072` leaves each slot 32,768 tokens.

## Budget your GPU memory {#memory-budget}

K-Quant-17GB with the vision projector and a full 131,072-token context measures 19 GiB of VRAM:

| Component                    | VRAM     |
| ---------------------------- | -------- |
| Text model                   | 15.6 GiB |
| Vision projector             | 1.3 GiB  |
| KV cache and compute buffers | 2.1 GiB  |
| Total                        | 19.0 GiB |

That fits a 24 GiB card with headroom. Add roughly 1.5 GiB for the DFlash drafter.

The KV cache stays small because Muse Glimmer uses grouped-query attention with 2 KV heads and sliding-window attention on three of every four layers, so only a quarter of the layers hold a full-length cache.

## Quantize it yourself {#quantize-yourself}

If neither shipped checkpoint fits your hardware, convert the full-precision weights:

**bash**

```bash
# Convert to GGUF format
python3 llama.cpp/convert_hf_to_gguf.py \
  ./muse-glimmer-30b \
  --outtype bf16 \
  --outfile muse-glimmer-30b-bf16.gguf

# Quantize to 4-bit
llama.cpp/build/bin/llama-quantize \
  muse-glimmer-30b-bf16.gguf \
  muse-glimmer-30b-q4_k_m.gguf \
  Q4_K_M
```

Compare perplexity against the full-precision model to confirm the quality loss is acceptable:

**bash**

```bash
# Evaluate perplexity with llama.cpp
llama.cpp/build/bin/llama-perplexity \
  -m muse-glimmer-30b-q4_k_m.gguf \
  -f wikitext-2-raw/wiki.test.raw
```

Validate any custom checkpoint on your own workload before you deploy it.

## Next steps {#next-steps}

Add [speculative decoding](https://dev.meta.ai/docs/muse-glimmer/spec-decode) with the DFlash drafter to speed up generation on the same hardware. For image input, tool calling, and reasoning strength, see the [llama.cpp guide](https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp).

# Run inference {#run-inference}

Run Muse Glimmer on your own infrastructure or call it through a hosted inference provider. The self-hosted runtimes load the released checkpoints, or a quantized version of them, and use the Muse Glimmer chat format described in the [prompting guide](https://dev.meta.ai/docs/muse-glimmer/prompting).

| Runtime                                                                                | Best for                                                                     | Checkpoints                   | Serving API                           |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- | ------------------------------------- |
| [vLLM](https://dev.meta.ai/docs/muse-glimmer/deploy#vllm)                              | Production serving on NVIDIA GPUs                                            | bf16                          | OpenAI-compatible HTTP                |
| [SGLang](https://dev.meta.ai/docs/muse-glimmer/deploy#sglang)                          | High-throughput serving for concurrent users on NVIDIA GPUs or Apple silicon | bf16, GGUF, NVFP4, MLX        | OpenAI-compatible HTTP                |
| [llama.cpp](https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp)                    | Local and mixed CPU and GPU inference, including laptops                     | GGUF                          | OpenAI-compatible HTTP and CLI        |
| [ExecuTorch](https://dev.meta.ai/docs/muse-glimmer/deploy#executorch)                  | Ahead-of-time export for CUDA or Apple silicon                               | GGUF exports, prebuilt `.pte` | OpenAI-compatible HTTP                |
| [Hugging Face Transformers](https://dev.meta.ai/docs/muse-glimmer/deploy#transformers) | Learning the generation loop in plain Python                                 | bf16                          | Python, no server                     |
| [Ollama](https://dev.meta.ai/docs/muse-glimmer/deploy#ollama)                          | One command to a local model                                                 | Ollama library builds         | Native and OpenAI-compatible HTTP     |
| [LM Studio](https://dev.meta.ai/docs/muse-glimmer/deploy#lm-studio)                    | A desktop app with a built-in agent                                          | LM Studio catalog builds      | OpenAI-compatible HTTP                |
| [Unsloth](https://dev.meta.ai/docs/muse-glimmer/deploy#unsloth)                        | Local inference through a desktop app on macOS, Windows, Linux, and WSL      | Unsloth Dynamic GGUFs         | OpenAI- and Anthropic-compatible HTTP |

To call the model without provisioning hardware, use a [hosted provider](https://dev.meta.ai/docs/muse-glimmer/deploy#hosted-providers). For partner-verified deployments on specific hardware, see [Hardware platforms](https://dev.meta.ai/docs/muse-glimmer/hardware-platforms).

Muse Glimmer is a dense 30B model. The bf16 weights are around 60 GB and need about 72 GB of VRAM to serve; the published quantized builds are 17 to 20 GB. [Get the model](https://dev.meta.ai/docs/muse-glimmer/get-the-model) lists every artifact.

> **NOTE: Stream reasoning workloads**
>
> Muse Glimmer produces long chain-of-thought reasoning by default. For reasoning workloads, request streaming (`stream: true`) so long generations don't hit request timeouts, and give `max_tokens` enough headroom for the reasoning trace plus the final answer. See [prompting](https://dev.meta.ai/docs/muse-glimmer/prompting#reasoning).

## Self-host {#self-host}

Each tab is a quick start for one runtime. Each runtime's section below covers installation, checkpoint variants, starting a server, and sending requests.

**vLLM**

```bash
docker run --rm --gpus all --ipc=host \
  -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai:muse-glimmer \
  meta-models/Muse-Glimmer-30B \
  --served-model-name muse-glimmer \
  --tensor-parallel-size 1 \
  --enable-auto-tool-choice \
  --tool-call-parser muse_glimmer \
  --reasoning-parser muse_glimmer \
  --generation-config auto
```

**SGLang**

```bash
sglang serve \
  --model-path meta-models/Muse-Glimmer-30B \
  --served-model-name muse-glimmer \
  --reasoning-parser muse \
  --tool-call-parser muse \
  --mem-fraction-static 0.85 \
  --host 0.0.0.0 --port 30000
```

**llama.cpp**

```bash
llama serve -hf meta-models/Muse-Glimmer-30B-GGUF \
  --hf-file Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf \
  -a muse-glimmer \
  -ngl 99 -c 131072 -np 1 \
  --host 127.0.0.1 --port 8080 --api-key <your-key> \
  --chat-template-kwargs '{"reasoning_strength":"low"}'
```

**ExecuTorch**

```bash
python -m executorch.examples.models.muse_glimmer.serving.serve \
  --model-path exports/solo/model.pte \
  --data-path exports/solo/aoti_cuda_blob.ptd \
  --tokenizer-path assets/hf/tokenizer.json \
  --hf-tokenizer assets/hf \
  --worker-bin cmake-out/examples/models/muse-glimmer/muse_glimmer_worker \
  --model-id muse-glimmer-30B \
  --tool-parser atem \
  --host 127.0.0.1 --port 8000
```

**Transformers**

```bash
pip install "transformers>=5.15" accelerate torch
```

**Ollama**

```bash
ollama run muse-glimmer
```

**LM Studio**

```bash
lms server start
```

**Unsloth**

```bash
unsloth studio -p 8888
```

The vLLM and SGLang tabs serve the bf16 checkpoint, and the llama.cpp tab serves the 17 GB GGUF with the vision projector. Each runtime's section below has the other variants.

### vLLM {#vllm}

Serve Muse Glimmer with [vLLM](https://recipes.vllm.ai/meta-models/Muse-Glimmer-30B) for high-throughput, low-latency inference with an OpenAI-compatible API endpoint. vLLM provides continuous batching, PagedAttention, and tensor parallelism.

> **IMPORTANT: The vLLM recipe is the source of truth**
>
> The [official vLLM Muse Glimmer recipe](https://recipes.vllm.ai/meta-models/Muse-Glimmer-30B) is the source of truth for the image tag, flags, and hardware requirements. vLLM moves faster than these docs: check the recipe first when a command here doesn't match what you see.

#### Prerequisites {#vllm-prerequisites}

- Docker with the NVIDIA container runtime
- An NVIDIA GPU with drivers for CUDA 13.0, which is what the image is pinned to
- 72 GB of VRAM to serve, on one card or across several

#### Install {#vllm-install}

Docker is the supported path:

**bash**

```bash
docker pull vllm/vllm-openai:muse-glimmer
```

The image is roughly 10.5 GB and publishes `linux/amd64` and `linux/arm64`. There's no published ROCm image.

What the image gives you:

| Capability                            | How you get it                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Text model (`MuseGlimmerForCausalLM`) | Automatic, with no `trust_remote_code`                                            |
| Tool-call parser                      | `--tool-call-parser muse_glimmer`                                                 |
| Reasoning parser                      | `--reasoning-parser muse_glimmer`                                                 |
| Chat template                         | Ships with the checkpoint as `chat_template.jinja`. Don't pass `--chat-template`. |
| Model config                          | Automatic (`muse-glimmer`, `muse_glimmer_text`, `muse_glimmer_vision`)            |

Parser names use underscores. vLLM matches `muse_glimmer` literally, so the hyphenated spelling fails. `--served-model-name muse-glimmer` is a label you choose, and it stays hyphenated.

#### Start the server {#vllm-start-the-server}

The image sets `ENTRYPOINT ["vllm", "serve"]`, so everything after the image name is appended to that. Pass the model and flags directly rather than retyping `vllm serve` or calling `python -m vllm.entrypoints.openai.api_server`.

**bash**

```bash
docker run --rm --gpus all --ipc=host \
  -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai:muse-glimmer \
  meta-models/Muse-Glimmer-30B \
  --served-model-name muse-glimmer \
  --tensor-parallel-size 1 \
  --enable-auto-tool-choice \
  --tool-call-parser muse_glimmer \
  --reasoning-parser muse_glimmer \
  --generation-config auto
```

The flags from `--served-model-name` down are the recipe's argument list for a single card. The `docker run` wrapper around them is standard vLLM boilerplate, so adjust it to your host. Mounting `~/.cache/huggingface` is what stops the container from re-downloading roughly 60 GB of weights on every start.

To serve weights you've already downloaded, mount them and pass the path instead of a Hub ID:

**bash**

```bash
docker run --rm --gpus all --ipc=host \
  -p 8000:8000 \
  -v /path/to/Muse-Glimmer-30B:/model \
  vllm/vllm-openai:muse-glimmer \
  /model \
  --served-model-name muse-glimmer \
  --tensor-parallel-size 1 \
  --enable-auto-tool-choice \
  --tool-call-parser muse_glimmer \
  --reasoning-parser muse_glimmer \
  --generation-config auto
```

To serve across multiple GPUs, raise the tensor-parallel size:

**bash**

```bash
docker run --rm --gpus all --ipc=host \
  -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai:muse-glimmer \
  meta-models/Muse-Glimmer-30B \
  --served-model-name muse-glimmer \
  --tensor-parallel-size 2 \
  --enable-auto-tool-choice \
  --tool-call-parser muse_glimmer \
  --reasoning-parser muse_glimmer \
  --generation-config auto
```

For tighter memory, at a cost in throughput and context:

**bash**

```bash
docker run --rm --gpus all --ipc=host \
  -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai:muse-glimmer \
  meta-models/Muse-Glimmer-30B \
  --served-model-name muse-glimmer \
  --gpu-memory-utilization 0.9 --max-model-len 8300 --enforce-eager \
  --enable-auto-tool-choice \
  --tool-call-parser muse_glimmer \
  --reasoning-parser muse_glimmer \
  --generation-config auto
```

> **NOTE: Budget 72 GB of VRAM**
>
> That is what the recipe asks for: the bf16 weights are roughly 60 GB, and the rest goes to KV cache, activations, and CUDA overhead. Sizing to the weights alone is the usual way to run out of memory shortly after startup.

The flags that carry Muse Glimmer-specific behavior:

| Flag                               | Why                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `--served-model-name muse-glimmer` | The name the API answers to. Every example here sends `"model": "muse-glimmer"`.       |
| `--enable-auto-tool-choice`        | Lets the model decide when to call a tool.                                             |
| `--tool-call-parser muse_glimmer`  | Converts native ATEM output into standard OpenAI `tool_calls`.                         |
| `--reasoning-parser muse_glimmer`  | Routes the thinking channel to `message.reasoning` instead of leaking it into content. |
| `--generation-config auto`         | Picks up the checkpoint's published sampling settings and stop tokens.                 |
| `--tensor-parallel-size N`         | Number of GPUs for tensor parallelism.                                                 |
| `--max-model-len N`                | Caps the sequence length to limit KV-cache memory.                                     |

#### Sampling {#vllm-sampling}

Serve with `--generation-config auto`, as every command above does, and vLLM picks up the checkpoint's published sampling settings: temperature 1.0, top\_p 0.95, and top\_k 64.

> **WARNING: Don't run greedy**
>
> Don't run this model greedy. Sending `"temperature": 0` overrides the published settings, and the recipe advises against it. If you set sampling per request, carry all three values rather than a bare temperature.

#### Send a request {#vllm-send-a-request}

The server exposes an OpenAI-compatible chat completions endpoint:

**curl**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-glimmer",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Write a Python function to compute Fibonacci numbers."}
    ],
    "max_tokens": 2048,
    "stream": true
  }'
```

**Python**

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="unused")

stream = client.chat.completions.create(
    model="muse-glimmer",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Write a Python function to compute Fibonacci numbers."},
    ],
    max_tokens=2048,
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

Neither request sets sampling parameters, so the server applies the published settings from `--generation-config auto`.

#### Verify tool calling {#vllm-tool-calling}

**curl**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-glimmer",
    "messages": [
      {"role": "user", "content": "What is the weather in Paris in celsius? Use the tool."}
    ],
    "tools": [{"type": "function", "function": {
      "name": "get_weather",
      "description": "Get current weather for a city.",
      "parameters": {"type": "object", "properties": {
        "city": {"type": "string"},
        "units": {"type": "string", "enum": ["celsius", "fahrenheit"]}},
        "required": ["city"]}}}],
    "tool_choice": "auto"
  }'
```

You get back `get_weather(city="Paris", units="celsius")`, with the reasoning under `message.reasoning`, or `delta.reasoning` when streaming. Parsing happens server-side, so an OpenAI-compatible harness needs no [ATEM](https://dev.meta.ai/docs/muse-glimmer/prompting#tool-calling)-specific handling.

#### Stop tokens {#vllm-stop-tokens}

Muse Glimmer needs `eos_token_id = [200001, 200008]`, which is `<|end_of_text|>` and `<|eot|>`. Serving with `--generation-config auto` picks these up from the checkpoint.

> **WARNING: Never stop on the eom token**
>
> Never stop on `<|eom|>` (200007). It ends a message while the turn continues, and it separates the reasoning block from the tool call, so stopping on it truncates the turn. Set this in the checkpoint's `generation_config.json`.

These token IDs come from the converted checkpoint. Confirm them against your checkpoint's `tokenizer_config.json`, since older exports can differ. See [special tokens](https://dev.meta.ai/docs/muse-glimmer/prompting#special-tokens) for the full chat-format token set.

#### Troubleshooting {#vllm-troubleshooting}

| Symptom                             | Cause                                                              | Fix                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `invalid tool call parser`          | Hyphenated parser name                                             | Use underscores: `muse_glimmer`.                                                                                          |
| Tool calls returned as plain text   | Parser not enabled                                                 | Pass `--tool-call-parser muse_glimmer`. The chat template comes from the checkpoint.                                      |
| Generation never stops              | Wrong stop tokens                                                  | See [Stop tokens](https://dev.meta.ai/docs/muse-glimmer/deploy#vllm-stop-tokens). Never stop on the end-of-message token. |
| Reasoning leaking into content      | No reasoning parser                                                | Pass `--reasoning-parser muse_glimmer`, which routes reasoning to `message.reasoning`.                                    |
| Flat, repetitive answers            | Running greedy                                                     | Drop `"temperature": 0` and use the published settings.                                                                   |
| Out of memory shortly after startup | Sized to the 60 GB weights rather than the 72 GB serving footprint | Lower `--max-model-len`, raise `--tensor-parallel-size`, or serve a quantized checkpoint.                                 |

### SGLang {#sglang}

Serve Muse Glimmer with [SGLang](https://docs.sglang.io/cookbook/autoregressive/Meta/MuseGlimmer) for high-throughput inference behind an OpenAI-compatible endpoint.

#### Install {#sglang-install}

Install SGLang from source:

**bash**

```bash
pip install --upgrade pip
pip install uv
git clone https://github.com/sgl-project/sglang.git
cd sglang
uv pip install -e python
```

A prebuilt image is the alternative:

**bash**

```bash
docker pull lmsysorg/sglang:dev-muse-glimmer
```

The tag is multi-arch and resolves to amd64 or arm64, so it also covers aarch64 machines such as DGX Spark. `dev-muse-glimmer-amd64` and `dev-muse-glimmer-arm64` pin one architecture. See the [upstream install guide](https://docs.sglang.io/docs/get-started/install) for platform variations.

#### Choose a checkpoint {#sglang-checkpoints}

SGLang serves four checkpoint formats. Your GPU decides which one you use:

| Format          | Checkpoint                                                            | Modality       | Hardware SGLang lists                             |
| --------------- | --------------------------------------------------------------------- | -------------- | ------------------------------------------------- |
| bf16            | `meta-models/Muse-Glimmer-30B`                                        | Text and image | B300, B200, H200, RTX PRO 6000 (96 GB), DGX Spark |
| GGUF Q4\_K\_M   | `meta-models/Muse-Glimmer-30B-GGUF`                                   | Text only      | B300, RTX 5090 (32 GB)                            |
| NVFP4 and MXFP8 | `RadixArk/Muse-Glimmer-NVFP4`                                         | Text only      | B300, B200, RTX 5090, RTX PRO 6000, DGX Spark     |
| MLX Q4 variants | `RadixArk/Muse-Glimmer-q4km-gs128-MLX`, `-q4-MLX`, `-q4k-dynamic-MLX` | Text only      | Apple silicon, 48 GB or more of unified memory    |

The bf16 checkpoint is the only one that takes images. NVFP4 serves with no conversion step.

SGLang's team verified these platforms, each on a single accelerator:

| Platform            | Class       | Accelerator            | Memory         | Precisions verified       | Verified   |
| ------------------- | ----------- | ---------------------- | -------------- | ------------------------- | ---------- |
| NVIDIA B300         | Server      | B300 SXM6 × 1          | 288 GB HBM3e   | bf16, nvfp4, q4\_k\_m     | 2026-08-10 |
| NVIDIA B200         | Server      | B200 × 1               | 192 GB HBM3e   | bf16, nvfp4               | 2026-08-09 |
| NVIDIA H200         | Server      | H200 SXM × 1           | 141 GB HBM3e   | bf16                      | 2026-08-09 |
| NVIDIA RTX PRO 6000 | Workstation | RTX PRO 6000 × 1       | 96 GB GDDR7    | bf16, nvfp4               | 2026-08-09 |
| NVIDIA DGX Spark    | Workstation | GB10 × 1               | 128 GB unified | bf16, nvfp4               | 2026-08-09 |
| NVIDIA RTX 5090     | Consumer    | RTX 5090 × 1           | 32 GB GDDR7    | q4\_k\_m, nvfp4           | 2026-08-09 |
| Apple silicon Mac   | Consumer    | M5 Pro (48 GB minimum) | 64 GB unified  | q4\_k\_m, q4, q4k-dynamic | 2026-08-09 |

SGLang publishes throughput and interactivity figures for each platform in the [official guide](https://docs.sglang.io/cookbook/autoregressive/Meta/MuseGlimmer). Measure your own with:

**bash**

```bash
python3 -m sglang.bench_serving \
  --backend sglang --host localhost --port 30000 \
  --model meta-models/Muse-Glimmer-30B \
  --dataset-name random --random-input-len 1024 --random-output-len 512 \
  --num-prompts 128 --max-concurrency 64 --flush-cache
```

#### Start the server {#sglang-start-the-server}

**bf16 · text and image**

```bash
sglang serve \
  --model-path meta-models/Muse-Glimmer-30B \
  --served-model-name muse-glimmer \
  --reasoning-parser muse \
  --tool-call-parser muse \
  --mem-fraction-static 0.85 \
  --host 0.0.0.0 --port 30000
```

**GGUF Q4\_K\_M · 32 GB cards**

```bash
sglang serve \
  --model-path meta-models/Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf \
  --served-model-name muse-glimmer \
  --reasoning-parser muse \
  --tool-call-parser muse \
  --mem-fraction-static 0.85 \
  --host 0.0.0.0 --port 30000
```

**NVFP4**

```bash
sglang serve \
  --model-path RadixArk/Muse-Glimmer-NVFP4 \
  --served-model-name muse-glimmer \
  --reasoning-parser muse \
  --tool-call-parser muse \
  --language-model-only \
  --kv-cache-dtype fp8_e4m3 \
  --mem-fraction-static 0.85 \
  --host 0.0.0.0 --port 30000
```

**MLX · Apple silicon**

```bash
SGLANG_USE_MLX=1 SGLANG_MLX_CACHE_LIMIT_GB=8 \
sglang serve \
  --model-path RadixArk/Muse-Glimmer-q4km-gs128-MLX \
  --served-model-name muse-glimmer \
  --trust-remote-code \
  --reasoning-parser muse \
  --tool-call-parser muse \
  --disable-radix-cache \
  --mem-fraction-static 0.85 \
  --host 0.0.0.0 --port 30000
```

`python -m sglang.launch_server` with the same flags is the equivalent long form.

**GGUF.** `--model-path` points at the file, not the repository. It's the same 17 GB file that [llama.cpp](https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp) serves. The path is text only, because SGLang has no `mmproj` support, and SGLang warns at startup that the path isn't optimized. Don't add `--language-model-only`: the GGUF config is already text-only, and SGLang rejects the command.

**NVFP4.** `--language-model-only` is required. The NVFP4 checkpoint ships no vision weights, and without the flag the loader tries to build them and the engine fails to start. On 32 GB cards, `--kv-cache-dtype fp8_e4m3` roughly doubles the KV pool: SGLang measured 57K to 115K tokens on an RTX 5090. SGLang doesn't list NVFP4 for H200.

**MLX.** Apple silicon uses MLX repacks, because the MLX backend has no GGUF path. The two extra settings are requirements: the sliding-window layers need the radix cache off, and `SGLANG_MLX_CACHE_LIMIT_GB=8` stops the MLX buffer cache from growing the memory footprint under concurrent load. The three MLX artifacts are drop-in `--model-path` swaps. `q4km-gs128` carries the same Q4\_K\_M codes as the GGUF and is SGLang's default, `q4` is the fastest, and `q4k-dynamic` has the highest fidelity. The MLX backend is text only and has no speculative decoding.

| Flag                               | Why                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--reasoning-parser muse`          | Splits the thinking channel into `message.reasoning_content`.                                                                                             |
| `--tool-call-parser muse`          | Emits structured `message.tool_calls`.                                                                                                                    |
| `--served-model-name muse-glimmer` | The name the API answers to. Without it, SGLang serves under the full `--model-path` value, and requests that send `"model": "muse-glimmer"` don't match. |
| `--mem-fraction-static`            | Fraction of VRAM reserved for weights and KV cache. See [Memory and parallelism](https://dev.meta.ai/docs/muse-glimmer/deploy#sglang-memory).             |
| `--kv-cache-dtype fp8_e4m3`        | Paired with NVFP4 in every published NVFP4 command.                                                                                                       |
| `--language-model-only`            | Skips the vision tower. Required on NVFP4. Optional on bf16, where it frees memory for KV cache and makes image requests fail. Rejected on GGUF.          |

Pass both parser flags explicitly. SGLang's parser name for both is `muse`.

#### Memory and parallelism {#sglang-memory}

SGLang sets `--mem-fraction-static` per machine:

| Hardware                       | bf16       | NVFP4      |
| ------------------------------ | ---------- | ---------- |
| B300, B200, H200, RTX PRO 6000 | 0.85       | 0.85       |
| RTX 5090                       | GGUF: 0.85 | 0.90       |
| DGX Spark                      | 0.75       | 0.40       |
| Apple silicon                  | MLX: 0.85  | Not listed |

Lower it if the server runs out of memory during startup, and raise it for more KV cache. DFlash speculative decoding needs room for the draft model, so SGLang lowers the fraction further on DGX Spark: 0.65 for bf16 and 0.38 for NVFP4.

> **WARNING: Use the DGX Spark values on DGX Spark**
>
> Use the lower fractions above on DGX Spark. Its 128 GB is unified memory shared with the OS and your clients, so a discrete-GPU value around 0.85 runs the whole machine out of memory during load.

Every combination SGLang verified runs on a single accelerator with no tensor parallelism. Muse Glimmer fits on one card in each of these formats, so treat multi-GPU serving as untested.

#### Speculative decoding {#sglang-spec-decode}

The DFlash draft model `meta-models/Muse-Glimmer-30B-assistant` serves as published. Add:

**bash**

```bash
  --speculative-algorithm DFLASH \
  --speculative-draft-model-path meta-models/Muse-Glimmer-30B-assistant \
  --speculative-dflash-block-size 5
```

Two targets need one more flag each:

- **GGUF target:** add `--speculative-draft-load-format auto`. Without it, the draft inherits the target's `gguf` load format and the loader rejects the draft directory.
- **NVFP4 target:** add `--speculative-draft-model-quantization fp8`.

SGLang also verified the GGUF draft, `dflash-Muse-Glimmer-30B-Q4_K_M.gguf`, on B300. Pass `--speculative-draft-model-quantization gguf` with it. Otherwise the draft is built unquantized from random weights: nothing errors, speculation runs, and the accept length stays at 1.0 with no speedup.

See [Speculative decoding](https://dev.meta.ai/docs/muse-glimmer/spec-decode) for how DFlash works.

#### Verify the server {#sglang-verify}

SGLang exposes an OpenAI-compatible endpoint on port 30000:

**curl**

```bash
curl http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-glimmer",
    "messages": [
      {"role": "user", "content": "What is the capital of France?"}
    ],
    "max_tokens": 512
  }'
```

Reasoning comes back under `message.reasoning_content`. Check tool calling with:

**curl**

```bash
curl -s http://localhost:30000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"muse-glimmer","messages":[{"role":"user","content":"What is the weather in Paris in celsius? Use the tool."}],
       "tools":[{"type":"function","function":{
         "name":"get_weather","description":"Get current weather for a city.",
         "parameters":{"type":"object","properties":{
           "city":{"type":"string"},"units":{"type":"string","enum":["celsius","fahrenheit"]}},
           "required":["city"]}}}],
       "tool_choice":"auto","temperature":1}'
```

A working parser returns a `tool_calls` array with `get_weather(city="Paris", units="celsius")` and the thinking under `reasoning_content`. Parsing happens server-side, so an OpenAI-compatible harness needs no [ATEM](https://dev.meta.ai/docs/muse-glimmer/prompting#tool-calling)-specific handling.

#### Stop tokens {#sglang-stop-tokens}

Muse Glimmer needs `eos_token_id = [<|end_of_text|>, <|eot|>]`. Never stop on `<|eom|>`, which ends a message while the turn continues. See [special tokens](https://dev.meta.ai/docs/muse-glimmer/prompting#special-tokens).

There's no serve flag for this. SGLang builds its stop set at load time by unioning `eos_token_id` from the checkpoint's `config.json` and its `generation_config.json`, so the checkpoint metadata is where you set it. Because it's a union, a request can add IDs through `stop_token_ids` but can't remove them.

#### Troubleshooting {#sglang-troubleshooting}

| Symptom                                          | Cause                                                                | Fix                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Requests return 404 or an unknown model          | The served name doesn't match what the client sends                  | Check `/v1/models` and pass `--served-model-name muse-glimmer`.                                     |
| Image requests are rejected                      | Only bf16 takes images, and only without `--language-model-only`     | Serve bf16 without the flag. GGUF, NVFP4, and MLX are text only.                                    |
| The draft model fails to load with a GGUF target | The draft inherits the target's `gguf` load format                   | Add `--speculative-draft-load-format auto`.                                                         |
| Speculation runs but accept length stays at 1.0  | The GGUF draft was built unquantized                                 | Add `--speculative-draft-model-quantization gguf`.                                                  |
| The NVFP4 engine fails to start                  | The loader tries to build vision weights the checkpoint doesn't have | Add `--language-model-only`.                                                                        |
| The GGUF serve rejects `--language-model-only`   | GGUF is already text only                                            | Drop the flag.                                                                                      |
| Out of memory at startup                         | `--mem-fraction-static` too high                                     | Lower it. See [Memory and parallelism](https://dev.meta.ai/docs/muse-glimmer/deploy#sglang-memory). |
| The whole machine runs out of memory during load | DGX Spark with a discrete-GPU fraction                               | Use the DGX Spark values.                                                                           |

### llama.cpp {#llama-cpp}

Run Muse Glimmer on your machine with [llama.cpp](https://github.com/ggml-org/llama.cpp), a C/C++ inference engine that supports CPU, mixed CPU/GPU, and full GPU execution. It's portable across CPU, Metal, CUDA, ROCm, and Vulkan, and it serves the published GGUF checkpoints with no conversion or quantization step.

> **IMPORTANT: Upstream is the source of truth**
>
> [`ggml-org/llama.cpp`](https://github.com/ggml-org/llama.cpp) is the source of truth for builds, flags, and releases. Muse Glimmer support landed in commit [`62bf73d25`](https://github.com/ggml-org/llama.cpp/commit/62bf73d25) ("model: Muse Glimmer Support", PR #26841), which adds the `muse-glimmer` architecture, the vision projector, the ATEM tool-call parser, and DFlash speculative decoding. Check upstream first when a command here doesn't match what you see.

#### Get llama.cpp {#llama-cpp-get-llama-cpp}

Install the [Llama app](https://llama.app/) from the llama.cpp team on macOS or Windows. On Linux, install the command-line version:

**bash**

```bash
curl -LsSf https://llama.app/install.sh | sh
```

Muse Glimmer needs llama.cpp `b10353` or newer. Older builds refuse to load the checkpoints with `unknown model architecture: 'muse-glimmer'`. To build from source instead, follow upstream's [build guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md).

#### Choose a checkpoint {#llama-cpp-download-checkpoints}

`llama serve -hf` downloads and caches the checkpoint from [`meta-models/Muse-Glimmer-30B-GGUF`](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF). Name the text model with `--hf-file`:

| File                                           | What                                             | Size     |
| ---------------------------------------------- | ------------------------------------------------ | -------- |
| `Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf`     | Text model, K-quant. Use this one.               | \~17 GB  |
| `Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf` | Text model, dynamic K-quant                      | \~20 GB  |
| `mmproj-Muse-Glimmer-30B-Q4_K_M.gguf`          | Vision projector, downloaded with the text model | \~1.4 GB |
| `dflash-Muse-Glimmer-30B-Q4_K_M.gguf`          | Speculative-decoding draft model, optional       | \~1.6 GB |

Full-precision weights aren't published as GGUF. For bf16, use the safetensors checkpoint at [`meta-models/Muse-Glimmer-30B`](https://huggingface.co/meta-models/Muse-Glimmer-30B) with [vLLM](https://dev.meta.ai/docs/muse-glimmer/deploy#vllm).

#### Start the server {#llama-cpp-server}

Muse Glimmer supports a native context of 131,072 tokens:

**bash**

```bash
llama serve -hf meta-models/Muse-Glimmer-30B-GGUF \
  --hf-file Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf \
  -a muse-glimmer \
  -ngl 99 -c 131072 -np 1 \
  --host 127.0.0.1 --port 8080 --api-key <your-key> \
  --chat-template-kwargs '{"reasoning_strength":"low"}'
```

The server prints the context size it allocated:

```
srv load_model: initializing, n_slots = 1, n_ctx_slot = 131072, kv_unified = 'false'
```

If it instead reports `exceeds the training context ... - capping`, the GGUF's `context_length` metadata is stale and the server clamps the slot to it. No serve flag overrides this. Fix the metadata with the script in the llama.cpp repository, where `muse-glimmer` is the architecture name llama.cpp registers and so is the key prefix:

**bash**

```bash
python gguf-py/gguf/scripts/gguf_set_metadata.py <model>.gguf muse-glimmer.context_length 131072
```

| Flag                     | Why                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-a muse-glimmer`        | The name the API answers to. Without it the alias is the checkpoint path, and the `"model": "muse-glimmer"` every example here sends won't match.                                                                                               |
| `--chat-template-kwargs` | Sets `reasoning_strength`. Template default is `high`.                                                                                                                                                                                          |
| `-np N`                  | Concurrent slots, and the context is divided N ways: `-np 4` with `-c 131072` gives each slot 32,768 tokens. Long-context agents want `-np 1`. See [Context per slot](https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp-context-per-slot). |
| `-ngl 99`                | Offload all layers to the GPU.                                                                                                                                                                                                                  |
| `--api-key`              | Guards inference endpoints only. `/health` and `/v1/models` still answer without it.                                                                                                                                                            |

Thinking lands in `message.reasoning_content` and `message.content` stays clean. That's the server default, with no flag needed. Pass `--reasoning-format none` to keep thinking inline in `message.content` instead.

The vision projector downloads with the text model, so image input needs no extra flag. Pass `--no-mmproj` for text-only. For speculative decoding, download `dflash-Muse-Glimmer-30B-Q4_K_M.gguf` from the same repository and add `-md dflash-Muse-Glimmer-30B-Q4_K_M.gguf --spec-type draft-dflash -ngld 99 --spec-draft-n-max 4`. A `[spec] failed to measure draft model memory` warning at startup is harmless, and the draft loads and serves normally after it.

> **NOTE: Don't override the chat template**
>
> Don't pass `--chat-template-file`. Upstream ships no Muse Glimmer template under `models/templates/`, and none is needed: llama.cpp uses the template embedded in the GGUF, which is byte-for-byte identical to the `chat_template.jinja` published with the safetensors checkpoint. llama.cpp selects the ATEM tool-call parser by detecting that template, so tool calling works with no extra flags.

Smoke test, where `--noproxy` bypasses a proxy that would intercept loopback:

**curl**

```bash
curl -s --noproxy '*' http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <your-key>" \
  -d '{"model":"muse-glimmer","messages":[{"role":"user","content":"What is 17 * 23?"}]}'
```

#### Context per slot {#llama-cpp-context-per-slot}

`n_ctx_slot` in the startup log, not `-c`, is what bounds a single generation. Getting this wrong fails quietly: a generation that runs out of room produces no answer and no error, so a batch job or an eval reports a worse number and gives you nothing to debug.

Muse Glimmer reasons at length: a single generation can approach a 32,768-token slot on its own. To keep concurrency without shrinking the slot, scale `-c` with `-np`:

**bash**

```bash
  -c 524288 -np 4        # 131072 per slot, still 4-way concurrent
```

KV cache stays affordable at that size: GQA with 2 KV heads, and sliding-window attention on three of every four layers.

#### Control reasoning length {#llama-cpp-reasoning-length}

The chat template reads `reasoning_strength` and defaults to `high`:

**jinja**

```jinja
{%- set rs = reasoning_strength if reasoning_strength is defined and reasoning_strength else 'high' -%}
```

Set it server-wide with `--chat-template-kwargs`, or per request:

**JSON**

```json
{"model":"muse-glimmer","messages":[],"chat_template_kwargs":{"reasoning_strength":"low"}}
```

The model card documents four levels: `low`, `medium`, `high`, and `xhigh`. Lower isn't automatically worse: where the environment validates the answer or the caller can retry cheaply, extra reasoning adds little. Reasoning tokens count against `max_tokens`, and a request that hits the ceiling mid-thought returns empty `content` with `finish_reason: "length"`.

> **NOTE: Use reasoning\_strength, not reasoning\_effort**
>
> `reasoning_effort`, the OpenAI spelling, is not implemented by llama.cpp. Use `chat_template_kwargs.reasoning_strength`, which is the same control the [prompting guide](https://dev.meta.ai/docs/muse-glimmer/prompting#reasoning) documents.

Reasoning can't be turned off here. The template opens the thinking channel unconditionally, so `--reasoning off` and `"reasoning_effort": "none"` both leave the output unchanged. `reasoning_strength: low` is how you spend fewer thinking tokens, and `--reasoning-budget N` is how you hard-cap them.

#### Vision {#llama-cpp-vision}

Send a remote URL, a `data:image/...;base64,...` URI, or a local path:

**curl**

```bash
curl -s --noproxy '*' http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <your-key>" \
  -d '{"model":"muse-glimmer","messages":[{"role":"user","content":[
        {"type":"text","text":"What is in this image?"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}
      ]}]}'
```

Images count as prompt tokens, scaling with resolution.

#### Command line, without the server {#llama-cpp-cli}

`llama cli` runs the model in the terminal:

**bash**

```bash
llama cli -hf meta-models/Muse-Glimmer-30B-GGUF \
  --hf-file Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf \
  -ngl 99 -c 32768 -st
```

`-st` (`--single-turn`) answers once and exits. Without it, `llama cli` stays interactive and waits on stdin, which reads as a hang.

`llama cli` prints the thinking trace inline with the answer. `--reasoning-format` only applies to the server's JSON response, so use `llama serve` when you want `content` and `reasoning_content` apart.

#### Verify tool calling {#llama-cpp-tool-calling}

**curl**

```bash
curl -s --noproxy '*' http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <your-key>" \
  -d '{"model":"muse-glimmer","messages":[{"role":"user","content":"What is the weather in Paris in celsius? Use the tool."}],
       "tools":[{"type":"function","function":{
         "name":"get_weather","description":"Get current weather for a city.",
         "parameters":{"type":"object","properties":{
           "city":{"type":"string"},"units":{"type":"string","enum":["celsius","fahrenheit"]}},
           "required":["city"]}}}],
       "tool_choice":"auto"}'
```

Returns `finish_reason: "tool_calls"` and a `tool_calls` array with `get_weather(city="Paris", units="celsius")`, with reasoning under `reasoning_content`. Parsing is server-side, so any OpenAI-compatible harness needs no [ATEM](https://dev.meta.ai/docs/muse-glimmer/prompting#tool-calling)-specific handling.

#### Stop tokens {#llama-cpp-stop-tokens}

Muse Glimmer needs `eos_token_id = [<|end_of_text|>, <|eot|>]`. Never stop on `<|eom|>`. The template embedded in the GGUF handles this. See [special tokens](https://dev.meta.ai/docs/muse-glimmer/prompting#special-tokens).

### ExecuTorch {#executorch}

Serve Muse Glimmer on your own CUDA GPU or Apple silicon with [ExecuTorch](https://github.com/pytorch/executorch), behind an OpenAI-compatible HTTP endpoint that supports vision, tool calling, and DFlash speculative decoding. ExecuTorch is ahead-of-time: you export the model once into a `.pte` program for a specific backend, then serve from that program.

With ExecuTorch, you write the model and its decoding strategy once in PyTorch, including Muse Glimmer's multimodal input and block-diffusion speculative decoding. `torch.export` then lowers the whole graph ahead of time: to Triton on CUDA, and to MLX-native or custom Metal kernels on Apple silicon.

| Backend | Host                   | Artifacts written by a local export   |
| ------- | ---------------------- | ------------------------------------- |
| CUDA    | Linux or Windows       | `model.pte` plus `aoti_cuda_blob.ptd` |
| MLX     | macOS on Apple silicon | Self-contained `model.pte`            |

Prebuilt exports are published as well, under [different filenames](https://dev.meta.ai/docs/muse-glimmer/deploy#executorch-prebuilt-export), so exporting a 30B model yourself is optional.

> **IMPORTANT: No CPU export; use llama.cpp**
>
> Use [llama.cpp](https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp) on a CPU-only machine. ExecuTorch doesn't support CPU export for Muse Glimmer.

#### Prerequisites {#executorch-prerequisites}

- An ExecuTorch checkout built from source per the [upstream guide](https://github.com/pytorch/executorch), including `examples/models/muse-glimmer`
- The server dependencies: `pip install -r examples/llm_server/python/requirements.txt`
- The Hugging Face CLI (`pip install huggingface_hub`)
- A CUDA GPU for the CUDA backend, or Apple silicon for the MLX backend

Run every command below from the ExecuTorch repository root.

#### Download the model assets {#executorch-download-assets}

Exports lower directly from the quantized GGUF checkpoints, the same files [llama.cpp](https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp) uses. The serving path also needs the tokenizer metadata from the main model repository:

**bash**

```bash
hf download meta-models/Muse-Glimmer-30B-GGUF --local-dir assets/quant \
  --include 'Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf' \
  --include 'dflash-Muse-Glimmer-30B-Q4_K_M.gguf' \
  --include 'mmproj-Muse-Glimmer-30B-Q4_K_M.gguf'

hf download meta-models/Muse-Glimmer-30B \
  tokenizer.json chat_template.jinja config.json processor_config.json \
  --local-dir assets/hf
```

Keep `chat_template.jinja` beside the rest of the tokenizer metadata: the serving path renders prompts and tool definitions with it.

Set the paths used by the commands that follow:

**bash**

```bash
TARGET=assets/quant/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf
DRAFT=assets/quant/dflash-Muse-Glimmer-30B-Q4_K_M.gguf
MMPROJ=assets/quant/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf
BACKEND=cuda   # mlx on macOS
```

#### Export the model {#executorch-export}

`$BACKEND` selects the target: `cuda` or `mlx`. A CUDA export autotunes Triton kernels against the GPU it runs on, so export on the same architecture you intend to serve from.

##### Target-only export

For text inference:

**bash**

```bash
python -m executorch.examples.models.muse_glimmer.export.export_solo \
  --gguf "$TARGET" \
  --backend "$BACKEND" \
  --output-dir exports/solo
```

##### DFlash export

DFlash speculative decoding lowers the target and the draft together, into their own export directory:

**bash**

```bash
python -m executorch.examples.models.muse_glimmer.export.export_dflash \
  --target-gguf "$TARGET" \
  --draft-gguf "$DRAFT" \
  --backend "$BACKEND" \
  --output-dir exports/dflash
```

Both land in one `.pte`: the draft shares the target's token embeddings and output head rather than carrying copies. The block dimension is exported dynamically, so you select block length at serve time. The exported range is backend-specific: `[2, 16]` on MLX and `[2, 4]` on CUDA, where the draft count is also capped at 3.

##### Vision exports

Add `--mmproj "$MMPROJ"` to either export command for text and image inference. A vision export also writes `pos_embed.bin` beside `model.pte`.

#### Download a prebuilt export {#executorch-prebuilt-export}

[`meta-models/Muse-Glimmer-30B-ExecuTorch-PTE`](https://huggingface.co/meta-models/Muse-Glimmer-30B-ExecuTorch-PTE) publishes 16 ready-made exports, so you can skip the export step. You still [build the runner](https://dev.meta.ai/docs/muse-glimmer/deploy#executorch-build-runner): a `.pte` is a model program, not a runtime.

> **WARNING: Download one export, not all**
>
> Download a single directory with `--include` rather than the whole repository. The repository is 372 GB, and one export is 18–31 GB.

Directories are named `muse-glimmer-<quantization>-128K-<modality>-<decoding>-<backend>`, and all 16 combinations of the four axes exist:

- **Quantization**: `k-quant-17G` targets 24 GB of VRAM. `k-quant-dynamic` targets 32 GB with less degradation, and the [model card](https://huggingface.co/meta-models/Muse-Glimmer-30B-ExecuTorch-PTE) quantifies the tradeoff.
- **Modality**: `text`, or `text-image` for vision.
- **Decoding**: `solo`, or `dflash` for speculative decoding.
- **Backend**: `metal` for Apple silicon, `sm80+ptx` for CUDA on SM80 and newer.

Context length is `128K` for every variant. Sizes, by directory:

| Quantization      | Modality     | Decoding | `…-metal` | `…-sm80+ptx` |
| ----------------- | ------------ | -------- | --------- | ------------ |
| `k-quant-17G`     | `text`       | `solo`   | 17.9 GB   | 19.8 GB      |
| `k-quant-17G`     | `text`       | `dflash` | 19.6 GB   | 27.2 GB      |
| `k-quant-17G`     | `text-image` | `solo`   | 19.4 GB   | 21.2 GB      |
| `k-quant-17G`     | `text-image` | `dflash` | 21.1 GB   | 28.6 GB      |
| `k-quant-dynamic` | `text`       | `solo`   | 20.7 GB   | 22.6 GB      |
| `k-quant-dynamic` | `text`       | `dflash` | 22.4 GB   | 30.0 GB      |
| `k-quant-dynamic` | `text-image` | `solo`   | 22.2 GB   | 24.0 GB      |
| `k-quant-dynamic` | `text-image` | `dflash` | 23.8 GB   | 31.5 GB      |

Each directory holds `<directory-name>.pte`. The `sm80+ptx` variants add `<directory-name>.ptd`, and the `text-image` variants add `pos_embed.bin`. On CUDA the weights live in the `.ptd` and the `.pte` is only tens of megabytes, so both files are required. The repository root carries the tokenizer metadata (`tokenizer.json`, `tokenizer_config.json`, and `chat_template.jinja`), so this one repository covers everything the server needs. The `assets/hf` download above is for the export path.

**bash**

```bash
EXPORT_DIR=muse-glimmer-k-quant-17G-128K-text-solo-sm80+ptx

hf download meta-models/Muse-Glimmer-30B-ExecuTorch-PTE \
  --include "$EXPORT_DIR/*" \
  --include tokenizer.json --include tokenizer_config.json --include chat_template.jinja \
  --local-dir exports
```

> **IMPORTANT: Pass the actual export filenames**
>
> Pass the downloaded filenames to `--model-path` and `--data-path`. A prebuilt directory names its artifacts after itself, so a download contains no `model.pte` and no `aoti_cuda_blob.ptd`.

#### Build the runner {#executorch-build-runner}

**bash**

```bash
(cd examples/models/muse-glimmer && cmake --workflow --preset muse-glimmer-cuda)
```

Use the `muse-glimmer-mlx` preset on Apple silicon. Binaries land in `cmake-out/examples/models/muse-glimmer/`; the server needs `muse_glimmer_worker`.

#### Serve the model {#executorch-serve}

**bash**

```bash
python -m executorch.examples.models.muse_glimmer.serving.serve \
  --model-path exports/solo/model.pte \
  --data-path exports/solo/aoti_cuda_blob.ptd \
  --tokenizer-path assets/hf/tokenizer.json \
  --hf-tokenizer assets/hf \
  --worker-bin cmake-out/examples/models/muse-glimmer/muse_glimmer_worker \
  --model-id muse-glimmer-30B \
  --tool-parser atem \
  --host 127.0.0.1 --port 8000
```

Adjust the command for your export:

- **MLX**: drop `--data-path`.
- **DFlash**: replace `exports/solo` with `exports/dflash` in both artifact paths. The server detects the exported method contract.
- **Vision**: add `--pos-embed-path <export-dir>/pos_embed.bin`.

From a [prebuilt export](https://dev.meta.ai/docs/muse-glimmer/deploy#executorch-prebuilt-export), substitute the artifact and tokenizer flags. The rest of the command is unchanged:

**bash**

```bash
  --model-path "exports/$EXPORT_DIR/$EXPORT_DIR.pte" \
  --data-path "exports/$EXPORT_DIR/$EXPORT_DIR.ptd" \
  --tokenizer-path exports/tokenizer.json \
  --hf-tokenizer exports \
```

Drop `--data-path` for a `-metal` variant, which has no `.ptd`. Add `--pos-embed-path "exports/$EXPORT_DIR/pos_embed.bin"` for a `text-image` variant. A `-dflash` variant needs no extra flag.

Send a request to the running server:

**curl**

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-glimmer-30B",
    "messages": [
      {"role": "user", "content": "What is the capital of France?"}
    ],
    "max_tokens": 32
  }'
```

The server implements `/health`, `/v1/models`, and `/v1/chat/completions` (streaming and non-streaming). `--max-context` bounds the context window, and prompts over that bound are rejected with a 400.

#### Verify tool calling {#executorch-tool-calling}

`--tool-parser atem` is what makes tool calling work end to end. The Hugging Face chat template renders your tool definitions, and the server converts Muse Glimmer's native [ATEM output](https://dev.meta.ai/docs/muse-glimmer/prompting#tool-calling) into an OpenAI-compatible `tool_calls` array, so your harness needs no Muse Glimmer-specific handling.

Two OpenAI parameters are rejected with a structured 400 rather than ignored:

- `reasoning_effort`: control reasoning with the chat template's [`reasoning_strength` argument](https://dev.meta.ai/docs/muse-glimmer/prompting#reasoning) instead.
- `tool_choice="required"`: `none`, `auto`, and unset are accepted.

#### Stop tokens {#executorch-stop-tokens}

Muse Glimmer needs `eos_token_id = [<|end_of_text|>, <|eot|>]`. Never stop on `<|eom|>`, which ends a message while the turn continues. See [special tokens](https://dev.meta.ai/docs/muse-glimmer/prompting#special-tokens).

#### Runtime limits {#executorch-limits}

These bound the runtime. The [model card](https://huggingface.co/meta-models/Muse-Glimmer-30B) covers the model itself.

- **No video input**: text and images only, one image per request.
- **No continuous batching**: one request runs at a time. `--num-runners` must be 1, the exported methods are batch-1, and execution is serialized. Concurrent sessions are isolated from each other rather than served in parallel.
- **No cross-session prefix sharing and no checkpointing**: every session holds its own KV cache, nothing is reused across sessions, and session state is discarded rather than saved.

For concurrent throughput from one machine, serve with [vLLM](https://dev.meta.ai/docs/muse-glimmer/deploy#vllm).

#### Troubleshooting {#executorch-troubleshooting}

| Symptom                                   | Cause                                                   | Fix                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Worker fails to load the method           | Runner built without the quantized or custom-op kernels | Rebuild with the model's CMake workflow preset rather than a plain ExecuTorch build.                                        |
| Tool calls arrive as plain text           | Server started without `--tool-parser atem`             | Restart with the flag. The default is `none`, which passes model output through unparsed.                                   |
| `400` on a request that works elsewhere   | Unsupported OpenAI parameter                            | See the rejected parameters in [Verify tool calling](https://dev.meta.ai/docs/muse-glimmer/deploy#executorch-tool-calling). |
| Artifact not found on a downloaded export | Export filenames used against a prebuilt directory      | A download has no `model.pte` or `aoti_cuda_blob.ptd`. Both artifacts are named after their directory.                      |

### Hugging Face Transformers {#transformers}

Run Muse Glimmer in plain Python with [Hugging Face Transformers](https://huggingface.co/docs/transformers). There's no server: use this path to learn the generation loop before you build an agent on top of it.

#### Install {#transformers-install}

**bash**

```bash
pip install "transformers>=5.15" accelerate torch
```

Use `transformers` 5.15 or later. Earlier versions lack the native Muse Glimmer path and prompt for `trust_remote_code`.

#### Run the model {#transformers-run-the-model}

**Python**

```python
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

model_id = "meta-models/Muse-Glimmer-30B"
tok = AutoTokenizer.from_pretrained(model_id)
model = AutoModelForCausalLM.from_pretrained(model_id, dtype=torch.bfloat16, device_map="auto")

messages = [{"role": "user", "content": "In one sentence, what is Muse Glimmer good at?"}]
enc = tok.apply_chat_template(messages, add_generation_prompt=True,
                              return_tensors="pt", return_dict=True).to(model.device)
out = model.generate(**enc, max_new_tokens=128, do_sample=True, temperature=1.0, top_p=0.95,
                     eos_token_id=[tok.convert_tokens_to_ids("<|eot|>"),
                                   tok.convert_tokens_to_ids("<|end_of_text|>")])
print(tok.decode(out[0][enc["input_ids"].shape[-1]:], skip_special_tokens=True))
```

The bf16 weights are around 60 GB, so `device_map="auto"` spreads them across the GPUs you have.

#### Stop tokens {#transformers-stop-tokens}

Pass `eos_token_id` as `<|eot|>` and `<|end_of_text|>`, as the example does. Never add `<|eom|>`, which ends a message while the turn continues. See [special tokens](https://dev.meta.ai/docs/muse-glimmer/prompting#special-tokens).

### Ollama {#ollama}

Run Muse Glimmer locally with one command through [Ollama](https://ollama.com/), then connect it to a coding agent or call it through Ollama's API.

#### Install {#ollama-install}

Install Ollama from [ollama.com/download](https://ollama.com/download). Muse Glimmer requires Ollama 0.32.7 or later:

**bash**

```bash
ollama --version
```

#### Run the model {#ollama-run-the-model}

**bash**

```bash
ollama run muse-glimmer
```

On Apple silicon, use Ollama's MLX engine instead:

**bash**

```bash
ollama run muse-glimmer:30b-mlx
```

The [Ollama library page](https://ollama.com/library/muse-glimmer) lists every published tag.

#### Connect a coding agent {#ollama-coding-agent}

`ollama launch` configures a coding agent or another long-running agent to run on Muse Glimmer:

**bash**

```bash
ollama launch claude --model muse-glimmer
ollama launch pi --model muse-glimmer
ollama launch opencode --model muse-glimmer
ollama launch hermes --model muse-glimmer
ollama launch openclaw --model muse-glimmer
```

#### Send a request {#ollama-send-a-request}

Ollama listens on `http://localhost:11434`. The native chat API needs no API key:

**curl**

```bash
curl http://localhost:11434/api/chat -d '{
  "model": "muse-glimmer",
  "stream": false,
  "messages": [
    {"role": "user", "content": "In one sentence, what is Muse Glimmer good at?"}
  ]
}'
```

OpenAI clients use the compatible chat completions endpoint. `ollama` is a placeholder key for clients that require one:

**curl**

```bash
curl http://localhost:11434/v1/chat/completions \
  -H 'Authorization: Bearer ollama' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "muse-glimmer",
    "messages": [
      {"role": "user", "content": "In one sentence, what is Muse Glimmer good at?"}
    ]
  }'
```

### LM Studio {#lm-studio}

Run Muse Glimmer locally with [LM Studio Bionic](https://lmstudio.ai/muse-glimmer), LM Studio's agent app for open models. Use it for agentic coding, research, and document tasks on your own hardware.

#### Install {#lm-studio-install}

Download LM Studio Bionic from [lmstudio.ai](https://lmstudio.ai/).

#### Use the agent {#lm-studio-use-the-agent}

1. Under **Settings > Explore**, select Muse Glimmer and download the recommended model file for your hardware.
2. Create a new project. To let Bionic run commands in your local folders, turn on **Allow Coding**.
3. Select Muse Glimmer from the model picker.
4. Prompt Bionic to complete a task, such as editing attached documents or researching a topic.

Confirm the model works by running an agentic task. For coding, ask Muse Glimmer to inspect a file in a real repository, explain the relevant code path, and propose a diff. For other tasks, attach a document and ask Muse Glimmer to extract facts with file citations.

#### Start the server {#lm-studio-start-the-server}

LM Studio ships an OpenAI-compatible local API server. From a terminal:

**bash**

```bash
lms server start
```

The server starts on port 1234. Change it with `--port`.

To start it from the app instead, turn on the local API server under **Settings > Local Model API**, then copy the base URL into your scripts or OpenAI-compatible client.

#### Verify tool calling {#lm-studio-tool-calling}

In Bionic, run a task that needs a tool. Tool calls appear in the chat log as the agent works.

Through the API, send a request that offers one or more tools and asks the model to use one. Confirm that the response requests the expected tool with valid arguments.

#### Troubleshooting {#lm-studio-troubleshooting}

| Symptom                                         | Cause                                                                              | Fix                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Muse Glimmer doesn't appear in the model picker | The model isn't downloaded, or the LM Link device is disconnected                  | Download Muse Glimmer under **Settings > Explore**. For a remote model, confirm the LM Link device is connected and the model is visible.               |
| The model fails to load or runs out of memory   | Another model is loaded, the context is too large, or the system lacks free memory | Unload other models and lower the context length. Q4\_K\_M measured about 24.1 GiB at one request and 16K context, so leave room for the OS and Bionic. |
| Bionic can read files but can't run commands    | **Allow Coding** is off for the project                                            | Turn on **Allow Coding** and retry.                                                                                                                     |
| `curl` can't connect to the local API           | Bionic is closed, the local API is off, or the request uses the wrong port         | Open Bionic, turn on **Settings > Local Model API**, and use the base URL it shows.                                                                     |
| The local API returns `model not found`         | The request uses a different name from Bionic's served model ID                    | Query `GET /v1/models` and copy the exact model ID into the request.                                                                                    |

#### More {#lm-studio-more}

- [Bionic docs](https://lmstudio.ai/docs/bionic)
- [LM Studio's Muse Glimmer blog post](https://lmstudio.ai/blog/muse-glimmer)

### Unsloth {#unsloth}

Run and serve Muse Glimmer locally with [Unsloth](https://unsloth.ai/), an open-source desktop app. It serves OpenAI- and Anthropic-compatible endpoints, connects coding agents, and supports tool calling, web search, remote access, and model export.

#### Links {#unsloth-links}

- [Unsloth Muse Glimmer GGUFs](https://huggingface.co/unsloth/Muse-Glimmer-30B-GGUF)
- [Download Unsloth](https://unsloth.ai/download)
- [Unsloth docs](https://unsloth.ai/docs/)

#### Install {#unsloth-install}

[Download Unsloth](https://unsloth.ai/download) for macOS, Windows, Linux, or WSL, or install it from a terminal:

**macOS, Linux, WSL**

```bash
curl -fsSL https://unsloth.ai/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://unsloth.ai/install.ps1 | iex
```

Launch it from the installed app shortcut, or run:

**bash**

```bash
unsloth studio -p 8888
```

See the [platform requirements](https://unsloth.ai/docs/get-started/beginner-start-here/unsloth-requirements).

#### Use Unsloth Desktop {#unsloth-desktop}

1. Open **Select model** or **Model Hub**, search for Muse Glimmer, and download GGUF, NVFP4, or another format. Select the official Meta checkpoint or the Unsloth build. For GGUF, choose a quantization that fits your VRAM, unified memory, and system RAM while leaving room for KV cache.
2. Chat with the model once it downloads.
3. To serve the model, create an API key under **Settings > API**. Unsloth exposes OpenAI-compatible `/v1/chat/completions` and `/v1/responses` endpoints, plus an Anthropic-compatible `/v1/messages`.

Keep the localhost binding unless you need remote access. Keep API keys private, and review enabled tools before you expose the server.

For LAN access:

**bash**

```bash
unsloth studio -H 0.0.0.0 -p 8888
```

For HTTPS tunnel access:

**bash**

```bash
unsloth studio --secure -p 8888
```

#### Connect a coding agent {#unsloth-coding-agent}

Load Muse Glimmer in Unsloth, then run:

**bash**

```bash
unsloth start claude
```

Replace `claude` with any of the [supported agents](https://unsloth.ai/docs/integrations/unsloth-start).

Unsloth publishes Muse Glimmer GGUFs at [`unsloth/Muse-Glimmer-30B-GGUF`](https://huggingface.co/unsloth/Muse-Glimmer-30B-GGUF): Dynamic quants from `UD-IQ2_XXS` through `UD-Q8_K_XL`, plus bf16 and the `mmproj` vision projectors. Pick one when you launch an agent, where the `:` suffix selects the quant:

**bash**

```bash
unsloth start claude \
  --model unsloth/Muse-Glimmer-30B-GGUF:UD-Q4_K_XL \
  --context-length 131072
```

`--gguf-variant UD-Q4_K_XL` does the same and overrides the suffix. If Unsloth isn't already running, `--model` starts a temporary server that stops when the agent exits.

#### Verify tool calling {#unsloth-function-calling}

The endpoint takes OpenAI-style `tools`. Replace `default` with the `id` from `/v1/models`:

**curl**

```bash
curl http://localhost:8888/v1/chat/completions \
  -H "Authorization: Bearer $UNSLOTH_STUDIO_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"default",
    "messages":[{"role":"user","content":"What is the weather in Paris in celsius? Use the tool."}],
    "tools":[{"type":"function","function":{
      "name":"get_weather","description":"Get current weather for a city.",
      "parameters":{"type":"object","properties":{
        "city":{"type":"string"},"units":{"type":"string","enum":["celsius","fahrenheit"]}},
        "required":["city"]}}}],
    "tool_choice":"auto"}'
```

A working setup returns a `tool_calls` array, not the call rendered as plain text.

#### Stop tokens {#unsloth-stop-tokens}

Muse Glimmer needs `eos_token_id = [<|end_of_text|>, <|eot|>]`. Never stop on `<|eom|>`. See [special tokens](https://dev.meta.ai/docs/muse-glimmer/prompting#special-tokens).

Unsloth sets inference parameters from the model on load, and the chat template and other per-model settings are editable in the app. Check which stop tokens Unsloth applies before you run long agentic turns, because stopping on `<|eom|>` truncates tool calling.

## Hosted providers {#hosted-providers}

Call Muse Glimmer through a hosted provider when you'd rather not run the hardware yourself. These providers serve the open weights:

| Provider                                                                | Model string                   | Get a key                                                                        |
| ----------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| [Together AI](https://dev.meta.ai/docs/muse-glimmer/deploy#together-ai) | `meta-models/Muse-Glimmer-30B` | [api.together.xyz/settings/api-keys](https://api.together.xyz/settings/api-keys) |

### Together AI {#together-ai}

Together AI serves Muse Glimmer as a managed API. There are no weights to download, no runtime to install, and no GPU to own. You send requests to `https://api.together.xyz/v1/chat/completions` with a model string and an API key.

**Together AI requires an API key.** To run without one, see [Self-host](https://dev.meta.ai/docs/muse-glimmer/deploy#self-host).

The figures under "What Together publishes" come from Together's [Muse Glimmer model page](https://www.together.ai/models/muse-glimmer).

#### Set the model string {#together-ai-model-string}

**Plaintext**

```plaintext
meta-models/Muse-Glimmer-30B
```

Together lists this string as the endpoint on its model page and uses it in all three of its published examples.

#### What Together publishes {#together-ai-published-details}

|                   |                                       |
| ----------------- | ------------------------------------- |
| Endpoint          | `meta-models/Muse-Glimmer-30B`        |
| Provider          | Meta                                  |
| Type              | Chat, Vision                          |
| Deployment        | Serverless, Dedicated                 |
| Parameters        | 30B                                   |
| Context length    | 128K+                                 |
| Input modalities  | Text, Image                           |
| Output modalities | Text                                  |
| Input price       | $0.35 / 1M tokens ($0.04 / 1M cached) |
| Output price      | $1.50 / 1M tokens                     |
| Released          | August 10, 2026                       |
| License           | Apache 2.0                            |
| Availability      | 99.9% SLA, serverless and dedicated   |

Tool calling is supported through the model's chat template, which makes this endpoint usable for the agent loops described in the [tool-calling guide](https://dev.meta.ai/docs/muse-glimmer/prompting#tool-calling).

#### Get a key {#together-ai-get-a-key}

**bash**

```bash
export TOGETHER_API_KEY=...   # https://api.together.xyz/settings/api-keys
```

Check that it works and that the model is visible to your account:

**bash**

```bash
curl -s https://api.together.xyz/v1/models \
  -H "Authorization: Bearer $TOGETHER_API_KEY" | grep -o 'meta-models/Muse-Glimmer-30B'
```

#### Send a request {#together-ai-call-it}

Together publishes three clients. The curl form shows the wire format:

**curl**

```bash
curl -X POST "https://api.together.xyz/v1/chat/completions" \
  -H "Authorization: Bearer $TOGETHER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-models/Muse-Glimmer-30B",
    "messages": [
      {"role": "user", "content": "What are some fun things to do in New York?"}
    ]
  }'
```

Python, using Together's official SDK (`pip install together`; it reads `TOGETHER_API_KEY` from the environment):

**Python**

```python
from together import Together

client = Together()
response = client.chat.completions.create(
    model="meta-models/Muse-Glimmer-30B",
    messages=[{"role": "user", "content": "What are some fun things to do in New York?"}],
)
print(response.choices[0].message.content)
```

TypeScript, using `together-ai`:

**TypeScript**

```typescript
import Together from 'together-ai';

const together = new Together();
const completion = await together.chat.completions.create({
  model: 'meta-models/Muse-Glimmer-30B',
  messages: [{ role: 'user', content: 'What are some fun things to do in New York?' }],
});
console.log(completion.choices[0].message.content);
```

The path, bearer header, and `{model, messages}` body use the OpenAI chat-completions wire format. An HTTP client pointed at `https://api.together.xyz/v1` can call it.

#### Verify tool calling {#together-ai-tool-calling}

A response with text only proves the endpoint is up. A tool-calling round trip verifies the model integration: expect `tool_calls` in the response, not prose.

**curl**

```bash
curl -s https://api.together.xyz/v1/chat/completions \
  -H "Authorization: Bearer $TOGETHER_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "meta-models/Muse-Glimmer-30B",
    "messages": [{"role": "user", "content": "What's the weather in Paris?"}],
    "tools": [{"type": "function", "function": {"name": "get_weather",
      "description": "Get current weather for a city",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}},
                     "required": ["city"]}}}]
  }'
```

A working call returns `tool_calls`, with reasoning available separately on the response object.

You can also drive the same prompt from [Together's Muse Glimmer playground](https://api.together.ai/playground/meta-models/Muse-Glimmer-30B).

#### Set sampling and stop tokens {#together-ai-behavior}

**Sampling.** Defaults come from the checkpoint: `temperature 1.0`, `top_p 0.95`. Greedy decoding loops on this model, so don't set `temperature` to `0`.

> **WARNING: Never stop on the eom token**
>
> Stop tokens: `eos_token_id = [<|end_of_text|>, <|eot|>]`. Never add `<|eom|>` to a `stop` parameter. It marks the end of a message, the turn continues after it, and stopping there cuts off tool calls. See [special tokens](https://dev.meta.ai/docs/muse-glimmer/prompting#special-tokens) for background.

**Weights.** Nothing here downloads them. For the model card or to run the same model locally, use [`meta-models/Muse-Glimmer-30B`](https://huggingface.co/meta-models/Muse-Glimmer-30B) on Hugging Face.

#### What Together measured {#together-ai-together-measurements}

These metrics are not on the model page. They describe Together's serving stack rather than anything you configure.

| Metric                      | Value  |
| --------------------------- | ------ |
| TTFT p50                    | 307 ms |
| Output tokens/s per request | 105    |

Together measured a dedicated 2 × H100-80GB tensor-parallel replica under a sustained 0.4 QPS long-context replay: mean input 58,290 tokens (p99 approximately 127K), mean output 244 tokens, and 1–2 requests in flight. Time to first token (TTFT) is substantially lower at 1K-token inputs.

Together also reports serving the model quantized to FP8: MLP-only blockwise e4m3, 128 × 128, with dynamic activations. Attention, embeddings, and the vision tower stay bf16. Together chose this configuration after checking quality against a bf16 reference on the same hardware: GPQA-Diamond 83.7 ± 0.9 over six runs, against 83.5 on the model card. Precision is not something you select on this endpoint. The detail helps when you compare a hosted result with a local bf16 result.

#### Troubleshooting {#together-ai-troubleshooting}

| Symptom                                                                   | Cause                                                                                                           | Fix                                                                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `401` on every request                                                    | `TOGETHER_API_KEY` unset, or the key is from a different account                                                | Re-export the key from `https://api.together.xyz/settings/api-keys` and re-run the `/v1/models` check above. |
| Output repeats or loops                                                   | `temperature 0` or greedy decoding                                                                              | Use the checkpoint defaults (`temperature 1.0`, `top_p 0.95`).                                               |
| Long requests end at 32,768 output tokens                                 | Together caps generation per request                                                                            | Split the task; the cap guards runaway reasoning loops.                                                      |
| `503 Service unavailable` minutes after provisioning a dedicated endpoint | Replica still warming; Together reports approximately 10–15 minutes for graph compilation and FP8 kernel warmup | Retry with backoff until the first `200`. Serverless is not affected.                                        |

#### Support {#together-ai-support}

- [Model page](https://www.together.ai/models/muse-glimmer)
- [Docs](https://docs.together.ai/)
- [Pricing](https://www.together.ai/pricing)
- [Support](https://www.together.ai/support)

## Next steps {#next-steps}

Once your server is up, frame your requests with the [prompting guide](https://dev.meta.ai/docs/muse-glimmer/prompting), shrink the model with [quantization](https://dev.meta.ai/docs/muse-glimmer/quantization), or speed up self-hosted generation with [speculative decoding](https://dev.meta.ai/docs/muse-glimmer/spec-decode). To fine-tune the model, see [Post-training](https://dev.meta.ai/docs/muse-glimmer/post-training).

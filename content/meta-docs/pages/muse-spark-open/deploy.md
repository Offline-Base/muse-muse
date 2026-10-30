# Run inference {#run-inference}

Run Muse Spark Open on your own infrastructure or call it through a hosted inference provider. The self-hosted runtimes load the released checkpoints and use the Muse Spark Open chat format described in the [prompting guide](https://dev.meta.ai/docs/muse-spark-open/prompting).

| Runtime                                                                                   | Best for                                                            | Checkpoints           | Serving API                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------- | ------------------------------------- |
| [SGLang](https://dev.meta.ai/docs/muse-spark-open/deploy#sglang)                          | High-throughput serving for concurrent users                        | BF16, NVFP4           | OpenAI-compatible HTTP                |
| [vLLM](https://dev.meta.ai/docs/muse-spark-open/deploy#vllm)                              | Production serving, high throughput                                 | BF16, NVFP4           | OpenAI-compatible HTTP                |
| [TensorRT-LLM](https://dev.meta.ai/docs/muse-spark-open/deploy#tensorrt-llm)              | Optimized serving on NVIDIA Blackwell, on a single 4-GPU node       | NVFP4                 | OpenAI-compatible HTTP                |
| [NVIDIA Dynamo](https://dev.meta.ai/docs/muse-spark-open/deploy#dynamo)                   | Disaggregated serving and KV-aware routing                          | NVFP4                 | OpenAI-compatible HTTP                |
| [Hugging Face Transformers](https://dev.meta.ai/docs/muse-spark-open/deploy#transformers) | Native Python implementation for research and custom pipelines      | BF16, NVFP4           | Python API                            |
| [llama.cpp](https://dev.meta.ai/docs/muse-spark-open/deploy#llama-cpp)                    | Portable inference across Metal, CUDA, ROCm, Vulkan, and CPU        | ggml-org GGUFs        | OpenAI-compatible HTTP                |
| [Unsloth](https://dev.meta.ai/docs/muse-spark-open/deploy#unsloth)                        | Local inference on macOS, Windows, Linux, and WSL                   | Unsloth Dynamic GGUFs | OpenAI- and Anthropic-compatible HTTP |
| [MLX](https://dev.meta.ai/docs/muse-spark-open/deploy#mlx)                                | Inference on Apple silicon, across two or four Mac Studio computers | NVFP4                 | OpenAI-compatible HTTP                |

To call the model without provisioning GPUs, use a [hosted provider](https://dev.meta.ai/docs/muse-spark-open/deploy#hosted-providers).

Muse Spark Open is a mixture-of-experts model that serves across multiple GPUs. NVFP4 serves at TP4 on 4 × B300 and BF16 at TP8 on 8 × B300. Read [Choose a checkpoint](https://dev.meta.ai/docs/muse-spark-open/get-the-model#checkpoints) before you provision hardware.

The commands on this page load each checkpoint by its Hugging Face repository ID, such as `meta-models/Muse-Spark-Open-816B-A42B-NVFP4`, and the runtime downloads the weights from Hugging Face. If you [downloaded the weights from Meta](https://dev.meta.ai/docs/muse-spark-open/get-the-model#download-from-meta), replace the repository ID with the path to your local folder, such as `./muse-spark-open-nvfp4`.

> **TIP: Stream long reasoning**
>
> Muse Spark Open produces long reasoning traces at higher reasoning strengths. Request streaming (`stream: true`) for reasoning workloads so long generations don't hit request timeouts. See [Recommended settings](https://dev.meta.ai/docs/muse-spark-open/settings#streaming).

## Self-host {#self-host}

Each tab is a quick start for one runtime: a command that starts a server or, for Transformers, a script that loads the model and generates a reply. Each runtime's section below covers prerequisites, checkpoint variants, and sending requests.

**SGLang**

```bash
sglang serve \
  --model-path meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
  --tp-size 4 \
  --ep-size 4 \
  --quantization modelopt_fp4 \
  --moe-runner-backend flashinfer_trtllm \
  --mem-fraction-static 0.8 \
  --host 0.0.0.0 \
  --port 30000 \
  --enable-layernorm-sp \
  --enable-megamoe-for-layernorm-sp \
  --speculative-algorithm DFLASH \
  --speculative-draft-model-path RadixArk/Muse-Spark-Open-DFlash2 \
  --speculative-draft-attention-backend fa4 \
  --speculative-num-draft-tokens 8 \
  --mm-feature-transport cpu \
  --enable-hierarchical-cache \
  --hicache-size 200 \
  --reasoning-parser muse \
  --tool-call-parser muse
```

**vLLM**

```bash
export VLLM_USE_RUST_FRONTEND=1

vllm serve meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
    --tensor-parallel-size 4 \
    --enable-expert-parallel \
    --max-model-len 1048576 \
    --reasoning-parser muse \
    --tool-call-parser muse \
    --enable-auto-tool-choice \
    --speculative-config '{"method":"dspark","model": "Inferact/Muse-Spark-Open-DSpark","num_speculative_tokens":7,"draft_sample_method":"probabilistic","rejection_sample_method":"block","enable_adaptive_verification":true}'
```

**TensorRT-LLM**

```bash
# serve_config.yaml: see TensorRT-LLM below
trtllm-serve meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
    --config serve_config.yaml \
    --custom_tokenizer musespark_open \
    --tool_parser musespark \
    --reasoning_parser musespark
```

**Transformers**

```python
# Launch with torchrun, which sets WORLD_SIZE; see Hugging Face Transformers below
import os

from transformers import AutoModelForMultimodalLM, AutoProcessor, DistributedConfig

distributed_config = DistributedConfig(
    tp_size=int(os.environ["WORLD_SIZE"]),
    ep_size=int(os.environ["WORLD_SIZE"]),
)

processor = AutoProcessor.from_pretrained("meta-models/Muse-Spark-Open-816B-A42B")
model = AutoModelForMultimodalLM.from_pretrained(
    "meta-models/Muse-Spark-Open-816B-A42B",
    distributed_config=distributed_config,
)

messages = [
    {"role": "user", "content": "Explain in one sentence why the sky is usually blue."},
]
inputs = processor.apply_chat_template(
    messages,
    reasoning_effort="low",  # default: xhigh, options: low/medium/high/xhigh
    add_generation_prompt=True,
    tokenize=True,
    return_dict=True,
    return_tensors="pt",
).to(model.device).to(model.dtype)
input_len = inputs["input_ids"].shape[-1]

outputs = model.generate(**inputs, max_new_tokens=512)
print(processor.decode(outputs[0][input_len:], skip_special_tokens=False))
# to=self<|message|>We need to explain in one sentence why sky is usually blue.
# ...
# <|eom|><|start|>assistant to=user<|message|>The sky appears blue because air molecules scatter shorter-wavelength blue light from the sun more strongly than longer-wavelength red light.<|eot|>
```

**llama.cpp**

```bash
llama serve -hf ggml-org/Muse-Spark-Open-816B-A42B-GGUF
```

**Unsloth**

```bash
unsloth run \
  --model unsloth/Muse-Spark-Open-816B-A42B-GGUF:UD-Q2_K_XL \
  -H 127.0.0.1 \
  -p 8888 \
  --context-length 32768 \
  --temperature 1.0 \
  --top-p 1.0 \
  --min-p 0.0 \
  --reasoning-effort medium
```

**MLX**

```bash
# hostfile.json lists every Mac; see the MLX section below
mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \
  mlx_lm.server --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --port 8080
```

The SGLang and vLLM tabs both serve NVFP4 on 4 × B300; the SGLang tab adds MegaMoE. Each runtime's section below has the other variants.

### SGLang {#sglang}

Serve Muse Spark Open with [SGLang](https://docs.sglang.io/), an inference framework for low-latency, high-throughput serving on anything from a single GPU to a large distributed cluster.

#### Links {#sglang-links}

[SGLang blog post on Muse Spark Open](https://www.lmsys.org/blog/2026-10-15-meta-muse-spark-open): the features SGLang supports for Muse Spark Open at launch.

[SGLang cookbook page for Muse Spark Open](https://docs.sglang.io/cookbook/autoregressive/Meta/MuseSparkOpen): detailed deployment options.

[DFlash2 draft model](https://huggingface.co/RadixArk/Muse-Spark-Open-DFlash2): a DFlash2 checkpoint trained for speculative decoding with Muse Spark Open.

#### Install {#sglang-install}

Run Muse Spark Open with this Docker image:

**bash**

```bash
docker pull lmsysorg/sglang:dev-muse-spark-open
```

For host setup, see the [SGLang installation documentation](https://docs.sglang.io/docs/get-started/install#method-3-using-docker).

#### Start the server {#sglang-start-the-server}

To serve NVFP4 checkpoint:

**bash**

```bash
sglang serve \
  --model-path meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
  --tp-size 4 \
  --ep-size 4 \
  --quantization modelopt_fp4 \
  --moe-runner-backend flashinfer_trtllm \
  --mem-fraction-static 0.8 \
  --host 0.0.0.0 \
  --port 30000 \
  --enable-layernorm-sp \
  --enable-megamoe-for-layernorm-sp \
  --speculative-algorithm DFLASH \
  --speculative-draft-model-path RadixArk/Muse-Spark-Open-DFlash2 \
  --speculative-draft-attention-backend fa4 \
  --speculative-num-draft-tokens 8 \
  --mm-feature-transport cpu \
  --enable-hierarchical-cache \
  --hicache-size 200 \
  --reasoning-parser muse \
  --tool-call-parser muse
```

To serve BF16 checkpoint:

**bash**

```bash
sglang serve \
  --model-path meta-models/Muse-Spark-Open-816B-A42B \
  --tp-size 8 \
  --ep-size 8 \
  --dtype bfloat16 \
  --mem-fraction-static 0.85 \
  --host 0.0.0.0 \
  --port 30000 \
  --enable-layernorm-sp \
  --enable-megamoe-for-layernorm-sp \
  --speculative-algorithm DFLASH \
  --speculative-draft-model-path RadixArk/Muse-Spark-Open-DFlash2 \
  --speculative-draft-attention-backend fa4 \
  --speculative-num-draft-tokens 8 \
  --mm-feature-transport cpu \
  --enable-hierarchical-cache \
  --hicache-size 200 \
  --reasoning-parser muse \
  --tool-call-parser muse
```

#### Recommended settings {#sglang-recommended-settings}

For the best prefill performance on the NVFP4 checkpoint, run prefill with sequence parallelism and the MegaMoE kernel (`--enable-layernorm-sp --enable-megamoe-for-layernorm-sp`, which both server commands above already pass). Prefill is sharded across the four ranks and its MoE layers run on MegaMoE; decode stays on the TensorRT-LLM MoE kernel.

To tune it, add `--attention-backend trtllm_mha --page-size 128` to the NVFP4 server command above, and set the MegaMoE token limit before starting it:

**bash**

```bash
export SGLANG_OPT_DEEPGEMM_MEGA_MOE_NUM_MAX_TOKENS_PER_RANK=8192
```

`SGLANG_OPT_DEEPGEMM_MEGA_MOE_NUM_MAX_TOKENS_PER_RANK` sets the maximum number of tokens that triggers MegaMoE. Raising it can improve prefill performance at larger batch sizes, but uses more device memory.

#### Speculative decoding {#sglang-speculative-decoding-dflash2}

The [DFlash2 draft model](https://huggingface.co/RadixArk/Muse-Spark-Open-DFlash2) proposes a block of eight draft tokens per step, and Muse Spark Open verifies them in a single pass. Both server commands above enable it with `--speculative-algorithm DFLASH` and the three `--speculative-*` flags after it. Remove those four flags to serve without speculative decoding.

#### HiCache {#sglang-hicache}

HiCache offloads the KV cache to pinned host memory, so evicted prefixes are restored instead of recomputed. Both server commands above enable it with `--enable-hierarchical-cache --hicache-size 200`.

`--hicache-size` is the pinned host memory per tensor-parallel rank, in GB: the NVFP4 command (four ranks) pins 800 GB and the BF16 command (eight ranks) pins 1.6 TB. To size the host tier relative to the device KV pool instead, pass `--hicache-ratio N`. Remove both flags to serve without HiCache.

#### Disaggregate prefill and decode {#sglang-pd-disaggregation}

Prefill runs MegaMoE and sequence parallelism with HiCache. Decode runs the TensorRT-LLM MoE kernel with DFlash2. Run prefill and decode as two servers on four GPUs each, with a router in front that takes client requests:

- **B300:** both servers share one 8-GPU node, prefill on GPUs 0–3 and decode on GPUs 4–7.
- **GB300:** each server takes a full 4-GPU node, so prefill and decode run on separate nodes.

**1. Set the environment for your hardware.** Run the matching block before starting each server.

On B300, in the prefill terminal:

**bash**

```bash
export MC_INTRANODE_NVLINK=true
export MC_TCP_ENABLE_CONNECTION_POOL=true
export SGLANG_MOONCAKE_CUSTOM_MEM_POOL=INTRA_NODE_NVLINK
export CUDA_VISIBLE_DEVICES=0,1,2,3
```

On B300, in the decode terminal:

**bash**

```bash
export MC_INTRANODE_NVLINK=true
export MC_TCP_ENABLE_CONNECTION_POOL=true
export SGLANG_MOONCAKE_CUSTOM_MEM_POOL=INTRA_NODE_NVLINK
export CUDA_VISIBLE_DEVICES=4,5,6,7
```

On GB300, on both the prefill node and the decode node:

**bash**

```bash
export NCCL_NVLS_ENABLE=1
export NCCL_MNNVL_ENABLE=1
export NCCL_CUMEM_ENABLE=1
export SGLANG_MOONCAKE_CUSTOM_MEM_POOL=NVLINK
export MC_FORCE_MNNVL=1
```

**2. Start the prefill server** (MegaMoE, sequence parallelism, and HiCache) on port 30001:

**bash**

```bash
sglang serve \
  --model-path meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
  --quantization modelopt_fp4 \
  --moe-runner-backend flashinfer_trtllm \
  --tp-size 4 --ep-size 4 \
  --attention-backend trtllm_mha --page-size 128 \
  --mem-fraction-static 0.8 \
  --reasoning-parser muse --tool-call-parser muse \
  --enable-layernorm-sp --enable-megamoe-for-layernorm-sp \
  --enable-hierarchical-cache --hicache-size 200 \
  --speculative-algorithm DFLASH \
  --speculative-draft-model-path RadixArk/Muse-Spark-Open-DFlash2 \
  --speculative-draft-attention-backend fa4 \
  --speculative-num-draft-tokens 8 \
  --disaggregation-mode prefill \
  --disaggregation-transfer-backend mooncake \
  --host 0.0.0.0 --port 30001
```

**3. Start the decode server** (TensorRT-LLM MoE kernel and DFlash2) on port 30002, in a second terminal on B300 or on the decode node on GB300:

**bash**

```bash
sglang serve \
  --model-path meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
  --quantization modelopt_fp4 \
  --moe-runner-backend flashinfer_trtllm \
  --tp-size 4 --ep-size 4 \
  --attention-backend trtllm_mha --page-size 128 \
  --mem-fraction-static 0.8 \
  --reasoning-parser muse --tool-call-parser muse \
  --speculative-algorithm DFLASH \
  --speculative-draft-model-path RadixArk/Muse-Spark-Open-DFlash2 \
  --speculative-draft-attention-backend fa4 \
  --speculative-num-draft-tokens 8 \
  --disaggregation-mode decode \
  --disaggregation-transfer-backend mooncake \
  --host 0.0.0.0 --port 30002
```

**4. Start the router** once both servers are up. Replace `<prefill-host>` and `<decode-host>` with addresses the router can reach; on B300, both are `127.0.0.1`.

**bash**

```bash
sglang-router launch \
  --pd-disaggregation \
  --prefill http://<prefill-host>:30001 8998 \
  --decode http://<decode-host>:30002 \
  --host 0.0.0.0 --port 8000
```

`8998` after the prefill URL is the prefill server's bootstrap port. Send client requests to the router on port 8000: in the script under [Send requests](https://dev.meta.ai/docs/muse-spark-open/deploy#sglang-send-requests), change the port from 30000 to 8000.

#### Send requests {#sglang-send-requests}

Here is a simple script for sending requests:

**Python**

```python
from openai import OpenAI
client = OpenAI(
    base_url="http://127.0.0.1:30000/v1",
    api_key="null",
    timeout=600.0,
)
model = client.models.list().data[0].id
response = client.chat.completions.create(
    model=model,
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Briefly explain: what is SGLang?"},
    ],
    temperature=1.0,
    top_p=1.0,
    max_tokens=16384, # For setting the maximum number of output tokens
    reasoning_effort="high", # Can be one of low/medium/high/xhigh. xhigh by default.
)
choice = response.choices[0]
print("Reasoning:", getattr(choice.message, "reasoning_content", None))
print("Content:", choice.message.content)
print("Finish reason:", choice.finish_reason)
```

For other ways to send requests, such as curl or Python `requests`, see the [SGLang tutorial](https://docs.sglang.io/docs/basic_usage/send_request).

#### More {#sglang-more}

To run Muse Spark Open on AMD GPUs or Intel Xeon, see [Hardware platforms](https://dev.meta.ai/docs/muse-spark-open/hardware-platforms). The [SGLang cookbook page](https://docs.sglang.io/cookbook/autoregressive/Meta/MuseSparkOpen) has more deployment options.

For more on SGLang, see the [SGLang website](https://docs.sglang.io/) and the [LMSYS blog](https://www.lmsys.org/blog/).

### vLLM {#vllm}

Serve Muse Spark Open with [vLLM](https://docs.vllm.ai/) behind an OpenAI-compatible endpoint.

#### Links {#vllm-links}

- [vLLM recipe for Muse Spark Open](https://recipes.vllm.ai/meta-models/Muse-Spark-Open-816B-A42B)
- [vLLM launch blog for Muse Spark Open](https://vllm.ai/blog/2026-10-15-muse-spark-open)

#### Prerequisites {#vllm-prerequisites}

- The downloaded weights. See [Get the model](https://dev.meta.ai/docs/muse-spark-open/get-the-model).
- NVIDIA or AMD GPUs. See [Choose a checkpoint](https://dev.meta.ai/docs/muse-spark-open/get-the-model#checkpoints).

#### Install {#vllm-install}

Prebuilt images are available for both vendors:

- NVIDIA: `vllm/vllm-openai:muse-spark-open`
- AMD: `vllm/vllm-openai-rocm:muse-spark-open`

Use one of the Docker images above to run Muse Spark Open.

#### Start the server {#vllm-start-the-server}

NVFP4 on 4 × B300, with DSpark speculative decoding:

**bash**

```bash
export VLLM_USE_RUST_FRONTEND=1

vllm serve meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
    --tensor-parallel-size 4 \
    --enable-expert-parallel \
    --max-model-len 1048576 \
    --reasoning-parser muse \
    --tool-call-parser muse \
    --enable-auto-tool-choice \
    --speculative-config '{"method":"dspark","model": "Inferact/Muse-Spark-Open-DSpark","num_speculative_tokens":7,"draft_sample_method":"probabilistic","rejection_sample_method":"block","enable_adaptive_verification":true}'
```

For BF16, serve `meta-models/Muse-Spark-Open-816B-A42B` with `--tensor-parallel-size 8` on 8 × B300 and keep the other flags.

`--max-model-len 1048576` serves the full 1,048,576-token context window. KV memory on the full-attention layers grows with context length, so if your workload needs less, lower it as described in [Context length](https://dev.meta.ai/docs/muse-spark-open/settings#context-length).

#### Send a request {#vllm-send-a-request}

vLLM exposes an OpenAI-compatible endpoint on port 8000:

**curl**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "meta-models/Muse-Spark-Open-816B-A42B-NVFP4",
    "messages": [{"role": "user", "content": "Refactor this module."}],
    "reasoning_effort": "xhigh"
  }'
```

Reasoning effort defaults to `xhigh`; set `reasoning_effort` to `low`, `medium`, `high`, or `xhigh`. See [Reasoning strength](https://dev.meta.ai/docs/muse-spark-open/settings#reasoning-strength).

Reasoning is returned separately from `content`, and tool calls arrive as a standard `tool_calls` array. Parsing happens server-side, so an OpenAI-compatible harness needs no model-specific handling.

#### Send image, video, and audio {#vllm-multimodal}

**curl**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "meta-models/Muse-Spark-Open-816B-A42B-NVFP4",
    "messages": [{"role": "user", "content": [
      {"type": "image_url", "image_url": {"url": "https://example.com/screenshot.png"}},
      {"type": "video_url", "video_url": {"url": "https://example.com/demo.mp4"}},
      {"type": "audio_url", "audio_url": {"url": "https://example.com/clip.wav"}},
      {"type": "text",      "text": "What is happening here, and when?"}
    ]}]
  }'
```

#### Stop tokens {#vllm-stop-tokens}

Muse Spark Open needs to stop on `<|eot|>` and the end-of-text token. Never stop on `<|eom|>`, which ends a message while the turn continues. See [Stop tokens](https://dev.meta.ai/docs/muse-spark-open/settings#stop-tokens).

### TensorRT-LLM {#tensorrt-llm}

[NVIDIA TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM) serves Muse Spark Open on NVIDIA Blackwell GPUs through an OpenAI-compatible server (`trtllm-serve`). The validated deployment runs the NVFP4 checkpoint on a single 4-GPU Blackwell node (tensor parallel 4, expert parallel 4). The configuration uses an FP8 KV cache, CUDA graphs, chunked prefill, and KV-cache block reuse. The server supports image, video, and audio input, guided decoding (JSON mode and JSON schema), tool calling, and optional speculative decoding.

#### Links {#tensorrt-llm-links}

- [Muse Spark Open deployment guide for TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM/blob/feat/musespark-open/docs/source/deployment-guide/deployment-guide-for-musespark-open-on-trtllm.md)
- [Runnable example and validated serving configuration](https://github.com/NVIDIA/TensorRT-LLM/tree/feat/musespark-open/examples/musespark_open)
- [NVIDIA technical blog: scale agentic coding workflows with Muse Spark Open on NVIDIA GB300 NVL72](https://developer.nvidia.com/blog/scale-agentic-coding-workflows-with-metas-muse-spark-open-on-nvidia-gb300-nvl72/)

#### Install {#tensorrt-llm-install}

Muse Spark Open support is in the TensorRT-LLM `feat/musespark-open` branch. Build TensorRT-LLM from that branch; no pre-built release container or wheel includes Muse Spark Open support.

Clone the branch and build from source following the [build-from-source guide](https://nvidia.github.io/TensorRT-LLM/installation/build-from-source.html). The only differences from that guide are the branch and the Blackwell CUDA architecture (`100-real`):

**bash**

```bash
git clone --branch feat/musespark-open https://github.com/NVIDIA/TensorRT-LLM.git
cd TensorRT-LLM
git lfs pull
```

Then, inside the TensorRT-LLM development container (see the guide for the `devel` container tag and the required `docker run` flags), build and install in editable mode, targeting Blackwell:

**bash**

```bash
python3 scripts/build_wheel.py --use_ccache -a "100-real" \
    --skip_building_wheel --linking_install_binary
pip install -e .
```

You also need a complete Hugging Face-format Muse Spark Open checkpoint with its tokenizer and processor files: [meta-models/Muse-Spark-Open-816B-A42B-NVFP4](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B-NVFP4) (a BF16 variant, [meta-models/Muse-Spark-Open-816B-A42B](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B), is also published). The NVFP4 checkpoint ships the routed-expert weights pre-quantized to NVFP4; no additional quantization step is needed.

#### Start the server {#tensorrt-llm-start-the-server}

Muse Spark Open at TP4/EP4 fits on a single Blackwell 4-GPU node, so `trtllm-serve` launches directly (no multi-node launcher needed). Write the recommended settings (next section) to a YAML file and pass it with `--config`:

**bash**

```bash
trtllm-serve meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
    --config serve_config.yaml \
    --custom_tokenizer musespark_open \
    --tool_parser musespark \
    --reasoning_parser musespark
```

Pass `--custom_tokenizer musespark_open`, `--tool_parser musespark`, and `--reasoning_parser musespark` explicitly; the two parsers enable tool-call and reasoning-content extraction on `/v1/chat/completions`. The server listens on `localhost:8000`. Add `--host 0.0.0.0 --port 8000` if it needs to be reachable from other hosts. The server is ready when the log shows `Application startup complete`; the first query may take longer due to warmup.

#### Recommended settings {#tensorrt-llm-recommended-settings}

Start from the validated aggregated serving configuration, `serve_config.yaml`, and tune it for your workload:

**YAML**

```yaml
tensor_parallel_size: 4
moe_expert_parallel_size: 4
enable_attention_dp: false
max_batch_size: 256
max_num_tokens: 8192
max_seq_len: 49152
trust_remote_code: true
enable_chunked_prefill: true
disable_overlap_scheduler: false
attn_backend: TRTLLM
allreduce_strategy: NCCL
guided_decoding_backend: xgrammar
cuda_graph_config:
  max_batch_size: 256
  enable_padding: true
moe_config:
  backend: TRTLLM
kv_cache_config:
  # FP8 KV cache is required on GB300 (SM103) when chunked prefill or
  # block reuse is enabled.
  dtype: fp8
  enable_block_reuse: true
  enable_partial_reuse: true
  free_gpu_memory_fraction: 0.8
```

Notes:

- **FP8 KV cache is required on GB300 (`SM103`) with chunked prefill or KV reuse.** For this model's head dimension (64), the fused paged-context attention kernel exists only for the FP8 KV-cache dtype; a 16-bit KV cache in that combination is refused at startup.
- `max_seq_len: 49152` is the validated serving window; the model supports up to 1M tokens of context. Longer windows need proportionally more KV-cache memory.
- On out-of-memory errors, reduce `kv_cache_config.free_gpu_memory_fraction`, `max_batch_size`, or `max_seq_len`.

#### Send requests {#tensorrt-llm-send-requests}

The server exposes the OpenAI-compatible API:

**curl**

```bash
curl http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d '{
    "model": "meta-models/Muse-Spark-Open-816B-A42B-NVFP4",
    "messages": [{"role": "user", "content": "Where is New York?"}],
    "max_tokens": 16384
}'
```

Muse Spark Open is a reasoning model: with `--reasoning_parser musespark`, each
chat response returns the chain-of-thought in a separate `reasoning_content`
field and the user-facing answer in `content`. Both are drawn from the same
`max_tokens` budget, so set `max_tokens` large enough to cover the reasoning
*and* the answer. Too small a budget is spent entirely on reasoning and returns
an empty `content` with `"finish_reason": "length"`.

Guided decoding (JSON mode and JSON schema via the `xgrammar` backend) works through the standard `response_format` field. The constraint applies to `content` (the answer), so the budget must also leave room for the model to finish reasoning first:

**curl**

```bash
curl http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d '{
    "model": "meta-models/Muse-Spark-Open-816B-A42B-NVFP4",
    "messages": [{"role": "user", "content": "Give me a city and its country as JSON."}],
    "max_tokens": 16384,
    "response_format": {"type": "json_object"}
}'
```

Image, video, and audio inputs are accepted through the standard multimodal chat-completions content parts; multimodal token budgets count against `max_num_tokens` and `max_seq_len` like text tokens.

#### More {#tensorrt-llm-more}

- The [TensorRT-LLM deployment guide for Muse Spark Open](https://github.com/NVIDIA/TensorRT-LLM/blob/feat/musespark-open/docs/source/deployment-guide/deployment-guide-for-musespark-open-on-trtllm.md) covers key YAML options, multimodal token budgets, speculative decoding, benchmarking with `tensorrt_llm.serve.scripts.benchmark_serving`, and troubleshooting.
- For disaggregated serving, with prefill and decode on separate workers, see [NVIDIA Dynamo](https://dev.meta.ai/docs/muse-spark-open/deploy#dynamo), which uses TensorRT-LLM as its backend engine.

### NVIDIA Dynamo {#dynamo}

[NVIDIA Dynamo](https://github.com/ai-dynamo/dynamo) provides an OpenAI-compatible frontend, reasoning and tool-call parsing, disaggregated serving, and KV-aware routing.

#### Links {#dynamo-links}

- [Dynamo documentation](https://docs.nvidia.com/dynamo/latest/)
- [Muse Spark Open Dynamo recipe](https://docs.nvidia.com/dynamo/recipes/Muse-Spark-Open)

#### Install {#dynamo-install}

See the [Dynamo installation guide](https://docs.nvidia.com/dynamo/cli/installation/install-dynamo). Use the Muse Spark Open-enabled image and checkpoint specified in the model recipe, including the latest tokenizer, processor, and chat template.

#### Start the server {#dynamo-start-the-server}

Follow the model recipe for launch commands and backend settings. The [Dynamo quickstart](https://docs.nvidia.com/dynamo/cli/getting-started/quickstart) explains how the frontend and model worker run together.

#### Recommended settings {#dynamo-recommended-settings}

See the [Dynamo recipes](https://github.com/ai-dynamo/dynamo/tree/main/recipes) for recommended deployment settings.

#### Send requests {#dynamo-send-requests}

See the request examples in the [Dynamo quickstart](https://docs.nvidia.com/dynamo/cli/getting-started/quickstart) and model recipe. Chat completions separate `reasoning_content` from `content` and return structured `tool_calls` when tools are supplied.

#### More {#dynamo-more}

- [Dynamo recipe catalog](https://github.com/ai-dynamo/dynamo/tree/main/recipes)
- [Disaggregated serving](https://docs.nvidia.com/dynamo/cli/disaggregated-serving/overview)
- [KV-aware routing](https://docs.nvidia.com/dynamo/cli/kv-aware-routing/overview)

### Hugging Face Transformers {#transformers}

Muse Spark Open comes with a native Hugging Face Transformers implementation, so you can run it using familiar APIs and integrate it into your workflows. It supports text, images, audio, and video, as well as agentic use cases including tool calls. Checkpoints are available in [BF16](https://dev.meta.ai/docs/muse-spark-open/deploy#transformers-install) and [NVFP4 formats](https://dev.meta.ai/docs/muse-spark-open/deploy#transformers-nvfp4). You can post-train Muse Spark Open with Transformer Reinforcement Learning (TRL) to adapt it to your own tasks and datasets; see [Post-train with TRL](https://dev.meta.ai/docs/muse-spark-open/post-training#trl).

#### Links {#transformers-links}

- [Transformers docs](https://hf.co/docs/transformers/main/en/model_doc/muse_spark). These are always the source of truth for using Muse Spark Open with Transformers.
- [Hugging Face collection](https://huggingface.co/collections/meta-models/muse-spark-open)
- [Hugging Face blog post on Muse Spark Open](https://hf.co/blog/meta-muse-spark-open)
- [Post-train with TRL](https://github.com/huggingface/trl/tree/main/examples/sft_muse_spark_open)

#### Install {#transformers-install}

Install Hugging Face Transformers with:

**bash**

```bash
pip install -U "transformers>=5.19"
```

See the [Transformers installation guide](https://hf.co/docs/transformers/main/en/installation) for more options.

#### Run the model {#transformers-run-the-model}

The Muse Spark Open implementation provides `MuseSparkForConditionalGeneration` for text generation from multimodal inputs and `MuseSparkProcessor` for preparing conversations. The processor combines the tokenizer, image and video processors, audio feature extractor, and chat template.

Use a `DistributedConfig` to configure the parallelism settings. `tp_size` is the number of devices across which the dense layers are sharded, and `ep_size` is the number of devices across which the experts are distributed.

The example below shows how to define the distributed config, load the model with `AutoModelForMultimodalLM`, preprocess the inputs, and generate and decode the output.

**Python**

```python
import os

from transformers import AutoModelForMultimodalLM, AutoProcessor, DistributedConfig

distributed_config = DistributedConfig(
    tp_size=int(os.environ["WORLD_SIZE"]),
    ep_size=int(os.environ["WORLD_SIZE"]),
)

processor = AutoProcessor.from_pretrained("meta-models/Muse-Spark-Open-816B-A42B")
model = AutoModelForMultimodalLM.from_pretrained(
    "meta-models/Muse-Spark-Open-816B-A42B",
    distributed_config=distributed_config,
)

messages = [
    {"role": "user", "content": "Explain in one sentence why the sky is usually blue."},
]
inputs = processor.apply_chat_template(
    messages,
    reasoning_effort="low",  # default: xhigh, options: low/medium/high/xhigh
    add_generation_prompt=True,
    tokenize=True,
    return_dict=True,
    return_tensors="pt",
).to(model.device).to(model.dtype)
input_len = inputs["input_ids"].shape[-1]

outputs = model.generate(**inputs, max_new_tokens=512)
print(processor.decode(outputs[0][input_len:], skip_special_tokens=False))
# to=self<|message|>We need to explain in one sentence why sky is usually blue.
# ...
# <|eom|><|start|>assistant to=user<|message|>The sky appears blue because air molecules scatter shorter-wavelength blue light from the sun more strongly than longer-wavelength red light.<|eot|>
```

Save the script above as `run_muse_spark_open.py` and launch it with `torchrun` on every node using Slurm:

**bash**

```bash
#!/bin/bash
#SBATCH --job-name=muse-spark-open
#SBATCH --nodes=2
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-node=8

export MASTER_ADDR=$(scontrol show hostnames "$SLURM_JOB_NODELIST" | head -n 1)
export MASTER_PORT=29500

srun bash -c 'torchrun \
    --nnodes=$SLURM_NNODES \
    --nproc-per-node=8 \
    --node-rank=$SLURM_NODEID \
    --master-addr=$MASTER_ADDR \
    --master-port=$MASTER_PORT \
    run_muse_spark_open.py'
```

#### NVFP4 weights {#transformers-nvfp4}

NVFP4 [quantized weights](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B-NVFP4) allow running the model with lower memory requirements on compatible hardware. The inference code is the same apart from the model ID, but NVFP4 needs a Transformers build from a pull request branch, installed below.

> **NOTE: Check the Transformers documentation first**
>
> The [Transformers documentation](https://hf.co/docs/transformers/main/en/model_doc/muse_spark) is the source of truth on how to run NVFP4 weights in Transformers. The Transformers package moves faster than this page: check the documentation first for the latest information.

NVFP4 support requires Transformers from the [NVFP4 pull request branch](https://github.com/huggingface/transformers/pull/49015):

**bash**

```bash
pip install git+https://github.com/huggingface/transformers.git@finegrained-per-scheme-demo
```

The weights can then be loaded by setting the model name to `"meta-models/Muse-Spark-Open-816B-A42B-NVFP4"` as demonstrated below.

**Python**

```python
import os

from transformers import AutoModelForMultimodalLM, AutoProcessor, DistributedConfig

distributed_config = DistributedConfig(
    tp_size=int(os.environ["WORLD_SIZE"]),
    ep_size=int(os.environ["WORLD_SIZE"]),
)

processor = AutoProcessor.from_pretrained("meta-models/Muse-Spark-Open-816B-A42B-NVFP4")
model = AutoModelForMultimodalLM.from_pretrained(
    "meta-models/Muse-Spark-Open-816B-A42B-NVFP4",
    distributed_config=distributed_config,
)

messages = [
    {"role": "user", "content": "Explain in one sentence why the sky is usually blue."},
]
inputs = processor.apply_chat_template(
    messages,
    reasoning_effort="low",
    add_generation_prompt=True,
    tokenize=True,
    return_dict=True,
    return_tensors="pt",
).to(model.device).to(model.dtype)
input_len = inputs["input_ids"].shape[-1]

outputs = model.generate(**inputs, max_new_tokens=512)
print(processor.decode(outputs[0][input_len:], skip_special_tokens=False))
```

Launch it with `torchrun` and the same Slurm script as [Run the model](https://dev.meta.ai/docs/muse-spark-open/deploy#transformers-run-the-model).

#### More {#transformers-more}

See the full [Transformers documentation for Muse Spark](https://hf.co/docs/transformers/main/en/model_doc/muse_spark) to see how to use the `pipeline` API and run inference for all modalities, including image, video, and audio.

The [Hugging Face blog post on Muse Spark Open](https://hf.co/blog/meta-muse-spark-open) covers the model in depth and more ways to deploy it with Transformers.

### llama.cpp {#llama-cpp}

Portable inference across Metal, CUDA, ROCm, Vulkan, and CPU. llama.cpp and the Llama app support Muse Spark Open.

#### Install {#llama-cpp-install}

Install a prebuilt llama binary for your platform:

**bash**

```bash
curl -LsSf https://llama.app/install.sh | sh
```

#### Serve {#llama-cpp-serve}

`llama serve -hf` downloads, caches, and serves a model in one command. Muse Spark Open supports up to 1,048,576 tokens of context.

**bash**

```bash
llama serve -hf ggml-org/Muse-Spark-Open-816B-A42B-GGUF --chat-template-kwargs '{"reasoning_effort":"low"}'
```

To serve a specific quantization, add its suffix. ggml-org ships three quantizations for this release: Q4\_K\_S, Q8\_0, and Q2\_K.

**bash**

```bash
llama serve -hf ggml-org/Muse-Spark-Open-816B-A42B-GGUF:Q4_K_S
llama serve -hf ggml-org/Muse-Spark-Open-816B-A42B-GGUF:Q8_0
llama serve -hf ggml-org/Muse-Spark-Open-816B-A42B-GGUF:Q2_K
```

The server exposes an OpenAI-compatible endpoint. Open `http://localhost:8080` to chat with Muse Spark Open in the Llama WebUI, which supports images, audio, and Model Context Protocol (MCP) tools.

Useful flags:

| Flag                     | Why                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `-a muse-spark-open`     | API alias. By default, this is the checkpoint path.                                                          |
| `--chat-template-kwargs` | Sets `reasoning_effort`, see below. Template default is `xhigh`.                                             |
| `-np N`                  | Concurrent slots. The context length is divided across the slots, so long-context agents should use `-np 1`. |
| `--api-key`              | Optional key to gate endpoints. `/health` and `/v1/models` still answer without it.                          |

Smoke test (`--noproxy` ensures the loopback request connects directly):

**curl**

```bash
curl -s --noproxy '*' http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <your-key>" \
  -d '{"model":"muse-spark-open","messages":[{"role":"user","content":"What is 17 * 23?"}],"temperature":1.0}'
```

#### Control reasoning {#llama-cpp-reasoning}

The chat template reads `reasoning_effort` and defaults to `xhigh`.

Set it server-wide with `--chat-template-kwargs`, or per request:

**JSON**

```json
{"model":"muse-spark-open","messages":[...],"chat_template_kwargs":{"reasoning_effort":"low"}}
```

The model supports four levels: `low`, `medium`, `high`, `xhigh`.

Reasoning can't be turned off. The chat template rejects `"reasoning_effort": "none"`, and `--reasoning off` leaves the output unchanged. Set `reasoning_effort` to `low` to spend fewer thinking tokens.

#### Vision {#llama-cpp-vision}

You can upload images through the Web UI. For applications that use the server endpoint, send a remote URL, a `data:image/...;base64,...` URI, or a local path:

**curl**

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <your-key>" \
  -d '{"model":"muse-spark-open","messages":[{"role":"user","content":[
        {"type":"text","text":"What is in this image?"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}
      ]}],"temperature":1.0}'
```

#### Audio {#llama-cpp-audio}

Similarly to vision, you can either upload through the Web UI or send base64 encoded files to the endpoint. Audio follows the OpenAI `input_audio` shape: raw base64 in `data`, not a data URL, and the file type (`wav` or `mp3`) in `format`.

**curl**

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <your-key>" \
  -d '{"model":"muse-spark-open","messages":[{"role":"user","content":[
        {"type":"text","text":"Transcribe this audio."},
        {"type":"input_audio","input_audio":{"data":"<base64>","format":"wav"}}
      ]}],"temperature":1.0}'
```

#### CLI {#llama-cpp-cli}

You can also use `llama cli` to interact with the model through CLI.

**bash**

```bash
llama cli -hf ggml-org/Muse-Spark-Open-816B-A42B-GGUF -c 32768
```

After you launch `llama cli`, use the `/image` command to pass in images. You can then enter a text prompt.

**bash**

```bash
> /image image.png
Loaded media from 'image.png'

> describe this image
```

Similarly, to pass audio:

**bash**

```bash
> /audio /path/example_audio.mp3

Loaded media from '/path/example_audio.mp3'

> transcribe this audio
```

#### Verify tool calling {#llama-cpp-tool-calling}

**curl**

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer <your-key>" \
  -d '{"model":"muse-spark-open","messages":[{"role":"user","content":"What is the weather in Paris in celsius? Use the tool."}],
       "tools":[{"type":"function","function":{
         "name":"get_weather","description":"Get current weather for a city.",
         "parameters":{"type":"object","properties":{
           "city":{"type":"string"},"units":{"type":"string","enum":["celsius","fahrenheit"]}},
           "required":["city"]}}}],
       "tool_choice":"auto","temperature":1.0}'
```

The command above returns finish\_reason: `"tool_calls"`, a `tool_calls` array containing `get_weather(city="Paris", units="celsius")`, and reasoning in `reasoning_content`. Tool-call parsing occurs server-side, so OpenAI-compatible clients require no Muse Spark Open–specific logic.

#### Context per slot {#llama-cpp-context-per-slot}

Check `n_ctx_slot` in the startup log to determine the per-generation context limit. Don't read the limit from `-c`: it sets the total context length, shared across slots. When a generation exceeds its slot limit, the server may return neither an answer nor an error, making batch and evaluation failures difficult to diagnose.

To increase concurrency while retaining the same per-slot limit, increase `-c` in proportion to `-np`:

**bash**

```bash
  -c 524288 -np 2        # 262144 per slot and 2-way concurrent
```

### Unsloth {#unsloth}

Run Muse Spark Open locally with Unsloth Desktop and Unsloth Dynamic GGUFs. Use the desktop interface to download and chat with the model, or serve an authenticated API for your applications and coding agents. Unsloth runs on macOS, Windows, Linux, and WSL, with CPU and GPU inference powered by llama.cpp.

Muse Spark Open is Meta's 816B-parameter mixture-of-experts model with about 42B active parameters, built for multimodal reasoning, coding, and agentic workflows. It supports text, image, video, and audio input with text output. This recipe covers text chat and API serving; multimodal input depends on the inference backend and the model assets you load.

#### Links {#unsloth-links}

- [Muse Spark Open: run locally with Unsloth](https://unsloth.ai/docs/models/muse-spark-open)
- [Muse Spark Open Unsloth Dynamic GGUFs](https://huggingface.co/unsloth/Muse-Spark-Open-816B-A42B-GGUF)
- [Download Unsloth Desktop](https://unsloth.ai/download)
- [Unsloth API guide](https://unsloth.ai/docs/basics/api)
- [Unsloth Dynamic GGUFs](https://unsloth.ai/docs/basics/dynamic-3.0-ggufs)

#### Choose a quantization {#unsloth-choose-a-quantization}

Start with a Dynamic 2-bit GGUF and choose a variant that fits your hardware. Unsloth's guide gives the following approximate memory planning ranges: system RAM plus VRAM, or unified memory on Apple silicon. Requirements vary with the exact quantization, context length, KV-cache format, and runtime configuration.

| Quantization | Approximate total memory |
| ------------ | ------------------------ |
| 2-bit        | 300-315 GB               |
| 3-bit        | 365-390 GB               |
| 4-bit        | 470-500 GB               |
| 6-bit        | 670-700 GB               |
| 8-bit        | 870-950 GB               |

BF16 language-model weights alone require approximately 1.63 TB before runtime overhead. Leave memory beyond the downloaded model size for the operating system, runtime, and KV cache. Longer contexts increase memory requirements. Offloading layers to system RAM reduces VRAM requirements; if memory pressure causes disk paging, generation can become much slower.

#### Install Unsloth Desktop {#unsloth-install}

[Download Unsloth](https://unsloth.ai/download) and complete the installer for your platform:

- [macOS](https://unsloth.ai/download/mac)
- [Windows](https://unsloth.ai/download/windows)
- [Linux and WSL](https://unsloth.ai/download/linux)

Alternatively, install from a terminal:

**macOS, Linux, WSL**

```bash
curl -fsSL https://unsloth.ai/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://unsloth.ai/install.ps1 | iex
```

Use a recent Unsloth release with Muse Spark Open support. See the [platform installation guides](https://unsloth.ai/docs/get-started/install) for additional setup instructions.

#### Start the server {#unsloth-start-the-server}

In Unsloth Desktop:

1. Launch Unsloth from your installed app shortcut.
2. Open **Model Hub**, search for "Muse Spark Open", and select the Unsloth GGUF repository linked above.
3. Download a quantization that fits your available memory. Start with Dynamic 2-bit; the CLI example below selects `UD-Q2_K_XL`.
4. Load the model from **Select model** on the Chat page and send a short message to confirm that it responds.
5. Open **Settings > API**, create an API key, and copy it. Use the endpoint URL shown in Unsloth when configuring your client.

Unsloth provides automatic per-model inference presets and lets you edit sampling settings, context length, and the chat template. Check the values against the [recommended settings](https://dev.meta.ai/docs/muse-spark-open/deploy#unsloth-recommended-settings) below when loading Muse Spark Open.

To load the model and start its API from the command line with the Unsloth CLI:

**bash**

```bash
unsloth run \
  --model unsloth/Muse-Spark-Open-816B-A42B-GGUF:UD-Q2_K_XL \
  -H 127.0.0.1 \
  -p 8888 \
  --context-length 32768 \
  --temperature 1.0 \
  --top-p 1.0 \
  --min-p 0.0 \
  --reasoning-effort medium
```

The `:UD-Q2_K_XL` suffix selects the quantization. Unsloth starts the server, loads the UI, and prints the endpoint URL and API key. Keep this terminal running while sending requests.

This example starts with a 32,768-token context to limit KV-cache memory. Increase `--context-length` as your available memory allows. The `medium` reasoning level is a starting choice for interactive use; change it to another supported level as needed.

For a larger-memory configuration, select `:UD-Q4_K_XL` instead. Additional llama-server runtime flags let you adjust GPU layers, CPU threads, sampling, and networking; see the [Unsloth API guide](https://unsloth.ai/docs/basics/api).

#### Recommended settings {#unsloth-recommended-settings}

| Setting                    | Recommended value                           |
| -------------------------- | ------------------------------------------- |
| Temperature                | `1.0`                                       |
| Top-p                      | `1.0`                                       |
| Min-p                      | `0.0` in the CLI example                    |
| Starting quantization      | Dynamic 2-bit                               |
| Example serving context    | `32768` tokens; adjust for available memory |
| Model maximum context      | `1048576` tokens                            |
| Supported reasoning effort | `low`, `medium`, `high`, `xhigh`            |

Use `--reasoning-effort` to pass the selected effort level to the model's chat template. The level takes effect only when the loaded template and backend support it. Choose `low` or `medium` for lighter reasoning, and `high` or `xhigh` for more demanding tasks. Muse Spark Open evaluations use `xhigh` for maximum reasoning strength.

The model's maximum context is not a recommended allocation for every machine. Context includes the input and generated tokens, and a larger KV cache needs additional memory. Allow enough output tokens for both reasoning and the final answer.

#### Send requests {#unsloth-send-requests}

Unsloth exposes OpenAI-compatible `/v1/chat/completions` and `/v1/responses` endpoints, plus the Anthropic-compatible `/v1/messages` endpoint. Authenticate with your Unsloth API key. The examples below use Chat Completions.

In a second terminal, set the base URL and the API key copied from Unsloth. These shell examples use Bash on macOS, Linux, or WSL, and require Python 3 for model discovery.

**bash**

```bash
export UNSLOTH_BASE_URL="http://127.0.0.1:8888"
export UNSLOTH_API_KEY="paste-your-unsloth-api-key-here"
```

Use the URL printed by your server if it differs. The `/v1/models` endpoint lists loaded and locally cached models. Select the loaded Muse Spark Open model's exact ID:

**bash**

```bash
UNSLOTH_MODEL_ID="$(
  curl --fail-with-body "${UNSLOTH_BASE_URL}/v1/models" \
    -H "Authorization: Bearer ${UNSLOTH_API_KEY}" |
    python3 -c '
import json
import sys

models = [
    model
    for model in json.load(sys.stdin)["data"]
    if model.get("loaded") is True
    and "muse-spark-open" in model["id"].lower()
]
if len(models) != 1:
    raise SystemExit("Load exactly one Muse Spark Open model and retry.")
print(models[0]["id"])
'
)" && export UNSLOTH_MODEL_ID
```

Send a chat request. The Python example needs the OpenAI SDK (`python3 -m pip install -U openai`) and runs in the same environment as the exported client variables:

**curl**

```bash
curl --fail-with-body "${UNSLOTH_BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${UNSLOTH_API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{
  "model": "${UNSLOTH_MODEL_ID}",
  "messages": [
    {"role": "user", "content": "Explain mixture-of-experts models in three sentences."}
  ],
  "temperature": 1.0,
  "top_p": 1.0,
  "min_p": 0.0,
  "reasoning_effort": "medium",
  "enable_tools": false,
  "max_tokens": 8192,
  "stream": false
}
JSON
```

**Python (OpenAI SDK)**

```python
import os

from openai import OpenAI

client = OpenAI(
    base_url=os.environ["UNSLOTH_BASE_URL"].rstrip("/") + "/v1",
    api_key=os.environ["UNSLOTH_API_KEY"],
)

response = client.chat.completions.create(
    model=os.environ["UNSLOTH_MODEL_ID"],
    messages=[
        {"role": "user", "content": "Explain mixture-of-experts models in three sentences."}
    ],
    temperature=1.0,
    top_p=1.0,
    reasoning_effort="medium",
    max_tokens=8192,
    extra_body={"min_p": 0.0, "enable_tools": False},
)

print(response.choices[0].message.content)
```

`min_p` and `enable_tools` are Unsloth extensions to the Chat Completions format. Sending sampling values explicitly also applies them when using the desktop workflow. `enable_tools: false` keeps this request as text generation. For streaming, set `"stream": true` and add `--no-buffer` to curl.

#### Check function calling {#unsloth-function-calling}

Send an OpenAI-style tool definition to request a structured function call:

**curl**

```bash
curl --fail-with-body "${UNSLOTH_BASE_URL}/v1/chat/completions" \
  -H "Authorization: Bearer ${UNSLOTH_API_KEY}" \
  -H "Content-Type: application/json" \
  --data-binary @- <<JSON
{
  "model": "${UNSLOTH_MODEL_ID}",
  "messages": [
    {"role": "user", "content": "Use add_integers to calculate 17 plus 25."}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "add_integers",
        "description": "Add two integers.",
        "parameters": {
          "type": "object",
          "properties": {
            "a": {"type": "integer"},
            "b": {"type": "integer"}
          },
          "required": ["a", "b"]
        }
      }
    }
  ],
  "tool_choice": "required",
  "temperature": 1.0,
  "top_p": 1.0,
  "min_p": 0.0,
  "reasoning_effort": "medium",
  "enable_tools": false,
  "max_tokens": 8192,
  "stream": false
}
JSON
```

Unsloth supports this client-side function-calling format; successful tool use also depends on the loaded model and its chat template. Check for a structured `choices[0].message.tool_calls` array. Your application executes client-defined functions: parse the arguments, run the function, then send the assistant's tool-call message and a `role: "tool"` result with the matching `tool_call_id` in the next request. This request disables Unsloth's built-in server-side tools so your application handles the defined function.

See the [curl and HTTP guide](https://unsloth.ai/docs/integrations/connect-curl-and-http-to-unsloth) and [Python SDK guide](https://unsloth.ai/docs/integrations/connect-python-sdk-to-unsloth) for additional endpoint examples.

#### Connect a coding agent {#unsloth-coding-agent}

Install your coding agent if it is not already available, load Muse Spark Open in Unsloth, and connect the agent:

**bash**

```bash
unsloth start claude
```

You can also select the model while launching the agent:

**bash**

```bash
unsloth start claude \
  --model unsloth/Muse-Spark-Open-816B-A42B-GGUF:UD-Q2_K_XL \
  --context-length 32768 \
  --temperature 1.0 \
  --top-p 1.0 \
  --min-p 0.0 \
  --reasoning-effort medium
```

On the default local address, passing `--model` starts a temporary server if Unsloth is not already running; that server stops when the agent exits. If Unsloth is already running, the launcher connects to it. Use `--temperature` for the Unsloth agent launcher. See [Unsloth Start](https://unsloth.ai/docs/integrations/unsloth-start) for supported agents and configuration options.

#### Explore other workflows {#unsloth-more}

- [Unsloth inference guide](https://unsloth.ai/docs/new/studio/chat): chat settings, web search, and Python or Bash execution.
- [Unsloth Desktop](https://unsloth.ai/docs/desktop): model downloads, training, and exporting workflows for supported models.
- [MCP integrations](https://unsloth.ai/docs/basics/mcp): connect additional tools.
- [llama.cpp](https://github.com/ggml-org/llama.cpp): run the GGUFs directly. Use a current build with Muse Spark Open support. Enable CUDA for NVIDIA GPUs; on Apple silicon, disable CUDA and use the default Metal backend.
- [llama-server documentation](https://github.com/ggml-org/llama.cpp/tree/master/tools/server): context sizing, GPU offload, threading, and sampling flags.

### MLX {#mlx}

Run Muse Spark Open on Apple silicon with MLX and the NVFP4 checkpoint. The model doesn't fit in one Mac's memory, so serve it across two Mac Studio computers with M5 Ultra and 512 GB of unified memory each, or four with 256 GB each. Four Macs serve fastest.

#### Links {#mlx-links}

- [NVFP4 weights on Hugging Face](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B-NVFP4)
- [mlx-lm on GitHub](https://github.com/ml-explore/mlx-lm)
- [MLX distributed documentation](https://ml-explore.github.io/mlx/build/html/usage/distributed.html)

#### Prerequisites {#mlx-prerequisites}

- **macOS 26.2 or later on every Mac.** It adds the RDMA-over-Thunderbolt driver that MLX's `jaccl` backend uses. Turn on RDMA on each Mac as described in the [MLX distributed documentation](https://ml-explore.github.io/mlx/build/html/usage/distributed.html).
- **MLX 0.30.1 or later.**
- **A direct Thunderbolt 5 link between every pair of Macs.** Connect each pair with two cables to double the link bandwidth. With four Macs, every Mac connects to each of the other three.
- **Passwordless SSH from the primary Mac to every other Mac.** These instructions call the primary `mac-studio-1.local` and the others `mac-studio-2.local` and so on; adjust the names to match your machines.

Check that the primary can reach each other Mac without a password prompt:

**bash**

```bash
ssh mac-studio-2.local 'echo ok'
```

If that prompts for a password, set up key-based access first:

**bash**

```bash
ssh-keygen -t ed25519
ssh-copy-id mac-studio-2.local
```

#### Install {#mlx-install}

`mlx.launch` starts the program over SSH on every Mac, so install mlx-lm on each one:

**bash**

```bash
pip install -U mlx-lm
```

Each Mac loads the model from its own disk, so each needs disk space for the full NVFP4 checkpoint.

#### Create the hostfile {#mlx-hostfile}

`mlx.launch` reads which Macs to use from a hostfile. List every Mac in it, two or four. For the `jaccl` backend, each entry also carries the host's Thunderbolt IP addresses and RDMA devices. The [MLX distributed documentation](https://ml-explore.github.io/mlx/build/html/usage/distributed.html) describes the format, and `mlx.distributed_config` can generate the file. These instructions save it as `hostfile.json` on the primary.

#### Start the server {#mlx-run-across-mac-studios}

Run this on the primary. It starts `mlx_lm.server` on every Mac in the hostfile and serves an OpenAI-compatible API on port 8080:

**bash**

```bash
mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \
  mlx_lm.server --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --port 8080
```

Everything after `--` is the program that `mlx.launch` runs on each Mac. `--backend jaccl` selects the RDMA-over-Thunderbolt backend. `--env MLX_METAL_FAST_SYNCH=1` turns on an experimental MLX feature for fast CPU-GPU synchronization, which cuts communication overhead between the CPU, which drives the Thunderbolt link, and the GPU, which does the compute.

#### Generate from the command line {#mlx-generate}

To test without a server, run `mlx_lm.generate` through the same launcher. The chat template defaults to `xhigh` reasoning, so leave room for reasoning tokens before the answer, and pass the [recommended sampling settings](https://dev.meta.ai/docs/muse-spark-open/settings):

**bash**

```bash
mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \
  mlx_lm.generate \
    --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
    --prompt "Give me a one-sentence summary of what you can do." \
    --max-tokens 4096 \
    --temp 1.0 \
    --top-p 1.0
```

## Hosted providers {#hosted-providers}

Call Muse Spark Open through a hosted provider when you'd rather not provision GPU capacity yourself. These providers serve the open weights:

| Provider                                                                       | Model string                                | Get a key                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Together AI](https://dev.meta.ai/docs/muse-spark-open/deploy#together-ai)     | `meta-models/muse-spark-open`               | [Together AI API keys](https://api.together.ai/settings/api-keys)                     |
| [Fireworks AI](https://dev.meta.ai/docs/muse-spark-open/deploy#fireworks-ai)   | `accounts/fireworks/models/muse-spark-open` | [API keys page](https://app.fireworks.ai/settings/users/api-keys)                     |
| [Baseten](https://dev.meta.ai/docs/muse-spark-open/deploy#baseten)             | `meta-models/muse-spark-open`               | [Baseten app](https://app.baseten.co/), Settings → API Keys                           |
| [Groq](https://dev.meta.ai/docs/muse-spark-open/deploy#groq)                   | `meta-models/muse-spark-open`               | [GroqCloud console](https://console.groq.com/keys), once your organization has access |
| [Nebius Token Factory](https://dev.meta.ai/docs/muse-spark-open/deploy#nebius) | `meta-models/muse-spark-open`               | [Token Factory API keys](https://tokenfactory.nebius.com/project/api-keys)            |

You can also call Muse Spark Open through [Modal](https://dev.meta.ai/docs/muse-spark-open/deploy#modal) and [OpenRouter](https://dev.meta.ai/docs/muse-spark-open/deploy#openrouter).

### Send a request {#hosted-send-a-request}

Pick your provider's tab:

**Together AI**

```bash
curl https://api.together.xyz/v1/chat/completions \
  -H "Authorization: Bearer $TOGETHER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-models/muse-spark-open",
    "messages": [{"role": "user", "content": "Explain mixture-of-experts models in two sentences."}]
  }'
```

**Fireworks AI**

```bash
curl https://api.fireworks.ai/inference/v1/chat/completions \
  -H "Authorization: Bearer $FIREWORKS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "accounts/fireworks/models/muse-spark-open",
    "messages": [{"role": "user", "content": "Explain mixture-of-experts models in two sentences."}],
    "max_tokens": 4096
  }'
```

**Baseten**

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["BASETEN_API_KEY"],
    base_url="https://inference.baseten.co/v1",
)

response = client.chat.completions.create(
    model="meta-models/muse-spark-open",
    messages=[{"role": "user", "content": "Explain what a stack trace is in two sentences."}],
)
print(response.choices[0].message.content)
```

**Groq**

```bash
# GroqCloud access requires approval for your organization; see Groq below.
curl https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-models/muse-spark-open",
    "reasoning_effort": "medium",
    "messages": [{"role": "user", "content": "What is the capital of France?"}]
  }'
```

**Nebius Token Factory**

```bash
curl https://api.tokenfactory.us-north1.nebius.com/v1/chat/completions \
  -H "Authorization: Bearer $NEBIUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-models/muse-spark-open",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}],
    "max_tokens": 16384
  }'
```

### Together AI {#together-ai}

Together AI serves Muse Spark Open on serverless and on-demand dedicated endpoints through an OpenAI-compatible API.

#### Links {#together-ai-links}

- [Muse Spark Open on Together AI](https://www.together.ai/models/muse-spark-open) has pricing and endpoint options.

#### Model string {#together-ai-model-string}

**Text**

```text
meta-models/muse-spark-open
```

#### Get a key {#together-ai-get-a-key}

Create an [API key](https://api.together.ai/settings/api-keys) and export it:

**bash**

```bash
export TOGETHER_API_KEY="YOUR_API_KEY"
```

#### Send requests {#together-ai-send-requests}

The base URL is `https://api.together.xyz/v1`. Any OpenAI-compatible client works.

**curl**

```bash
curl https://api.together.xyz/v1/chat/completions \
  -H "Authorization: Bearer $TOGETHER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-models/muse-spark-open",
    "messages": [{"role": "user", "content": "Explain mixture-of-experts models in two sentences."}]
  }'
```

### Fireworks AI {#fireworks-ai}

Fireworks serves Muse Spark Open on serverless inference. You pay per token and send requests to an OpenAI-compatible endpoint. There is no deployment to provision. The model accepts text and images, supports tool calling, and has a context window of 1,048,576 tokens. You can set how much the model reasons on each request with `reasoning_effort`.

For dedicated capacity, guaranteed throughput, or private networking, run the same model on an on-demand deployment.

#### Links {#fireworks-ai-links}

- [Muse Spark Open on Fireworks](https://fireworks.ai/models/fireworks/muse-spark-open) is the model page, with pricing and a playground.
- [Fireworks blog post on Muse Spark Open](https://fireworks.ai/blog/meta-muse-spark-open)
- [Fireworks quickstart](https://docs.fireworks.ai/getting-started/quickstart) covers account setup and your first request.
- [Post-train with Fireworks AI](https://dev.meta.ai/docs/muse-spark-open/post-training#fireworks-ai) covers LoRA fine-tuning and reinforcement learning on Muse Spark Open.

#### Model string {#fireworks-ai-model-string}

**Text**

```text
accounts/fireworks/models/muse-spark-open
```

#### Get a key {#fireworks-ai-get-a-key}

1. Create a Fireworks account at [fireworks.ai](https://fireworks.ai/).
2. Create an API key on the [API keys page](https://app.fireworks.ai/settings/users/api-keys), or run `firectl api-key create`.
3. Export the key:

**bash**

```bash
export FIREWORKS_API_KEY="fw_..."
```

#### Send requests {#fireworks-ai-send-requests}

The base URL is `https://api.fireworks.ai/inference/v1`. Any OpenAI-compatible client works.

**curl**

```bash
curl https://api.fireworks.ai/inference/v1/chat/completions \
  -H "Authorization: Bearer $FIREWORKS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "accounts/fireworks/models/muse-spark-open",
    "messages": [{"role": "user", "content": "Explain mixture-of-experts models in two sentences."}],
    "max_tokens": 4096
  }'
```

With the OpenAI Python SDK:

**bash**

```bash
pip install openai
```

**Python**

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["FIREWORKS_API_KEY"],
    base_url="https://api.fireworks.ai/inference/v1",
)

response = client.chat.completions.create(
    model="accounts/fireworks/models/muse-spark-open",
    messages=[{"role": "user", "content": "Explain mixture-of-experts models in two sentences."}],
    max_tokens=4096,
)
print(response.choices[0].message.content)
```

**Reasoning effort.** Muse Spark Open always reasons. Set `reasoning_effort` to `low`, `medium`, `high`, or `xhigh`. The default is `xhigh`. Higher settings think longer and cost more output tokens. Use `xhigh` for hard reasoning, coding, and agentic tasks. Reasoning is returned in `reasoning_content`, separate from `content`. Thinking cannot be turned off, so `reasoning_effort="none"` is rejected.

**Python**

```python
# Uses the client from the first Python example in this section
response = client.chat.completions.create(
    model="accounts/fireworks/models/muse-spark-open",
    messages=[{"role": "user", "content": "How many primes are there below 1000?"}],
    reasoning_effort="xhigh",
    max_tokens=32768,
)
```

**Images.** Pass image URLs or base64 data URLs in the message content.

**Python**

```python
# Uses the client from the first Python example in this section
response = client.chat.completions.create(
    model="accounts/fireworks/models/muse-spark-open",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What is in this image?"},
            {"type": "image_url", "image_url": {"url": "http://images.cocodataset.org/val2017/000000039769.jpg"}},
        ],
    }],
)
```

**Tool calling.** Pass `tools` in the OpenAI function-calling format. Tool calls come back in `message.tool_calls`.

**Python**

```python
# Uses the client from the first Python example in this section
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

response = client.chat.completions.create(
    model="accounts/fireworks/models/muse-spark-open",
    messages=[{"role": "user", "content": "What's the weather in Menlo Park?"}],
    tools=tools,
)
print(response.choices[0].message.tool_calls)
```

Streaming (`stream=True`) and JSON mode (`response_format={"type": "json_object"}`) work the same way they do for other Fireworks chat models.

#### More {#fireworks-ai-more}

- Serverless is billed per token for input, cached input, and output. Current rates are on the [model page](https://fireworks.ai/models/fireworks/muse-spark-open).
- Prompt caching is automatic. Repeated prefixes, such as long system prompts and agent histories, are billed at the cached-input rate.
- For dedicated GPUs, higher rate limits, or reserved throughput, create an [on-demand deployment](https://docs.fireworks.ai/guides/ondemand-deployments) of the same model, or [contact Fireworks](https://fireworks.ai/contact).
- Fireworks also serves an [Anthropic-compatible Messages API](https://docs.fireworks.ai/tools-sdks/anthropic-compatibility), so Muse Spark Open can run in coding agents built for that API.

### Baseten {#baseten}

Baseten serves Muse Spark Open on Model APIs (serverless, pay per token) and Dedicated Inference (single-tenant capacity), with the full 1,048,576-token context window and text, image, video, and audio input.

#### Links {#baseten-links}

- [Baseten launch blog post for Muse Spark Open](https://www.baseten.co/blog/muse-spark-open-launch/)
- [Baseten model page for Muse Spark Open](https://www.baseten.co/library/muse-spark-open)
- [Baseten docs](https://docs.baseten.co/)

#### Model string {#baseten-model-string}

**Text**

```text
meta-models/muse-spark-open
```

#### Get a key {#baseten-get-a-key}

1. Create an account in the [Baseten app](https://app.baseten.co/).
2. Go to Settings → API Keys and create a key.

#### Send requests {#baseten-send-requests}

The endpoint is OpenAI-compatible. Point any OpenAI client at Baseten:

**Python**

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["BASETEN_API_KEY"],
    base_url="https://inference.baseten.co/v1",
)

response = client.chat.completions.create(
    model="meta-models/muse-spark-open",
    messages=[{"role": "user", "content": "Explain what a stack trace is in two sentences."}],
)
print(response.choices[0].message.content)
```

Image, video, and audio inputs use the standard OpenAI content-part format (`image_url`, `video_url`, `audio_url`). Send media larger than \~74 MB by URL rather than inline base64; video inputs by URL are supported up to 200 MB.

#### More {#baseten-more}

- Pricing: see the [Baseten model page for Muse Spark Open](https://www.baseten.co/library/muse-spark-open).
- The video encoder samples at most 96 frames per clip: a 720p clip costs about 144 tokens per second, capped at \~6.9K tokens from about 48 seconds on, so longer clips (up to 300 s) cost no more than that.

### Modal {#modal}

Modal serves Muse Spark Open. See [Muse Spark Open on Modal](https://modal.com/library/meta/muse-spark-open) for setup and request examples, and the [Modal blog post on Muse Spark Open](https://modal.com/blog/meta-muse-spark-open-now-available-on-modal).

### OpenRouter {#openrouter}

OpenRouter routes requests to upstream providers rather than hosting the model, so the provider serving your request depends on your routing configuration. See [Muse Spark Open on OpenRouter](https://openrouter.ai/meta/muse-spark-open) for the model string and setup.

### Groq {#groq}

GroqCloud serves Muse Spark Open through an OpenAI-compatible API. Access requires approval for your organization; to request it, [contact the Groq team](https://groq.com/muse-spark-open).

#### Links {#groq-links}

- [Muse Spark Open on GroqCloud](https://console.groq.com/docs/model/meta-models/muse-spark-open)
- [Groq blog post on Muse Spark Open](https://groq.com/blog/meta-s-muse-spark-open-release-is-now-in-limited-preview-on-groqcloud)
- [Groq reasoning guide](https://console.groq.com/docs/reasoning)
- [Groq SDKs](https://console.groq.com/docs/libraries)

#### Model string {#groq-model-string}

**Text**

```text
meta-models/muse-spark-open
```

On GroqCloud the model has a 131,072-token context window and supports tool calling, structured outputs, and image input.

#### Get a key {#groq-get-a-key}

Once your organization has access, create an API key in the [GroqCloud console](https://console.groq.com/keys) and export it:

**bash**

```bash
export GROQ_API_KEY="YOUR_API_KEY"
```

#### Send requests {#groq-send-requests}

The base URL is `https://api.groq.com/openai/v1`. Use a Groq SDK, or any OpenAI SDK with `base_url` set to that URL.

**curl**

```bash
curl https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-models/muse-spark-open",
    "reasoning_effort": "medium",
    "messages": [{"role": "user", "content": "What is the capital of France?"}]
  }'
```

`reasoning_effort` accepts `low`, `medium`, `high`, or `xhigh`, and defaults to `xhigh`. Lower settings respond faster. See [Reasoning strength](https://dev.meta.ai/docs/muse-spark-open/settings#reasoning-strength).

#### More {#groq-more}

For access questions, contact [Groq sales](mailto:sales@groq.com).

### Nebius Token Factory {#nebius}

Nebius Token Factory serves Muse Spark Open on a serverless endpoint with an OpenAI-compatible API. You pay per token. To send a request, you need an API key and the model ID below.

#### Links {#nebius-links}

- [Muse Spark Open on Token Factory](https://tokenfactory.nebius.com/?modals=endpoint-details\&model-id=meta-models/muse-spark-open) has current endpoint details, pricing, and availability.
- [Token Factory Playground](https://tokenfactory.nebius.com/playground?models=meta-models/muse-spark-open) lets you try the model in the browser.

#### Model string {#nebius-model-string}

The model ID is case-sensitive:

**Text**

```text
meta-models/muse-spark-open
```

Set your client's base URL to:

**Text**

```text
https://api.tokenfactory.us-north1.nebius.com/v1/
```

#### Get a key {#nebius-get-a-key}

1. [Create a Token Factory account](https://tokenfactory.nebius.com/) or sign in.
2. Complete [billing setup](https://docs.tokenfactory.nebius.com/other-capabilities/billing-new). New accounts need a bank card.
3. Select your project and open [API keys](https://tokenfactory.nebius.com/project/api-keys).
4. Create a key and copy it. You can't view it again later.
5. Export the key:

**bash**

```bash
export NEBIUS_API_KEY="YOUR_API_KEY"
```

Keep the key out of source code and browser applications. Check that the key can list models:

**bash**

```bash
curl --fail-with-body --silent --show-error \
  https://api.tokenfactory.us-north1.nebius.com/v1/models \
  -H "Authorization: Bearer $NEBIUS_API_KEY"
```

Look for `meta-models/muse-spark-open` in the response. If it's missing, check model availability for the project that owns your key.

#### Send requests {#nebius-send-requests}

**curl**

```bash
curl --fail-with-body --silent --show-error \
  https://api.tokenfactory.us-north1.nebius.com/v1/chat/completions \
  -H "Authorization: Bearer $NEBIUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-models/muse-spark-open",
    "messages": [
      {"role": "user", "content": "Say hello in one sentence."}
    ],
    "max_tokens": 16384
  }'
```

The answer is in `choices[0].message.content`.

With the OpenAI Python SDK:

**bash**

```bash
pip install openai
```

**Python**

```python
import os

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["NEBIUS_API_KEY"],
    base_url="https://api.tokenfactory.us-north1.nebius.com/v1/",
)

response = client.chat.completions.create(
    model="meta-models/muse-spark-open",
    messages=[{"role": "user", "content": "Say hello in one sentence."}],
    max_tokens=16384,
)

print(response.choices[0].message.content)
```

**Tool calling.** Pass `tools` in the OpenAI function-calling format. This request asks for a `get_weather` call with a `city` argument:

**Python**

```python
# Uses the client from the first Python example in this section
response = client.chat.completions.create(
    model="meta-models/muse-spark-open",
    messages=[{"role": "user", "content": "What is the weather in Paris?"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a city.",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
                "additionalProperties": False,
            },
        },
    }],
    tool_choice={"type": "function", "function": {"name": "get_weather"}},
    max_tokens=16384,
)

for call in response.choices[0].message.tool_calls or []:
    print(call.id, call.function.name, call.function.arguments)
```

The request doesn't fetch the weather itself. Your application runs the function and sends the result back with the returned call ID. See the [Chat Completions reference](https://docs.tokenfactory.nebius.com/api-reference/inference/create-chat-completion) for the `tools` and tool-message fields.

#### More {#nebius-more}

- [Token Factory quickstart](https://docs.tokenfactory.nebius.com/quickstart) covers account setup and your first request.
- [API documentation](https://docs.tokenfactory.nebius.com/api-reference/examples/overview) lists endpoints, request parameters, and response formats.
- [Token Factory Cookbook](https://github.com/nebius/token-factory-cookbook) has reusable code examples and sample applications.

## Next steps {#next-steps}

Once your server is up, set the sampling parameters, parallelism, and stop tokens from the [recommended settings](https://dev.meta.ai/docs/muse-spark-open/settings), and frame your requests with the [prompting guide](https://dev.meta.ai/docs/muse-spark-open/prompting). To fine-tune the model, see [Post-training](https://dev.meta.ai/docs/muse-spark-open/post-training).

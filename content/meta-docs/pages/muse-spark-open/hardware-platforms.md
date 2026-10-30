# Hardware platforms {#hardware-platforms}

Run Muse Spark Open on NVIDIA, AMD, Intel, and Apple hardware. Each section lists the checkpoints, parallelism, and runtime for its platform, with sample commands. Pick a platform to jump to it.

| Vendor                                                                       | Accelerator                                                           | Checkpoints      | Runtime                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------- | ----------------------------------------- |
| [NVIDIA](https://dev.meta.ai/docs/muse-spark-open/hardware-platforms#nvidia) | Blackwell, such as B300 and GB300 (4 GPUs for NVFP4, 8 for BF16)      | BF16, NVFP4      | SGLang, vLLM, TensorRT-LLM, NVIDIA Dynamo |
| [AMD](https://dev.meta.ai/docs/muse-spark-open/hardware-platforms#amd)       | Instinct MI355X or MI350X (8 GPUs)                                    | BF16, MXFP4, FP8 | vLLM                                      |
| [Intel](https://dev.meta.ai/docs/muse-spark-open/hardware-platforms#intel)   | Xeon 6 with P-cores, such as the 6980P                                | INT4             | SGLang                                    |
| [Apple](https://dev.meta.ai/docs/muse-spark-open/hardware-platforms#apple)   | Mac Studio with M5 Ultra (2 × 512 GB or 4 × 256 GB of unified memory) | NVFP4            | MLX                                       |

For SGLang and vLLM on NVIDIA GPUs, see [Run inference](https://dev.meta.ai/docs/muse-spark-open/deploy).

## NVIDIA {#nvidia}

Validated serving configurations for Muse Spark Open are maintained in the runtime recipe databases; start from those rather than hand-tuning.

- TensorRT-LLM: the pareto-optimized serving configuration database at [`examples/configs/database/`](https://github.com/NVIDIA/TensorRT-LLM/tree/feat/musespark-open/examples/configs/database), the [Muse Spark Open deployment guide](https://github.com/NVIDIA/TensorRT-LLM/blob/feat/musespark-open/docs/source/deployment-guide/deployment-guide-for-musespark-open-on-trtllm.md), and the [speculative-decoding deployment guide](https://github.com/NVIDIA/TensorRT-LLM/blob/feat/musespark-open/docs/source/deployment-guide/deployment-guide-for-musespark-open-speculative-decoding-on-trtllm.md). See also [Deploy with TensorRT-LLM](https://dev.meta.ai/docs/muse-spark-open/deploy#tensorrt-llm).
- Dynamo deployment recipes: the [Muse Spark Open Dynamo recipe](https://docs.nvidia.com/dynamo/recipes/Muse-Spark-Open). See also [Deploy with NVIDIA Dynamo](https://dev.meta.ai/docs/muse-spark-open/deploy#dynamo).

Hardware notes not covered by the recipe sources:

| Checkpoint                                  | Accelerator         | GPUs | Parallelism | KV cache | Runtime      |
| ------------------------------------------- | ------------------- | ---- | ----------- | -------- | ------------ |
| meta-models/Muse-Spark-Open-816B-A42B-NVFP4 | GB300 NVL (`SM103`) | 4    | TP4, EP4    | FP8      | TensorRT-LLM |

The NVFP4 checkpoint fits on a single NVIDIA Blackwell (`SM100` family) 4-GPU node, with attention tensor-parallel 4-way and the 256 routed experts sharded 4-way. The configuration above was validated on GB300 NVL with TensorRT-LLM. The FP8 KV cache is required on `SM103` when chunked prefill or KV-cache block reuse is enabled, and the recommended TensorRT-LLM configuration enables both; see [Deploy with TensorRT-LLM](https://dev.meta.ai/docs/muse-spark-open/deploy#tensorrt-llm).

## AMD {#amd}

| Checkpoint                                   | Accelerator      | GPUs | Parallelism | KV cache | Runtime |
| -------------------------------------------- | ---------------- | ---- | ----------- | -------- | ------- |
| meta-models/Muse-Spark-Open-816B-A42B        | MI355X or MI350X | 8    | TP8         | GPU      | vLLM    |
| amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4    | MI355X or MI350X | 8    | TP8+EP8     | GPU      | vLLM    |
| amd/Muse-Spark-Open-816B-A42B-Quark-PTPC-FP8 | MI355X or MI350X | 8    | TP8+EP8     | GPU      | vLLM    |

### Sample commands {#amd-sample-command}

#### BF16 {#amd-bf16}

**bash**

```bash
export VLLM_ROCM_USE_AITER=1
export VLLM_ROCM_MUSE_MOE_REDUCE_DTYPE=bf16

COMMON_ARGS="--host 127.0.0.1 --port 8006 --served-model-name musespark \
  --tokenizer-mode hf --config-format auto --load-format safetensors --generation-config vllm \
  --language-model-only --dtype bfloat16 \
  --tensor-parallel-size 8 --distributed-executor-backend mp --attention-backend ROCM_AITER_FA \
  --max-model-len 32768 --max-num-batched-tokens 4096 --gpu-memory-utilization 0.95 \
  --enable-chunked-prefill \
  --reasoning-parser muse --tool-call-parser muse --enable-auto-tool-choice"

CG='--compilation-config {"cudagraph_mode":"FULL_AND_PIECEWISE"}'

vllm serve meta-models/Muse-Spark-Open-816B-A42B \
  $COMMON_ARGS $CG --moe-backend triton --max-num-seqs 32
```

#### BF16 checkpoint with online MXFP4 experts {#amd-bf16-checkpoint-with-online-mxfp4-experts}

**bash**

```bash
export VLLM_ROCM_USE_AITER=1
export VLLM_ROCM_MUSE_MOE_REDUCE_DTYPE=bf16

COMMON_ARGS="--host 127.0.0.1 --port 8006 --served-model-name musespark \
  --tokenizer-mode hf --config-format auto --load-format safetensors --generation-config vllm \
  --language-model-only --dtype bfloat16 \
  --tensor-parallel-size 8 --distributed-executor-backend mp --attention-backend ROCM_AITER_FA \
  --max-model-len 32768 --max-num-batched-tokens 8192 --gpu-memory-utilization 0.90 \
  --enable-chunked-prefill \
  --reasoning-parser muse --tool-call-parser muse --enable-auto-tool-choice"

CG='--compilation-config {"cudagraph_mode":"FULL_AND_PIECEWISE"}'

VLLM_ROCM_MUSE_MOE_ONLINE_QUANT=mxfp4 vllm serve meta-models/Muse-Spark-Open-816B-A42B \
  $COMMON_ARGS $CG --max-num-seqs 128
```

#### MXFP4 {#amd-mxfp4}

**bash**

```bash
export VLLM_ROCM_USE_AITER=1
export VLLM_ROCM_MUSE_MOE_REDUCE_DTYPE=bf16

COMMON_ARGS="--host 127.0.0.1 --port 8006 --served-model-name musespark \
  --tokenizer-mode hf --config-format auto --load-format safetensors --generation-config vllm \
  --language-model-only --dtype bfloat16 \
  --tensor-parallel-size 8 --distributed-executor-backend mp --attention-backend ROCM_AITER_FA \
  --max-model-len 32768 --max-num-batched-tokens 8192 --gpu-memory-utilization 0.90 \
  --enable-chunked-prefill \
  --reasoning-parser muse --tool-call-parser muse --enable-auto-tool-choice"

CG='--compilation-config {"cudagraph_mode":"FULL_AND_PIECEWISE"}'

vllm serve amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4 \
  $COMMON_ARGS $CG --max-num-seqs 128
```

Throughput mode:

**bash**

```bash
export VLLM_ROCM_USE_AITER=1
export VLLM_ROCM_MUSE_MOE_REDUCE_DTYPE=bf16

COMMON_ARGS="--host 127.0.0.1 --port 8006 --served-model-name musespark \
  --tokenizer-mode hf --config-format auto --load-format safetensors --generation-config vllm \
  --language-model-only --dtype bfloat16 \
  --tensor-parallel-size 8 --distributed-executor-backend mp --attention-backend ROCM_AITER_FA \
  --max-model-len 32768 --max-num-batched-tokens 8192 --gpu-memory-utilization 0.90 \
  --enable-chunked-prefill \
  --reasoning-parser muse --tool-call-parser muse --enable-auto-tool-choice"

CG='--compilation-config {"cudagraph_mode":"FULL_AND_PIECEWISE"}'

vllm serve amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4 \
  $COMMON_ARGS $CG --max-num-seqs 128 --enable-expert-parallel
```

Lowest latency mode:

**bash**

```bash
export VLLM_ROCM_USE_AITER=1
export VLLM_ROCM_MUSE_MOE_REDUCE_DTYPE=bf16

COMMON_ARGS="--host 127.0.0.1 --port 8006 --served-model-name musespark \
  --tokenizer-mode hf --config-format auto --load-format safetensors --generation-config vllm \
  --language-model-only --dtype bfloat16 \
  --tensor-parallel-size 8 --distributed-executor-backend mp --attention-backend ROCM_AITER_FA \
  --max-model-len 32768 --max-num-batched-tokens 8192 --gpu-memory-utilization 0.90 \
  --enable-chunked-prefill \
  --reasoning-parser muse --tool-call-parser muse --enable-auto-tool-choice"

CG='--compilation-config {"cudagraph_mode":"FULL_AND_PIECEWISE"}'

VLLM_KV_CACHE_LAYOUT=LBHNC vllm serve amd/Muse-Spark-Open-816B-A42B-Quark-MXFP4 \
  $COMMON_ARGS $CG --max-num-seqs 32 \
  --speculative-config '{"method":"dspark","model":"Inferact/Muse-Spark-Open-DSpark","num_speculative_tokens":7}'
```

#### FP8 {#amd-fp8}

**bash**

```bash
export VLLM_ROCM_USE_AITER=1
export SAFETENSORS_FAST_GPU=1

COMMON_ARGS="--host 127.0.0.1 --port 8006 --served-model-name musespark \
  --tokenizer-mode hf --config-format auto --load-format safetensors --generation-config vllm \
  --language-model-only --dtype bfloat16 \
  --tensor-parallel-size 8 --distributed-executor-backend mp --attention-backend ROCM_AITER_FA \
  --max-model-len 32768 --max-num-batched-tokens 8192 --gpu-memory-utilization 0.90 \
  --enable-chunked-prefill \
  --reasoning-parser muse --tool-call-parser muse --enable-auto-tool-choice"

CG='--compilation-config {"cudagraph_mode":"FULL_AND_PIECEWISE"}'

vllm serve amd/Muse-Spark-Open-816B-A42B-Quark-PTPC-FP8 \
  $COMMON_ARGS $CG \
  --max-num-seqs 128 \
  --enable-expert-parallel \
  --moe-backend triton
```

## Intel {#intel}

| Checkpoint | Hugging Face repo                         | Hardware                                     | Runtime |
| ---------- | ----------------------------------------- | -------------------------------------------- | ------- |
| INT4       | `intel-ai/Muse-Spark-Open-816B-A42B-INT4` | Intel Xeon 6 with P-cores, such as the 6980P | SGLang  |

**bash**

```bash
python -m sglang.launch_server \
  --model-path intel-ai/Muse-Spark-Open-816B-A42B-INT4 \
  --quantization gptq \
  --tp-size 2 \
  --reasoning-parser muse --tool-call-parser muse
```

- [Intel launch blog for Muse Spark Open](https://www.intel.com/content/www/us/en/newsroom/news/artificial-intelligence/intel-offers-day-0-support-for-meta-muse-spark.html)
- [SGLang launch blog for Muse Spark Open](https://www.lmsys.org/blog/2026-10-15-meta-muse-spark-open)
- [SGLang cookbook page for Muse Spark Open](https://docs.sglang.io/cookbook/autoregressive/Meta/MuseSparkOpen)

## Apple {#apple}

| Checkpoint                                  | Hardware                                                                                           | Runtime |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------- |
| meta-models/Muse-Spark-Open-816B-A42B-NVFP4 | Two Mac Studio computers with M5 Ultra and 512 GB of unified memory each, or four with 256 GB each | MLX     |

MLX splits the model across the Macs over RDMA on Thunderbolt 5, which needs macOS 26.2 or later and a direct link between every pair of Macs. For setup and commands, see [Run inference › MLX](https://dev.meta.ai/docs/muse-spark-open/deploy#mlx).

## Next steps {#next-steps}

For every runtime and its full flag set, see [Run inference](https://dev.meta.ai/docs/muse-spark-open/deploy). To size parallelism and context length for your workload, see [Recommended settings](https://dev.meta.ai/docs/muse-spark-open/settings).

# Hardware platforms {#hardware-platforms}

Run Muse Glimmer on specific partner hardware. Each partner verified its deployment on its own machines at the software versions listed; we don't re-run these verifications. Pick a platform to jump to its deploy steps.

| Vendor | Platform                                                                                              | Class  | Accelerator           | Memory                          | Precisions verified |
| ------ | ----------------------------------------------------------------------------------------------------- | ------ | --------------------- | ------------------------------- | ------------------- |
| Intel  | [Arc Pro GPU (server)](https://dev.meta.ai/docs/muse-glimmer/hardware-platforms#intel-arc-pro-server) | Server | Arc Pro B70 × 2       | 32 GB per accelerator           | bf16                |
| Intel  | [Xeon 6 6980P](https://dev.meta.ai/docs/muse-glimmer/hardware-platforms#intel-xeon-6)                 | Server | CPU only              | More than 512 GB DDR5 suggested | bf16                |
| NVIDIA | [B300](https://dev.meta.ai/docs/muse-glimmer/hardware-platforms#nvidia-b300)                          | Server | B300 × 1 (8-GPU node) | 288 GB HBM3e per GPU            | bf16                |

SGLang publishes its own matrix of verified GPUs and Apple silicon; see [Choose a checkpoint](https://dev.meta.ai/docs/muse-glimmer/deploy#sglang-checkpoints) on Run inference.

## Intel {#intel}

Intel verified Muse Glimmer with vLLM on Arc Pro GPUs and Xeon processors. Intel's day-0 guide, [Day-0 Muse Glimmer Support on Intel Platforms with vLLM and Hugging Face](https://huggingface.co/blog/MatrixYao/muse-glimmer-day0), adds the tool-calling flags and a Hugging Face Transformers alternative, including DFlash speculative decoding on Xeon.

### Arc Pro GPU (server) {#intel-arc-pro-server}

|                    |                                          |
| ------------------ | ---------------------------------------- |
| Accelerator        | Arc Pro B70 × 2                          |
| Memory             | 32 GB GDDR6 per card                     |
| Memory bandwidth   | 608 GB/s                                 |
| Host OS tested     | Ubuntu 24.04                             |
| Driver and runtime | Level Zero 1.28.2 (check with `xpu-smi`) |
| Model server       | vLLM `main` branch                       |
| Disk               | 80 GB free for the bf16 weights          |
| Verified           | Intel, 2026-08-09                        |

Build and enter the vLLM XPU container:

**bash**

```bash
git clone https://github.com/vllm-project/vllm.git
cd vllm
docker build -f docker/Dockerfile.xpu -t vllm-xpu-env --shm-size=4g .
docker run -it --rm --network=host --ipc=host --privileged \
                 --device /dev/dri:/dev/dri \
                 -v /dev/dri/by-path:/dev/dri/by-path \
                 --entrypoint bash \
                 vllm-xpu-env
```

Download the weights and serve across both cards:

**bash**

```bash
hf download meta-models/Muse-Glimmer-30B --local-dir ./muse-glimmer-bf16

ZE_AFFINITY_MASK=0,1  \
python -m vllm.entrypoints.openai.api_server \
  --model ./muse-glimmer-bf16 \
  --served-model-name muse-glimmer \
  --reasoning-parser muse_glimmer \
  --enforce-eager \
  --tensor-parallel-size 2
```

Tensor parallelism across more accelerators, such as `--tensor-parallel-size 4`, also works. Intel reports validating this path on Arc Pro B70 and Arc Pro B60.

| Precision | Status   | Artifact                       |
| --------- | -------- | ------------------------------ |
| bf16      | Verified | `meta-models/Muse-Glimmer-30B` |

### Xeon 6 6980P {#intel-xeon-6}

|                  |                                                           |
| ---------------- | --------------------------------------------------------- |
| Accelerator      | None, CPU only                                            |
| Memory           | Depends on the DDR5 installed; more than 512 GB suggested |
| Memory bandwidth | 1228.8 GB/s                                               |
| Host OS tested   | Ubuntu 24.04                                              |
| Model server     | vLLM `main` branch                                        |
| Disk             | 80 GB free for the bf16 weights                           |
| Verified         | Intel, 2026-08-09                                         |

Build and enter the vLLM CPU container:

**bash**

```bash
git clone https://github.com/vllm-project/vllm.git
cd vllm
docker build -f docker/Dockerfile.cpu \
        --tag vllm-cpu-env \
        --target vllm-openai .
docker run -it --rm \
            --privileged \
            --shm-size=4g \
            --entrypoint bash \
            --name vllm-cpu-env \
            vllm-cpu-env
```

Download the weights and serve:

**bash**

```bash
hf download meta-models/Muse-Glimmer-30B --local-dir ./muse-glimmer-bf16

vllm serve ./muse-glimmer-bf16 \
    --served-model-name muse-glimmer \
    -tp "<TP_SIZE>" \
    --dtype=bfloat16 \
    --trust-remote-code --enable-auto-tool-choice \
    --tool-call-parser muse_glimmer \
    --reasoning-parser muse_glimmer \
    --generation-config auto
```

Confirm the deploy with the [vLLM tool-calling check](https://dev.meta.ai/docs/muse-glimmer/deploy#vllm-tool-calling).

| Precision | Status   | Artifact                       |
| --------- | -------- | ------------------------------ |
| bf16      | Verified | `meta-models/Muse-Glimmer-30B` |

For Arc Pro and Xeon issues, use the [vLLM issue tracker](https://github.com/vllm-project/vllm/issues) and the [vLLM installation docs](https://docs.vllm.ai/en/stable/getting_started/installation/).

## NVIDIA {#nvidia}

NVIDIA data-center GPUs run Muse Glimmer with vLLM on the standard CUDA stack, with no plugins. The serving path is the same as the [vLLM](https://dev.meta.ai/docs/muse-glimmer/deploy#vllm) section. Once vLLM is serving, any agent harness can drive the OpenAI-compatible endpoint. NVIDIA's [NemoClaw](https://github.com/NVIDIA/NemoClaw) is one: it runs the agent loop in a sandbox with filesystem, network, and credential policy in front of the tools.

### B300 {#nvidia-b300}

|                    |                                                                                  |
| ------------------ | -------------------------------------------------------------------------------- |
| Accelerator        | B300 SXM6 AC × 8 (compute capability 10.3)                                       |
| Memory             | 288 GB HBM3e per GPU (275,040 MiB reported)                                      |
| Memory bandwidth   | About 8 TB/s per GPU                                                             |
| Host OS tested     | Ubuntu 24.04.3 LTS                                                               |
| Driver and runtime | Driver 580.167.08 or later (580 or later for Blackwell Ultra sm\_103), CUDA 13.0 |
| Python             | 3.10 or later (tested on 3.12.3)                                                 |
| Model server       | vLLM `0.1.dev19055+g6b0c510ec`, torch 2.13.0+cu130, transformers 5.14.1          |
| Disk               | 80 GB free for the bf16 weights                                                  |
| Verified           | NVIDIA, 2026-08-10                                                               |

**bash**

```bash
hf download meta-models/Muse-Glimmer-30B --local-dir ./muse-glimmer-bf16
```

**bash**

```bash
docker run --rm --gpus all --ipc=host \
  -p 8000:8000 \
  -v "$PWD/muse-glimmer-bf16:/model" \
  vllm/vllm-openai:muse-glimmer \
  /model \
  --served-model-name muse-glimmer \
  --tensor-parallel-size 1 \
  --enable-auto-tool-choice \
  --tool-call-parser muse_glimmer \
  --reasoning-parser muse_glimmer \
  --generation-config auto
```

The bf16 weights fit on a single B300, so `--tensor-parallel-size 1` is correct on an 8-GPU node too. NVIDIA took its measurements on the vLLM build in the spec table rather than this container; the flags are the same. Confirm the deploy with the [vLLM tool-calling check](https://dev.meta.ai/docs/muse-glimmer/deploy#vllm-tool-calling).

| Precision | Status   | Artifact                       | Notes                  |
| --------- | -------- | ------------------------------ | ---------------------- |
| bf16      | Verified | `meta-models/Muse-Glimmer-30B` | Fits on a single B300. |

NVIDIA measured these single-GPU numbers on 2026-08-09. The node has eight B300s, but the sweep used one, without tensor parallelism:

| Concurrency | TTFT p50  | Output tok/s per request | Output tok/s total |
| ----------- | --------- | ------------------------ | ------------------ |
| 1           | 215.6 ms  | 85.76                    | 76.83              |
| 2           | 307.3 ms  | 84.44                    | 148.81             |
| 4           | 395.3 ms  | 81.99                    | 280.96             |
| 8           | 618.7 ms  | 77.37                    | 503.27             |
| 16          | 979.7 ms  | 67.26                    | 830.71             |
| 32          | 1747.9 ms | 53.29                    | 1,224.67           |
| 64          | 2760.0 ms | 36.53                    | 1,632.21           |
| 128         | 3432.2 ms | 19.69                    | 1,912.99           |
| 256         | 2790.0 ms | 9.88                     | 2,093.52           |

The run used vLLM `0.1.dev19055+g6b0c510ec`, torch 2.13.0+cu130, driver 580.167.08, and CUDA 13.0, with 2048 input tokens, 256 output tokens, and a 32768-token prefix cache. Reproduce it with:

**bash**

```bash
aiperf profile --model '/model' --tokenizer '/model' --url 'http://localhost:8000' \
  --endpoint-type 'chat' --streaming \
  --num-prefix-prompts 1 --prefix-prompt-length 32768 \
  --num-dataset-entries 10240 --dataset-sampling-strategy 'shuffle' --random-seed 7 \
  --isl 2048 --isl-stddev 0 --osl 256 --osl-stddev 0 \
  --concurrency '1,2,4,8,16,32,64,128,256' \
  --request-count '10,20,40,80,160,320,640,1280,2560' \
  --sweep-type 'zip' --warmup-request-count 3 --num-profile-runs 1 \
  --use-server-token-count --use-legacy-max-tokens \
  --extra-inputs 'max_tokens:256' --extra-inputs 'min_tokens:256' \
  --extra-inputs 'ignore_eos:true' --extra-inputs 'temperature:0'
```

## Troubleshoot a deployment {#troubleshooting}

These fixes apply on every platform above.

| Symptom                            | Cause                                | Fix                                                                                                                                                               |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool calls returned as plain text  | Parser not enabled                   | Pass both `--enable-auto-tool-choice` and `--tool-call-parser muse_glimmer`. The chat template ships with the checkpoint, so no `--chat-template` flag is needed. |
| Generation never stops             | The runtime overrode the stop tokens | Confirm `<\|eom\|>` isn't in `eos_token_id`, and serve with `--generation-config auto`.                                                                           |
| Out of memory at large batch sizes | KV cache exhausted                   | Lower `--max-num-seqs` or `--max-model-len`.                                                                                                                      |

## Next steps {#next-steps}

For every runtime and its full flag set, see [Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy). To shrink the model for smaller hardware, see [quantization](https://dev.meta.ai/docs/muse-glimmer/quantization).

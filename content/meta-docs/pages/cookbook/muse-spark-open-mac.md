# Muse Spark Open on Mac {#muse-spark-open-on-mac}

|                      |                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Section**          | [Run locally](https://dev.meta.ai/docs/cookbook#run-locally)                                                                                                                                                                          |
| **Time to complete** | \~4 hours                                                                                                                                                                                                                             |
| **Model**            | Muse Spark Open                                                                                                                                                                                                                       |
| **Harness**          | `mlx-lm` across Thunderbolt-linked Mac Studios                                                                                                                                                                                        |
| **Prerequisites**    | Two Mac Studio computers with M5 Ultra and 512 GB of unified memory each, or four with 256 GB each; macOS 26.2 or later; a direct Thunderbolt 5 link between every pair of Macs; disk space for the full NVFP4 checkpoint on each Mac |

***

## How it works {#how-it-works}

The model doesn't fit in one Mac's memory. `mlx.launch` starts the same mlx-lm program on every Mac over SSH. Each Mac loads its share of the model, and the Macs exchange intermediate results over RDMA on Thunderbolt 5, through MLX's `jaccl` backend. Four Macs serve fastest.

***

## Before you start {#before-you-start}

- **macOS 26.2 or later on every Mac.** It adds the RDMA-over-Thunderbolt driver that `jaccl` uses. Turn on RDMA on each Mac as described in the [MLX distributed documentation](https://ml-explore.github.io/mlx/build/html/usage/distributed.html).
- **MLX 0.30.1 or later.**
- **A direct Thunderbolt 5 link between every pair of Macs.** Connect each pair with two cables to double the link bandwidth. With four Macs, every Mac connects to each of the other three.
- **Passwordless SSH from the primary Mac to every other Mac.** These instructions call the primary `mac-studio-1.local` and the others `mac-studio-2.local` and so on; adjust the names to match your machines.

Check that the primary can reach each other Mac without a password prompt:

```bash
ssh mac-studio-2.local 'echo ok'
```

If that prompts for a password, set up key-based access first:

```bash
ssh-keygen -t ed25519
ssh-copy-id mac-studio-2.local
```

***

## Run it {#run-it}

### Install mlx-lm {#install-mlx-lm}

`mlx.launch` starts the program over SSH on every Mac, so install mlx-lm on each one:

```bash
pip install -U mlx-lm
```

Each Mac loads the model from its own disk, so each needs disk space for the full NVFP4 checkpoint.

### Create the hostfile {#create-the-hostfile}

`mlx.launch` reads which Macs to use from a hostfile. List every Mac in it, two or four. For the `jaccl` backend, each entry also carries the host's Thunderbolt IP addresses and RDMA devices. The [MLX distributed documentation](https://ml-explore.github.io/mlx/build/html/usage/distributed.html) describes the format, and `mlx.distributed_config` can generate the file. These instructions save it as `hostfile.json` on the primary.

### Start the server {#start-the-server}

Run this on the primary. It starts `mlx_lm.server` on every Mac in the hostfile and serves an OpenAI-compatible API on port 8080:

```bash
mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \
  mlx_lm.server --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 --port 8080
```

Everything after `--` is the program that `mlx.launch` runs on each Mac. `--backend jaccl` selects the RDMA-over-Thunderbolt backend. `--env MLX_METAL_FAST_SYNCH=1` turns on an experimental MLX feature for fast CPU-GPU synchronization, which cuts communication overhead between the CPU, which drives the Thunderbolt link, and the GPU, which does the compute.

### Generate from the command line {#generate-from-the-command-line}

To test without a server, run `mlx_lm.generate` through the same launcher. The chat template defaults to `xhigh` reasoning, so leave room for reasoning tokens before the answer, and pass the [recommended sampling settings](https://dev.meta.ai/docs/muse-spark-open/settings):

```bash
mlx.launch --hostfile hostfile.json --backend jaccl --env MLX_METAL_FAST_SYNCH=1 -- \
  mlx_lm.generate \
    --model meta-models/Muse-Spark-Open-816B-A42B-NVFP4 \
    --prompt "Give me a one-sentence summary of what you can do." \
    --max-tokens 4096 \
    --temp 1.0 \
    --top-p 1.0
```

## References {#references}

- [NVFP4 weights on Hugging Face](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B-NVFP4)
- [mlx-lm on GitHub](https://github.com/ml-explore/mlx-lm)
- [MLX distributed documentation](https://ml-explore.github.io/mlx/build/html/usage/distributed.html)

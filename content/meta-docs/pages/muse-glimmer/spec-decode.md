# Speculative decoding {#speculative-decoding}

Speed up Muse Glimmer with DFlash, its block-diffusion speculative decoding. A small draft model proposes continuation tokens and Muse Glimmer verifies them, so more than one token can land per verification step. That helps most on Muse Glimmer's long reasoning traces, where single-request latency dominates.

DFlash is set up per runtime. This page covers what the drafts are and where each runtime documents the flags.

## Draft checkpoints {#draft-checkpoints}

Two draft artifacts are published. The runtime-specific guide determines which one to use:

| Draft                                    | Where it lives                                                                                                  | Use it with                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `meta-models/Muse-Glimmer-30B-assistant` | Its own repository. Serves as published, with no conversion step.                                               | SGLang's documented bf16, GGUF, and NVFP4 paths             |
| `dflash-Muse-Glimmer-30B-Q4_K_M.gguf`    | [`meta-models/Muse-Glimmer-30B-GGUF`](https://huggingface.co/meta-models/Muse-Glimmer-30B-GGUF), roughly 1.6 GB | llama.cpp, ExecuTorch exports, and SGLang's GGUF-draft path |

## Set it up on your runtime {#runtimes}

| Runtime                                                                             | How DFlash is enabled                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [llama.cpp](https://dev.meta.ai/docs/muse-glimmer/deploy#llama-cpp-server)          | Add `-md` with the GGUF draft, plus `--spec-type draft-dflash` and its draft flags, to the serve command.                                                                            |
| [SGLang](https://dev.meta.ai/docs/muse-glimmer/deploy#sglang-spec-decode)           | Pass `--speculative-algorithm DFLASH` with a draft model path and block size. Not available on the MLX backend, and the draft needs its own memory headroom.                         |
| [ExecuTorch](https://dev.meta.ai/docs/muse-glimmer/deploy#executorch-dflash-export) | Export target and draft together with `export_dflash`. They land in one program, because the draft shares the target's token embeddings and output head rather than carrying copies. |

Each runtime exposes its own draft-length and block-size knobs, and the useful values depend on the backend and hardware. Each runtime's section on [Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy) carries the current flags and their limits.

## Next steps {#next-steps}

Combine speculative decoding with [quantization](https://dev.meta.ai/docs/muse-glimmer/quantization) for maximum efficiency on limited hardware. For production deployment, see [Run inference](https://dev.meta.ai/docs/muse-glimmer/deploy).

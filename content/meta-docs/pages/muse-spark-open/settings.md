# Recommended settings {#recommended-settings}

The settings that most affect Muse Spark Open's output quality and throughput on a self-hosted server. Sampling, reasoning strength, and streaming are per-request, so tune them against a running server. Parallelism and context length are fixed by the serve command, so decide those before you launch.

## Sampling {#sampling}

The recommended defaults are `temperature 1.0`, `top_p 1.0`, and `do_sample true`, which suit most use cases. The evaluation results in the [Muse Spark Open model card](https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B) were measured at these values with `xhigh` reasoning strength.

## Reasoning strength {#reasoning-strength}

Muse Spark Open reasons before it answers. Reasoning strength sets how much it reasons, and it's the single biggest lever on both answer quality and token spend. A server started with the `muse` reasoning parser, such as SGLang or vLLM, returns the reasoning in a separate field from the answer.

On the request, `reasoning_effort` takes a level name. The open-weight chat template turns it into the **numeric** strength that the model reads from the system block:

| `reasoning_effort` | Rendered strength | Use it for                                                                  |
| ------------------ | ----------------- | --------------------------------------------------------------------------- |
| `low`              | 8                 | Classification, extraction, straightforward questions, and short tool loops |
| `medium`           | 32                | General agentic work                                                        |
| `high`             | 256               | Multi-step reasoning, hard debugging, and long tool loops                   |
| `xhigh`            | 512 (default)     | Problems where depth matters more than latency                              |

The default is `xhigh`, so set `reasoning_effort` explicitly when you want shorter reasoning. Lower strength reduces generated reasoning tokens and latency.

## Context length {#context-length}

Muse Spark Open carries a 1,048,576-token context window. Of its 62 decoder layers, 46 use sliding-window attention over the most recent 2,048 tokens and 16 use full attention. Only the full-attention layers keep a KV cache for the whole context, so KV memory grows with context length on those 16 layers and stays fixed on the rest. Set the server's maximum context length (`--context-length` in SGLang, `--max-model-len` in vLLM) to what your workload needs rather than the full window.

## Parallelism {#parallelism}

Muse Spark Open is a mixture-of-experts model, so expert weights dominate the footprint. Expert parallelism spreads those experts across ranks, and it's what makes the model fit on a given number of GPUs.

The serving recipes assume B300 GPUs.

| Checkpoint | Tensor parallel | Expert parallel | GPUs     |
| ---------- | --------------- | --------------- | -------- |
| BF16       | 8               | 8               | 8 × B300 |
| NVFP4      | 4               | 4               | 4 × B300 |

Parser flags:

- SGLang: `--reasoning-parser muse --tool-call-parser muse`
- vLLM: `--reasoning-parser muse --tool-call-parser muse --enable-auto-tool-choice`
- TensorRT-LLM: `--reasoning_parser musespark --tool_parser musespark`

## Stop tokens {#stop-tokens}

Muse Spark Open ends a finished turn with `<|eot|>`. It ends a message that continues the turn with `<|eom|>`.

> **WARNING: Never stop on <|eom|>**
>
> Stop on `<|eot|>` and the end-of-text token only. `<|eom|>` ends a message while the turn continues, so stopping there truncates the model before it emits a tool call or its final answer.

| Token                      | ID     | Role                                                                                                                                   |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `<\|begin_of_text\|>`      | 200000 | `bos_token_id`                                                                                                                         |
| `<\|end_of_text\|>`        | 200001 | End of text, in `eos_token_id`                                                                                                         |
| `<\|eom\|>`                | 200007 | Ends a message while the turn continues, such as reasoning, commentary, or a tool call followed by another call. Not in `eos_token_id` |
| `<\|eot\|>`                | 200008 | Ends the turn, in `eos_token_id`                                                                                                       |
| `<\|finetune_right_pad\|>` | 200018 | `pad_token_id`                                                                                                                         |

`eos_token_id` is `[200001, 200008]`. SGLang reads the same pair from the checkpoint's `config.json` and `generation_config.json`, so no explicit flag is needed there.

## Stream long generations {#streaming}

Muse Spark Open produces long reasoning traces at higher strengths. Request streaming (`stream: true`) for reasoning workloads so a long generation doesn't hit a client or proxy timeout.

## Next steps {#next-steps}

Apply these settings in your runtime's serve command. See [Run inference](https://dev.meta.ai/docs/muse-spark-open/deploy) for SGLang, vLLM, TensorRT-LLM, and the other runtimes.

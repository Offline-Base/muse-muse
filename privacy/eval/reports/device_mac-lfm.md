# Device bench: mac-lfm

Command: `uv run python -m scripts.bench_device --label mac-lfm --gguf LFM3-VL-2B-Q4_K_M.gguf --mmproj mmproj-LFM3-VL-2B-Q8_0.gguf --kind lfm --expect-power plugged --full-grade --hash --max-minutes 12`

Date: 2026-10-30 23:53. Result: valid.

Invented demo data only: a copy of the invented class in a throwaway home. Numbers are from this one run on this one device. Prompt and generation speeds are llama-server's own timings with the prompt cache off.

## Device

| What | Value |
|---|---|
| OS | macOS 26.5.1 |
| Board | not reported |
| CPU | Apple M4 Max |
| Architecture | arm64 |
| Cores | 14 |
| Memory | 36.00 GB |
| Free disk on the model's volume | 7.29 GB |
| llama.cpp build | b11972 |
| Other llama-server processes running | 2 |

## Model

| What | Value |
|---|---|
| File | LFM3-VL-2B-Q4_K_M.gguf |
| Kind | LFM3-VL-2B body (Liquid's sampling, thinking off) |
| Size | 1.02 GB |
| Vision projector | mmproj-LFM3-VL-2B-Q8_0.gguf, 0.19 GB |
| sha256 (first 16) | 56dac2e192ff0d9a |
| KV cache at 16,384 tokens | 0.34 GB |
| Server flags | -c 16384 -ngl 99 -np 1 --cache-ram 0 --ctx-checkpoints 0 |
| Memory check | fits: about 2.6 GB of 36.00 GB with a 1 GB margin |

## llama-bench (pp512, tg128, 3 repetitions)

| Test | Tokens/s | Std dev |
|---|---:|---:|
| pp512 | 3253.9 | 6.3 |
| tg128 | 210.4 | 0.6 |

## Server

| What | Value |
|---|---|
| Load time (start to the first 200 from /health) | 0.8 s |
| Peak resident memory of llama-server | 1.70 GB (ps; Metal buffers may not count) |
| Lowest available memory during the run | 7.21 GB (a drop of 0.30 GB) |
| Model buffers | 1246 MiB |
| KV cache buffers | 200 MiB |
| Recurrent state buffers | 1 MiB |
| Compute buffers | 513 MiB |
| Layers offloaded to the GPU | 25/25 |

## Steps

| Step | Reasoning | Calls | Mean latency (ms) | p50 (ms) | Prompt tokens | Prompt tok/s | Generated tokens | Gen tok/s | Reasoning | Valid JSON | Errors |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Router decision | n/a | 3 | 349 | 347 | 438 | 2965.0 | 40 | 196.6 | n/a | 3 | 0 |
| Second pass for names | n/a | 3 | 253 | 254 | 416 | 2684.9 | 19 | 188.1 | n/a | 3 | 0 |
| Request topics | n/a | 3 | 170 | 170 | 272 | 2323.5 | 10 | 177.0 | n/a | 3 | 0 |
| Grade one essay | n/a | 3 | 1486 | 1514 | 1249 | 2482.2 | 181 | 183.5 | n/a | 3 | 0 |
| Name pass, essay folder | n/a | 24 | 232 | 226 | 367 | 2615.2 | 18 | 191.6 | n/a | 24 | 0 |
| ask_device answer | n/a | 1 | 13772 | 13772 | n/a | n/a | n/a | n/a | n/a | n/a | 0 |
| Grading job, every essay | n/a | 1 | 32703 | 32703 | n/a | n/a | n/a | n/a | n/a | n/a | 0 |

Name pass over 24 essays: 5.6 s in all, 232 ms per essay, 24 valid JSON replies.

ask_device: 13.8 s, 2 part(s), 1 answered, 2 quote(s), timed out: no.

Grading job: 32.7 s, status done, 24 model steps, 24 feedback files written in the throwaway home.

## Power

| When | Source |
|---|---|
| At start | plugged (AC Power) |
| At end | plugged (AC Power) |
| Expected | plugged (--expect-power) |

Raw rows: raw/device_mac-lfm.jsonl next to this report (numbers, lengths and hashes only).

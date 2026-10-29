# A Snapdragon 8 Elite Gen 5 phone with bartowski's Q3_K_M

A kit output folder for `lib/devices/__tests__/result.test.ts`, built around a real run on a QDC reference phone on
Oct 28, 2026: Snapdragon 8 Elite Gen 5 (SM8850, "Canoe"), Android 16 (SDK 36), MemTotal 23,760,480 kB, 8 cores,
about 43 GB free on /data, a root adb shell. The run was done by hand with llama.cpp b11669's
android-arm64-snapdragon build before the kit existed, so only some files are the phone's own output.

| File | What it is |
|---|---|
| `bench-cpu.jsonl`, `bench-cpu.log` | **Real.** llama-bench's stdout and stderr for `-dev none -ngl 0 -p 128 -n 32 -r 1 -o jsonl`: pp128 5.61 t/s, tg32 3.01 t/s. Without `-v`, so the log has no buffer sizes. |
| `bench-gpu.jsonl`, `bench-gpu.log` | **Real.** The same with `-dev GPUOpenCL -ngl 99`: pp128 5.82 t/s, tg32 2.09 t/s. |
| `bench-npu.jsonl`, `bench-npu.log` | **Real.** `-dev HTP0 -ngl 99 -ub 1024`: only its init lines when the session ended, and no result. |
| `run.txt`, `steps.txt`, `model.txt` | **Reconstructed** in the kit's format: the settings the hand run used (`bench_gen=32`, `bench_reps=1`, one Hexagon session, the Snapdragon build for every backend, so `layout_cpu=bin-lib`), the measured sha256 check (5 s) and CPU bench (68 s), and the other times estimated from the JSONL's `test_time`. The NPU bench is written as the kit would have ended it: a timeout at its 900 s limit. |
| `device.txt` | **Reconstructed** from the session's facts: `ram_kb`, `cores`, `android`, `sdk`, `soc_model`, `abi`, `arch`, the free disk, and `board=canoe` (the phone's name in the session). Properties nobody recorded are left empty. |
| `mem-bench-cpu.txt`, `mem-bench-gpu.txt` | **Reconstructed** around the measured extremes: the peak RSS (5,493 MiB on the CPU, 7,440 MiB on the GPU) and the lowest MemAvailable (13,232 MiB and 6,522 MiB), from an idle 19,066 MiB, the session's own smoke reading. The samples between are made up. |
| `thermal-bench-*.txt` | **Constructed**, so the parser has some to read. |
| `answer-*.txt`, `answer-*.log` | **Constructed.** No Glimmer answer was asked on the phone. They show Glimmer's channels as the GGUF's template makes them (reasoning on `to=self`, then `<|eom|>`, `<|start|>assistant to=user<|message|>` and the answer, closed by `<|eot|>`), with perf lines that follow the bench speeds. `answer-cpu-color.txt` spends its 192 tokens reasoning and never answers. |

Its verdict: slow on the CPU (3.01 tokens a second, 2 of 3 answers right), with the GPU counting too (2.09, 3 of 3) and
the NPU timed out.
